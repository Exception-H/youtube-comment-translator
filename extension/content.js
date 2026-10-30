(() => {
  'use strict';
  const SELECTOR = 'ytd-comment-view-model #content-text, ytd-comment-renderer #content-text, ytm-comment-renderer #content-text, ytm-comment-renderer .comment-text';
  const records = new Map();
  const pending = new Set();
  const roots = new Set();
  // Free mode may run three 25s attempts plus throttling, so one translation can
  // legitimately take almost 100s. The watchdog only exists to free a slot when
  // the worker never answers at all.
  const REQUEST_TIMEOUT_MS = 100000;
  const activeWaits = new Set();
  let prefs = YTC.settings();
  let running = 0;
  let requestEpoch = 0;
  let scanTimer;
  let contextGone = false;
  let booted = false;

  function textOf(node) { return YTC.normalize(node.innerText || node.textContent); }
  function contextOf(node) {
    if (prefs.provider !== 'ai' || !prefs.useContext) return {};
    const title = document.querySelector('ytd-watch-metadata h1')?.textContent || document.title.replace(/\s*[-–—]\s*YouTube\s*$/, '');
    let parent = '';
    const replies = node.closest('ytd-comment-replies-renderer');
    const thread = replies?.closest('ytd-comment-thread-renderer');
    if (thread) {
      const candidate = Array.from(thread.querySelectorAll(SELECTOR)).find(item => item !== node && !item.closest('ytd-comment-replies-renderer'));
      if (candidate) parent = textOf(candidate);
    }
    return YTC.context({ title, parent });
  }
  function valid(record) {
    return prefs.enabled && record.node.isConnected && records.get(record.node) === record && textOf(record.node) === record.original;
  }
  function removeRecord(record) {
    viewport.unobserve(record.node);
    pending.delete(record);
    record.block?.remove();
    record.node.classList.remove('ytcc-hide-original');
    records.delete(record.node);
  }
  // A reset belongs to a new page/configuration: bump the epoch first so results
  // that are still in flight can neither touch the DOM nor decrement the fresh
  // running counter, then drop the local waiters and their watchdogs.
  function reset() {
    requestEpoch++;
    running = 0;
    for (const wait of activeWaits) wait.cancel();
    activeWaits.clear();
    for (const record of records.values()) removeRecord(record);
    pending.clear();
  }
  function button(label, action) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
    return el;
  }
  function render(record, status, value = '') {
    if (!valid(record)) return;
    if (!record.block) {
      record.block = document.createElement('div');
      record.block.className = 'ytcc-translation';
      record.block.lang = 'zh-CN';
      record.node.insertAdjacentElement('afterend', record.block);
    }
    const block = record.block;
    block.replaceChildren();
    block.dataset.state = status;
    const bar = document.createElement('div');
    bar.className = 'ytcc-bar';
    const label = document.createElement('span');
    label.className = 'ytcc-label';
    label.textContent = status === 'loading' ? '正在翻译…' : status === 'error' ? '翻译未完成' : record.engine === 'ai' ? 'AI 中文' : '简体中文';
    if (record.model) label.title = '实际模型：' + record.model;
    bar.append(label);
    if (status === 'done') {
      const hideOriginal = prefs.display === 'translation' && !record.showOriginal;
      record.node.classList.toggle('ytcc-hide-original', hideOriginal);
      if (prefs.display === 'translation') {
        bar.append(button(hideOriginal ? '查看原文' : '收起原文', () => {
          record.showOriginal = !record.showOriginal;
          render(record, 'done', record.translated);
        }));
      }
      const toggle = button(record.collapsed ? '展开译文' : '收起译文', () => {
        record.collapsed = !record.collapsed;
        render(record, 'done', record.translated);
      });
      toggle.setAttribute('aria-expanded', String(!record.collapsed));
      bar.append(toggle);
      if (record.engine === 'ai') {
        const regenerate = button('重新翻译', () => retry(record, true));
        regenerate.title = '重新请求 AI 模型，会消耗接口额度';
        bar.append(regenerate);
      }
      // Collapsing a translation must never hide the only visible comment.
      if (record.collapsed) record.node.classList.remove('ytcc-hide-original');
    } else {
      record.node.classList.remove('ytcc-hide-original');
      if (status === 'error' && value !== 'TOO_LONG') bar.append(button('重试', () => retry(record)));
    }
    block.append(bar);
    if (status === 'done' && !record.collapsed || status === 'error') {
      const body = document.createElement('div');
      body.className = 'ytcc-text';
      body.dir = 'auto';
      body.textContent = status === 'error' ? YTC.errorText({ error: value, diagnostic: record.diagnostic }) : value;
      block.append(body);
    }
  }

  function retry(record, force = false) {
    if (!valid(record) || contextGone || record.status === 'loading') return;
    record.force = force;
    record.status = 'queued';
    pending.add(record);
    drain();
  }
  // One in-flight translation. Every exit path (response, error, timeout, reset)
  // settles exactly once and clears its watchdog.
  function dispatch(record) {
    const epoch = requestEpoch;
    record.status = 'loading';
    render(record, 'loading');
    running++;
    const request = { type: 'TRANSLATE', text: record.original, context: contextOf(record.node), force: record.force === true };
    record.force = false;
    const wait = { epoch, timer: 0, finished: false };
    const settle = (result, failure) => {
      if (wait.finished) return;
      wait.finished = true;
      activeWaits.delete(wait);
      if (wait.timer) { clearTimeout(wait.timer); wait.timer = 0; }
      // Late results from a previous page or configuration are dropped: the new
      // epoch already owns a zeroed running counter.
      if (epoch !== requestEpoch) return;
      running--;
      if (failure) {
        if (/context invalidated|Extension context/i.test(String(failure))) contextGone = true;
        if (valid(record)) {
          record.status = 'error';
          record.diagnostic = null;
          render(record, 'error', contextGone ? 'CONTEXT' : 'NETWORK');
        }
      } else if (result?.ok) {
        if (valid(record)) {
          record.status = 'done';
          record.engine = result.engine || prefs.provider;
          record.model = result.model || '';
          record.translated = result.text;
          render(record, 'done', record.translated);
        }
      } else if (valid(record)) {
        record.status = 'error';
        record.diagnostic = YTC.safeDiagnostic(result?.diagnostic);
        render(record, 'error', result?.error || 'SERVICE');
      }
      drain();
    };
    wait.cancel = () => {
      if (wait.finished) return;
      wait.finished = true;
      if (wait.timer) { clearTimeout(wait.timer); wait.timer = 0; }
    };
    activeWaits.add(wait);
    wait.timer = setTimeout(() => settle({ ok: false, error: 'OUTPUT_TIMEOUT' }), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = chrome.runtime.sendMessage(request);
    } catch (error) {
      settle(null, error);
      return;
    }
    Promise.resolve(response).then(result => settle(result), error => settle(null, error));
  }
  function drain() {
    if (!prefs.enabled || contextGone) return;
    while (running < (prefs.freeMode ? 6 : 2) && pending.size) {
      const record = pending.values().next().value;
      pending.delete(record);
      if (!valid(record)) continue;
      dispatch(record);
    }
  }

  const viewport = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target);
      if (!record) continue;
      if (entry.isIntersecting && record.status === 'idle') {
        record.status = 'queued';
        pending.add(record);
      } else if (!entry.isIntersecting && record.status === 'queued') {
        pending.delete(record);
        record.status = 'idle';
      }
    }
    drain();
  }, { rootMargin: '250px 0px', threshold: 0 });

  function discover(node) {
    if (!prefs.enabled || !node.isConnected) return;
    const original = textOf(node);
    const old = records.get(node);
    if (old && old.original === original && (!old.block || old.block.isConnected)) return;
    if (old) removeRecord(old);
    // Empty placeholders can later receive text; mutations discover them again.
    if (!original || !YTC.shouldTranslate(original, prefs.skipChinese)) return;
    const record = { node, original, status: 'idle', block: null, translated: '', showOriginal: false, collapsed: false };
    records.set(node, record);
    viewport.observe(node);
  }
  function scan(root = document) {
    if (!prefs.enabled || contextGone) return;
    if (root.matches?.(SELECTOR)) discover(root);
    root.querySelectorAll?.(SELECTOR).forEach(discover);
  }
  function scheduleScan(root) {
    if (!booted || !prefs.enabled || contextGone) return;
    roots.add(root);
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      for (const record of records.values()) {
        if (!record.node.isConnected) removeRecord(record);
      }
      for (const item of roots) { if (item === document || item.isConnected) scan(item); }
      roots.clear();
    }, 150);
  }
  const mutations = new MutationObserver(changes => {
    for (const change of changes) {
      const element = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
      if (element?.closest('.ytcc-translation')) continue;
      const comment = element?.closest(SELECTOR);
      if (comment) scheduleScan(comment);
      if (change.type === 'childList') {
        for (const added of change.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE && !added.matches('.ytcc-translation')) scheduleScan(added);
        }
        // Also prune detached records even when no comments were added.
        if (change.removedNodes.length) scheduleScan(element || document);
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'GET_STATUS') {
      const list = Array.from(records.values()).filter(record => record.node.isConnected);
      respond({ enabled: prefs.enabled, translated: list.filter(r => r.status === 'done').length,
        pending: list.filter(r => ['queued', 'loading'].includes(r.status)).length,
        failed: list.filter(r => r.status === 'error').length });
    }
    if (message?.type === 'RETRY_FAILED') {
      let retried = 0;
      for (const record of records.values()) {
        if (record.status === 'error' && record.node.isConnected) { retry(record); retried++; }
      }
      respond({ ok: true, retried });
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.settings && !changes.aiConfig)) return;
    if (changes.settings) prefs = YTC.settings(changes.settings.newValue);
    reset();
    if (booted) scheduleScan(document);
  });
  document.addEventListener('yt-navigate-start', reset);
  document.addEventListener('yt-navigate-finish', () => scheduleScan(document));
  chrome.storage.local.get('settings').then(value => {
    prefs = YTC.settings(value.settings);
    booted = true;
    mutations.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scan();
  }).catch(() => { contextGone = true; });
})();
