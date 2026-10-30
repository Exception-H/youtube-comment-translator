/* Search-only translation bridge. Never reads the comment service or its key. */
(function (root) {
  'use strict';
  const TYPES = new Set(['SEARCH_START', 'SEARCH_END', 'SEARCH_TRANSLATE', 'TITLE_TRANSLATE', 'OPEN_DUAL_SETTINGS']);
  const TTL = 6 * 60 * 60 * 1000;
  const LIMIT = 400;
  function shared() { return root.YTC; }
  function fail(code) { return new Error(code); }
  function senderTab(sender) {
    let url;
    try { url = new URL(sender?.url || ''); } catch { throw fail('SEARCH_SESSION'); }
    if (url.protocol !== 'https:' || !['www.youtube.com', 'm.youtube.com'].includes(url.hostname) || !Number.isInteger(sender?.tab?.id)) throw fail('SEARCH_SESSION');
    // During a YouTube SPA navigation sender.url can still describe the previous
    // page, so the search term is read from the message. This URL value is only a
    // fallback for older callers.
    return { id: sender.tab.id, query: shared().normalize(url.searchParams.get('search_query')) };
  }
  function isQuery(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 300 && /\p{Script=Han}/u.test(value);
  }
  class Controller {
    constructor({ chrome, client, prepare, now = Date.now }) {
      this.chrome = chrome; this.client = client; this.prepare = prepare; this.now = now;
      this.sessions = new Map(); this.ended = new Map(); this.cache = new Map(); this.inflight = new Map(); this.timer = null; this.cacheEpoch = 0;
      this.ready = Promise.resolve(chrome.storage.session.get('searchTranslations')).then(value => {
        const entries = value?.searchTranslations;
        if (!Array.isArray(entries)) return;
        for (const item of entries.slice(-LIMIT)) {
          if (Array.isArray(item) && /^[a-f0-9]{64}$/.test(item[0]) && typeof item[1]?.text === 'string' && item[1].text.length <= 3000 && Number.isFinite(item[1].time) && this.now() - item[1].time >= 0 && this.now() - item[1].time < TTL) this.cache.set(item[0], item[1]);
        }
      }).catch(() => {});
      chrome.tabs?.onRemoved?.addListener(id => this.sessions.delete(id));
    }
    accepts(type) { return TYPES.has(type); }
    active(tabId, session) { return this.sessions.get(tabId)?.session === session; }
    async enabled() {
      const value = await this.chrome.storage.local.get('settings');
      if (!shared().settings(value.settings).dualSearch) throw fail('DISABLED');
    }
    async key(purpose, text, query) {
      const value = JSON.stringify(['search-v1-index35', purpose, text, query]);
      const digest = await root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    persist() {
      while (this.cache.size > LIMIT) this.cache.delete(this.cache.keys().next().value);
      if (this.timer) root.clearTimeout(this.timer);
      this.timer = root.setTimeout(() => {
        this.timer = null;
        this.chrome.storage.session.set({ searchTranslations: Array.from(this.cache) }).catch(() => {});
      }, 400);
    }
    async clear() {
      this.cacheEpoch++;
      await this.ready;
      if (this.timer) root.clearTimeout(this.timer);
      this.timer = null; this.cache.clear(); this.inflight.clear();
      await this.chrome.storage.session.remove('searchTranslations');
    }
    async translateTitleOnly(text) {
      const isCurrent = () => true;
      await this.ready;
      const key = await this.key('title', text, '');
      const cached = this.cache.get(key);
      if (cached && this.now() - cached.time >= 0 && this.now() - cached.time < TTL) return { ok: true, text: cached.text, model: cached.model, cached: true };
      const jobKey = 'title-only:' + key;
      if (this.inflight.has(jobKey)) return this.inflight.get(jobKey);
      const epoch = this.cacheEpoch;
      const pending = (async () => {
        if (!await this.chrome.permissions.contains({ origins: ['https://index-translate.bilibili.com/*'] })) throw fail('AI_PERMISSION');
        await this.prepare();
        const result = await this.client.translateTitle(text, { isCurrent, query: '' });
        await this.enabled();
        if (epoch === this.cacheEpoch) {
          this.cache.set(key, { text: result.text, model: result.model || '', time: this.now() });
          this.persist();
        }
        return { ok: true, text: result.text, model: result.model || '', cached: false };
      })();
      this.inflight.set(jobKey, pending);
      try { return await pending; } finally { if (this.inflight.get(jobKey) === pending) this.inflight.delete(jobKey); }
    }
    async handle(message, sender) {
      const type = message?.type;
      if (!this.accepts(type)) throw fail('SEARCH_SESSION');
      const owner = senderTab(sender);
      if (type === 'OPEN_DUAL_SETTINGS') {
        if (this.chrome.tabs?.create) await this.chrome.tabs.create({ url: this.chrome.runtime.getURL('options.html#dual-search') });
        else await this.chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      if (type === 'TITLE_TRANSLATE') {
        await this.enabled();
        const heading = typeof message.text === 'string' ? shared().normalize(message.text) : '';
        if (!heading || heading.length > 500) throw fail('TOO_LONG');
        return this.translateTitleOnly(heading);
      }
      const session = typeof message.session === 'string' && /^[a-z0-9_-]{1,80}$/i.test(message.session) ? message.session : '';
      if (!session) throw fail('SEARCH_SESSION');
      if (type === 'SEARCH_END') {
        this.ended.set(owner.id + ':' + session, this.now());
        while (this.ended.size > 400) this.ended.delete(this.ended.keys().next().value);
        if (this.active(owner.id, session)) this.sessions.delete(owner.id);
        return { ok: true };
      }
      if (this.ended.has(owner.id + ':' + session)) throw fail('SEARCH_SESSION');
      const seq = Number.isFinite(message.seq) ? Math.floor(message.seq) : null;
      const provided = typeof message.query === 'string' ? shared().normalize(message.query) : '';
      const hasQueryField = Object.prototype.hasOwnProperty.call(message, 'query');
      const resolved = isQuery(provided) ? provided : (!hasQueryField && isQuery(owner.query)) ? owner.query : '';
      if (type === 'SEARCH_START') {
        if (!resolved) throw fail('SEARCH_SESSION');
        const current = this.sessions.get(owner.id);
        if (seq !== null && current && Number.isFinite(current.seq) && seq < current.seq) throw fail('SEARCH_SESSION');
        if (seq !== null && current && Number.isFinite(current.seq) && seq === current.seq && current.session !== session) throw fail('SEARCH_SESSION');
        this.sessions.set(owner.id, { session, seq: seq === null ? (Number(current?.seq) || 0) : seq, query: resolved });
        if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
        try { await this.enabled(); } catch (error) { if (this.active(owner.id, session)) this.sessions.delete(owner.id); throw error; }
        if (!this.active(owner.id, session)) throw fail('SEARCH_SESSION');
        return { ok: true };
      }
      await this.enabled();
      const purpose = message.purpose;
      const text = typeof message.text === 'string' ? shared().normalize(message.text) : '';
      if (!['query', 'title'].includes(purpose) || !text || text.length > (purpose === 'query' ? 300 : 500)) throw fail('TOO_LONG');
      if (!resolved) throw fail('SEARCH_SESSION');
      if (purpose === 'query' && text !== resolved) throw fail('SEARCH_SESSION');
      // A service-worker restart can lose the in-memory owner; the current page
      // may reestablish it, but an older session cannot replace a newer one.
      let current = this.sessions.get(owner.id);
      const expected = current && typeof current.query === 'string' && current.query ? current.query : resolved;
      if (resolved !== expected) throw fail('SEARCH_SESSION');
      if (seq !== null && current && Number.isFinite(current.seq) && seq < current.seq) throw fail('SEARCH_SESSION');
      if (!current) this.sessions.set(owner.id, { session, seq: seq === null ? 0 : seq, query: resolved });
      else if (seq !== null && Number.isFinite(current.seq) && seq > current.seq) this.sessions.set(owner.id, { session, seq, query: resolved });
      if (!this.active(owner.id, session)) throw fail('SEARCH_SESSION');
      const isCurrent = () => this.active(owner.id, session);
      await this.ready;
      const key = await this.key(purpose, text, resolved);
      const cached = this.cache.get(key);
      if (cached && this.now() - cached.time >= 0 && this.now() - cached.time < TTL) return { ok: true, text: cached.text, model: cached.model, cached: true };
      const jobKey = owner.id + ':' + session + ':' + key;
      if (this.inflight.has(jobKey)) return this.inflight.get(jobKey);
      const epoch = this.cacheEpoch;
      const pending = (async () => {
        if (!isCurrent()) throw fail('SEARCH_SESSION');
        if (!await this.chrome.permissions.contains({ origins: ['https://index-translate.bilibili.com/*'] })) throw fail('AI_PERMISSION');
        await this.prepare();
        const result = purpose === 'query'
          ? await this.client.translateQuery(text, { isCurrent })
          : await this.client.translateTitle(text, { isCurrent, query: resolved });
        if (!isCurrent()) throw fail('SEARCH_SESSION');
        await this.enabled();
        if (epoch === this.cacheEpoch) {
          this.cache.set(key, { text: result.text, model: result.model || '', time: this.now() });
          this.persist();
        }
        return { ok: true, text: result.text, model: result.model || '', cached: false };
      })();
      this.inflight.set(jobKey, pending);
      try { return await pending; } finally { if (this.inflight.get(jobKey) === pending) this.inflight.delete(jobKey); }
    }
  }
  const api = { Controller };
  root.YTCSearchBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
