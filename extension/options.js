/* Local options page. External calls require an explicit save, refresh, test or quota action. */
(() => {
  'use strict';
  const FREE_BASE = 'https://openrouter.ai/api/v1';
  const FREE_ROUTER = 'openrouter/free';
  const SILICON_BASE = 'https://api.siliconflow.cn/v1';
  const SILICON_MODEL = 'Qwen/Qwen3-8B';
  // Both origins are requested together when a SiliconFlow configuration is saved.
  const SILICON_ORIGINS = ['https://api.siliconflow.cn/*', 'https://www.siliconflow.cn/*'];
  const SILICON_SEED = Object.freeze([
    { id: 'Qwen/Qwen3-8B', name: 'Qwen3-8B' },
    { id: 'Qwen/Qwen3.5-4B', name: 'Qwen3.5-4B' },
    { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B-Instruct' }
  ]);
  // B站 Index-Translate: official free public endpoint, no key, fixed model whitelist.
  const INDEX_BASE = 'https://index-translate.bilibili.com/v1';
  const INDEX_ORIGIN = 'https://index-translate.bilibili.com/*';
  const INDEX_MODEL = 'Index-Translate-35B-A3B';
  const INDEX_MODELS = Object.freeze(['Index-Translate-35B-A3B', 'Index-Translate-9B', 'Index-Translate-2B']);
  // Dual search only ever needs this one keyless B站 origin. Never request the
  // comment-translation service origins from this control.
  const DUAL_ORIGIN = 'https://index-translate.bilibili.com/*';
  const ui = Object.fromEntries([
    'settingsForm', 'serviceFields', 'providerGoogle', 'providerAI', 'aiFields', 'preset',
    'baseUrl', 'model', 'apiKey', 'apiKeyField', 'useContext', 'modeBadge', 'configurationHint',
    'saveSettings', 'saveStatus', 'testAI', 'testHint', 'testStatus', 'testResult', 'testText', 'testModel',
    'freePanel', 'freeModel', 'refreshFreeModels', 'catalogStatus', 'freeQuotaSection', 'freeStatus', 'quotaStatus',
    'sfPanel', 'sfModel', 'sfRefresh', 'sfStatus',
    'indexPanel', 'indexModel',
    // Dual search is independent of the AI/comment settings; older test DOMs
    // may not provide these nodes, so every use below is guarded.
    'dualSearchSection', 'dualSearch', 'grantDualSearch', 'dualSearchStatus'
  ].map(id => [id, document.getElementById(id)]));
  let ready = false;
  let busy = false;
  let dualBusy = false;
  let dirty = false;
  let savedSettings = YTC.settings();
  let savedConfig = null;
  let modelList = [{ id: FREE_ROUTER, name: '免费自动路由 · 通用模型优先' }];
  let siliconList = SILICON_SEED.map(item => ({ ...item }));

  function announce(target, text, kind = '') {
    if (!target) return;
    target.textContent = text;
    target.dataset.error = String(kind === 'error');
    target.dataset.success = String(kind === 'success');
  }
  function errorText(code, fallback) {
    return typeof code === 'string' && Object.hasOwn(YTC.errors, code) ? YTC.errors[code] : fallback;
  }
  function provider() { return ui.providerAI.checked ? 'ai' : 'google'; }
  function freePreset() { return ui.preset.value === 'openrouter-free'; }
  function siliconPreset() { return ui.preset.value === 'siliconflow-free'; }
  function freeId(id) {
    return typeof id === 'string' && id.length <= 200 && (id === FREE_ROUTER || /^[\w./-]+:free$/.test(id));
  }
  // Local filter only: the authoritative free/zero-price check runs in shared.js and the worker.
  function siliconId(id) {
    return typeof id === 'string' && id.length > 2 && id.length <= 200
      && /^[\w.-]+\/[\w.:-]+$/.test(id) && !/^pro\//i.test(id);
  }
  function indexPreset() { return ui.preset.value === 'index-translate-free'; }
  function presetService(preset = ui.preset.value) {
    if (preset === 'index-translate-free') return 'indextranslate';
    if (preset === 'siliconflow-free') return 'siliconflow';
    if (preset === 'openrouter-free') return 'openrouter';
    return 'custom';
  }
  // Older configs have no service field; infer it from the endpoint without touching key or model.
  function serviceOf(config) {
    if (['indextranslate', 'siliconflow', 'openrouter', 'custom'].includes(config?.service)) return config.service;
    const base = typeof config?.baseUrl === 'string' ? config.baseUrl.replace(/\/+$/, '') : '';
    if (base === INDEX_BASE) return 'indextranslate';
    if (base === SILICON_BASE) return 'siliconflow';
    if (base === FREE_BASE) return 'openrouter';
    return 'custom';
  }
  function isIndex(config) {
    if (typeof YTC.isIndexConfig === 'function') return YTC.isIndexConfig(config) === true;
    return config?.service === 'indextranslate';
  }
  function validateIndex(config) {
    if (typeof YTC.validateIndexConfig === 'function') return YTC.validateIndexConfig(config);
    if (!isIndex(config) || config?.freeOnly !== true) throw new Error('AI_CONFIG');
    if (YTC.aiEndpoint(config?.baseUrl) !== INDEX_BASE + '/chat/completions') throw new Error('AI_CONFIG');
    if (!INDEX_MODELS.includes(config?.model)) throw new Error('AI_CONFIG');
    return true;
  }
  function isSilicon(config) {
    if (typeof YTC.isSiliconConfig === 'function') return YTC.isSiliconConfig(config) === true;
    return config?.freeOnly === true && serviceOf(config) === 'siliconflow';
  }
  function validateSilicon(config) {
    if (typeof YTC.validateSiliconConfig === 'function') return YTC.validateSiliconConfig(config);
    if (config?.freeOnly !== true) throw new Error('AI_CONFIG');
    if (YTC.aiEndpoint(config?.baseUrl) !== SILICON_BASE + '/chat/completions') throw new Error('AI_CONFIG');
    if (!siliconId(config?.model)) throw new Error('AI_CONFIG');
    return true;
  }
  function formConfig(service = presetService()) {
    const index = service === 'indextranslate';
    const indexModel = INDEX_MODELS.includes(ui.indexModel?.value) ? ui.indexModel.value : INDEX_MODEL;
    const config = YTC.aiConfig({
      baseUrl: index ? INDEX_BASE : ui.baseUrl.value,
      model: index ? indexModel : ui.model.value,
      // B站 preset is keyless: the field is hidden and its value is always emptied.
      apiKey: index ? '' : ui.apiKey.value,
      service,
      freeOnly: index || freePreset() || siliconPreset()
    });
    // Keep the service label accurate even if an older shared.js does not know it yet.
    if (index) {
      config.service = 'indextranslate';
      config.apiKey = '';
      config.freeOnly = true;
    }
    return config;
  }
  function validAI(config) {
    if (!config || !config.baseUrl || !config.model) return false;
    const index = isIndex(config) || serviceOf(config) === 'indextranslate';
    // B站 Index-Translate needs no key; every other service still requires one.
    if (!index && !config.apiKey) return false;
    try {
      YTC.aiEndpoint(config.baseUrl);
      if (index) validateIndex(config);
      else if (config.freeOnly === true) {
        if (isSilicon(config)) validateSilicon(config);
        else YTC.validateFreeConfig(config);
      }
      return true;
    } catch (_) { return false; }
  }
  function savedAIReady() {
    return ready && !dirty && provider() === 'ai' && savedSettings.provider === 'ai' && validAI(savedConfig);
  }
  function savedSiliconReady() {
    return ready && !dirty && provider() === 'ai' && siliconPreset()
      && savedSettings.provider === 'ai' && serviceOf(savedConfig) === 'siliconflow'
      && savedConfig?.freeOnly === true && validAI(savedConfig);
  }
  function clearTestResult() {
    ui.testResult.hidden = true;
    ui.testText.textContent = '';
    ui.testModel.hidden = true;
    ui.testModel.textContent = '';
    announce(ui.testStatus, '');
  }
  function updateControls() {
    const ai = provider() === 'ai';
    const free = freePreset();
    const silicon = siliconPreset();
    const index = indexPreset();
    ui.serviceFields.disabled = !ready || busy;
    ui.preset.disabled = !ready || busy;
    ui.aiFields.disabled = !ready || busy || !ai;
    ui.saveSettings.disabled = !ready || busy;
    if (ui.dualSearch) ui.dualSearch.disabled = !ready || busy || dualBusy;
    if (ui.grantDualSearch) ui.grantDualSearch.disabled = !ready || busy || dualBusy;
    ui.testAI.disabled = busy || !savedAIReady();
    ui.refreshFreeModels.disabled = !ready || busy || !ai || !free;
    ui.freeStatus.disabled = busy || !savedAIReady() || savedConfig?.freeOnly !== true || serviceOf(savedConfig) !== 'openrouter';
    ui.freePanel.hidden = !free;
    if (ui.sfPanel) ui.sfPanel.hidden = !silicon;
    if (ui.sfRefresh) ui.sfRefresh.disabled = busy || !savedSiliconReady();
    if (ui.sfModel) ui.sfModel.disabled = !ready || busy || !silicon;
    if (ui.indexPanel) ui.indexPanel.hidden = !index;
    if (ui.indexModel) ui.indexModel.disabled = !ready || busy || !ai || !index;
    // The B站 preset is keyless: hide the field and never keep a stale key in it.
    if (ui.apiKeyField) ui.apiKeyField.hidden = index;
    ui.apiKey.disabled = index;
    if (index) ui.apiKey.value = '';
    ui.freeQuotaSection.hidden = !free;
    ui.baseUrl.readOnly = free || silicon || index;
    ui.model.readOnly = free || index;
    ui.modeBadge.textContent = !ready ? '正在读取…'
      : !ai ? 'Google 模式'
        : index ? 'B站 Index-Translate · 免 Key'
          : silicon ? '硅基流动 · 零价模型'
            : free ? '仅免费模式' : '自定义 AI · 可付费';
    ui.configurationHint.textContent = !ai
      ? '当前使用 Google 翻译；无需密钥，也可直接保存切回 Google。'
      : index
        ? '固定使用 B站官方免费公网接口与 Index-Translate-2B / 9B / 35B-A3B（默认 35B），单条翻译、免 Key；官方免费接口可能限流，无长期 SLA。保存时会请求该来源权限，不会向其他服务发送 Key。'
        : silicon
          ? '仅使用硅基流动官方中国站零价模型，单条翻译、不合并批量；后台按已保存的 Key 核验官方零价目录与账户可用模型的交集，不转 Pro/ 付费。保存时会同时申请接口与官网两个来源的权限。'
          : free
            ? '仅允许 OpenRouter 免费自动路由或固定 :free 模型；自动模式在本机挑选通用免费模型，不交由服务端代选。保存时只申请该来源权限；启用后自动批量翻译，不付费回退。'
            : '此模式不限制模型价格，调用可能收费。保存时仅申请所填接口来源权限，请自行确认服务价格。';
    ui.testHint.textContent = !ai || savedSettings.provider !== 'ai' || !validAI(savedConfig)
      ? '先选择 AI 翻译并保存有效配置，再测试连接。'
      : dirty ? '配置有未保存的更改，请先保存，再测试已保存的服务。'
        : serviceOf(savedConfig) === 'indextranslate' ? '发送一个固定样例到已保存的 B站官方免费公网接口，不需要 Key；免费请求可能限流，无长期 SLA。'
          : serviceOf(savedConfig) === 'siliconflow' ? '发送一个固定样例，使用已保存的硅基流动零价模型，单条请求；实际使用的模型会在返回时显示。'
            : savedConfig.freeOnly === true ? '发送一个固定样例，占用免费请求（失败换模型时最多 3 次）；实际使用的模型会在返回时显示。'
              : '将使用已保存的地址、模型和密钥发送固定翻译样例，可能产生费用。';
  }
  function markDirty() {
    if (!ready || busy) return;
    dirty = true;
    clearTestResult();
    if (freePreset()) announce(ui.quotaStatus, '配置有未保存的更改，请先保存后再查询。');
    if (siliconPreset()) announce(ui.sfStatus, '有未保存的更改；保存后才能刷新账户零价模型。');
    announce(ui.saveStatus, '有未保存的更改');
    updateControls();
  }
  function renderModels(selected = FREE_ROUTER) {
    const previous = freeId(selected) ? selected : FREE_ROUTER;
    ui.freeModel.replaceChildren();
    for (const item of modelList) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name + ' · ' + item.id;
      ui.freeModel.append(option);
    }
    if (!modelList.some(item => item.id === previous)) {
      const option = document.createElement('option');
      option.value = previous;
      option.textContent = '已保存或已选模型（待刷新核验） · ' + previous;
      ui.freeModel.append(option);
    }
    ui.freeModel.value = previous;
  }
  function renderSiliconModels(selected = SILICON_MODEL) {
    if (!ui.sfModel) return;
    const previous = siliconId(selected) ? selected : SILICON_MODEL;
    ui.sfModel.replaceChildren();
    const seen = new Set();
    for (const item of siliconList) {
      if (!siliconId(item?.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = (typeof item.name === 'string' && item.name.trim() ? item.name.trim() + ' · ' : '') + item.id;
      ui.sfModel.append(option);
    }
    if (!seen.has(previous)) {
      const option = document.createElement('option');
      option.value = previous;
      option.textContent = '已选模型（待刷新核验） · ' + previous;
      ui.sfModel.append(option);
    }
    ui.sfModel.value = previous;
  }
  function renderSettings(settings, config) {
    ui.providerAI.checked = settings.provider === 'ai';
    ui.providerGoogle.checked = settings.provider !== 'ai';
    ui.baseUrl.value = config.baseUrl;
    ui.model.value = config.model;
    ui.apiKey.value = config.apiKey;
    ui.useContext.checked = settings.useContext !== false;
    // Default on: only an explicit false turns dual search off.
    if (ui.dualSearch) ui.dualSearch.checked = settings.dualSearch !== false;
    const service = serviceOf(config);
    // A legacy config is never promoted into a free-only mode implicitly.
    ui.preset.value = service === 'indextranslate' ? 'index-translate-free'
      : config.freeOnly === true && service === 'siliconflow' ? 'siliconflow-free'
        : config.freeOnly === true && service === 'openrouter' ? 'openrouter-free'
          : config.baseUrl.replace(/\/+$/, '') === 'https://api.deepseek.com/v1' && config.model === 'deepseek-flash' ? 'deepseek' : 'custom';
    if (service === 'indextranslate') {
      ui.apiKey.value = '';
      ui.indexModel.value = INDEX_MODELS.includes(config.model) ? config.model : INDEX_MODEL;
      ui.model.value = ui.indexModel.value;
    }
    renderModels(config.freeOnly === true && service === 'openrouter' ? config.model : FREE_ROUTER);
    renderSiliconModels(service === 'siliconflow' ? config.model : SILICON_MODEL);
  }
  async function load() {
    try {
      const current = await chrome.storage.local.get(['settings', 'aiConfig']);
      savedSettings = YTC.settings(current.settings);
      // Preserve existing model/key and require an explicit true for old configs.
      const old = current.aiConfig;
      savedConfig = YTC.aiConfig(old && typeof old === 'object'
        ? { ...old, freeOnly: old.freeOnly === true }
        : { baseUrl: INDEX_BASE, model: INDEX_MODEL, apiKey: '', freeOnly: true, service: 'indextranslate' });
      renderSettings(savedSettings, savedConfig);
      ready = true;
      dirty = false;
      announce(ui.saveStatus, '设置保存在本机，更改后请点击保存。');
    } catch (_) {
      announce(ui.saveStatus, '设置读取失败，请重新打开本页后再试。', 'error');
    }
    updateControls();
  }

  // Not async: request the chosen origin during the actual submit gesture,
  // before any storage read or await can consume Chrome's user activation.
  function save(event) {
    event.preventDefault();
    if (!ready || busy) return;
    const chosenProvider = provider();
    const useContext = ui.useContext.checked;
    let config;
    let permission;
    let service = 'custom';
    try {
      service = presetService();
      config = formConfig(service);
      if (chosenProvider === 'ai') {
        if (service === 'indextranslate') validateIndex(config);
        else if (config.freeOnly === true) {
          if (service === 'siliconflow') validateSilicon(config);
          else YTC.validateFreeConfig(config);
        }
        if (!validAI(config)) {
          announce(ui.saveStatus, errorText('AI_CONFIG', '请填写有效的接口地址、聊天模型和 API Key。'), 'error');
          return;
        }
        // The permission request must stay inside the submit gesture, before any await.
        // B站 needs only its official free public API origin; SiliconFlow needs its site too.
        permission = chrome.permissions.request({
          origins: service === 'indextranslate' ? [INDEX_ORIGIN]
            : service === 'siliconflow' ? SILICON_ORIGINS.slice() : [YTC.endpointOrigin(config.baseUrl)]
        });
      } else {
        permission = Promise.resolve(true);
      }
    } catch (error) {
      const known = typeof error?.message === 'string' && Object.hasOwn(YTC.errors, error.message);
      const code = known ? error.message : 'AI_CONFIG';
      announce(ui.saveStatus, service === 'indextranslate' && !known
        ? 'B站 Index-Translate 预设只接受官方固定接口和 Index-Translate-2B / 9B / 35B-A3B 模型，请检查后重试。'
        : service === 'siliconflow' && !known
          ? '硅基流动仅免费配置只接受官方中国站端点、非 Pro 模型名和本机 Key，请检查后重试。'
          : errorText(code, code === 'FREE_ONLY'
            ? '仅免费模式只能使用固定的 OpenRouter 入口和免费模型，请重新选择。'
            : '接口配置无效，请检查地址、模型和密钥。'), 'error');
      return;
    }
    busy = true;
    clearTestResult();
    announce(ui.saveStatus, chosenProvider === 'ai' ? '正在确认接口权限并保存…' : '正在保存…');
    updateControls();
    Promise.resolve(permission).then(async granted => {
      if (!granted) {
        announce(ui.saveStatus, errorText('AI_PERMISSION', '未获得接口访问权限，设置尚未保存。可再次保存或切回 Google。'), 'error');
        return;
      }
      const current = await chrome.storage.local.get('settings');
      const latest = YTC.settings(current.settings);
      const next = YTC.settings({ ...latest, provider: chosenProvider, useContext,
        // Keep the independent dual-search switch even if an older shared.js
        // does not normalise it; this form never changes it.
        dualSearch: latest.dualSearch !== false,
        aiService: service,
        freeMode: service === 'indextranslate' ? false : config.freeOnly === true && chosenProvider === 'ai' && service !== 'siliconflow' });
      // Keep the service label even if an older shared.js does not normalise it yet.
      if (!next.aiService) next.aiService = service;
      await chrome.storage.local.set({ settings: next, aiConfig: config });
      savedSettings = next;
      savedConfig = config;
      dirty = false;
      announce(ui.quotaStatus, '尚未查询。');
      announce(ui.saveStatus, chosenProvider !== 'ai' ? '已切换为 Google 翻译，无需密钥。'
        : service === 'indextranslate' ? 'B站 Index-Translate 配置已保存（免 Key、单条翻译）。官方免费公网接口可能限流，无长期 SLA；可点击测试连接。'
          : service === 'siliconflow' ? '硅基流动零价配置已保存（单条翻译）。后台会核验官方零价目录，价格变化或核验失败时停止，不转 Pro/ 付费。'
            : config.freeOnly === true ? '仅免费配置已保存。自动模式在本机挑选通用免费模型，可测试或查询免费请求额度。'
              : 'AI 配置已保存。此模式可调用收费模型，请确认服务价格。', 'success');
      if (service === 'siliconflow' && chosenProvider === 'ai') {
        announce(ui.sfStatus, '已保存。可点击「刷新账户零价模型」核验账户可用的官方零价模型。');
      }
    }).catch(() => {
      announce(ui.saveStatus, '保存未完成，请检查接口权限后重试。', 'error');
    }).finally(() => {
      busy = false;
      updateControls();
    });
  }

  // The catalog is public. Request only its origin and never attach a user key.
  function refreshFreeModels() {
    if (ui.refreshFreeModels.disabled || busy) return;
    let permission;
    try { permission = chrome.permissions.request({ origins: ['https://openrouter.ai/*'] }); }
    catch (_) { announce(ui.catalogStatus, '无法申请 OpenRouter 目录访问权限，请再试一次。', 'error'); return; }
    busy = true;
    announce(ui.catalogStatus, '正在获取当前免费模型目录…');
    updateControls();
    Promise.resolve(permission).then(async granted => {
      if (!granted) {
        announce(ui.catalogStatus, '未获得目录访问权限，未请求免费模型列表。', 'error');
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: 'LIST_FREE_MODELS' });
      if (!response?.ok || !Array.isArray(response.models)) {
        announce(ui.catalogStatus, errorText(response?.error, '免费模型目录获取失败，请稍后重试。'), 'error');
        return;
      }
      const unique = new Map([[FREE_ROUTER, { id: FREE_ROUTER, name: '免费自动路由 · 通用模型优先' }]]);
      // Keep the local auto sentinel; list only verified general-purpose fixed candidates.
      for (const item of YTC.translationModels(response.models)) {
        if (!freeId(item?.id) || item.id === FREE_ROUTER) continue;
        unique.set(item.id, { id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 160) : item.id });
      }
      const selected = ui.model.value;
      modelList = Array.from(unique.values());
      renderModels(selected);
      const stillListed = unique.has(selected);
      announce(ui.catalogStatus, stillListed
        ? '通用免费模型列表已刷新（自动模式优先 Nvidia Lightning / Gemma / Xing）。选择模型后请保存；刷新不会更换密钥。'
        : '列表已刷新；当前所选固定模型未出现在目录中，可能已下线。请选择其他免费模型后保存。', stillListed ? 'success' : 'error');
    }).catch(() => {
      announce(ui.catalogStatus, '无法获取免费模型目录，请检查网络后重试。', 'error');
    }).finally(() => { busy = false; updateControls(); });
  }
  // Reads the saved SiliconFlow key inside the worker; no key ever enters this message.
  function refreshSiliconModels() {
    if (!ui.sfRefresh || ui.sfRefresh.disabled || busy) return;
    busy = true;
    announce(ui.sfStatus, '正在按已保存的 Key 核验官方中国站零价目录与账户可用模型的交集…');
    updateControls();
    Promise.resolve(chrome.runtime.sendMessage({ type: 'LIST_SILICON_MODELS' })).then(response => {
      if (!response?.ok || !Array.isArray(response.models)) {
        announce(ui.sfStatus, errorText(response?.error, '零价模型目录核验失败，已停止；不会转为 Pro/ 付费模型。'), 'error');
        return;
      }
      const unique = new Map();
      for (const item of response.models) {
        if (!siliconId(item?.id)) continue;
        unique.set(item.id, { id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 160) : item.id });
      }
      if (!unique.size) {
        announce(ui.sfStatus, '官方零价目录与账户可用模型的交集为空，无法核验零价模型，已停止；不会转 Pro/ 付费。', 'error');
        return;
      }
      siliconList = Array.from(unique.values());
      const selected = ui.model.value;
      renderSiliconModels(selected);
      const stillListed = unique.has(selected);
      announce(ui.sfStatus, stillListed
        ? '已核验 ' + unique.size + ' 个官方零价且账户可用的模型；选择后请保存。价格可能变化，核验失败时会停止，不会转 Pro/ 付费。'
        : '目录已刷新，但当前模型名不在官方零价与账户可用模型的交集中；请重新选择，否则保存后会被拒绝。', stillListed ? 'success' : 'error');
    }).catch(() => {
      announce(ui.sfStatus, '无法读取零价模型目录，请检查网络或稍后重试；未发送翻译请求。', 'error');
    }).finally(() => { busy = false; updateControls(); });
  }
  async function freeStatus() {
    if (ui.freeStatus.disabled || busy) return;
    busy = true;
    announce(ui.quotaStatus, '正在查询已保存 Key 的免费请求额度…');
    updateControls();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'FREE_STATUS' });
      if (!response?.ok) {
        announce(ui.quotaStatus, YTC.errorText(response, '免费请求额度查询失败，请检查已保存配置。'), 'error');
      } else if (![response.used, response.limit, response.remaining].every(value => Number.isSafeInteger(value) && value >= 0)) {
        announce(ui.quotaStatus, '服务未返回有效的免费请求计数，请稍后重试。', 'error');
      } else {
        announce(ui.quotaStatus, '免费请求' + (response.estimated ? '（本机保守估算）' : '') + '：已用 ' + response.used + ' 次 / 上限 ' + response.limit + ' 次 / 剩余 ' + response.remaining + ' 次。计数对应请求，不是评论条数。', 'success');
      }
    } catch (_) {
      announce(ui.quotaStatus, '无法查询免费请求额度，请检查网络后重试。', 'error');
    } finally { busy = false; updateControls(); }
  }
  async function testAI() {
    if (ui.testAI.disabled || busy) return;
    busy = true;
    clearTestResult();
    announce(ui.testStatus, '正在向已保存的服务发送固定样例…');
    updateControls();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'TEST_AI' });
      if (!response || response.ok !== true) {
        announce(ui.testStatus, YTC.errorText(response, 'AI 翻译测试失败，请检查配置和接口权限后重试。'), 'error');
      } else if (typeof response.text !== 'string' || !response.text.trim()) {
        announce(ui.testStatus, errorText('RESPONSE', '服务未返回有效译文，请检查模型后重试。'), 'error');
      } else {
        ui.testText.textContent = response.text;
        if (typeof response.model === 'string' && response.model.trim()) {
          ui.testModel.textContent = '实际返回模型：' + response.model.trim().slice(0, 240);
          ui.testModel.hidden = false;
        }
        ui.testResult.hidden = false;
        announce(ui.testStatus, serviceOf(savedConfig) === 'indextranslate'
          ? '连接成功，已收到样例译文。官方免费请求可能限流，没有长期 SLA。'
          : '连接成功，已收到样例译文。', 'success');
        if (serviceOf(savedConfig) === 'siliconflow') {
          announce(ui.sfStatus, '测试已发送一条单条请求，可能消耗账户零价额度；价格以官方页面为准。');
        } else if (serviceOf(savedConfig) !== 'indextranslate' && savedConfig?.freeOnly === true) {
          announce(ui.quotaStatus, '测试已消耗免费请求，点击查询可更新额度。');
        }
      }
    } catch (_) {
      announce(ui.testStatus, errorText('NETWORK', '无法连接扩展后台，请重新打开设置页后重试。'), 'error');
    } finally { busy = false; updateControls(); }
  }

  // Dual search is independent of the comment service: only settings.dualSearch
  // is written, and provider / useContext / enabled / aiConfig stay untouched.
  async function persistDualSearch(enabled, message, kind) {
    const current = await chrome.storage.local.get('settings');
    const next = YTC.settings({ ...YTC.settings(current.settings), dualSearch: enabled === true });
    await chrome.storage.local.set({ settings: next });
    savedSettings = next;
    if (ui.dualSearch) ui.dualSearch.checked = next.dualSearch;
    announce(ui.dualSearchStatus, message, kind);
  }
  // Synchronous on purpose: the permission request must happen inside the click
  // gesture, before the first await, and must ask for the B站 origin only.
  function grantDualSearch() {
    if (!ui.grantDualSearch || ui.grantDualSearch.disabled || !ready || busy || dualBusy) return;
    let permission;
    try {
      permission = chrome.permissions.request({ origins: [DUAL_ORIGIN] });
    } catch (_) {
      announce(ui.dualSearchStatus, '无法申请 B站来源权限，请再试一次。', 'error');
      return;
    }
    dualBusy = true;
    announce(ui.dualSearchStatus, '正在请求 B站来源权限…');
    updateControls();
    Promise.resolve(permission).then(async granted => {
      if (!granted) {
        announce(ui.dualSearchStatus, '未获得 B站来源权限，中英双搜不会发送翻译；评论翻译设置保持不变。', 'error');
        return;
      }
      await persistDualSearch(true, '已授权 B站来源并开启中英双搜；不会读取或发送任何 Key，也不会更改评论翻译服务。', 'success');
    }).catch(() => {
      announce(ui.dualSearchStatus, '授权未完成，请再试一次；评论翻译设置保持不变。', 'error');
    }).finally(() => { dualBusy = false; updateControls(); });
  }
  function toggleDualSearch() {
    if (!ui.dualSearch || !ready || busy || dualBusy) return;
    const enabled = ui.dualSearch.checked === true;
    dualBusy = true;
    announce(ui.dualSearchStatus, enabled ? '正在保存…' : '正在关闭中英双搜…');
    updateControls();
    // Turning it off is a local preference write and never requests a permission.
    // Turning it on only stores the preference: translation is sent only after
    // the B站 origin is granted, so this never prompts for or reads another origin.
    const saving = enabled
      ? persistDualSearch(true, '已开启中英双搜。点击「授权中英双搜」授予 B站来源权限后才会发送翻译。')
      : persistDualSearch(false, '已关闭中英双搜；YouTube 搜索页恢复原生结果。', 'success');
    saving.catch(() => {
      if (ui.dualSearch) ui.dualSearch.checked = !enabled;
      announce(ui.dualSearchStatus, '保存失败，请再试一次。', 'error');
    }).finally(() => { dualBusy = false; updateControls(); });
  }

  ui.settingsForm.addEventListener('submit', save);
  ui.testAI.addEventListener('click', testAI);
  ui.refreshFreeModels.addEventListener('click', refreshFreeModels);
  ui.freeStatus.addEventListener('click', freeStatus);
  if (ui.sfRefresh) ui.sfRefresh.addEventListener('click', refreshSiliconModels);
  if (ui.grantDualSearch) ui.grantDualSearch.addEventListener('click', grantDualSearch);
  if (ui.dualSearch) ui.dualSearch.addEventListener('change', toggleDualSearch);
  for (const input of [ui.providerGoogle, ui.providerAI, ui.useContext]) input.addEventListener('change', markDirty);
  for (const input of [ui.baseUrl, ui.model, ui.apiKey]) input.addEventListener('input', () => {
    if (input !== ui.apiKey && (freePreset() || siliconPreset() || indexPreset())) {
      // readOnly is a UI affordance; the authoritative restriction is validated on save.
      markDirty();
      return;
    }
    if (input !== ui.apiKey) ui.preset.value = 'custom';
    markDirty();
  });
  if (ui.indexModel) ui.indexModel.addEventListener('change', () => {
    if (!ready || busy || !indexPreset() || !INDEX_MODELS.includes(ui.indexModel.value)) return;
    ui.model.value = ui.indexModel.value;
    markDirty();
  });
  ui.freeModel.addEventListener('change', () => {
    if (!ready || busy || !freePreset() || !freeId(ui.freeModel.value)) return;
    ui.model.value = ui.freeModel.value;
    markDirty();
  });
  if (ui.sfModel) ui.sfModel.addEventListener('change', () => {
    if (!ready || busy || !siliconPreset() || !siliconId(ui.sfModel.value)) return;
    ui.model.value = ui.sfModel.value;
    markDirty();
  });
  ui.baseUrl.addEventListener('change', () => {
    if (!ready || busy || !savedConfig?.apiKey || ui.apiKey.value !== savedConfig.apiKey) return;
    try {
      if (YTC.endpointOrigin(ui.baseUrl.value) !== YTC.endpointOrigin(savedConfig.baseUrl)) {
        ui.apiKey.value = '';
        markDirty();
        announce(ui.saveStatus, '接口来源已改变，已清空旧密钥。请填写新服务的 API Key。');
      }
    } catch (_) { /* Invalid URLs are rejected when saving. */ }
  });
  ui.preset.addEventListener('change', () => {
    if (!ready || busy) return;
    ui.providerAI.checked = true;
    ui.providerGoogle.checked = false;
    if (indexPreset()) {
      ui.baseUrl.value = INDEX_BASE;
      ui.indexModel.value = INDEX_MODEL;
      ui.model.value = INDEX_MODEL;
    } else if (siliconPreset()) {
      ui.baseUrl.value = SILICON_BASE;
      ui.model.value = SILICON_MODEL;
      renderSiliconModels(SILICON_MODEL);
    } else if (freePreset()) {
      ui.baseUrl.value = FREE_BASE;
      ui.model.value = FREE_ROUTER;
      renderModels(FREE_ROUTER);
    } else if (ui.preset.value === 'deepseek') {
      ui.baseUrl.value = 'https://api.deepseek.com/v1';
      ui.model.value = 'deepseek-flash';
    }
    // Switching services never carries a key across origins.
    ui.apiKey.value = '';
    markDirty();
    announce(ui.saveStatus, indexPreset()
      ? '已选择 B站 Index-Translate 预设并清空旧密钥：官方免费公网 API，不用登录、不需要 Key，默认 35B。请点击保存授权，再测试连接。'
      : siliconPreset()
        ? '已选择硅基流动零价模式并清空旧密钥。请在本机填写硅基流动 Key 后保存（Key 未加密，账号需实名）。'
        : freePreset()
          ? '已选择仅免费模式并清空旧密钥。请在本机填写 OpenRouter Key 后保存。'
          : '已明确切出仅免费模式并清空密钥。此服务可能收费，请确认价格后填写 Key 并保存。');
  });
  updateControls();
  void load();
})();
