/* Popup-only UI. Secrets are read and managed exclusively by the options page. */
(function () {
  'use strict';

  const ui = Object.fromEntries([
    'enabled', 'display', 'skipChinese', 'dualSearch', 'saveStatus', 'pageStatus', 'providerStatus', 'openAISettings',
    'translated', 'pending', 'failed', 'refreshStatus', 'retryFailed', 'clearCache', 'actionStatus'
  ].map(id => [id, document.getElementById(id)]));
  // Dual search only ever asks for this keyless B站 origin; never a service origin.
  const DUAL_ORIGIN = 'https://index-translate.bilibili.com/*';
  const preferences = [ui.enabled, ui.display, ui.skipChinese];
  let savedSettings = YTC.settings();
  let settingsReady = false;
  let saving = false;
  let dualSearchBusy = false;
  let pageBusy = false;
  let actionBusy = false;
  let tabId = null;
  let tabUrlKnown = false;
  let latestStatus = null;

  function announce(element, message, error = false) {
    element.textContent = message;
    element.dataset.error = String(error);
  }
  function serviceLabel(value) {
    // Never read aiConfig here: the popup only shows the stored service label.
    // Older settings default aiService to 'openrouter', so a paid custom config still needs freeMode.
    const service = typeof value.aiService === 'string' ? value.aiService
      : value.freeMode === true ? 'openrouter' : 'custom';
    if (service === 'indextranslate') return 'B站 Index-Translate · 免 Key · 单条翻译';
    if (service === 'siliconflow') return '硅基流动 · 零价模型 · 单条翻译';
    if (service === 'openrouter' && value.freeMode === true) return 'OpenRouter 仅免费 · 自动批量';
    return value.useContext !== false ? 'AI 语境翻译 · 附带语境' : 'AI 翻译 · 仅发送评论';
  }
  function renderSettings(value) {
    ui.enabled.checked = value.enabled;
    ui.display.value = value.display;
    ui.skipChinese.checked = value.skipChinese;
    // Default on: only an explicit false turns dual search off.
    if (ui.dualSearch) ui.dualSearch.checked = value.dualSearch !== false;
    ui.providerStatus.textContent = !settingsReady ? '正在读取…' : value.provider === 'ai'
      ? serviceLabel(value)
      : 'Google 免费翻译';
  }
  function updateControls() {
    for (const input of preferences) input.disabled = !settingsReady || saving;
    if (ui.dualSearch) ui.dualSearch.disabled = !settingsReady || saving || dualSearchBusy;
    ui.clearCache.disabled = !settingsReady || actionBusy;
    ui.refreshStatus.disabled = tabId === null || pageBusy || actionBusy;
    ui.retryFailed.disabled = !settingsReady || saving || pageBusy || actionBusy ||
      tabId === null || !latestStatus || !savedSettings.enabled || latestStatus.failed === 0;
  }
  function renderCounts(status) {
    for (const key of ['translated', 'pending', 'failed']) ui[key].textContent = status ? String(status[key]) : '—';
  }
  function normalizeStatus(response) {
    if (!response || typeof response.enabled !== 'boolean') throw new Error('STATUS');
    const result = { enabled: response.enabled };
    for (const key of ['translated', 'pending', 'failed']) {
      if (!Number.isFinite(response[key]) || response[key] < 0) throw new Error('STATUS');
      result[key] = Math.floor(response[key]);
    }
    return result;
  }
  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('settings');
      savedSettings = YTC.settings(stored.settings);
      settingsReady = true;
      renderSettings(savedSettings);
      announce(ui.saveStatus, '更改后自动保存');
    } catch (_) {
      ui.providerStatus.textContent = '暂时无法读取翻译服务';
      announce(ui.saveStatus, '设置读取失败，请重新打开面板', true);
    }
    updateControls();
  }
  async function saveSettings() {
    if (!settingsReady || saving) return;
    const readingPreferences = { enabled: ui.enabled.checked, display: ui.display.value, skipChinese: ui.skipChinese.checked };
    saving = true;
    announce(ui.saveStatus, '正在保存…');
    updateControls();
    try {
      // Read again before merging: options may have changed provider/useContext.
      const current = await chrome.storage.local.get('settings');
      const raw = current.settings && typeof current.settings === 'object' ? current.settings : {};
      const latest = YTC.settings(raw);
      const next = YTC.settings({ ...savedSettings, ...latest, ...readingPreferences,
        // Comment preferences never change the independent dual-search switch.
        dualSearch: latest.dualSearch !== false });
      // Preserve the stored service label even if an older shared.js does not normalise it.
      if (!next.aiService && typeof raw.aiService === 'string') next.aiService = raw.aiService;
      await chrome.storage.local.set({ settings: next });
      savedSettings = next;
      renderSettings(savedSettings);
      announce(ui.saveStatus, '已自动保存');
      await refreshPageStatus();
    } catch (_) {
      renderSettings(savedSettings);
      announce(ui.saveStatus, '保存失败，请再试一次', true);
    } finally {
      saving = false;
      updateControls();
    }
  }
  // Only settings.dualSearch is written here: the stored provider, service label
  // and aiConfig stay untouched, and no key is ever read or sent.
  async function persistDualSearch(enabled) {
    const current = await chrome.storage.local.get('settings');
    const raw = current.settings && typeof current.settings === 'object' ? current.settings : {};
    const next = YTC.settings({ ...YTC.settings(raw), dualSearch: enabled === true });
    if (!next.aiService && typeof raw.aiService === 'string') next.aiService = raw.aiService;
    await chrome.storage.local.set({ settings: next });
    savedSettings = next;
    renderSettings(savedSettings);
    announce(ui.saveStatus, enabled ? '已开启中英双搜' : '已关闭中英双搜');
  }
  function toggleDualSearch() {
    if (!ui.dualSearch || !settingsReady || saving || dualSearchBusy) return;
    const enabled = ui.dualSearch.checked === true;
    let permission = Promise.resolve(true);
    if (enabled) {
      // The request stays inside the change gesture, before any await; when the
      // B站 origin is already granted Chrome resolves without prompting again.
      try { permission = chrome.permissions.request({ origins: [DUAL_ORIGIN] }); }
      catch (_) {
        ui.dualSearch.checked = savedSettings.dualSearch !== false;
        announce(ui.saveStatus, '无法申请 B站来源权限，请再试一次', true);
        return;
      }
    }
    dualSearchBusy = true;
    announce(ui.saveStatus, '正在保存…');
    updateControls();
    Promise.resolve(permission).then(granted => {
      if (!granted) {
        // Denied: write nothing and restore the switch to its saved value.
        if (ui.dualSearch) ui.dualSearch.checked = savedSettings.dualSearch !== false;
        announce(ui.saveStatus, '未获得 B站来源权限，未开启中英双搜', true);
        return undefined;
      }
      return persistDualSearch(enabled);
    }).catch(() => {
      if (ui.dualSearch) ui.dualSearch.checked = savedSettings.dualSearch !== false;
      announce(ui.saveStatus, '保存失败，请再试一次', true);
    }).finally(() => { dualSearchBusy = false; updateControls(); });
  }
  async function findCurrentPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !Number.isInteger(tab.id) || tab.id < 0) {
        announce(ui.pageStatus, '未找到当前标签页，请打开 YouTube 视频页面。');
        return;
      }
      tabUrlKnown = typeof tab.url === 'string' && tab.url.length > 0;
      if (tabUrlKnown) {
        let url;
        try { url = new URL(tab.url); } catch (_) { /* Unsupported browser page. */ }
        if (!url || url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
          announce(ui.pageStatus, '当前不是 YouTube 页面。打开 YouTube 视频，向下滚动即可翻译评论。');
          return;
        }
      }
      tabId = tab.id;
      await refreshPageStatus();
    } catch (_) {
      announce(ui.pageStatus, '无法读取当前标签页，请重新打开面板。');
    } finally {
      updateControls();
    }
  }
  async function refreshPageStatus() {
    if (tabId === null || pageBusy) return;
    pageBusy = true;
    updateControls();
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
      latestStatus = normalizeStatus(response);
      renderCounts(latestStatus);
      if (!latestStatus.enabled) announce(ui.pageStatus, '自动翻译已暂停。开启后继续翻译可见评论。');
      else if (latestStatus.pending > 0) announce(ui.pageStatus, '正在翻译可见评论。继续滚动可加载更多评论。');
      else if (latestStatus.failed > 0) announce(ui.pageStatus, '部分评论翻译失败。检查服务配置或网络后，可立即重试。');
      else if (latestStatus.translated > 0) announce(ui.pageStatus, '译文已就绪。继续滚动可翻译更多评论。');
      else announce(ui.pageStatus, '已连接 YouTube。向下滚动到评论区开始翻译。');
    } catch (_) {
      latestStatus = null;
      renderCounts(null);
      announce(ui.pageStatus, tabUrlKnown ? '页面尚未连接插件。请刷新 YouTube 页面，再重新打开面板。' : '请打开 YouTube 视频页面；若已打开，请刷新页面后重试。');
    } finally {
      pageBusy = false;
      updateControls();
    }
  }
  async function retryFailed() {
    if (ui.retryFailed.disabled || tabId === null) return;
    actionBusy = true;
    announce(ui.actionStatus, '正在重试失败评论…');
    updateControls();
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'RETRY_FAILED' });
      await refreshPageStatus();
      if (!latestStatus) throw new Error('CONNECTION');
      announce(ui.actionStatus, '已提交重试，可刷新状态查看进度。');
    } catch (_) {
      announce(ui.actionStatus, '重试未成功，请刷新 YouTube 页面后再试。', true);
    } finally {
      actionBusy = false;
      updateControls();
    }
  }
  async function clearCache() {
    if (ui.clearCache.disabled) return;
    actionBusy = true;
    announce(ui.actionStatus, '正在清除缓存…');
    updateControls();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      if (!response || response.ok !== true) throw new Error('CLEAR_CACHE');
      announce(ui.actionStatus, '缓存已清除。已显示的译文仍保留在页面上。');
    } catch (_) {
      announce(ui.actionStatus, '清除缓存失败，请重新打开面板后再试。', true);
    } finally {
      actionBusy = false;
      updateControls();
    }
  }
  async function openAISettings() {
    if (ui.openAISettings.disabled) return;
    ui.openAISettings.disabled = true;
    try { await chrome.runtime.openOptionsPage(); }
    catch (_) { announce(ui.actionStatus, '无法打开 AI 设置，请在扩展管理页中打开此扩展的选项。', true); }
    finally { ui.openAISettings.disabled = false; }
  }

  for (const input of preferences) input.addEventListener('change', saveSettings);
  if (ui.dualSearch) ui.dualSearch.addEventListener('change', toggleDualSearch);
  ui.refreshStatus.addEventListener('click', refreshPageStatus);
  ui.retryFailed.addEventListener('click', retryFailed);
  ui.clearCache.addEventListener('click', clearCache);
  ui.openAISettings.addEventListener('click', openAISettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || !settingsReady || saving) return;
    savedSettings = YTC.settings(changes.settings.newValue);
    renderSettings(savedSettings);
    updateControls();
  });
  renderSettings(savedSettings);
  updateControls();
  void loadSettings();
  void findCurrentPage();
})();
