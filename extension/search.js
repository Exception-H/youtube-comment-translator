/* Bilingual YouTube search results. Runs beside content.js and shares no state with it. */
(() => {
  'use strict';

  const PREFIX = 'ytcc-search';
  const ZH = 'zh';
  const EN = 'en';
  const CHINESE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const SAFE_ID = /^[A-Za-z0-9_-]{3,64}$/;
  const NARROW_WIDTH = 1100;
  const NARROW_HOST_WIDTH = 1024;
  const TRANSLATE_TIMEOUT_MS = 45000;
  const MIN_HOST_HEIGHT = 320;
  const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
  const THUMB_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com']);
  const HEADER_TAGS = new Set([
    'YTD-SEARCH-HEADER-RENDERER',
    'YTD-SEARCH-SUB-MENU-RENDERER',
    'YTD-CHIP-CLOUD-RENDERER',
    'YTD-FEED-FILTER-CHIP-BAR-RENDERER'
  ]);
  const RESULT_TAGS = new Set([
    'YTD-SECTION-LIST-RENDERER',
    'YTD-TWO-COLUMN-SEARCH-RESULTS-RENDERER',
    'YTD-SECONDARY-SEARCH-RESULTS-RENDERER',
    'YTD-SEARCH-RESULTS-RENDERER'
  ]);
  const RESULT_SELECTOR = 'ytd-section-list-renderer, ytd-two-column-search-results-renderer, ytd-secondary-search-results-renderer, ytd-search-results-renderer';
  const ERROR_TEXT = {
    SEARCH_SOURCE_MISSING: '搜索数据模块未加载，无法显示结果。',
    SEARCH_SOURCE_PROTOCOL: '搜索结果格式异常，已停止显示，未生成任何伪造结果。',
    SEARCH_FAILED: '搜索请求失败，请重试。',
    NETWORK: '网络请求失败，请重试。',
    TRANSLATE_FAILED: '英文关键词翻译失败，中文结果不受影响。',
    TRANSLATE_TIMEOUT: '翻译请求超时，请重试。',
    TRANSLATE_EMPTY: '翻译结果为空，请重试。',
    TOO_LONG: '搜索词或标题过长，无法翻译。',
    DISABLED: '中英双搜已关闭。',
    CONTEXT: '扩展已重新加载，请刷新页面后再试。'
  };

  const state = {
    booted: false,
    dualSearch: true,
    contextGone: false,
    view: null,
    toggle: null,
    observer: null,
    scheduled: false,
    epoch: 0
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, action) {
    const node = document.createElement('button');
    node.type = 'button';
    if (className) node.className = className;
    node.textContent = label;
    node.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      action(event);
    });
    return node;
  }

  function normalizeSp(value) {
    let text = String(value || '').trim();
    // YouTube sometimes emits a percent-encoded or padded base64url token.
    // SearchSource only accepts the bare token, so decode and drop padding.
    for (let index = 0; index < 2 && /%[0-9a-f]{2}/i.test(text); index++) {
      try { text = decodeURIComponent(text); } catch { break; }
    }
    text = text.replace(/=+$/, '');
    return /^[A-Za-z0-9_-]+$/.test(text) ? text : '';
  }

  function parseContext() {
    let url;
    try { url = new URL(location.href); } catch { return null; }
    if (url.pathname !== '/results') return null;
    const query = (url.searchParams.get('search_query') || '').trim();
    if (!query || !CHINESE.test(query)) return null;
    const sp = normalizeSp(url.searchParams.get('sp') || '');
    return { query, sp, key: url.pathname + '\n' + query + '\n' + sp };
  }

  function readDualSearch(value) {
    if (value && typeof value === 'object' && typeof value.dualSearch === 'boolean') return value.dualSearch;
    try {
      if (typeof YTC !== 'undefined' && YTC && typeof YTC.settings === 'function') {
        const prefs = YTC.settings(value);
        if (prefs && typeof prefs.dualSearch === 'boolean') return prefs.dualSearch;
      }
    } catch { /* the raw value still has a usable default */ }
    return true;
  }

  function newSession() {
    const bytes = new Uint8Array(12);
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    } catch {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return (PREFIX.replace(/[^a-z0-9_-]/g, '') + '-' + hex).slice(0, 80);
  }

  let seqCounter = 0;
  function nextSeq() {
    let previous = 0;
    try { previous = Number(sessionStorage.getItem('ytcc-search-seq')) || 0; } catch { /* storage unavailable */ }
    seqCounter = Math.max(previous + 1, Date.now(), seqCounter + 1);
    try { sessionStorage.setItem('ytcc-search-seq', String(seqCounter)); } catch { /* storage unavailable */ }
    return seqCounter;
  }

  function isContextError(message) {
    // A missing response port is not the same as an invalidated extension:
    // START/END are intentionally fire-and-forget and may have no responder.
    return /context invalidated|extension context/i.test(String(message || ''));
  }

  function handleRuntimeError(message) {
    if (isContextError(message)) state.contextGone = true;
  }

  function sendRuntime(message, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = 0; }
        fn(value);
      };
      try {
        const maybe = chrome.runtime.sendMessage(message, response => {
          let lastError;
          try { lastError = chrome.runtime.lastError; } catch { lastError = null; }
          if (lastError && lastError.message) {
            handleRuntimeError(lastError.message);
            finish(reject, new Error(lastError.message));
            return;
          }
          finish(resolve, response);
        });
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(value => finish(resolve, value), error => {
            handleRuntimeError(error && error.message);
            finish(reject, error instanceof Error ? error : new Error(String(error)));
          });
        }
      } catch (error) {
        handleRuntimeError(error && error.message);
        finish(reject, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!settled && timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error('TRANSLATE_TIMEOUT');
          error.code = 'TRANSLATE_TIMEOUT';
          finish(reject, error);
        }, timeoutMs);
      }
    });
  }

  async function translate(purpose, text, query, session, seq) {
    const response = await sendRuntime({
      type: 'SEARCH_TRANSLATE',
      purpose,
      text,
      query,
      session,
      seq
    }, TRANSLATE_TIMEOUT_MS);
    if (!response || response.ok !== true) {
      const code = String((response && (response.error || response.code)) || 'TRANSLATE_FAILED');
      const error = new Error(code);
      error.code = code;
      throw error;
    }
    const output = typeof response.text === 'string' ? response.text.trim() : '';
    if (!output) {
      const error = new Error('TRANSLATE_EMPTY');
      error.code = 'TRANSLATE_EMPTY';
      throw error;
    }
    return output;
  }

  function isPermissionError(error) {
    const code = String((error && (error.code || error.message)) || '');
    return /PERMISSION|AUTH|UNAUTHORIZED|FORBIDDEN|403|BILIBILI/i.test(code);
  }

  function isAbort(error) {
    return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR' || /aborted|abort/i.test(String(error.message || '')));
  }

  function errorText(error) {
    const code = String((error && (error.code || error.message)) || '');
    if (isPermissionError(error)) return '英文关键词翻译需要授权，请打开设置完成授权。';
    if (ERROR_TEXT[code]) return ERROR_TEXT[code];
    if (/SEARCH_FAIL/.test(code)) return ERROR_TEXT.SEARCH_FAILED;
    if (/SEARCH_SOURCE_MISSING/.test(code)) return ERROR_TEXT.SEARCH_SOURCE_MISSING;
    if (/SEARCH_SOURCE_PROTOCOL|protocol/i.test(code)) return ERROR_TEXT.SEARCH_SOURCE_PROTOCOL;
    if (/timeout/i.test(code)) return ERROR_TEXT.TRANSLATE_TIMEOUT;
    if (isContextError(code)) return ERROR_TEXT.CONTEXT;
    try {
      if (typeof YTC !== 'undefined' && YTC && YTC.errors && typeof YTC.errors[code] === 'string') return YTC.errors[code];
    } catch { /* fall through to the generic message */ }
    return '请求失败，请重试。';
  }

  function openOptionsTab() {
    try {
      const url = chrome.runtime.getURL('options.html');
      window.open(url, '_blank', 'noopener');
    } catch { /* extension context is gone */ }
  }

  function openOptionsFallback() {
    try {
      if (chrome.runtime.openOptionsPage) {
        const maybe = chrome.runtime.openOptionsPage();
        if (maybe && typeof maybe.catch === 'function') maybe.catch(openOptionsTab);
        return;
      }
    } catch { /* fall through to a tab */ }
    openOptionsTab();
  }

  function openOptions() {
    // The worker owns the dual-search section; fall back to a plain options tab
    // when the bridge is unavailable (older worker or a discarded message port).
    void sendRuntime({ type: 'OPEN_DUAL_SETTINGS' }, 5000).then(response => {
      if (!response || response.ok !== true) openOptionsFallback();
    }).catch(() => openOptionsFallback());
  }

  /* ------------------------------------------------------------------ toggle */

  function buildToggle() {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = PREFIX + '-toggle';
    toggle.className = PREFIX + '-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', '中英双搜');
    const track = element('span', PREFIX + '-switch');
    track.setAttribute('aria-hidden', 'true');
    track.append(element('span', PREFIX + '-switch-thumb'));
    toggle.append(track, element('span', PREFIX + '-toggle-label', '中英双搜'));
    toggle.addEventListener('click', () => {
      const next = !state.dualSearch;
      state.dualSearch = next;
      updateToggle();
      void persistDualSearch(next);
      if (!next) teardownView('off');
      else schedule();
    });
    state.toggle = toggle;
    return toggle;
  }

  function ensureToggle() {
    if (!state.toggle) buildToggle();
    return state.toggle;
  }

  function attachToggle() {
    const toggle = ensureToggle();
    const end = document.querySelector('ytd-masthead #end');
    if (end) {
      if (toggle.parentElement !== end) end.insertBefore(toggle, end.firstChild);
      toggle.classList.remove(PREFIX + '-toggle-fixed');
    } else if (toggle.parentElement !== document.body) {
      document.body.appendChild(toggle);
      toggle.classList.add(PREFIX + '-toggle-fixed');
    }
  }

  function updateToggle() {
    if (!state.toggle) return;
    state.toggle.setAttribute('aria-checked', String(state.dualSearch));
    state.toggle.classList.toggle(PREFIX + '-toggle-on', state.dualSearch);
    state.toggle.title = state.dualSearch
      ? '关闭中英双搜，恢复原生搜索结果'
      : '开启中英双搜，左右对照中文与英文结果';
  }

  function removeToggle() {
    if (state.toggle) {
      state.toggle.remove();
      state.toggle = null;
    }
  }

  async function persistDualSearch(value) {
    try {
      const saved = await chrome.storage.local.get('settings');
      const current = saved && saved.settings && typeof saved.settings === 'object' ? saved.settings : {};
      await chrome.storage.local.set({ settings: Object.assign({}, current, { dualSearch: value }) });
    } catch (error) {
      if (isContextError(error && error.message)) state.contextGone = true;
    }
  }

  /* -------------------------------------------------------------------- view */

  function isLive(view) {
    return !!view && state.view === view && !view.closed && !!view.host && view.host.isConnected;
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    setTimeout(() => {
      state.scheduled = false;
      reconcile();
    }, 80);
  }

  function reconcile() {
    if (!state.booted) return;
    const context = parseContext();
    if (!context) {
      teardownView('inactive');
      removeToggle();
      return;
    }
    attachToggle();
    updateToggle();
    if (!state.dualSearch) {
      teardownView('off');
      return;
    }
    const ytdSearch = document.querySelector('ytd-search');
    if (!ytdSearch) {
      if (state.view) teardownView('no-search');
      return;
    }
    if (!state.view || state.view.key !== context.key) {
      teardownView('query');
      createView(context, ytdSearch);
      return;
    }
    if (!state.view.host.isConnected) ytdSearch.appendChild(state.view.host);
    hideNative(state.view, ytdSearch);
    layout(state.view);
  }

  function createView(context, ytdSearch) {
    const view = {
      key: context.key,
      query: context.query,
      sp: context.sp,
      session: newSession(),
      seq: nextSeq(),
      epoch: ++state.epoch,
      controller: new AbortController(),
      host: null,
      tabs: null,
      panes: {},
      activePane: ZH,
      narrow: null,
      hidden: new Map(),
      observers: [],
      closed: false,
      source: null,
      sourceError: null
    };
    buildHost(view);
    state.view = view;
    ytdSearch.appendChild(view.host);
    hideNative(view, ytdSearch);
    layout(view);
    void beginView(view);
    return view;
  }

  async function beginView(view) {
    if (!isLive(view)) return;
    try {
      const started = await sendRuntime({ type: 'SEARCH_START', session: view.session, seq: view.seq, query: view.query }, 8000);
      if (started && started.ok === false) {
        if (isLive(view) && started.error === 'DISABLED') {
          setPaneState(view.panes[ZH], 'error', errorText({ code: 'DISABLED' }));
          setPaneState(view.panes[EN], 'error', errorText({ code: 'DISABLED' }));
        }
        return;
      }
    } catch (error) {
      handleRuntimeError(error && error.message);
    }
    if (!isLive(view)) return;
    view.source = createSource(view);
    if (!view.source) {
      failPane(view, view.panes[ZH], view.sourceError || sourceError('SEARCH_SOURCE_MISSING'), { retry: true });
      failPane(view, view.panes[EN], view.sourceError || sourceError('SEARCH_SOURCE_MISSING'), { retry: true });
      return;
    }
    void startPaneSearch(view, view.panes[ZH], view.query);
    void translateQuery(view);
  }

  function createSource(view) {
    try {
      if (typeof YTCSearchSource === 'undefined' || !YTCSearchSource || typeof YTCSearchSource.SearchSource !== 'function') {
        throw sourceError('SEARCH_SOURCE_MISSING');
      }
      return new YTCSearchSource.SearchSource({
        document,
        fetch: (...args) => window.fetch(...args),
        origin: location.origin
      });
    } catch (error) {
      view.sourceError = error && error.code ? error : sourceError('SEARCH_SOURCE_MISSING', error);
      return null;
    }
  }

  function sourceError(code, cause) {
    const error = new Error(code);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function buildHost(view) {
    const host = element('div', PREFIX + '-host');
    host.id = PREFIX + '-host';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', '中英双搜结果');
    host.dataset.ytccSearchQuery = view.query;
    host.dataset.ytccSearchSp = view.sp;

    const tabs = element('div', PREFIX + '-tabs');
    tabs.id = PREFIX + '-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '中英双搜视图');
    const tabZh = button('中文结果', PREFIX + '-tab', () => setActivePane(view, ZH));
    tabZh.id = PREFIX + '-tab-zh';
    tabZh.setAttribute('role', 'tab');
    tabZh.setAttribute('aria-controls', PREFIX + '-pane-zh');
    const tabEn = button('英文结果', PREFIX + '-tab', () => setActivePane(view, EN));
    tabEn.id = PREFIX + '-tab-en';
    tabEn.setAttribute('role', 'tab');
    tabEn.setAttribute('aria-controls', PREFIX + '-pane-en');
    tabs.append(tabZh, tabEn);

    const columns = element('div', PREFIX + '-columns');
    columns.id = PREFIX + '-columns';
    const zh = createPane(view, ZH);
    const en = createPane(view, EN);
    view.panes[ZH] = zh;
    view.panes[EN] = en;
    columns.append(zh.el, en.el);

    host.append(tabs, columns);
    view.host = host;
    view.tabs = { root: tabs, zh: tabZh, en: tabEn };
    setActivePane(view, ZH, true);
    updateTabCounts(view);
  }

  function createPane(view, key) {
    const isEnglish = key === EN;
    const pane = {
      key,
      el: null,
      scrollBody: null,
      list: null,
      stateEl: null,
      more: null,
      sentinel: null,
      queryEl: null,
      countEl: null,
      items: [],
      ids: new Set(),
      cards: new Map(),
      continuation: '',
      usedTokens: new Set(),
      loading: false,
      done: false,
      fatal: false,
      error: null,
      initialized: false,
      query: key === ZH ? view.query : '',
      queryState: 'idle',
      generation: 0,
      titleQueue: [],
      titleActive: false,
      titleObserver: null,
      savedScroll: 0
    };

    const el = element('section', PREFIX + '-pane' + (key === ZH ? ' ' + PREFIX + '-active' : ''));
    el.id = PREFIX + '-pane-' + key;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', isEnglish ? '英文关键词搜到的' : '中文关键词搜到的');

    const head = element('div', PREFIX + '-pane-head');
    const titleRow = element('div', PREFIX + '-pane-title-row');
    const titleWrap = element('div', PREFIX + '-pane-title-wrap');
    const title = document.createElement('h2');
    title.className = PREFIX + '-pane-title';
    title.id = PREFIX + '-title-' + key;
    title.textContent = isEnglish ? '英文关键词搜到的' : '中文关键词搜到的';
    titleWrap.append(title);
    if (isEnglish) {
      const badge = element('span', PREFIX + '-badge ' + PREFIX + '-badge-translate', '文A');
      badge.setAttribute('aria-hidden', 'true');
      titleWrap.append(badge);
    }
    const hint = element('div', PREFIX + '-hint');
    hint.append(element('span', PREFIX + '-hint-text', '独立滚动'));
    const info = element('span', PREFIX + '-hint-info', 'ⓘ');
    info.setAttribute('aria-hidden', 'true');
    info.title = '两栏各自滚动，互不影响';
    hint.append(info);
    titleRow.append(titleWrap, hint);

    const query = element('div', PREFIX + '-pane-query', isEnglish ? '正在翻译搜索词…' : view.query);
    query.id = PREFIX + '-query-' + key;
    query.lang = 'zh-CN';
    head.append(titleRow, query);

    const scrollBody = element('div', PREFIX + '-scroll');
    scrollBody.id = PREFIX + '-scroll-' + key;
    scrollBody.tabIndex = 0;
    const list = element('div', PREFIX + '-list');
    list.id = PREFIX + '-list-' + key;
    const stateEl = element('div', PREFIX + '-state');
    stateEl.id = PREFIX + '-state-' + key;
    stateEl.hidden = true;
    stateEl.setAttribute('aria-live', 'polite');
    const more = button('加载更多', PREFIX + '-more', () => void loadMore(pane));
    more.id = PREFIX + '-more-' + key;
    more.hidden = true;
    more.setAttribute('aria-controls', PREFIX + '-list-' + key);
    const sentinel = element('div', PREFIX + '-sentinel');
    sentinel.id = PREFIX + '-sentinel-' + key;
    sentinel.hidden = true;
    sentinel.setAttribute('aria-hidden', 'true');
    scrollBody.append(stateEl, list, more, sentinel);
    el.append(head, scrollBody);

    pane.el = el;
    pane.scrollBody = scrollBody;
    pane.list = list;
    pane.stateEl = stateEl;
    pane.more = more;
    pane.sentinel = sentinel;
    pane.queryEl = query;

    let titleTick = 0;
    scrollBody.addEventListener('scroll', () => {
      // Hiding the inactive narrow pane can fire a final scroll event with 0;
      // never let that erase the position we are keeping for the next tab.
      if (view.narrow && view.activePane !== key) return;
      pane.savedScroll = scrollBody.scrollTop;
      if (titleTick) return;
      titleTick = setTimeout(() => {
        titleTick = 0;
        const current = state.view;
        if (current && isLive(current)) queueVisibleTitles(current, pane);
      }, 80);
    }, { passive: true });
    setupPaneObserver(view, pane);

    return pane;
  }

  function setupPaneObserver(view, pane) {
    if (typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(entries => {
      const current = state.view;
      if (!current || current !== view || !isLive(current)) return;
      if (!entries.some(entry => entry.isIntersecting)) return;
      if (pane.scrollBody.scrollTop <= 0) return;
      if (pane.loading || !pane.continuation || pane.done || pane.fatal || pane.error) return;
      void loadMore(pane);
    }, { root: pane.scrollBody, rootMargin: '240px 0px' });
    observer.observe(pane.sentinel);
    view.observers.push(observer);
  }

  function hideNative(view, ytdSearch) {
    if (!ytdSearch) return;
    const children = Array.from(ytdSearch.children).filter(node => node !== view.host);
    const results = children.filter(node => RESULT_TAGS.has(node.tagName) || (typeof node.querySelector === 'function' && node.querySelector(RESULT_SELECTOR)));
    const targets = results.length ? results : children.filter(node => !HEADER_TAGS.has(node.tagName));
    for (const node of targets) {
      if (view.hidden.has(node)) continue;
      view.hidden.set(node, node.getAttribute('style'));
      node.style.setProperty('display', 'none', 'important');
    }
  }

  function restoreNative(view) {
    for (const [node, style] of view.hidden) {
      try {
        if (style === null) node.removeAttribute('style');
        else node.setAttribute('style', style);
      } catch { /* node may belong to a discarded document fragment */ }
    }
    view.hidden.clear();
  }

  function teardownView() {
    const view = state.view;
    if (!view) return;
    state.view = null;
    view.closed = true;
    try { view.controller.abort(); } catch { /* already aborted */ }
    for (const observer of view.observers) {
      try { observer.disconnect(); } catch { /* disconnected */ }
    }
    view.observers.length = 0;
    for (const key of [ZH, EN]) {
      const pane = view.panes[key];
      if (!pane) continue;
      pane.titleQueue.length = 0;
      pane.titleActive = false;
      if (pane.titleObserver) {
        try { pane.titleObserver.disconnect(); } catch { /* disconnected */ }
        pane.titleObserver = null;
      }
    }
    restoreNative(view);
    try { view.host.remove(); } catch { /* already removed */ }
    void sendRuntime({ type: 'SEARCH_END', session: view.session, seq: view.seq }).catch(() => {});
  }

  function layout(view) {
    if (!view || view.closed || !view.host || !view.host.isConnected) return;
    const top = view.host.getBoundingClientRect().top;
    const height = Math.max(MIN_HOST_HEIGHT, window.innerHeight - Math.max(0, top) - 8);
    view.host.style.height = height + 'px';
    const narrow = window.innerWidth < NARROW_WIDTH || view.host.clientWidth < NARROW_HOST_WIDTH;
    if (view.narrow === narrow) {
      for (const paneKey of [ZH, EN]) queueVisibleTitles(view, view.panes[paneKey]);
      return;
    }
    for (const key of [ZH, EN]) {
      const pane = view.panes[key];
      if (pane && (!view.narrow || view.activePane === key)) pane.savedScroll = pane.scrollBody.scrollTop;
    }
    view.narrow = narrow;
    view.host.classList.toggle(PREFIX + '-narrow', narrow);
    if (narrow) {
      setActivePane(view, view.activePane, true);
    } else {
      for (const key of [ZH, EN]) {
        const pane = view.panes[key];
        if (pane) pane.scrollBody.scrollTop = pane.savedScroll || 0;
      }
    }
    for (const paneKey of [ZH, EN]) queueVisibleTitles(view, view.panes[paneKey]);
  }

  function setActivePane(view, key, force = false) {
    if (!force && view.activePane === key) return;
    const previous = view.panes[view.activePane];
    if (previous) previous.savedScroll = previous.scrollBody.scrollTop;
    view.activePane = key;
    for (const name of [ZH, EN]) {
      const pane = view.panes[name];
      if (pane) pane.el.classList.toggle(PREFIX + '-active', name === key);
    }
    if (view.tabs) {
      view.tabs.zh.setAttribute('aria-selected', String(key === ZH));
      view.tabs.en.setAttribute('aria-selected', String(key === EN));
    }
    const current = view.panes[key];
    if (current && view.narrow) current.scrollBody.scrollTop = current.savedScroll || 0;
    if (current) queueVisibleTitles(view, current);
  }

  /* ------------------------------------------------------------------- panes */

  function setPaneQuery(pane, text, lang) {
    if (!pane || !pane.queryEl) return;
    pane.queryEl.textContent = text;
    if (lang) pane.queryEl.lang = lang;
  }

  function setPaneState(pane, kind, message, options = {}) {
    const box = pane.stateEl;
    box.replaceChildren();
    if (!kind) {
      box.hidden = true;
      delete box.dataset.ytccSearchKind;
      return;
    }
    box.hidden = false;
    box.dataset.ytccSearchKind = kind;
    const text = element('span', PREFIX + '-state-text', message || '');
    text.dir = 'auto';
    box.append(text);
    if (options.settings) {
      box.append(button('打开设置', PREFIX + '-action', () => openOptions()));
    }
    if (options.reload) {
      box.append(button('刷新页面', PREFIX + '-action', () => location.reload()));
    }
    if (options.retry && typeof options.retryAction === 'function') {
      const retry = button(options.retryLabel || '重试', PREFIX + '-action', options.retryAction);
      retry.classList.add(PREFIX + '-retry');
      box.append(retry);
    }
  }

  function updateMore(pane) {
    const available = !!pane.continuation && !pane.done && !pane.fatal && !pane.error;
    pane.more.hidden = !available;
    pane.more.disabled = pane.loading;
    pane.more.textContent = pane.loading ? '正在加载…' : '加载更多';
    pane.more.setAttribute('aria-busy', String(pane.loading));
    pane.sentinel.hidden = !available;
  }

  function updateTabCounts(view) {
    if (!view.tabs) return;
    const zhCount = view.panes[ZH] ? view.panes[ZH].items.length : 0;
    const enCount = view.panes[EN] ? view.panes[EN].items.length : 0;
    if (!view.tabs.zh.querySelector('.' + PREFIX + '-tab-count')) view.tabs.zh.append(element('span', PREFIX + '-tab-count'));
    if (!view.tabs.en.querySelector('.' + PREFIX + '-tab-count')) view.tabs.en.append(element('span', PREFIX + '-tab-count'));
    view.tabs.zh.querySelector('.' + PREFIX + '-tab-count').textContent = String(zhCount);
    view.tabs.en.querySelector('.' + PREFIX + '-tab-count').textContent = String(enCount);
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!SAFE_ID.test(id)) return null;
    const title = cleanText(raw.title, 500);
    if (!title) return null;
    return {
      id,
      title,
      channel: cleanText(raw.channel, 200),
      views: cleanText(raw.views, 100),
      published: cleanText(raw.published, 100),
      duration: cleanText(raw.duration, 20),
      description: cleanText(raw.description, 2000),
      thumbnail: safeThumbnail(raw.thumbnail),
      url: safeVideoUrl(raw.url, id)
    };
  }

  function cleanText(value, limit) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, limit) : '';
  }

  function safeVideoUrl(raw, id) {
    if (!SAFE_ID.test(id)) return '';
    if (typeof raw === 'string') {
      try {
        const url = new URL(raw, location.href);
        if (YT_HOSTS.has(url.hostname.toLowerCase()) && url.pathname === '/watch' && url.searchParams.get('v') === id) {
          return '/watch?v=' + encodeURIComponent(id);
        }
      } catch { /* fall back to a constructed watch URL */ }
    }
    return '/watch?v=' + encodeURIComponent(id);
  }

  function safeThumbnail(raw) {
    if (typeof raw !== 'string') return '';
    let url;
    try { url = new URL(raw, location.href); } catch { return ''; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    const host = url.hostname.toLowerCase();
    const trusted = THUMB_HOSTS.has(host) || host.endsWith('.ytimg.com') || host.endsWith('.ggpht.com');
    if (!trusted) return '';
    return url.href;
  }

  function appendMeta(meta, text) {
    if (!text) return;
    meta.append(element('span', PREFIX + '-meta-item', text));
  }

  // A title needs translation when it has almost no Chinese characters. Chinese
  // titles (common in the left pane) are left untouched.
  function needsTitleTranslation(text) {
    if (typeof text !== 'string') return false;
    const chars = Array.from(text.trim());
    if (!chars.length) return false;
    let han = 0;
    for (const ch of chars) if (CHINESE.test(ch)) han++;
    return han / chars.length < 0.15;
  }

  function renderCard(view, pane, item) {
    const card = element('article', PREFIX + '-card');
    card.dataset.ytccSearchId = item.id;

    const thumb = document.createElement('a');
    thumb.className = PREFIX + '-thumb';
    thumb.href = item.url;
    thumb.setAttribute('aria-label', item.title);
    if (item.thumbnail) {
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.decoding = 'async';
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.src = item.thumbnail;
      image.addEventListener('error', () => {
        image.remove();
        thumb.classList.add(PREFIX + '-no-image');
      });
      thumb.append(image);
    } else {
      thumb.classList.add(PREFIX + '-no-image');
    }
    if (item.duration) {
      thumb.append(element('span', PREFIX + '-duration', item.duration));
    }

    const content = element('div', PREFIX + '-content');
    const titleWrap = element('div', PREFIX + '-title-wrap');
    const title = document.createElement('a');
    title.className = PREFIX + '-title';
    title.href = item.url;
    title.textContent = item.title;
    const translateTitle = needsTitleTranslation(item.title);
    title.lang = translateTitle ? 'en' : 'zh-CN';
    titleWrap.append(title);

    const badge = element('span', PREFIX + '-badge ' + PREFIX + '-badge-translated', '中文译名');
    badge.hidden = true;
    const toggle = button('查看英文原标题', PREFIX + '-title-toggle', () => {
      const show = original.hidden;
      original.hidden = !show;
      toggle.textContent = show ? '收起英文原标题' : '查看英文原标题';
      toggle.setAttribute('aria-expanded', String(show));
    });
    toggle.hidden = true;
    const original = element('div', PREFIX + '-original-title');
    original.hidden = true;
    original.lang = 'en';
    original.textContent = item.title;
    const retry = button('重试译名', PREFIX + '-title-retry', () => {
      const current = state.view;
      if (!current || !isLive(current) || rec.generation !== pane.generation) return;
      rec.titleState = 'idle';
      rec.retry.hidden = true;
      enqueueTitle(current, pane, rec, true);
    });
    retry.hidden = true;
    if (translateTitle) titleWrap.append(badge, toggle, retry, original);

    const meta = element('div', PREFIX + '-meta');
    appendMeta(meta, item.channel);
    appendMeta(meta, item.views);
    appendMeta(meta, item.published);
    const cross = element('span', PREFIX + '-badge ' + PREFIX + '-badge-cross', '两路均命中');
    cross.hidden = true;
    meta.append(cross);

    const description = element('div', PREFIX + '-description', item.description);
    if (!item.description) description.hidden = true;

    content.append(titleWrap, meta, description);
    card.append(thumb, content);

    const rec = {
      item,
      card,
      title,
      badge,
      cross,
      toggle,
      original,
      retry,
      titleState: translateTitle ? 'idle' : 'done',
      generation: pane.generation
    };
    return rec;
  }

  function markCrossMatches(view) {
    const zh = view.panes[ZH];
    const en = view.panes[EN];
    if (!zh || !en) return;
    for (const [id, rec] of zh.cards) rec.cross.hidden = !en.ids.has(id);
    for (const [id, rec] of en.cards) rec.cross.hidden = !zh.ids.has(id);
  }

  function applyPage(view, pane, result, options = {}) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.items)) {
      throw sourceError('SEARCH_SOURCE_PROTOCOL');
    }
    const token = typeof options.token === 'string' ? options.token : '';
    const next = typeof result.continuation === 'string' ? result.continuation.trim() : '';
    let duplicate = false;
    if (next) {
      if ((token && next === token) || pane.usedTokens.has(next)) duplicate = true;
    }

    for (const raw of result.items) {
      const item = normalizeItem(raw);
      if (!item || pane.ids.has(item.id)) continue;
      pane.ids.add(item.id);
      pane.items.push(item);
      const rec = renderCard(view, pane, item);
      pane.cards.set(item.id, rec);
      pane.list.append(rec.card);
      if (rec.titleState === 'idle') observeTitleCard(view, pane, rec);
    }

    pane.continuation = next;
    pane.loading = false;
    pane.initialized = true;
    pane.error = null;
    pane.done = !next;
    pane.fatal = duplicate;
    if (duplicate) pane.done = true;

    if (!pane.items.length && pane.done) {
      setPaneState(pane, 'empty', '没有找到结果。');
    } else if (duplicate) {
      setPaneState(pane, 'error', '分页标记重复，已停止加载。');
    } else {
      setPaneState(pane, null);
    }
    updateMore(pane);
    updateTabCounts(view);
    markCrossMatches(view);
    if (options.first) pane.scrollBody.scrollTop = 0;
    if (pane.titleQueue.length === 0) queueVisibleTitles(view, pane);
    return { duplicate };
  }

  async function startPaneSearch(view, pane, query) {
    if (!isLive(view)) return;
    pane.generation++;
    pane.query = query;
    pane.loading = true;
    pane.error = null;
    pane.fatal = false;
    pane.done = false;
    pane.initialized = false;
    pane.continuation = '';
    pane.usedTokens.clear();
    pane.items = [];
    pane.ids.clear();
    pane.cards.clear();
    pane.titleQueue.length = 0;
    if (pane.titleObserver) {
      try { pane.titleObserver.disconnect(); } catch { /* disconnected */ }
      const index = view.observers.indexOf(pane.titleObserver);
      if (index >= 0) view.observers.splice(index, 1);
      pane.titleObserver = null;
    }
    pane.list.replaceChildren();
    pane.savedScroll = 0;
    pane.scrollBody.scrollTop = 0;
    setPaneState(pane, 'loading', '正在加载…');
    updateMore(pane);
    updateTabCounts(view);
    try {
      const result = await view.source.search(query, {
        // SearchSource takes the raw YouTube `sp` filter token as a string.
        params: view.sp,
        signal: view.controller.signal
      });
      if (!isLive(view)) return;
      applyPage(view, pane, result, { first: true });
    } catch (error) {
      if (isAbort(error) || !isLive(view)) return;
      pane.loading = false;
      failPane(view, pane, error, { retry: true });
    }
  }

  async function loadMore(pane) {
    const view = state.view;
    if (!view || !isLive(view) || pane.loading || pane.done || pane.fatal) return;
    const token = pane.continuation;
    if (!token) {
      pane.done = true;
      updateMore(pane);
      return;
    }
    if (pane.usedTokens.has(token)) {
      fatalPane(pane);
      return;
    }
    pane.usedTokens.add(token);
    pane.loading = true;
    pane.error = null;
    setPaneState(pane, 'loading', '正在加载更多…');
    updateMore(pane);
    try {
      const result = await view.source.next(token, { signal: view.controller.signal });
      if (!isLive(view)) return;
      const info = applyPage(view, pane, result, { token });
      if (info.duplicate) fatalPane(pane);
    } catch (error) {
      if (isAbort(error) || !isLive(view)) return;
      pane.usedTokens.delete(token);
      pane.loading = false;
      failPane(view, pane, error, { retry: true });
    }
  }

  function fatalPane(pane) {
    pane.loading = false;
    pane.error = sourceError('SEARCH_DUPLICATE_TOKEN');
    pane.fatal = true;
    pane.done = true;
    setPaneState(pane, 'error', '分页标记重复，已停止加载。');
    updateMore(pane);
  }

  function failPane(view, pane, error, options = {}) {
    pane.loading = false;
    pane.error = error;
    const retry = options.retry !== false;
    setPaneState(pane, 'error', errorText(error), {
      retry,
      retryAction: retry ? () => retryPane(view, pane) : null
    });
    updateMore(pane);
  }

  function retryPane(view, pane) {
    if (!isLive(view) || pane.loading) return;
    if ((pane.error?.code || pane.error?.message) === 'SEARCH_EXPIRED') {
      view.source = createSource(view);
      if (!view.source) { failPane(view, pane, view.sourceError || sourceError('SEARCH_SOURCE_MISSING')); return; }
      void startPaneSearch(view, pane, pane.query || view.query);
      return;
    }
    if (!view.source) {
      view.source = createSource(view);
      if (!view.source) {
        failPane(view, pane, view.sourceError || sourceError('SEARCH_SOURCE_MISSING'), { retry: true });
        return;
      }
    }
    if (pane.key === EN && !pane.query) {
      void translateQuery(view);
      return;
    }
    if (!pane.items.length) void startPaneSearch(view, pane, pane.query || view.query);
    else void loadMore(pane);
  }

  /* ------------------------------------------------------- English query/title */

  async function translateQuery(view) {
    const pane = view.panes[EN];
    if (!pane) return;
    pane.queryState = 'loading';
    setPaneQuery(pane, '正在翻译搜索词…', 'zh-CN');
    setPaneState(pane, 'loading', '正在翻译英文关键词…');
    updateMore(pane);
    try {
      const text = await translate('query', view.query, view.query, view.session, view.seq);
      if (!isLive(view)) return;
      pane.queryState = 'done';
      setPaneQuery(pane, text, 'en');
      setPaneState(pane, null);
      await startPaneSearch(view, pane, text);
    } catch (error) {
      if (!isLive(view)) return;
      pane.queryState = isPermissionError(error) ? 'auth' : 'error';
      setPaneQuery(pane, '英文关键词翻译未完成', 'zh-CN');
      if (isPermissionError(error)) {
        setPaneState(pane, 'auth', '英文关键词翻译需要授权，请打开设置完成授权。', {
          settings: true,
          retry: true,
          retryLabel: '重新检查',
          retryAction: () => void translateQuery(view)
        });
      } else {
        const contextGone = isContextError(error && error.message);
        setPaneState(pane, 'error', errorText(error), contextGone
          ? { reload: true }
          : { retry: true, retryAction: () => void translateQuery(view) });
      }
      updateMore(pane);
    }
  }

  function queueVisibleTitles(view, pane) {
    if (!isLive(view) || !pane) return;
    const root = pane.scrollBody.getBoundingClientRect();
    if (root.bottom <= root.top) return;
    for (const rec of pane.cards.values()) {
      if (rec.titleState !== 'idle') continue;
      const rect = rec.card.getBoundingClientRect();
      if (rect.bottom > root.top && rect.top < root.bottom) enqueueTitle(view, pane, rec);
    }
  }

  function ensureTitleObserver(view, pane) {
    if (pane.titleObserver) return;
    if (typeof IntersectionObserver !== 'function') return;
    pane.titleObserver = new IntersectionObserver(entries => {
      const current = state.view;
      if (!current || !isLive(current)) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target && entry.target.dataset ? entry.target.dataset.ytccSearchId : '';
        const rec = pane.cards.get(id);
        if (rec) enqueueTitle(current, pane, rec);
      }
    }, { root: pane.scrollBody, rootMargin: '80px 0px', threshold: 0.01 });
    view.observers.push(pane.titleObserver);
  }

  function observeTitleCard(view, pane, rec) {
    if (rec.titleState !== 'idle') return;
    ensureTitleObserver(view, pane);
    if (pane.titleObserver) pane.titleObserver.observe(rec.card);
  }

  function enqueueTitle(view, pane, rec, force = false) {
    if (!isLive(view) || !pane || state.contextGone) return;
    if (rec.generation !== pane.generation || pane.cards.get(rec.item.id) !== rec) return;
    if (!force && rec.titleState !== 'idle') return;
    rec.titleState = 'queued';
    rec.retry.hidden = true;
    if (!pane.titleQueue.includes(rec)) pane.titleQueue.push(rec);
    pumpTitle(view, pane);
  }

  function pumpTitle(view, pane) {
    if (!isLive(view) || pane.titleActive || !pane.titleQueue.length) return;
    if (state.contextGone) {
      pane.titleQueue.length = 0;
      return;
    }
    const rec = pane.titleQueue.shift();
    if (rec.titleState !== 'queued' || rec.generation !== pane.generation || pane.cards.get(rec.item.id) !== rec) {
      pumpTitle(view, pane);
      return;
    }
    pane.titleActive = true;
    rec.titleState = 'active';
    translate('title', rec.item.title, view.query, view.session, view.seq).then(text => {
      if (!isLive(view) || rec.generation !== pane.generation || pane.cards.get(rec.item.id) !== rec) return;
      if (!text || (text === rec.item.title && !CHINESE.test(text))) {
        rec.titleState = 'failed';
        rec.retry.hidden = false;
        return;
      }
      rec.titleState = 'done';
      rec.title.textContent = text;
      rec.title.lang = 'zh-CN';
      rec.badge.hidden = false;
      rec.toggle.hidden = false;
      rec.original.hidden = true;
      rec.original.textContent = rec.item.title;
      rec.toggle.textContent = '查看英文原标题';
      rec.toggle.setAttribute('aria-expanded', 'false');
      rec.retry.hidden = true;
    }).catch(error => {
      if (!isLive(view) || rec.generation !== pane.generation || pane.cards.get(rec.item.id) !== rec) return;
      if (isAbort(error)) return;
      rec.titleState = 'failed';
      rec.retry.hidden = false;
      if (isContextError(error && error.message)) state.contextGone = true;
    }).finally(() => {
      pane.titleActive = false;
      if (state.contextGone) {
        pane.titleQueue.length = 0;
        return;
      }
      if (isLive(view)) pumpTitle(view, pane);
    });
  }

  /* -------------------------------------------------------------------- boot */

  function boot() {
    if (state.booted) return;
    state.booted = true;

    document.addEventListener('yt-navigate-finish', schedule);
    document.addEventListener('yt-navigate-start', () => {
      teardownView();
      schedule();
    });
    window.addEventListener('popstate', schedule);
    window.addEventListener('resize', () => {
      if (state.view) layout(state.view);
      else schedule();
    });
    window.addEventListener('pagehide', () => teardownView());
    window.addEventListener('pageshow', event => {
      if (event && event.persisted) schedule();
    });
    if (typeof MutationObserver === 'function') {
      state.observer = new MutationObserver(schedule);
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        if (!changes || !changes.settings) return;
        const next = readDualSearch(changes.settings.newValue);
        if (next === state.dualSearch) return;
        state.dualSearch = next;
        updateToggle();
        if (!next) teardownView('storage-off');
        else schedule();
      });
    } catch { /* storage events unavailable in this context */ }

    let request;
    try { request = chrome.storage.local.get('settings'); }
    catch (error) {
      if (isContextError(error && error.message)) state.contextGone = true;
      schedule();
      return;
    }
    Promise.resolve(request).then(saved => {
      state.dualSearch = readDualSearch(saved && saved.settings);
      updateToggle();
      schedule();
    }).catch(error => {
      if (isContextError(error && error.message)) state.contextGone = true;
      schedule();
    });
  }

  boot();
})();
