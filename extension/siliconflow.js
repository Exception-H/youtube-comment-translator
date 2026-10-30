/* SiliconFlow (China site) free-model catalog and translation client.
 * The public catalog is a Next.js page whose model objects are embedded in
 * self.__next_f.push([1, "..."]) flight payloads. This file extracts those
 * strings and parses model objects with JSON.parse only. No eval, no new
 * Function, and no host-application credentials are read.
 */
(function (root) {
  'use strict';

  const PAGE = 'https://www.siliconflow.cn/models';
  const API = 'https://api.siliconflow.cn';
  const ENDPOINT = API + '/v1/chat/completions';
  const ORIGINS = [PAGE.replace(/\/models$/, '/*'), API + '/*'];
  const CATALOG_TTL = 600000;
  const AVAILABLE_TTL = 300000;
  const START_GAP = 2100;
  const REQUEST_TIMEOUT = 25000;

  function ytc() {
    if (!root.YTC) throw new Error('AI_CONFIG');
    return root.YTC;
  }

  function fail(name, diagnostic) {
    const error = new Error(name);
    const diag = ytc().safeDiagnostic(diagnostic);
    if (diag) error.diagnostic = diag;
    return error;
  }

  /* Quote/escape-aware balanced JSON slice starting at an opening [ or {. */
  function balancedEnd(text, start) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') {
        depth--;
        if (depth === 0) return index + 1;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  /* Reads only the JSON argument of self.__next_f.push(...), never executes it. */
  function flightStrings(html) {
    const chunks = [];
    const marker = /self\.__next_f\.push\s*\(/g;
    let match;
    while ((match = marker.exec(html))) {
      let start = match.index + match[0].length;
      while (start < html.length && /\s/.test(html[start])) start++;
      const end = balancedEnd(html, start);
      if (end < 0) break;
      let argument;
      try { argument = JSON.parse(html.slice(start, end)); } catch { argument = null; }
      if (Array.isArray(argument) && argument[0] === 1 && typeof argument[1] === 'string') chunks.push(argument[1]);
      marker.lastIndex = end;
    }
    return chunks;
  }

  function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function modelFrom(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = value.modelName;
    if (typeof id !== 'string' || !id.trim() || id.length > 200) return null;
    const name = id.trim();
    if (/pro\//i.test(name)) return null;
    if (/coder|math|safety|embed|ocr/i.test(name)) return null;
    if (value.status !== 'normal') return null;
    if (value.type !== 'text' || value.subType !== 'chat') return null;
    if (!Array.isArray(value.pricing) || value.pricing.length === 0) return null;

    const specifications = new Set();
    for (const entry of value.pricing) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      if (typeof entry.price !== 'string' || !entry.price.trim()) return null;
      const price = Number(entry.price);
      if (!Number.isFinite(price) || price !== 0) return null;
      if (typeof entry.specification === 'string') specifications.add(entry.specification);
    }
    if (!specifications.has('prompt') || !specifications.has('completion')) return null;

    const model = { id: name, name: typeof value.DisplayName === 'string' && value.DisplayName.trim() ? value.DisplayName.trim().slice(0, 180) : name };
    const info = Array.isArray(value.modelInfo)
      ? value.modelInfo.find(entry => Number(entry?.Level) === 0) || value.modelInfo.find(entry => entry && typeof entry === 'object')
      : null;
    const rpm = numberOrNull(info?.RPM);
    const tpm = numberOrNull(info?.TPM);
    if (rpm !== null && rpm > 0) model.rpm = Math.floor(rpm);
    if (tpm !== null && tpm > 0) model.tpm = Math.floor(tpm);
    return model;
  }

  /* Scans every top-level { outside strings. A successfully parsed model object
   * is skipped as a whole; wrappers are parsed and then scanned into. */
  function scanObjects(text) {
    const models = [];
    const seen = new Set();
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char !== '{') continue;
      const end = balancedEnd(text, index);
      if (end < 0) continue;
      let value;
      try { value = JSON.parse(text.slice(index, end)); } catch { continue; }
      const model = modelFrom(value);
      if (!model) continue;
      if (!seen.has(model.id)) { seen.add(model.id); models.push(model); }
      index = end - 1;
      quoted = false;
      escaped = false;
    }
    return models;
  }

  /* Pure HTML parser. Returns only verified zero-price general chat models. */
  function parseCatalog(html) {
    if (typeof html !== 'string' || !html) throw fail('SF_CATALOG', { stage: 'catalog' });
    const flight = flightStrings(html).join('');
    let models = flight ? scanObjects(flight) : [];
    if (!models.length) models = scanObjects(html);
    if (!models.length) throw fail('SF_CATALOG', { stage: 'catalog' });
    return models;
  }

  function contentTypeOf(response) {
    const header = response?.headers?.get?.('Content-Type') || '';
    if (/json/i.test(header)) return 'json';
    if (/html/i.test(header)) return 'html';
    if (/text/i.test(header)) return 'text';
    return 'other';
  }

  function timeoutSignal() {
    try {
      return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT) : undefined;
    } catch { return undefined; }
  }

  function requestOptions(extra = {}) {
    const options = { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', ...extra };
    const signal = timeoutSignal();
    if (signal) options.signal = signal;
    return options;
  }

  function httpError(status, data, stage, contentType) {
    const apiCode = Number(data?.error?.code ?? data?.code);
    let name = 'SERVICE';
    if (status === 401) name = 'SF_AUTH';
    else if (status === 403) name = 'SF_ACCESS';
    else if (status === 404) name = 'AI_MODEL';
    else if (status === 429) name = 'RATE_LIMIT';
    else if (status === 400 || status === 422) name = 'SF_PARAMETERS';
    else if (status === 408 || status === 504) name = 'OUTPUT_TIMEOUT';
    else if (status >= 500) name = 'SF_BUSY';
    return fail(name, { stage, status, apiCode, contentType });
  }

  function assertConfig(config) {
    if (!config || typeof config !== 'object') throw fail('AI_CONFIG');
    if (config.service !== 'siliconflow' || config.freeOnly !== true) throw fail('FREE_ONLY');
    if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) throw fail('AI_CONFIG');
    if (typeof config.model !== 'string' || !config.model.trim()) throw fail('AI_CONFIG');
    let endpoint;
    try { endpoint = ytc().aiEndpoint(config.baseUrl); } catch { throw fail('AI_CONFIG'); }
    if (endpoint !== ENDPOINT) throw fail('AI_CONFIG');
  }

  function configView(value) {
    const config = value && typeof value === 'object' ? value : {};
    return {
      service: typeof config.service === 'string' ? config.service : '',
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '',
      model: typeof config.model === 'string' ? config.model.trim() : '',
      apiKey: typeof config.apiKey === 'string' ? config.apiKey.trim() : '',
      freeOnly: config.freeOnly === true
    };
  }

  function sameConfig(a, b) {
    return JSON.stringify(configView(a)) === JSON.stringify(configView(b));
  }

  class Client {
    constructor({ chrome, fetch, now = Date.now, sleep, setTimer } = {}) {
      this.chrome = chrome;
      this.fetch = fetch;
      this.now = typeof now === 'function' ? now : Date.now;
      this.sleep = typeof sleep === 'function'
        ? sleep
        : ms => new Promise(resolve => (typeof setTimer === 'function' ? setTimer : setTimeout)(resolve, ms));
      this.setTimer = setTimer;
      this.catalogCache = null;
      this.availableCache = new Map();
      this.pending = [];
      this.running = false;
      this.lastStart = 0;
      this.blockedUntil = 0;
    }

    async permission() {
      const origins = ORIGINS.slice();
      let allowed = false;
      try { allowed = await this.chrome.permissions.contains({ origins }); } catch { allowed = false; }
      if (!allowed) throw fail('AI_PERMISSION');
    }

    rateLimited() {
      return fail('RATE_LIMIT', { stage: 'translate' });
    }

    noteRateLimit(response) {
      const raw = Number(response?.headers?.get?.('Retry-After'));
      const retry = Number.isFinite(raw) && raw > 0 ? Math.min(raw * 1000, 86400000) : 60000;
      this.blockedUntil = this.now() + Math.max(retry, 60000);
    }

    async catalog(force = false) {
      if (!force && this.catalogCache && this.now() - this.catalogCache.time < CATALOG_TTL) return this.catalogCache.models;
      await this.permission();
      let response;
      try {
        response = await this.fetch(PAGE, requestOptions({ method: 'GET', headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } }));
      } catch {
        throw fail('SF_CATALOG', { stage: 'catalog' });
      }
      const contentType = contentTypeOf(response);
      if (!response.ok) throw fail('SF_CATALOG', { stage: 'catalog', status: response.status, contentType });
      let html;
      try { html = await response.text(); } catch {
        throw fail('SF_CATALOG', { stage: 'catalog', status: response.status, contentType });
      }
      const models = parseCatalog(html);
      this.catalogCache = { time: this.now(), models };
      return models;
    }

    async keyId(apiKey) {
      const subtle = root.crypto?.subtle;
      if (!subtle) throw fail('AI_CONFIG');
      const encoder = root.TextEncoder || TextEncoder;
      const bytes = await subtle.digest('SHA-256', new encoder().encode(apiKey));
      return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async accountIds(config) {
      const id = await this.keyId(config.apiKey);
      const cached = this.availableCache.get(id);
      if (cached && this.now() - cached.time < AVAILABLE_TTL) return cached.ids;
      await this.permission();
      let response;
      try {
        response = await this.fetch(API + '/v1/models', requestOptions({ method: 'GET', headers: { Authorization: 'Bearer ' + config.apiKey } }));
      } catch {
        throw fail('NETWORK', { stage: 'catalog' });
      }
      const contentType = contentTypeOf(response);
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const error = httpError(response.status, data, 'catalog', contentType);
        if (error.message === 'RATE_LIMIT') this.noteRateLimit(response);
        throw error;
      }
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
      const ids = new Set();
      for (const entry of list) {
        const value = typeof entry === 'string' ? entry : entry?.id;
        if (typeof value === 'string' && value.trim()) ids.add(value.trim());
      }
      this.availableCache.set(id, { time: this.now(), ids });
      return ids;
    }

    async available(config) {
      assertConfig(config);
      const ids = await this.accountIds(config);
      const catalog = await this.catalog();
      return catalog.filter(model => ids.has(model.id));
    }

    async current(config, test, hasContext) {
      const latest = await this.chrome.storage.local.get(['settings', 'aiConfig']);
      const prefs = ytc().settings(latest?.settings);
      if (prefs.provider !== 'ai') throw fail('DISABLED');
      if (!prefs.enabled && !test) throw fail('DISABLED');
      if (hasContext && !prefs.useContext) throw fail('DISABLED');
      if (!sameConfig(latest?.aiConfig, config)) throw fail('DISABLED');
    }

    async pace() {
      if (this.now() < this.blockedUntil) throw this.rateLimited();
      const wait = this.lastStart ? START_GAP - (this.now() - this.lastStart) : 0;
      if (wait > 0) await this.sleep(wait);
      if (this.now() < this.blockedUntil) throw this.rateLimited();
      this.lastStart = this.now();
    }

    async prove(config) {
      const catalog = await this.catalog();
      if (!catalog.some(model => model.id === config.model)) throw fail('SF_CATALOG', { stage: 'catalog' });
      const available = await this.available(config);
      if (!available.some(model => model.id === config.model)) throw fail('AI_MODEL', { stage: 'catalog' });
    }

    async request(job) {
      const context = job.context;
      const payload = {
        model: job.config.model,
        stream: false,
        temperature: 0.2,
        max_tokens: Math.min(4096, Math.max(512, job.text.length * 2 + 256)),
        messages: [
          { role: 'system', content: ytc().AI_PROMPT },
          { role: 'user', content: JSON.stringify({ comment: job.text, video_title: context.title, parent_comment: context.parent }) }
        ]
      };
      if (/^Qwen\/Qwen3(?:[.-]|$)/i.test(job.config.model)) payload.enable_thinking = false;

      let response;
      try {
        response = await this.fetch(ENDPOINT, requestOptions({
          method: 'POST',
          headers: { Authorization: 'Bearer ' + job.config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }));
      } catch (cause) {
        const timedOut = ['TimeoutError', 'AbortError'].includes(cause?.name);
        throw fail(timedOut ? 'OUTPUT_TIMEOUT' : 'NETWORK', { stage: 'translate' });
      }
      const contentType = contentTypeOf(response);
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok || data?.error) {
        const error = httpError(response.status, data, 'translate', contentType);
        if (error.message === 'RATE_LIMIT') this.noteRateLimit(response);
        throw error;
      }
      if (data?.usage?.cost !== undefined && Number(data.usage.cost) > 0) throw fail('SF_NOT_FREE', { stage: 'translate', status: response.status, contentType });

      let cleaned;
      try {
        cleaned = ytc().cleanSingleOutput(data, job.text);
      } catch (cause) {
        const name = ['OUTPUT_UNTRANSLATED', 'OUTPUT_FORMAT', 'RESPONSE'].includes(cause?.message) ? cause.message : 'RESPONSE';
        throw fail(name, { stage: 'format', status: response.status });
      }
      const model = typeof data?.model === 'string' ? data.model.slice(0, 200) : job.config.model;
      return { text: cleaned.text, source: cleaned.source, model };
    }

    async run(job) {
      if (this.now() < this.blockedUntil) throw this.rateLimited();
      const hasContext = Boolean(job.context.title || job.context.parent);
      await this.current(job.config, job.test, hasContext);
      await this.prove(job.config);
      await this.pace();
      await this.current(job.config, job.test, hasContext);
      await this.permission();
      return this.request(job);
    }

    async pump() {
      while (this.pending.length) {
        const job = this.pending.shift();
        try {
          job.resolve(await this.run(job));
        } catch (error) {
          job.reject(error);
        }
      }
    }

    kick() {
      if (this.running) return;
      this.running = true;
      Promise.resolve().then(() => this.pump()).catch(() => {}).finally(() => {
        this.running = false;
        if (this.pending.length) this.kick();
      });
    }

    translate(text, context, config, test = false) {
      try { assertConfig(config); } catch (error) { return Promise.reject(error); }
      if (this.pending.length >= 80) return Promise.reject(fail('BUSY'));
      const job = {
        text: typeof text === 'string' ? text : String(text || ''),
        context: ytc().context(context),
        config: configView(config),
        test
      };
      return new Promise((resolve, reject) => {
        this.pending.push({ ...job, resolve, reject });
        this.kick();
      });
    }
  }

  root.YTCSilicon = { parseCatalog, Client };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.YTCSilicon;
})(globalThis);
