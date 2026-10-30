/* Homepage video title translation. Reuses the keyless B站 Index-Translate bridge.
 * Each visible English title gets one Chinese line below it. Runs only on the
 * YouTube home/feed pages; the results page is handled by search.js. */
(function (root) {
  'use strict';

  const MAX_TEXT = 500;
  const MAX_RETRIES = 2;
  const CONCURRENCY = 2;
  const SELECTOR = [
    'ytd-rich-item-renderer a#video-title-link',
    'ytd-rich-item-renderer #video-title',
    'ytd-rich-grid-media #video-title-link',
    'ytd-rich-grid-media #video-title',
    'ytd-rich-grid-slim-media #video-title',
    'ytd-rich-item-renderer .yt-lockup-metadata-view-model__title',
    'yt-lockup-view-model .yt-lockup-metadata-view-model__title',
    'ytd-rich-item-renderer h3 a[href*="/watch"]',
    'ytd-video-renderer #video-title'
  ].join(',');

  function normalize(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }

  function pickTitleText(element) {
    if (element == null) return '';
    const source = typeof element === 'string' ? element : element.textContent;
    return normalize(source).slice(0, MAX_TEXT);
  }

  function shouldTranslateTitle(text) {
    const value = normalize(text);
    if (!value || value.length > MAX_TEXT) return false;
    // A title that already contains a meaningful amount of Chinese is readable
    // to this user; translating it again would only add noise.
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return true;
    const letters = value.match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const han = (value.match(/\p{Script=Han}/gu) || []).length;
    return han / letters.length < 0.15;
  }

  function isHomePath(pathname) {
    if (pathname === '/' || pathname === '') return true;
    return pathname === '/feed/subscriptions' || pathname === '/feed/trending' || pathname === '/feed/explore';
  }

  const api = { pickTitleText, shouldTranslateTitle, isHomePath };
  root.YTCHomeTitles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage) return;

  let enabled = true;
  let observer = null;
  let mutation = null;
  let rescanTimer = 0;
  let active = 0;
  let epoch = 0;
  const queue = [];
  const tracked = new WeakSet();

  function settingsEnabled(value) {
    if (value && typeof value === 'object' && typeof value.dualSearch === 'boolean') return value.dualSearch;
    try {
      const ytc = root.YTC;
      if (ytc && typeof ytc.settings === 'function') return ytc.settings(value).dualSearch !== false;
    } catch { /* default on */ }
    return true;
  }

  function send(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const finish = (fn, value) => { if (settled) return; settled = true; if (timer) { clearTimeout(timer); timer = 0; } fn(value); };
      try {
        chrome.runtime.sendMessage(message, response => {
          let lastError;
          try { lastError = chrome.runtime.lastError; } catch { lastError = null; }
          if (lastError && lastError.message) { finish(reject, new Error(lastError.message)); return; }
          finish(resolve, response);
        });
      } catch (error) { finish(reject, error); return; }
      if (timeoutMs > 0) timer = setTimeout(() => finish(reject, new Error('TIMEOUT')), timeoutMs);
    });
  }

  function ensureObserver() {
    if (observer || typeof IntersectionObserver !== 'function') return;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        if (observer) observer.unobserve(el);
        enqueue(el);
      }
    }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
  }

  function translationFor(element) {
    const sibling = element.nextElementSibling;
    return sibling && sibling.classList && sibling.classList.contains('ytcc-title-translation') ? sibling : null;
  }

  function resetElement(element) {
    element.removeAttribute('data-ytcc-title-state');
    element.removeAttribute('data-ytcc-title-tries');
  }

  function collect() {
    if (!enabled || !isHomePath(location.pathname)) return;
    ensureObserver();
    const nodes = document.querySelectorAll(SELECTOR);
    for (const element of nodes) {
      if (tracked.has(element)) continue;
      tracked.add(element);
      // Prefer the outermost title element: a link and its inner text node can
      // both match, but only one Chinese line should be added per title.
      const outer = element.parentElement && element.parentElement.closest(SELECTOR);
      if (outer && outer !== element) continue;
      const item = element.closest('ytd-rich-item-renderer, yt-lockup-view-model, ytd-rich-grid-media');
      if (item && item.querySelector('.ytcc-title-translation')) continue;
      if (translationFor(element)) continue;
      const text = pickTitleText(element);
      if (!shouldTranslateTitle(text)) { element.setAttribute('data-ytcc-title-state', 'skip'); continue; }
      element.setAttribute('data-ytcc-title-state', 'idle');
      element.setAttribute('data-ytcc-title-tries', '0');
      if (observer) observer.observe(element);
      else enqueue(element);
    }
  }

  function enqueue(element) {
    if (!enabled || !element.isConnected) return;
    if (element.getAttribute('data-ytcc-title-state') !== 'idle') return;
    element.setAttribute('data-ytcc-title-state', 'queued');
    queue.push(element);
    pump();
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const element = queue.shift();
      if (!element.isConnected || element.getAttribute('data-ytcc-title-state') !== 'queued') continue;
      translateElement(element).finally(pump);
    }
  }

  async function translateElement(element) {
    if (!element.isConnected) return;
    const text = pickTitleText(element);
    if (!shouldTranslateTitle(text)) { element.setAttribute('data-ytcc-title-state', 'skip'); return; }
    active++;
    const myEpoch = epoch;
    element.setAttribute('data-ytcc-title-state', 'active');
    try {
      const response = await send({ type: 'TITLE_TRANSLATE', text }, 45000);
      if (myEpoch !== epoch || !element.isConnected) return;
      if (response && response.ok === true && typeof response.text === 'string' && response.text.trim()) {
        applyTranslation(element, response.text.trim());
        element.setAttribute('data-ytcc-title-state', 'done');
        return;
      }
      failElement(element);
    } catch {
      if (myEpoch === epoch && element.isConnected) failElement(element);
    } finally {
      active--;
    }
  }

  function failElement(element) {
    const tries = Number(element.getAttribute('data-ytcc-title-tries') || '0') + 1;
    element.setAttribute('data-ytcc-title-tries', String(tries));
    element.setAttribute('data-ytcc-title-state', tries > MAX_RETRIES ? 'failed' : 'idle');
    if (tries > MAX_RETRIES && observer) { try { observer.observe(element); } catch { /* ignore */ } }
  }

  function applyTranslation(element, text) {
    if (translationFor(element)) return;
    const node = document.createElement('div');
    node.className = 'ytcc-title-translation';
    node.lang = 'zh-CN';
    node.textContent = text;
    if (element.insertAdjacentElement) element.insertAdjacentElement('afterend', node);
    else if (element.parentNode) element.parentNode.insertBefore(node, element.nextSibling);
  }

  function clearAll() {
    epoch++;
    queue.length = 0;
    for (const node of document.querySelectorAll('.ytcc-title-translation')) node.remove();
    for (const element of document.querySelectorAll('[data-ytcc-title-state]')) resetElement(element);
    if (observer) { try { observer.disconnect(); } catch { /* ignore */ } observer = null; }
  }

  function setEnabled(value) {
    const next = settingsEnabled(value);
    if (next === enabled) return;
    enabled = next;
    if (!enabled) clearAll();
    else collect();
  }

  function schedule() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => { rescanTimer = 0; collect(); }, 150);
  }

  function boot() {
    chrome.storage.local.get('settings').then(value => {
      enabled = settingsEnabled(value && value.settings);
      if (enabled) collect();
    }).catch(() => { collect(); });
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes && changes.settings) setEnabled((changes.settings.newValue));
      });
    } catch { /* older Chrome */ }
    if (typeof MutationObserver === 'function') {
      mutation = new MutationObserver(schedule);
      mutation.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener('yt-navigate-finish', () => { clearAll(); enabled = settingsEnabled(); if (enabled) collect(); }, true);
    document.addEventListener('yt-page-data-updated', schedule, true);
    window.addEventListener('popstate', schedule);
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
