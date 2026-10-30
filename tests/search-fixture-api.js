/* Test-only fake chrome APIs and a synthetic YTCSearchSource for search-fixture.html. */
(() => {
  'use strict';

  const CHINESE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const settings = {
    enabled: true,
    display: 'bilingual',
    skipChinese: true,
    provider: 'google',
    useContext: true,
    freeMode: false,
    aiService: 'openrouter',
    dualSearch: true
  };
  const messages = [];
  const storageListeners = [];
  const sourceCalls = { search: [], next: [], constructed: [] };
  const scenarios = new Map();
  const queryTranslations = new Map();
  const titleFailures = new Set();
  const titleTranslation = { delay: 12, error: null, calls: 0, active: 0, maxActive: 0 };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError());
        return;
      }
      let timer = 0;
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function abortError() {
    try { return new DOMException('Aborted', 'AbortError'); }
    catch { const error = new Error('Aborted'); error.name = 'AbortError'; return error; }
  }

  function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function item(id, title, extra = {}) {
    return Object.assign({
      id,
      title,
      channel: '测试频道',
      views: '12万次观看',
      published: '2周前',
      duration: '09:42',
      description: '这是用于测试的真实字段描述，不含伪造播放量。',
      thumbnail: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
      url: '/watch?v=' + id
    }, extra);
  }

  function defaultScenario(query) {
    const chinese = !/^english\s/i.test(query) && CHINESE.test(query);
    const prefix = chinese ? 'zh' : 'en';
    const label = chinese ? '中文结果' : 'English result';
    const page1 = {
      items: Array.from({ length: 6 }, (_, index) => item(
        prefix + '00' + (index + 1),
        label + ' ' + query + ' #' + (index + 1),
        {
          channel: chinese ? '中文频道 ' + (index + 1) : 'English Channel ' + (index + 1),
          views: (index + 1) + '万次观看',
          published: (index + 1) + '周前',
          duration: '0' + (index + 1) + ':00',
          description: label + ' 第 ' + (index + 1) + ' 条描述'
        }
      )),
      continuation: prefix + '-p2'
    };
    const page2 = {
      items: Array.from({ length: 3 }, (_, index) => item(
        prefix + '00' + (index + 7),
        label + ' ' + query + ' 第二页 #' + (index + 1),
        { duration: '1' + (index + 1) + ':00' }
      )),
      continuation: ''
    };
    return {
      pages: [page1, page2],
      nextMap: { [prefix + '-p2']: page2 },
      searchDelay: 18,
      nextDelay: 18
    };
  }

  function scenarioFor(query) {
    if (!scenarios.has(query)) scenarios.set(query, defaultScenario(query));
    return scenarios.get(query);
  }

  function pageFor(scenario, token) {
    if (token && scenario.nextMap && scenario.nextMap[token]) return scenario.nextMap[token];
    if (!token && scenario.pages && scenario.pages[0]) return scenario.pages[0];
    if (scenario.pages) {
      for (const page of scenario.pages) {
        if (page.continuation && page.continuation === token) return page;
      }
    }
    return null;
  }

  function pageResult(page) {
    if (!page) return { items: [], continuation: '' };
    return {
      items: clone(Array.isArray(page.items) ? page.items : []),
      continuation: typeof page.continuation === 'string' ? page.continuation : ''
    };
  }

  function syntheticCfg() {
    return Object.freeze({
      version: 'test-public-2026',
      clientVersion: '2.0-test',
      apiKey: '',
      origin: 'https://www.youtube.com'
    });
  }

  class SearchSource {
    constructor(options) {
      this.options = options || {};
      this.tokenScenarios = new Map();
      this.query = '';
      sourceCalls.constructed.push({
        hasDocument: !!this.options.document,
        origin: this.options.origin,
        hasFetch: typeof this.options.fetch === 'function'
      });
    }

    async search(query, options = {}) {
      const scenario = scenarioFor(query);
      const params = options.params;
      if (typeof params !== 'string') throw codedError('SEARCH_INPUT');
      if (params && !/^[A-Za-z0-9_-]+$/.test(params)) throw codedError('SEARCH_INPUT');
      sourceCalls.search.push({
        query,
        sp: params || '',
        params,
        origin: this.options.origin,
        signal: options.signal
      });
      this.query = query;
      await wait(scenario.searchDelay == null ? 18 : scenario.searchDelay, options.signal);
      if (scenario.searchError) throw codedError(scenario.searchError);
      const page = pageFor(scenario, '');
      const result = pageResult(page);
      if (result.continuation) this.tokenScenarios.set(result.continuation, scenario);
      return result;
    }

    async next(token, options = {}) {
      const scenario = this.tokenScenarios.get(token) || scenarioFor(this.query);
      sourceCalls.next.push({ token, signal: options.signal });
      const page = pageFor(scenario, token);
      const delay = page && page.delay != null ? page.delay : scenario.nextDelay == null ? 18 : scenario.nextDelay;
      await wait(delay, options.signal);
      if (scenario.nextError) throw codedError(scenario.nextError);
      if (page && page.error) throw codedError(page.error);
      const result = pageResult(page);
      if (result.continuation) this.tokenScenarios.set(result.continuation, scenario);
      return result;
    }
  }

  const sourceApi = {
    readClientContext() { return syntheticCfg(); },
    parseResults(value) { return value; },
    SearchSource
  };

  function notifyStorage(oldValue, newValue) {
    const event = { settings: { oldValue: clone(oldValue), newValue: clone(newValue) } };
    for (const listener of storageListeners) {
      try { listener(event, 'local'); } catch { /* test listener */ }
    }
  }

  async function translateQuery(message) {
    const override = queryTranslations.get(message.text) || {};
    await wait(override.delay == null ? 4 : override.delay);
    if (override.error) return { ok: false, error: override.error };
    return { ok: true, text: override.text || 'english ' + message.text };
  }

  async function translateTitle(message) {
    titleTranslation.calls++;
    titleTranslation.active++;
    titleTranslation.maxActive = Math.max(titleTranslation.maxActive, titleTranslation.active);
    try {
      await wait(titleTranslation.delay);
      if (titleFailures.has(message.text) || titleTranslation.error) {
        return { ok: false, error: titleTranslation.error || 'TITLE_FAILED' };
      }
      return { ok: true, text: '译名：' + message.text };
    } finally {
      titleTranslation.active--;
    }
  }

  async function handleMessage(message) {
    messages.push(clone(message));
    if (!message || typeof message !== 'object') return { ok: false, error: 'BAD_MESSAGE' };
    if (message.type === 'SEARCH_START' || message.type === 'SEARCH_END') return { ok: true };
    if (message.type === 'OPEN_DUAL_SETTINGS') {
      window.testAPI.optionsOpened++;
      return { ok: true };
    }
    if (message.type !== 'SEARCH_TRANSLATE') return { ok: false, error: 'UNKNOWN_MESSAGE' };
    if (message.purpose === 'query') return translateQuery(message);
    if (message.purpose === 'title') return translateTitle(message);
    return { ok: false, error: 'UNKNOWN_PURPOSE' };
  }

  window.YTCSearchSource = sourceApi;
  window.chrome = {
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) return { settings: clone(settings) };
          if (key === 'settings') return { settings: clone(settings) };
          if (Array.isArray(key)) {
            const result = {};
            for (const name of key) if (name === 'settings') result.settings = clone(settings);
            return result;
          }
          return {};
        },
        async set(patch) {
          const oldValue = clone(settings);
          if (patch && patch.settings && typeof patch.settings === 'object') {
            Object.assign(settings, patch.settings);
          } else if (patch && typeof patch === 'object') {
            Object.assign(settings, patch);
          }
          notifyStorage(oldValue, settings);
          return undefined;
        }
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    runtime: {
      sendMessage(message, callback) {
        const promise = handleMessage(message);
        if (typeof callback === 'function') {
          promise.then(response => {
            try { callback(response); } catch { /* test callback */ }
          });
          return undefined;
        }
        return promise;
      },
      openOptionsPage() { window.testAPI.optionsOpened++; },
      getURL(path) { return 'chrome-extension://ytcc-search-test/' + String(path || ''); },
      lastError: undefined
    }
  };

  const api = {
    messages,
    sourceCalls,
    titleTranslation,
    get settings() { return clone(settings); },
    optionsOpened: 0,
    item,
    async setSettings(patch) {
      const oldValue = clone(settings);
      Object.assign(settings, patch || {});
      notifyStorage(oldValue, settings);
    },
    scenario(query, value) {
      scenarios.set(query, value);
      return value;
    },
    resetScenarios() { scenarios.clear(); },
    setQueryTranslation(text, value) { queryTranslations.set(text, value); },
    resetQueryTranslations() { queryTranslations.clear(); },
    failTitle(text) { titleFailures.add(text); },
    resetTitleFailures() { titleFailures.clear(); },
    setTitleTranslation(value) { Object.assign(titleTranslation, value || {}); },
    resetTitleTranslation() {
      titleTranslation.delay = 12;
      titleTranslation.error = null;
      titleTranslation.calls = 0;
      titleTranslation.active = 0;
      titleTranslation.maxActive = 0;
      titleFailures.clear();
    },
    clearMessages() { messages.length = 0; },
    resetSourceCalls() {
      sourceCalls.search.length = 0;
      sourceCalls.next.length = 0;
      sourceCalls.constructed.length = 0;
    },
    wait,
    clone
  };
  window.testAPI = api;
})();
