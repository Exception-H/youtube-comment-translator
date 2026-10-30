/* OpenRouter zero-price routing. Never reads a host application's credentials. */
(function (root) {
  'use strict';
  const ORIGIN = 'https://openrouter.ai';
  const ENDPOINT = ORIGIN + '/api/v1/chat/completions';
  const BATCH_PROMPT = '\n本次输入是批量评论。每个 items 元素的 id、comment、video_title、parent_comment 属于该条评论，绝不串用其他条的上下文。只输出一个 JSON 对象：{"translations":[{"id":"原id","text":"该条完整中文译文"}]}。必须为每个输入 id 恰好返回一次，顺序不限，不增删 id，不输出 Markdown 或额外文字。';
  function parseBatch(data, ids) {
    let text = YTC.parseAI(data).text;
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let json;
    try { json = JSON.parse(text); } catch {
      // Some real providers append a prose explanation after an otherwise valid JSON object.
      // Only accept a leading, balanced object; quoted braces and escapes cannot end it early.
      let depth = 0, quoted = false, escaped = false, end = -1;
      if (text.trimStart().startsWith('{')) {
        const start = text.indexOf('{');
        for (let index = start; index < text.length; index++) {
          const char = text[index];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === '{') depth++;
          else if (char === '}' && --depth === 0) { end = index + 1; break; }
        }
        if (end > start) { try { json = JSON.parse(text.slice(start, end)); } catch {} }
      }
      if (!json) throw new Error('FREE_BATCH');
    }
    if (!Array.isArray(json?.translations) || json.translations.length !== ids.length) throw new Error('FREE_BATCH');
    const result = new Map();
    for (const entry of json.translations) {
      if (typeof entry?.id !== 'string' || !ids.includes(entry.id) || result.has(entry.id) || typeof entry.text !== 'string' || !entry.text.trim()) throw new Error('FREE_BATCH');
      result.set(entry.id, entry.text.trim());
    }
    return result;
  }
  function routeError(status, data, stage, contentType = 'other') {
    const apiCode = Number(data?.error?.code ?? data?.error?.status);
    const code = Number.isInteger(apiCode) && apiCode >= 400 && apiCode <= 599 ? apiCode : status;
    const hint = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 1200).toLowerCase() : '';
    const symbolic = typeof data?.error?.code === 'string' ? data.error.code.toLowerCase() : '';
    let name = 'SERVICE';
    if (/data.policy|privacy|data.collection|zero.data.retention|allow.*training|no.*training/.test(hint) && [403, 404, 503].includes(code)) name = 'FREE_POLICY';
    else if ((code === 429 || /rate.limit/.test(symbolic)) && /daily|per.day|requests.per.day/.test(hint + ' ' + symbolic)) name = 'FREE_DAILY';
    else if (stage === 'translate' && code === 429 && (/upstream|temporarily.*rate|provider.*rate/.test(hint) || typeof data?.error?.metadata?.provider_name === 'string')) name = 'FREE_BUSY';
    else if (code === 429 || /rate.limit/.test(symbolic)) name = 'RATE_LIMIT';
    else if ([400, 422].includes(code)) name = 'FREE_PARAMETERS';
    else if (code === 401) name = 'AI_AUTH';
    else if (code === 402) name = 'AI_QUOTA';
    else if (code === 403) name = 'FREE_ACCESS';
    else if (code === 404) name = /invalid.model|model.*not.found|unknown.model/.test(hint) ? 'AI_MODEL' : 'FREE_NO_PROVIDER';
    else if (code === 503) name = 'FREE_NO_PROVIDER';
    else if (code === 502) name = 'FREE_UPSTREAM';
    else if ([408, 504].includes(code)) name = 'FREE_TIMEOUT';
    const error = new Error(name);
    error.diagnostic = YTC.safeDiagnostic({ stage, status, apiCode, contentType });
    return error;
  }
  function invalidTranslation(text, job) {
    const source = YTC.normalize(job.text);
    if (/^(?:user\s+safety|safety\s*(?:label|classification)|(?:safe|unsafe|allow|deny)\s*$)/i.test(text.trim())) return true;
    if (YTC.normalize(text) === source && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(source)) return true;
    if (/\bmiss(?:ed|es)?\s+(?:every|all(?:\s+the)?)\s+shot/i.test(source) && /每投必中|百发百中|(?:全|全部)(?:都)?(?:投|命)?中/.test(text)) return true;
    if (/basketball|篮球/i.test(job.context.title) && /\bshots?\b/i.test(source) && !/arrow|archer/i.test(source) && /射箭|每一箭/.test(text)) return true;
    return false;
  }
  class Router {
    constructor({ chrome, fetch, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), setTimer = setTimeout }) {
      this.chrome = chrome; this.fetch = fetch; this.now = now; this.sleep = sleep; this.setTimer = setTimer;
      this.pending = []; this.running = false; this.timer = null;
      this.catalogCache = null; this.quotaCache = new Map(); this.blockedUntil = 0;
      this.lastStart = 0; this.pacingReady = null;
      this.modelCooldowns = new Map();
    }
    async permission() {
      if (!await this.chrome.permissions.contains({ origins: [ORIGIN + '/*'] })) throw new Error('AI_PERMISSION');
    }
    async json(url, config = null, options = {}) {
      await this.permission();
      const stage = url.endsWith('/models') ? 'catalog' : url.endsWith('/key') ? 'quota' : 'translate';
      let response;
      try {
        response = await this.fetch(url, { ...options, headers: { ...(config ? { Authorization: 'Bearer ' + config.apiKey } : {}), ...(options.headers || {}) }, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(25000) });
      } catch (cause) {
        const error = new Error(['TimeoutError', 'AbortError'].includes(cause?.name) ? 'FREE_TIMEOUT' : 'NETWORK');
        error.diagnostic = { stage };
        throw error;
      }
      const header = response.headers?.get?.('Content-Type') || '';
      const contentType = /json/i.test(header) ? 'json' : /html/i.test(header) ? 'html' : /text/i.test(header) ? 'text' : 'other';
      let data;
      try { data = await response.json(); } catch {
        if (!response.ok) throw routeError(response.status, null, stage, contentType);
        const error = new Error('RESPONSE'); error.diagnostic = { stage, status: response.status, contentType }; throw error;
      }
      if (!response.ok || data?.error) {
        const error = routeError(response.status, data, stage, contentType);
        if (['RATE_LIMIT', 'FREE_DAILY'].includes(error.message)) {
          const raw = Number(response.headers?.get?.('Retry-After'));
          const retryMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw * 1000, 86400000) : 60000;
          this.blockedUntil = this.now() + Math.max(retryMs, 60000);
          await this.chrome.storage.session.set({ freeBlockedUntil: this.blockedUntil }).catch(() => {});
        }
        throw error;
      }
      return data;
    }
    async catalog(force = false) {
      if (!force && this.catalogCache && this.now() - this.catalogCache.time < 300000) return this.catalogCache.models;
      const data = await this.json(ORIGIN + '/api/v1/models');
      const models = YTC.freeModels(data);
      if (!models.some(model => model.id === 'openrouter/free')) throw new Error('FREE_CATALOG');
      this.catalogCache = { time: this.now(), models };
      return models;
    }
    async identity(config) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.apiKey));
      return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    day() { return new Date(this.now()).toISOString().slice(0, 10); }
    async status(config, force = false) {
      YTC.validateFreeConfig(config);
      if (!config.apiKey) throw new Error('AI_CONFIG');
      const id = await this.identity(config);
      const cached = this.quotaCache.get(id);
      if (!force && cached?.day === this.day() && this.now() - cached.checkedAt < 60000) return { ...cached, id };
      const stored = (await this.chrome.storage.session.get('freeQuota')).freeQuota;
      const old = stored?.id === id && stored.day === this.day() ? stored : null;
      const result = await this.json(ORIGIN + '/api/v1/key', config);
      const remote = result?.data?.free_model_daily_requests;
      const known = Number.isFinite(remote?.limit) && Number.isFinite(remote?.used) && Number.isFinite(remote?.remaining) && remote.limit >= 0 && remote.used >= 0 && remote.remaining >= 0;
      // Older accounts may lack this field; use a conservative local 50-request cap.
      const limit = known ? Math.floor(remote.limit) : 50;
      const used = Math.max(old?.used || 0, known ? Math.floor(remote.used) : 0);
      const remaining = Math.max(0, Math.min(limit - used, known ? Math.floor(remote.remaining) : limit));
      const quota = { id, day: this.day(), checkedAt: this.now(), used, limit, remaining, estimated: !known };
      this.quotaCache.set(id, quota);
      await this.chrome.storage.session.set({ freeQuota: quota }).catch(() => {});
      return { ...quota };
    }
    async reserve(config) {
      const quota = await this.status(config);
      if (quota.remaining <= 0) throw new Error('FREE_DAILY');
      quota.used++; quota.remaining--;
      this.quotaCache.set(quota.id, quota);
      // Reserve before sending. Failed attempts conservatively remain counted locally.
      await this.chrome.storage.session.set({ freeQuota: quota }).catch(() => {});
    }
    async pace() {
      if (!this.pacingReady) this.pacingReady = this.chrome.storage.session.get(['freeLastStart', 'freeBlockedUntil']).then(value => {
        this.lastStart = Number(value.freeLastStart) || 0;
        this.blockedUntil = Math.max(this.blockedUntil, Number(value.freeBlockedUntil) || 0);
      });
      await this.pacingReady;
      if (this.now() < this.blockedUntil) throw new Error('RATE_LIMIT');
      const wait = 3200 - (this.now() - this.lastStart);
      if (wait > 0) await this.sleep(wait);
      if (this.now() < this.blockedUntil) throw new Error('RATE_LIMIT');
      this.lastStart = this.now();
      await this.chrome.storage.session.set({ freeLastStart: this.lastStart }).catch(() => {});
    }
    translate(text, context, config, test = false) {
      YTC.validateFreeConfig(config);
      if (this.pending.length >= 80) return Promise.reject(new Error('BUSY'));
      return new Promise((resolve, reject) => {
        this.pending.push({ text, context: YTC.context(context), config, test, resolve, reject });
        if (!this.timer && !this.running) this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, 220);
      });
    }
    async current(config, test, hasContext = false) {
      const latest = await this.chrome.storage.local.get(['settings', 'aiConfig']);
      const prefs = YTC.settings(latest.settings);
      const current = YTC.aiConfig(latest.aiConfig);
      if ((!prefs.enabled && !test) || (hasContext && !prefs.useContext) || prefs.provider !== 'ai' || JSON.stringify(current) !== JSON.stringify(config)) throw new Error('DISABLED');
    }
    async pump() {
      if (this.running) return;
      this.running = true;
      try {
        while (this.pending.length) {
          const first = this.pending.shift();
          const jobs = [first];
          let chars = first.text.length + first.context.parent.length;
          for (let index = 0; index < this.pending.length && jobs.length < 6;) {
            const item = this.pending[index];
            const length = item.text.length + item.context.parent.length;
            if (item.test === first.test && JSON.stringify(item.config) === JSON.stringify(first.config) && chars + length <= 10000) {
              jobs.push(...this.pending.splice(index, 1)); chars += length;
            } else index++;
          }
          let selectedModel = '';
          try {
            await this.current(first.config, first.test, jobs.some(job => Boolean(job.context.title || job.context.parent)));
            const catalog = await this.catalog();
            if (!catalog.some(model => model.id === first.config.model)) throw new Error('FREE_ONLY');
            const automatic = first.config.model === 'openrouter/free';
            selectedModel = automatic ? YTC.translationModels(catalog).find(model => this.now() >= (this.modelCooldowns.get(model.id) || 0) && !jobs.some(job => job.excludedModels?.includes(model.id)))?.id : first.config.model;
            if (!selectedModel) throw first.lastError || new Error('FREE_NO_PROVIDER');
            await this.pace();
            await this.current(first.config, first.test, jobs.some(job => Boolean(job.context.title || job.context.parent)));
            await this.reserve(first.config);
            const ids = jobs.map((_, index) => String(index));
            const single = jobs.length === 1;
            const payload = {
              model: selectedModel, stream: false,
              reasoning: { enabled: false, exclude: true },
              max_tokens: Math.min(8192, Math.max(512, jobs.reduce((sum, job) => sum + job.text.length * 2, 0) + 500)),
              messages: [
                { role: 'system', content: YTC.AI_PROMPT + (single ? '' : BATCH_PROMPT) },
                { role: 'user', content: JSON.stringify(single
                  ? { comment: first.text, video_title: first.context.title, parent_comment: first.context.parent }
                  : { items: jobs.map((job, index) => ({ id: ids[index], comment: job.text, video_title: job.context.title, parent_comment: job.context.parent })) }) }
              ]
            };
            // Automatic mode resolves a verified general-purpose :free candidate locally.
            // Never send the random server router, which may choose a safety classifier.
            payload.provider = { max_price: { prompt: '0', completion: '0' }, allow_fallbacks: true };
            const data = await this.json(ENDPOINT, first.config, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (data?.usage?.cost !== undefined && Number(data.usage.cost) > 0) throw new Error('FREE_ONLY');
            let results;
            try { results = single ? new Map([[ids[0], YTC.cleanSingleOutput(data, first.text).text]]) : parseBatch(data, ids); }
            catch (error) { error.diagnostic = { stage: 'format', status: 200 }; throw error; }
            const model = typeof data.model === 'string' ? data.model.slice(0, 200) : selectedModel;
            jobs.forEach((job, index) => {
              const text = results.get(ids[index]);
              if (!invalidTranslation(text, job)) { job.resolve({ text, source: 'auto', model }); return; }
              const error = new Error('FREE_NOT_TRANSLATION');
              error.diagnostic = { stage: 'format', status: 200 };
              if (first.config.model === 'openrouter/free' && (job.attempt || 0) < 2) {
                job.attempt = (job.attempt || 0) + 1; job.lastError = error;
                job.excludedModels = [...(job.excludedModels || []), selectedModel];
                this.pending.push(job);
              } else job.reject(error);
            });
          } catch (error) {
            const recoverable = ['FREE_BUSY', 'FREE_UPSTREAM', 'FREE_TIMEOUT', 'FREE_PARAMETERS', 'FREE_NO_PROVIDER', 'FREE_NOT_TRANSLATION', 'FREE_BATCH', 'RESPONSE', 'OUTPUT_FORMAT', 'OUTPUT_UNTRANSLATED'].includes(error.message);
            if (selectedModel && first.config.model === 'openrouter/free' && recoverable && jobs.every(job => (job.attempt || 0) < 2)) {
              this.modelCooldowns.set(selectedModel, this.now() + 60000);
              jobs.forEach(job => { job.attempt = (job.attempt || 0) + 1; job.lastError = error; });
              this.pending.unshift(...jobs);
            } else jobs.forEach(job => job.reject(error));
          }
        }
      } finally { this.running = false; }
    }
  }
  root.YTCFree = { Router, parseBatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.YTCFree;
})(globalThis);
