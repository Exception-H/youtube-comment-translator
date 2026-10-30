'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const YTC = require('../extension/shared.js');
const source = fs.readFileSync(path.join(__dirname, '../extension/options.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const KEY = 'test-only-key';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_ORIGIN = 'https://openrouter.ai/*';
const SILICON_BASE = 'https://api.siliconflow.cn/v1';
const SILICON_MODEL = 'Qwen/Qwen3-8B';
const SILICON_ORIGINS = ['https://api.siliconflow.cn/*', 'https://www.siliconflow.cn/*'];
const INDEX_BASE = 'https://index-translate.bilibili.com/v1';
const INDEX_ORIGIN = 'https://index-translate.bilibili.com/*';
// Dual search only ever needs the one keyless B站 origin; it is independent of
// the comment-translation provider and must never ask for another service.
const DUAL_ORIGIN = 'https://index-translate.bilibili.com/*';
const INDEX_MODEL = 'Index-Translate-35B-A3B';
const INDEX_MODELS = ['Index-Translate-35B-A3B', 'Index-Translate-9B', 'Index-Translate-2B'];
// A saved OpenRouter free config without a key. The default harness seeds this
// so the legacy OpenRouter scenarios keep their original meaning; a true fresh
// install (no stored aiConfig at all) is requested with { missingAiConfig: true }
// and now defaults to the keyless B站 Index-Translate preset.
const SAVED_OR = Object.freeze({ baseUrl: OPENROUTER_BASE, model: 'openrouter/free', apiKey: '', freeOnly: true, service: 'openrouter' });
const SAVED_SF = Object.freeze({ baseUrl: SILICON_BASE, model: SILICON_MODEL, apiKey: KEY, freeOnly: true, service: 'siliconflow' });
const SAVED_INDEX = Object.freeze({ baseUrl: INDEX_BASE, model: INDEX_MODEL, apiKey: '', freeOnly: true, service: 'indextranslate' });

// Minimal DOM nodes: only the behaviour options.js actually uses
// (value/textContent/dataset/events, plus <select> option bookkeeping and the
// query helpers a browser node always exposes).
function makeNode(extra = {}) {
  return {
    value: '', checked: false, disabled: false, hidden: false, readOnly: false,
    textContent: '', dataset: {}, events: {}, options: [],
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); },
    append(child) { this.options.push(child); },
    replaceChildren() { this.options.length = 0; this.value = ''; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    ...extra
  };
}
function harness(seed = {}) {
  // IDs mirrored from extension/options.js.
  const ids = [
    'settingsForm', 'serviceFields', 'providerGoogle', 'providerAI', 'aiFields', 'preset',
    'baseUrl', 'model', 'apiKey', 'useContext', 'modeBadge', 'configurationHint',
    'saveSettings', 'saveStatus', 'testAI', 'testHint', 'testStatus', 'testResult', 'testText', 'testModel',
    'freePanel', 'freeModel', 'refreshFreeModels', 'catalogStatus', 'freeQuotaSection', 'freeStatus', 'quotaStatus',
    'sfPanel', 'sfModel', 'sfRefresh', 'sfStatus',
    // B站 Index-Translate additions: the preset panel, its model select and the
    // wrapper field that is hidden while the keyless preset is active.
    'indexPanel', 'indexModel', 'apiKeyField',
    // Independent dual-search controls. options.js guards every access because
    // older DOMs may not provide them.
    'dualSearchSection', 'dualSearch', 'grantDualSearch', 'dualSearchStatus'
  ];
  const nodes = Object.fromEntries(ids.map(id => [id, makeNode()]));
  const state = {
    settings: YTC.settings(seed.settings),
    aiConfig: seed.aiConfig !== undefined ? seed.aiConfig : seed.missingAiConfig ? undefined : { ...SAVED_OR },
    calls: [],
    // Finer-grained logs kept beside `calls` so existing strict call-sequence
    // assertions stay valid while new tests can prove what was read/written.
    getCalls: [],
    setCalls: [],
    grant: true,
    response: { ok: true, text: '这段太带劲了。' }
  };
  const chrome = {
    storage: { local: {
      get: async keys => {
        state.calls.push('get');
        const list = Array.isArray(keys) ? keys.slice() : [keys];
        state.getCalls.push(Array.from(list));
        return Object.fromEntries(list.map(key => [key, state[key]]));
      },
      set: async values => {
        state.calls.push('set');
        state.setCalls.push({ ...values });
        Object.assign(state, values);
      }
    } },
    permissions: { request: value => { state.calls.push(['permission', value]); return Promise.resolve(state.grant); } },
    runtime: { sendMessage: async message => { state.calls.push(['message', message]); return state.response; } }
  };
  const document = {
    getElementById: id => nodes[id],
    createElement: tag => makeNode({ tagName: String(tag).toUpperCase() })
  };
  vm.runInNewContext(source, { YTC, chrome, document });
  function fire(id, type) { for (const fn of nodes[id].events[type] || []) fn({ preventDefault() {} }); }
  const h = {
    nodes, state, fire,
    chooseAI() {
      nodes.providerAI.checked = true;
      nodes.providerGoogle.checked = false;
      nodes.apiKey.value = KEY;
      fire('providerAI', 'change');
    },
    // Choose AI without typing a key: required by the keyless B站 preset.
    chooseAIWithoutKey() {
      nodes.providerAI.checked = true;
      nodes.providerGoogle.checked = false;
      fire('providerAI', 'change');
    },
    chooseIndex() {
      nodes.preset.value = 'index-translate-free';
      fire('preset', 'change');
    },
    chooseCustom(key = KEY) {
      nodes.preset.value = 'custom';
      fire('preset', 'change');
      nodes.apiKey.value = key;
      fire('apiKey', 'input');
    },
    chooseSilicon(key = KEY) {
      nodes.preset.value = 'siliconflow-free';
      fire('preset', 'change');
      nodes.apiKey.value = key;
      fire('apiKey', 'input');
    },
    async save() { fire('settingsForm', 'submit'); await tick(); },
    clearCalls() {
      state.calls.length = 0;
      state.getCalls.length = 0;
      state.setCalls.length = 0;
    },
    setDualSearch(checked) {
      nodes.dualSearch.checked = checked;
      fire('dualSearch', 'change');
    },
    grantDualSearch() { fire('grantDualSearch', 'click'); },
    sent(type) { return state.calls.filter(call => Array.isArray(call) && call[0] === 'message').map(call => call[1]).filter(message => message?.type === type); },
    permissions() { return state.calls.filter(call => Array.isArray(call) && call[0] === 'permission'); }
  };
  return h;
}
test('translation failure displays safe HTTP diagnostics without raw upstream details', async () => {
  const h = harness(); await tick(); h.chooseAI(); await h.save();
  h.state.response = { ok: false, error: 'FREE_NO_PROVIDER', diagnostic: { stage: 'translate', status: 503, apiCode: 503, message: 'test-only-key' } };
  h.fire('testAI', 'click'); await tick();
  assert.ok(h.nodes.testStatus.textContent.includes('HTTP 503'));
  assert.ok(h.nodes.testStatus.textContent.includes('API 503'));
  assert.ok(h.nodes.testStatus.textContent.includes('免费路由'));
  assert.ok(!h.nodes.testStatus.textContent.includes(KEY));
  assert.equal(YTC.safeDiagnostic({ stage: 'test-only-key', status: 503 }), null);
  assert.deepEqual(YTC.safeDiagnostic({ stage: 'translate', status: 'test-only-key', apiCode: 503, message: KEY }), { stage: 'translate', apiCode: 503 });
});
test('options does not request network/permissions on load, validates AI before saving', async () => {
  const h = harness(); await tick();
  assert.deepEqual(h.state.calls, ['get']);
  assert.equal(h.nodes.testAI.disabled, true);
  h.nodes.providerAI.checked = true; h.nodes.providerGoogle.checked = false;
  h.fire('providerAI', 'change'); h.fire('settingsForm', 'submit');
  assert.deepEqual(h.state.calls, ['get']);
  assert.ok(h.nodes.saveStatus.textContent.includes('API Key'));
});
test('AI save requests only the chosen origin synchronously, then merges current reading settings', async () => {
  const h = harness(); await tick(); h.chooseAI();
  h.state.settings.enabled = false; h.state.settings.display = 'translation';
  h.state.calls.length = 0;
  h.fire('settingsForm', 'submit');
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0][0], 'permission');
  assert.equal(h.state.calls[0][1].origins[0], OPENROUTER_ORIGIN);
  assert.equal(h.nodes.saveSettings.disabled, true);
  h.fire('settingsForm', 'submit');
  await tick();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission', 'get', 'set']);
  assert.equal(h.state.settings.provider, 'ai');
  assert.equal(h.state.settings.enabled, false);
  assert.equal(h.state.settings.display, 'translation');
  assert.equal(h.state.settings.freeMode, true);
  assert.equal(h.nodes.testAI.disabled, false);
});
test('declining optional host permission leaves stored settings unchanged', async () => {
  const h = harness(); await tick(); h.chooseAI(); h.state.grant = false;
  h.fire('settingsForm', 'submit'); await tick();
  assert.equal(h.state.settings.provider, 'google');
  assert.ok(!h.state.calls.includes('set'));
  assert.equal(h.nodes.testAI.disabled, true);
});
test('saved AI connection test sends no key or user comment through the UI message', async () => {
  const h = harness(); await tick(); h.chooseAI();
  h.fire('settingsForm', 'submit'); await tick();
  h.state.response = { ok: true, text: '<img src=x onerror=bad>' };
  h.fire('testAI', 'click'); await tick();
  const request = h.state.calls.find(call => Array.isArray(call) && call[0] === 'message')[1];
  assert.deepEqual(JSON.parse(JSON.stringify(request)), { type: 'TEST_AI' });
  assert.equal(h.nodes.testText.textContent, '<img src=x onerror=bad>');
  assert.equal(h.nodes.testResult.hidden, false);
  h.state.response = { ok: false, error: 'untrusted test-only-key error text' };
  h.fire('testAI', 'click'); await tick();
  assert.ok(!h.nodes.testStatus.textContent.includes('test-only-key'));
});
test('changing the saved AI host clears the old key; Google remains available without a key', async () => {
  const h = harness(); await tick(); h.chooseAI(); await h.save();
  assert.equal(h.state.aiConfig.apiKey, KEY);
  // The free preset locks the endpoint, so a host change first needs an explicit custom preset.
  h.nodes.preset.value = 'custom'; h.fire('preset', 'change');
  assert.equal(h.nodes.apiKey.value, '');
  h.nodes.apiKey.value = KEY; h.fire('apiKey', 'input');
  await h.save();
  assert.equal(h.state.aiConfig.freeOnly, false);
  h.nodes.baseUrl.value = 'https://different.example.test/v1'; h.fire('baseUrl', 'change');
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.testAI.disabled, true);
  h.nodes.providerAI.checked = false; h.nodes.providerGoogle.checked = true; h.fire('providerGoogle', 'change');
  h.state.calls.length = 0; h.fire('settingsForm', 'submit'); await tick();
  assert.equal(h.state.settings.provider, 'google');
  assert.ok(!h.state.calls.some(call => Array.isArray(call) && call[0] === 'permission'));
});
test('a saved OpenRouter free config loads the free preset and keeps Google offline', async () => {
  const h = harness(); await tick();
  assert.deepEqual(h.state.calls, ['get']);
  assert.equal(h.nodes.preset.value, 'openrouter-free');
  assert.equal(h.nodes.baseUrl.value, OPENROUTER_BASE);
  assert.equal(h.nodes.model.value, 'openrouter/free');
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.providerGoogle.checked, true);
  assert.equal(h.nodes.providerAI.checked, false);
  assert.equal(h.nodes.baseUrl.readOnly, true);
  assert.equal(h.nodes.model.readOnly, true);
  assert.equal(h.nodes.freePanel.hidden, false);
  assert.equal(h.nodes.freeQuotaSection.hidden, false);
  assert.equal(h.nodes.sfPanel.hidden, true);
  assert.equal(h.nodes.modeBadge.textContent, 'Google 模式');
  assert.equal(h.nodes.testAI.disabled, true);
  assert.equal(h.nodes.freeStatus.disabled, true);
  assert.equal(h.nodes.refreshFreeModels.disabled, true);
  assert.ok(!h.state.calls.some(call => Array.isArray(call) && call[0] === 'permission'));
});
test('a saved SiliconFlow config keeps its key, loads the zero-price preset and stays offline', async () => {
  // SiliconFlow migration coverage: an existing saved SF config must still load
  // as SF (never silently converted to the B站 preset) and keep its stored key.
  const h = harness({ aiConfig: { ...SAVED_SF } }); await tick();
  assert.deepEqual(h.state.calls, ['get']);
  assert.equal(h.nodes.preset.value, 'siliconflow-free');
  assert.notEqual(h.nodes.preset.value, 'index-translate-free');
  assert.equal(h.nodes.baseUrl.value, SILICON_BASE);
  assert.equal(h.nodes.model.value, SILICON_MODEL);
  assert.equal(h.nodes.apiKey.value, KEY);
  assert.equal(h.nodes.apiKeyField.hidden, false);
  assert.equal(h.nodes.apiKey.disabled, false);
  assert.equal(h.nodes.providerGoogle.checked, true);
  assert.equal(h.nodes.providerAI.checked, false);
  assert.equal(h.nodes.baseUrl.readOnly, true);
  assert.equal(h.nodes.model.readOnly, false);
  assert.equal(h.nodes.freePanel.hidden, true);
  assert.equal(h.nodes.freeQuotaSection.hidden, true);
  assert.equal(h.nodes.indexPanel.hidden, true);
  assert.equal(h.nodes.sfPanel.hidden, false);
  assert.equal(h.nodes.sfModel.options[0].value, SILICON_MODEL);
  assert.equal(h.nodes.sfRefresh.disabled, true);
  assert.equal(h.nodes.testAI.disabled, true);
  assert.equal(h.nodes.modeBadge.textContent, 'Google 模式');
  // Provider is still Google: neither refresh action may hit the network.
  h.fire('sfRefresh', 'click'); h.fire('refreshFreeModels', 'click'); await tick();
  assert.ok(!h.state.calls.some(call => Array.isArray(call) && (call[0] === 'permission' || call[0] === 'message')));
});
test('a fresh install with no stored aiConfig defaults to the keyless B站 preset and stays offline', async () => {
  const h = harness({ missingAiConfig: true }); await tick();
  assert.deepEqual(h.state.calls, ['get']);
  assert.equal(h.state.aiConfig, undefined);
  assert.equal(h.nodes.preset.value, 'index-translate-free');
  assert.equal(h.nodes.baseUrl.value, INDEX_BASE);
  assert.equal(h.nodes.model.value, INDEX_MODEL);
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.apiKeyField.hidden, true);
  assert.equal(h.nodes.apiKey.disabled, true);
  assert.equal(h.nodes.providerGoogle.checked, true);
  assert.equal(h.nodes.providerAI.checked, false);
  assert.equal(h.nodes.baseUrl.readOnly, true);
  assert.equal(h.nodes.model.readOnly, true);
  assert.equal(h.nodes.indexPanel.hidden, false);
  assert.equal(h.nodes.indexModel.value, INDEX_MODEL);
  assert.equal(h.nodes.indexModel.disabled, true);
  assert.equal(h.nodes.freePanel.hidden, true);
  assert.equal(h.nodes.freeQuotaSection.hidden, true);
  assert.equal(h.nodes.sfPanel.hidden, true);
  assert.equal(h.nodes.testAI.disabled, true);
  assert.equal(h.nodes.modeBadge.textContent, 'Google 模式');
  // Loading is passive: no permission request, no worker message, no network.
  h.fire('sfRefresh', 'click'); h.fire('refreshFreeModels', 'click'); h.fire('freeStatus', 'click');
  h.fire('testAI', 'click'); h.fire('indexModel', 'change');
  await tick();
  assert.ok(!h.state.calls.some(call => Array.isArray(call) && (call[0] === 'permission' || call[0] === 'message')));
});
test('saving the B站 preset without any key requests only the official origin and stores a keyless config', async () => {
  const h = harness({ missingAiConfig: true }); await tick();
  h.chooseAIWithoutKey();
  assert.equal(h.nodes.apiKey.value, '');
  h.state.calls.length = 0;
  h.fire('settingsForm', 'submit');
  // The permission request happens synchronously inside the submit gesture.
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0][0], 'permission');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0][1])), { origins: [INDEX_ORIGIN] });
  assert.equal(h.nodes.saveSettings.disabled, true);
  await tick();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission', 'get', 'set']);
  assert.equal(h.state.settings.provider, 'ai');
  assert.equal(h.state.settings.aiService, 'indextranslate');
  assert.equal(h.state.settings.freeMode, false);
  assert.equal(h.state.aiConfig.service, 'indextranslate');
  assert.equal(h.state.aiConfig.baseUrl, INDEX_BASE);
  assert.equal(h.state.aiConfig.model, INDEX_MODEL);
  assert.equal(h.state.aiConfig.apiKey, '');
  assert.equal(h.state.aiConfig.freeOnly, true);
  assert.equal(h.nodes.modeBadge.textContent, 'B站 Index-Translate · 免 Key');
  assert.equal(h.nodes.testAI.disabled, false);
  assert.equal(h.nodes.saveStatus.dataset.success, 'true');
  assert.ok(h.nodes.saveStatus.textContent.includes('免 Key'));
  assert.ok(!JSON.stringify(h.permissions()).includes('openrouter.ai'));
  assert.ok(!JSON.stringify(h.permissions()).includes('siliconflow.cn'));
});
test('the saved B站 config tests without a key and sends only the TEST_AI message', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_INDEX } }); await tick();
  assert.equal(h.nodes.testAI.disabled, false);
  h.state.calls.length = 0;
  h.state.response = { ok: true, text: '样例译文', model: INDEX_MODEL };
  h.fire('testAI', 'click'); await tick();
  const sent = h.state.calls.filter(call => Array.isArray(call) && call[0] === 'message');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), { type: 'TEST_AI' });
  assert.ok(!JSON.stringify(h.state.calls).includes(KEY));
  assert.equal(h.permissions().length, 0);
  assert.equal(h.nodes.testText.textContent, '样例译文');
  assert.equal(h.nodes.testModel.textContent, '实际返回模型：' + INDEX_MODEL);
  assert.equal(h.nodes.testResult.hidden, false);
  assert.equal(h.nodes.testStatus.dataset.success, 'true');
  assert.ok(h.nodes.testStatus.textContent.includes('官方免费请求可能限流'));
  // A keyless B站 test must never consume or report OpenRouter / SiliconFlow state.
  assert.ok(!h.nodes.quotaStatus.textContent.includes('测试已消耗免费请求'));
  assert.equal(h.nodes.sfStatus.textContent, '');
  h.state.response = { ok: false, error: 'INDEX_BUSY' };
  h.fire('testAI', 'click'); await tick();
  assert.equal(h.nodes.testStatus.textContent, YTC.errors.INDEX_BUSY);
  assert.equal(h.nodes.testStatus.dataset.error, 'true');
});
test('the B站 preset accepts only the official endpoint and 35B/9B/2B models', async () => {
  assert.equal(YTC.validateIndexConfig({ baseUrl: INDEX_BASE, model: INDEX_MODEL, apiKey: '', freeOnly: true, service: 'indextranslate' }), true);
  for (const model of INDEX_MODELS.slice(1)) {
    assert.equal(YTC.validateIndexConfig({ baseUrl: INDEX_BASE, model, apiKey: '', freeOnly: true, service: 'indextranslate' }), true);
  }
  for (const bad of [
    { baseUrl: INDEX_BASE, model: 'Index-Translate-999B', apiKey: '', freeOnly: true, service: 'indextranslate' },
    { baseUrl: INDEX_BASE, model: 'gpt-4o', apiKey: '', freeOnly: true, service: 'indextranslate' },
    { baseUrl: 'https://index-translate.bilibili.com.evil.test/v1', model: INDEX_MODEL, apiKey: '', freeOnly: true, service: 'indextranslate' },
    { baseUrl: 'https://evil.example.test/v1', model: INDEX_MODEL, apiKey: '', freeOnly: true, service: 'indextranslate' },
    { baseUrl: 'http://index-translate.bilibili.com/v1', model: INDEX_MODEL, apiKey: '', freeOnly: true, service: 'indextranslate' },
    { baseUrl: INDEX_BASE, model: INDEX_MODEL, apiKey: '', freeOnly: false, service: 'indextranslate' }
  ]) {
    // Non-HTTPS endpoints fail earlier in aiEndpoint (AI_CONFIG); everything
    // else must be rejected by the index whitelist itself (INDEX_CONFIG).
    assert.throws(() => YTC.validateIndexConfig(bad), /INDEX_CONFIG|AI_CONFIG/);
  }
  // An official index URL forces the keyless service, whatever label was supplied.
  const forced = YTC.aiConfig({ baseUrl: INDEX_BASE, model: INDEX_MODEL, apiKey: KEY, service: 'custom', freeOnly: true });
  assert.equal(forced.service, 'indextranslate');
  assert.equal(forced.apiKey, '');
  assert.equal(YTC.isIndexConfig(forced), true);

  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_INDEX } }); await tick();
  h.nodes.indexModel.value = 'Index-Translate-9B'; h.fire('indexModel', 'change');
  assert.equal(h.nodes.model.value, 'Index-Translate-9B');
  await h.save();
  assert.equal(h.state.aiConfig.model, 'Index-Translate-9B');
  assert.equal(h.state.aiConfig.apiKey, '');
  assert.deepEqual(JSON.parse(JSON.stringify(h.permissions().at(-1)[1])), { origins: [INDEX_ORIGIN] });
  // Tampering with the read-only fields cannot smuggle a paid endpoint or model past save.
  h.state.calls.length = 0;
  h.nodes.baseUrl.value = 'https://evil.example.test/v1';
  h.nodes.indexModel.value = 'Index-Translate-999B';
  h.nodes.model.value = 'gpt-4o';
  h.fire('baseUrl', 'input'); h.fire('indexModel', 'change'); h.fire('model', 'input');
  await h.save();
  assert.equal(h.state.aiConfig.baseUrl, INDEX_BASE);
  assert.equal(h.state.aiConfig.model, INDEX_MODEL);
  assert.equal(h.state.aiConfig.apiKey, '');
  assert.deepEqual(JSON.parse(JSON.stringify(h.permissions().at(-1)[1])), { origins: [INDEX_ORIGIN] });
  assert.ok(!JSON.stringify(h.state.calls).includes('evil.example.test'));
});
test('switching to the B站 preset clears an old SiliconFlow or OpenRouter key and never sends it', async () => {
  for (const seed of [{ ...SAVED_SF }, { ...SAVED_OR, apiKey: KEY }]) {
    const h = harness({ settings: { provider: 'ai' }, aiConfig: seed }); await tick();
    assert.ok(['siliconflow-free', 'openrouter-free'].includes(h.nodes.preset.value));
    assert.equal(h.nodes.apiKey.value, KEY);
    h.chooseIndex();
    assert.equal(h.nodes.providerAI.checked, true);
    assert.equal(h.nodes.providerGoogle.checked, false);
    assert.equal(h.nodes.apiKey.value, '');
    assert.equal(h.nodes.apiKey.disabled, true);
    assert.equal(h.nodes.apiKeyField.hidden, true);
    assert.equal(h.nodes.baseUrl.value, INDEX_BASE);
    assert.equal(h.nodes.model.value, INDEX_MODEL);
    assert.equal(h.nodes.indexPanel.hidden, false);
    assert.equal(h.nodes.sfPanel.hidden, true);
    assert.equal(h.nodes.freePanel.hidden, true);
    assert.ok(h.nodes.saveStatus.textContent.includes('清空旧密钥'));
    h.state.calls.length = 0;
    h.fire('settingsForm', 'submit');
    assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0][1])), { origins: [INDEX_ORIGIN] });
    await tick();
    assert.equal(h.state.aiConfig.apiKey, '');
    assert.equal(h.state.aiConfig.service, 'indextranslate');
    assert.equal(h.state.settings.aiService, 'indextranslate');
    assert.equal(h.state.settings.freeMode, false);
    assert.ok(!JSON.stringify(h.permissions()).includes('siliconflow.cn'));
    assert.ok(!JSON.stringify(h.permissions()).includes('openrouter.ai'));
    assert.ok(!JSON.stringify(h.state.calls).includes(KEY));
  }
});
test('switching away from the B站 preset restores the key field empty and still requires a key', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_INDEX } }); await tick();
  assert.equal(h.nodes.apiKeyField.hidden, true);
  assert.equal(h.nodes.apiKey.disabled, true);
  h.nodes.preset.value = 'siliconflow-free'; h.fire('preset', 'change');
  assert.equal(h.nodes.apiKeyField.hidden, false);
  assert.equal(h.nodes.apiKey.disabled, false);
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.baseUrl.value, SILICON_BASE);
  h.state.calls.length = 0;
  h.fire('settingsForm', 'submit'); await tick();
  // No key is inherited from the keyless preset, so saving an SF config must fail.
  assert.equal(h.nodes.saveStatus.textContent, YTC.errors.AI_CONFIG);
  assert.equal(h.nodes.saveStatus.dataset.error, 'true');
  assert.equal(h.permissions().length, 0);
  assert.ok(!h.state.calls.includes('set'));
  assert.equal(h.state.aiConfig.apiKey, '');
  h.nodes.apiKey.value = KEY; h.fire('apiKey', 'input');
  await h.save();
  assert.equal(h.state.aiConfig.apiKey, KEY);
  assert.equal(h.state.settings.aiService, 'siliconflow');
  assert.deepEqual(JSON.parse(JSON.stringify(h.permissions()[0][1])), { origins: SILICON_ORIGINS });
  // Back to B站: the field is hidden and emptied again.
  h.chooseIndex();
  assert.equal(h.nodes.apiKeyField.hidden, true);
  assert.equal(h.nodes.apiKey.disabled, true);
  assert.equal(h.nodes.apiKey.value, '');
});
test('a saved B站 config hides OpenRouter quota and SiliconFlow controls and cannot trigger them', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_INDEX } }); await tick();
  assert.equal(h.nodes.indexPanel.hidden, false);
  assert.equal(h.nodes.freePanel.hidden, true);
  assert.equal(h.nodes.freeQuotaSection.hidden, true);
  assert.equal(h.nodes.sfPanel.hidden, true);
  assert.equal(h.nodes.freeStatus.disabled, true);
  assert.equal(h.nodes.refreshFreeModels.disabled, true);
  assert.equal(h.nodes.sfRefresh.disabled, true);
  assert.equal(h.nodes.modeBadge.textContent, 'B站 Index-Translate · 免 Key');
  h.state.calls.length = 0;
  h.fire('freeStatus', 'click');
  h.fire('refreshFreeModels', 'click');
  h.fire('sfRefresh', 'click');
  await tick();
  assert.deepEqual(h.sent('FREE_STATUS'), []);
  assert.deepEqual(h.sent('LIST_FREE_MODELS'), []);
  assert.deepEqual(h.sent('LIST_SILICON_MODELS'), []);
  assert.equal(h.permissions().length, 0);
  assert.ok(!h.nodes.quotaStatus.textContent.includes('免费请求'));
  assert.equal(h.nodes.apiKey.value, '');
});
test('an official B站 URL always drops the key, even when another service is selected', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_OR, apiKey: KEY } }); await tick();
  h.chooseCustom();
  h.nodes.apiKey.value = KEY; h.fire('apiKey', 'input');
  h.nodes.baseUrl.value = INDEX_BASE; h.fire('baseUrl', 'input');
  h.nodes.model.value = INDEX_MODEL; h.fire('model', 'input');
  h.state.calls.length = 0;
  h.fire('settingsForm', 'submit'); await tick();
  // The config is normalised to the keyless B站 service before validation; the
  // custom preset never claims index freeOnly, so it is refused before any
  // permission request and no stored key can be replayed.
  assert.equal(h.nodes.saveStatus.textContent, YTC.errors.AI_CONFIG);
  assert.equal(h.nodes.saveStatus.dataset.error, 'true');
  assert.equal(h.permissions().length, 0);
  assert.ok(!h.state.calls.includes('set'));
  assert.ok(!JSON.stringify(h.state.calls).includes(KEY));
  // The same guarantee holds without the UI.
  const forced = YTC.aiConfig({ baseUrl: INDEX_BASE, model: INDEX_MODEL, apiKey: KEY, service: 'siliconflow', freeOnly: true });
  assert.equal(forced.service, 'indextranslate');
  assert.equal(forced.apiKey, '');
  assert.equal(forced.freeOnly, true);
});
test('saved OpenRouter and SiliconFlow configs are never migrated to the B站 preset', async () => {
  const or = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_OR, apiKey: KEY } }); await tick();
  assert.equal(or.nodes.preset.value, 'openrouter-free');
  assert.notEqual(or.nodes.preset.value, 'index-translate-free');
  assert.equal(or.nodes.apiKey.value, KEY);
  assert.equal(or.nodes.apiKeyField.hidden, false);
  assert.equal(or.nodes.indexPanel.hidden, true);
  assert.equal(or.state.aiConfig.service, 'openrouter');
  assert.equal(or.state.aiConfig.baseUrl, OPENROUTER_BASE);

  const sf = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_SF } }); await tick();
  assert.equal(sf.nodes.preset.value, 'siliconflow-free');
  assert.notEqual(sf.nodes.preset.value, 'index-translate-free');
  assert.equal(sf.nodes.apiKey.value, KEY);
  assert.equal(sf.state.aiConfig.service, 'siliconflow');
  assert.equal(sf.state.aiConfig.baseUrl, SILICON_BASE);
});
test('selecting SiliconFlow clears the OpenRouter key and saves both origins before storage', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_OR, apiKey: KEY } });
  await tick();
  assert.equal(h.nodes.preset.value, 'openrouter-free');
  h.nodes.preset.value = 'siliconflow-free'; h.fire('preset', 'change');
  assert.equal(h.nodes.providerAI.checked, true);
  assert.equal(h.nodes.providerGoogle.checked, false);
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.baseUrl.value, SILICON_BASE);
  assert.equal(h.nodes.model.value, SILICON_MODEL);
  assert.equal(h.nodes.sfPanel.hidden, false);
  assert.equal(h.nodes.freePanel.hidden, true);
  assert.ok(h.nodes.saveStatus.textContent.includes('清空旧密钥'));
  h.nodes.apiKey.value = KEY; h.fire('apiKey', 'input');
  h.state.calls.length = 0;
  h.fire('settingsForm', 'submit');
  // Permission must be requested synchronously, before any storage read.
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0][0], 'permission');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0][1])), { origins: SILICON_ORIGINS });
  await tick();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission', 'get', 'set']);
  assert.equal(h.state.settings.provider, 'ai');
  assert.equal(h.state.settings.aiService, 'siliconflow');
  assert.equal(h.state.settings.freeMode, false);
  assert.equal(h.state.aiConfig.service, 'siliconflow');
  assert.equal(h.state.aiConfig.freeOnly, true);
  assert.equal(h.state.aiConfig.apiKey, KEY);
  assert.equal(h.nodes.sfRefresh.disabled, false);
  assert.ok(h.nodes.sfStatus.textContent.includes('已保存'));
});
test('SF refresh sends only LIST_SILICON_MODELS without a key and trusts the verified backend list', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_SF } });
  await tick();
  assert.equal(h.nodes.preset.value, 'siliconflow-free');
  assert.equal(h.nodes.sfRefresh.disabled, false);
  h.state.calls.length = 0;
  h.state.response = { ok: true, models: [
    { id: 'Qwen/Qwen3-8B', name: 'Qwen3-8B' },
    { id: 'Qwen/Qwen3.5-4B', name: '  Qwen3.5-4B  ' },
    // No pricing fields: the UI must not re-derive price, only trust the worker's verified set.
    { id: 'deepseek-ai/DeepSeek-V3' },
    { id: 'Pro/Qwen3-8B', name: 'Pro' },
    { id: 'not a model' },
    { id: 'Qwen/Qwen3-8B', name: 'duplicate' }
  ] };
  h.fire('sfRefresh', 'click');
  const sent = h.state.calls.filter(call => Array.isArray(call) && call[0] === 'message');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), { type: 'LIST_SILICON_MODELS' });
  assert.ok(!JSON.stringify(sent[0][1]).includes(KEY));
  await tick();
  assert.deepEqual(h.nodes.sfModel.options.map(option => option.value), ['Qwen/Qwen3-8B', 'Qwen/Qwen3.5-4B', 'deepseek-ai/DeepSeek-V3']);
  assert.equal(h.nodes.sfModel.options[1].textContent, 'Qwen3.5-4B · Qwen/Qwen3.5-4B');
  assert.equal(h.nodes.sfModel.options[2].textContent, 'deepseek-ai/DeepSeek-V3 · deepseek-ai/DeepSeek-V3');
  assert.equal(h.nodes.apiKey.value, KEY);
  assert.equal(h.nodes.sfStatus.dataset.success, 'true');
  assert.ok(h.nodes.sfStatus.textContent.includes('已核验 3 个'));
});
test('SF refresh is disabled while dirty and a failed verification keeps the saved key and model', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_SF } });
  await tick();
  h.nodes.apiKey.value = KEY + '-changed'; h.fire('apiKey', 'input');
  assert.equal(h.nodes.sfRefresh.disabled, true);
  h.state.calls.length = 0;
  h.fire('sfRefresh', 'click');
  assert.equal(h.state.calls.length, 0);
  await h.save();
  h.state.calls.length = 0;
  h.state.response = { ok: false, error: 'SF_CATALOG' };
  h.fire('sfRefresh', 'click'); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent('LIST_SILICON_MODELS'))), [{ type: 'LIST_SILICON_MODELS' }]);
  assert.equal(h.nodes.sfStatus.textContent, YTC.errors.SF_CATALOG);
  assert.equal(h.nodes.sfStatus.dataset.error, 'true');
  assert.equal(h.nodes.apiKey.value, KEY + '-changed');
  assert.equal(h.state.aiConfig.apiKey, KEY + '-changed');
  assert.equal(h.state.aiConfig.model, SILICON_MODEL);
  // An empty verified intersection is also a stop, never a silent paid fallback.
  h.state.response = { ok: true, models: [] };
  h.fire('sfRefresh', 'click'); await tick();
  assert.ok(h.nodes.sfStatus.textContent.includes('交集为空'));
  assert.equal(h.nodes.apiKey.value, KEY + '-changed');
  assert.ok(!h.sent('FREE_STATUS').length);
});
test('a saved SiliconFlow config offers no OpenRouter quota and never sends FREE_STATUS', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_SF } });
  await tick();
  assert.equal(h.nodes.freePanel.hidden, true);
  assert.equal(h.nodes.freeQuotaSection.hidden, true);
  assert.equal(h.nodes.freeStatus.disabled, true);
  assert.equal(h.nodes.refreshFreeModels.disabled, true);
  assert.equal(h.nodes.modeBadge.textContent, '硅基流动 · 零价模型');
  h.state.calls.length = 0;
  h.fire('freeStatus', 'click'); h.fire('refreshFreeModels', 'click'); await tick();
  assert.deepEqual(h.sent('FREE_STATUS'), []);
  assert.deepEqual(h.sent('LIST_FREE_MODELS'), []);
  assert.equal(h.nodes.apiKey.value, KEY);
});
test('switching from SiliconFlow to OpenRouter clears the key and requests only the OpenRouter origin', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_SF } });
  await tick();
  assert.equal(h.nodes.preset.value, 'siliconflow-free');
  h.nodes.preset.value = 'openrouter-free'; h.fire('preset', 'change');
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.baseUrl.value, OPENROUTER_BASE);
  assert.equal(h.nodes.model.value, 'openrouter/free');
  assert.equal(h.nodes.sfPanel.hidden, true);
  assert.equal(h.nodes.freePanel.hidden, false);
  h.nodes.apiKey.value = KEY; h.fire('apiKey', 'input');
  h.state.calls.length = 0;
  h.fire('settingsForm', 'submit');
  assert.equal(h.state.calls[0][0], 'permission');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0][1])), { origins: [OPENROUTER_ORIGIN] });
  await tick();
  assert.equal(h.state.settings.freeMode, true);
  assert.equal(h.state.settings.aiService, 'openrouter');
  assert.equal(h.state.aiConfig.service, 'openrouter');
  assert.equal(h.state.aiConfig.freeOnly, true);
  assert.equal(h.state.aiConfig.apiKey, KEY);
  assert.ok(!JSON.stringify(h.permissions()).includes('siliconflow.cn'));
});
test('SF save rejects Pro models, malformed ids and non-official endpoints before permission', async () => {
  const h = harness({ settings: { provider: 'ai' }, aiConfig: { ...SAVED_SF } });
  await tick();
  async function rejected() {
    h.state.calls.length = 0;
    h.fire('settingsForm', 'submit'); await tick();
    assert.equal(h.nodes.saveStatus.textContent, YTC.errors.SF_NOT_FREE);
    assert.equal(h.nodes.saveStatus.dataset.error, 'true');
    assert.equal(h.permissions().length, 0);
    assert.ok(!h.state.calls.includes('set'));
    assert.equal(h.nodes.apiKey.value, KEY);
  }
  h.nodes.model.value = 'Pro/Qwen3-8B'; h.fire('model', 'input'); await rejected();
  h.nodes.model.value = 'Qwen3-8B'; h.fire('model', 'input'); await rejected();
  h.nodes.model.value = SILICON_MODEL; h.fire('model', 'input');
  h.nodes.baseUrl.value = 'https://api.siliconflow.com/v1'; h.fire('baseUrl', 'input'); await rejected();
  h.nodes.baseUrl.value = OPENROUTER_BASE; h.fire('baseUrl', 'input'); await rejected();
});
test('legacy base/model without freeOnly is not auto-upgraded and keeps its key', async () => {
  assert.equal(YTC.aiConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }).freeOnly, false);
  const h = harness({
    settings: { provider: 'ai' },
    aiConfig: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: KEY }
  });
  await tick();
  assert.deepEqual(h.state.calls, ['get']);
  assert.equal(h.nodes.preset.value, 'deepseek');
  assert.notEqual(h.nodes.preset.value, 'openrouter-free');
  assert.equal(h.nodes.baseUrl.value, 'https://api.deepseek.com/v1');
  assert.equal(h.nodes.model.value, 'deepseek-flash');
  assert.equal(h.nodes.apiKey.value, KEY);
  assert.equal(h.nodes.baseUrl.readOnly, false);
  assert.equal(h.nodes.model.readOnly, false);
  assert.equal(h.nodes.freePanel.hidden, true);
  assert.equal(h.nodes.testAI.disabled, false);
  assert.equal(h.nodes.freeStatus.disabled, true);
  assert.equal(h.state.settings.freeMode, false);
  assert.equal(h.state.aiConfig.freeOnly, undefined);
});
test('selecting the free preset enables AI, clears the key and locks the endpoint fields', async () => {
  const h = harness({
    settings: { provider: 'ai' },
    aiConfig: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: KEY, freeOnly: false }
  });
  await tick();
  assert.equal(h.nodes.baseUrl.readOnly, false);
  h.nodes.preset.value = 'openrouter-free'; h.fire('preset', 'change');
  assert.equal(h.nodes.providerAI.checked, true);
  assert.equal(h.nodes.providerGoogle.checked, false);
  assert.equal(h.nodes.baseUrl.value, OPENROUTER_BASE);
  assert.equal(h.nodes.model.value, 'openrouter/free');
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.baseUrl.readOnly, true);
  assert.equal(h.nodes.model.readOnly, true);
  assert.equal(h.nodes.freePanel.hidden, false);
  assert.equal(h.nodes.freeQuotaSection.hidden, false);
  assert.ok(h.nodes.saveStatus.textContent.includes('清空旧密钥'));
  assert.equal(h.nodes.testAI.disabled, true);
  assert.equal(h.nodes.refreshFreeModels.disabled, false);
  assert.equal(h.nodes.freeModel.options[0].value, 'openrouter/free');
});
test('saving the free preset stores settings.freeMode while preserving enabled and display', async () => {
  const h = harness(); await tick(); h.chooseAI();
  h.state.settings.enabled = false;
  h.state.settings.display = 'translation';
  await h.save();
  assert.equal(h.state.settings.freeMode, true);
  assert.equal(h.state.settings.enabled, false);
  assert.equal(h.state.settings.display, 'translation');
  assert.equal(h.state.aiConfig.freeOnly, true);
  assert.equal(h.nodes.saveStatus.dataset.success, 'true');
  assert.ok(h.nodes.saveStatus.textContent.includes('仅免费'));
});
test('tampered paid model or endpoint is rejected before any permission request', async () => {
  const paidModel = harness(); await tick(); paidModel.chooseAI(); await paidModel.save();
  paidModel.state.calls.length = 0;
  paidModel.nodes.model.value = 'openai/gpt-4o';
  paidModel.fire('model', 'input');
  paidModel.fire('settingsForm', 'submit'); await tick();
  assert.equal(paidModel.nodes.saveStatus.textContent, YTC.errors.FREE_ONLY);
  assert.equal(paidModel.nodes.saveStatus.dataset.error, 'true');
  assert.equal(paidModel.permissions().length, 0);
  assert.ok(!paidModel.sent('TEST_AI').length);
  assert.equal(paidModel.nodes.apiKey.value, KEY);

  const paidEndpoint = harness(); await tick(); paidEndpoint.chooseAI(); await paidEndpoint.save();
  paidEndpoint.state.calls.length = 0;
  paidEndpoint.nodes.baseUrl.value = 'https://paid.example.test/v1';
  paidEndpoint.fire('settingsForm', 'submit'); await tick();
  assert.equal(paidEndpoint.nodes.saveStatus.textContent, YTC.errors.FREE_ONLY);
  assert.ok(!paidEndpoint.nodes.saveStatus.textContent.includes('paid.example.test'));
  assert.equal(paidEndpoint.permissions().length, 0);
  assert.equal(paidEndpoint.nodes.apiKey.value, KEY);
  assert.ok(!paidEndpoint.state.calls.includes('set'));
});
test('refreshing the catalog requests permission first, sends only LIST_FREE_MODELS, keeps the key and filters non-free models', async () => {
  const h = harness(); await tick(); h.chooseAI(); await h.save();
  assert.equal(h.nodes.refreshFreeModels.disabled, false);
  h.state.calls.length = 0;
  h.state.response = { ok: true, models: [
    { id: 'openrouter/free', name: 'duplicate router' },
    { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Lightning Free' },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma Free' },
    { id: 'meta/llama:free', name: '  Llama Free  ' },
    { id: 'openai/gpt-4o', name: 'Paid' },
    { id: 'paid/model', name: 'Paid two' },
    { id: 'weird id:free', name: 'bad id' },
    { id: 'a/b:free', name: '' },
    { id: 'a/b:free', name: 'duplicate free' }
  ] };
  h.fire('refreshFreeModels', 'click');
  // The origin permission is requested synchronously, before the catalog message.
  assert.equal(h.state.calls[0][0], 'permission');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0][1])), { origins: [OPENROUTER_ORIGIN] });
  await tick();
  const sent = h.state.calls.filter(call => Array.isArray(call) && call[0] === 'message');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), { type: 'LIST_FREE_MODELS' });
  assert.ok(!JSON.stringify(sent[0][1]).includes(KEY));
  assert.equal(h.nodes.apiKey.value, KEY);
  const options = h.nodes.freeModel.options;
  assert.deepEqual(options.map(option => option.value), ['openrouter/free', 'nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-31b-it:free']);
  assert.equal(options[1].textContent, 'Lightning Free · nvidia/nemotron-3.5-lightning:free');
  assert.equal(options[2].textContent, 'Gemma Free · google/gemma-4-31b-it:free');
  assert.equal(h.nodes.freeModel.value, 'openrouter/free');
  assert.equal(h.nodes.catalogStatus.dataset.success, 'true');
  assert.ok(h.nodes.catalogStatus.textContent.includes('已刷新'));
});
test('free status stays available only for a saved free-mode config and reports counts', async () => {
  const h = harness(); await tick();
  assert.equal(h.nodes.freeStatus.disabled, true);
  h.chooseAI(); await h.save();
  assert.equal(h.nodes.freeStatus.disabled, false);
  h.state.calls.length = 0;
  h.state.response = { ok: true, used: 2, limit: 50, remaining: 48 };
  h.fire('freeStatus', 'click'); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent('FREE_STATUS'))), [{ type: 'FREE_STATUS' }]);
  assert.ok(h.nodes.quotaStatus.textContent.includes('已用 2 次'));
  assert.ok(h.nodes.quotaStatus.textContent.includes('上限 50 次'));
  assert.ok(h.nodes.quotaStatus.textContent.includes('剩余 48 次'));
  assert.equal(h.nodes.quotaStatus.dataset.success, 'true');
  h.chooseCustom(); await h.save();
  assert.equal(h.state.aiConfig.freeOnly, false);
  assert.equal(h.nodes.freeStatus.disabled, true);
});
test('connection test shows the actual model as plain text and maps error codes', async () => {
  const h = harness(); await tick(); h.chooseAI(); await h.save();
  h.state.response = { ok: true, text: '样例译文', model: '  openrouter/free  ' };
  h.fire('testAI', 'click'); await tick();
  assert.equal(h.nodes.testText.textContent, '样例译文');
  assert.equal(h.nodes.testModel.textContent, '实际返回模型：openrouter/free');
  assert.equal(h.nodes.testModel.hidden, false);
  h.state.response = { ok: true, text: '样例译文', model: '<b>free</b>' };
  h.fire('testAI', 'click'); await tick();
  assert.equal(h.nodes.testModel.textContent, '实际返回模型：<b>free</b>');
  assert.equal(h.nodes.testStatus.dataset.success, 'true');
  h.state.response = { ok: false, error: 'AI_AUTH', detail: 'upstream says test-only-key is invalid' };
  h.fire('testAI', 'click'); await tick();
  assert.equal(h.nodes.testStatus.textContent, YTC.errors.AI_AUTH);
  assert.ok(!h.nodes.testStatus.textContent.includes('upstream says'));
  assert.equal(h.nodes.testStatus.dataset.error, 'true');
});
test('switching to custom disables freeOnly; switching to Google disables settings.freeMode', async () => {
  const h = harness(); await tick(); h.chooseAI(); await h.save();
  assert.equal(h.state.settings.freeMode, true);
  assert.equal(h.state.aiConfig.freeOnly, true);
  h.nodes.providerAI.checked = false; h.nodes.providerGoogle.checked = true;
  h.fire('providerGoogle', 'change');
  h.state.calls.length = 0; await h.save();
  assert.equal(h.state.settings.provider, 'google');
  assert.equal(h.state.settings.freeMode, false);
  assert.equal(h.permissions().length, 0);
  h.chooseCustom(); await h.save();
  assert.equal(h.state.settings.provider, 'ai');
  assert.equal(h.state.aiConfig.freeOnly, false);
  assert.equal(h.state.settings.freeMode, false);
  assert.equal(h.nodes.preset.value, 'custom');
  assert.equal(h.nodes.baseUrl.readOnly, false);
});

// Dual search is an independent preference: these tests pin the default-on
// state, the local-only toggle, and the explicit user-gesture grant flow. They
// also prove the original AI save form never drops an explicitly disabled value.
test('dual search defaults on at load without permissions, messages or network', async () => {
  const h = harness(); await tick();
  assert.equal(h.state.settings.dualSearch, true);
  assert.equal(h.nodes.dualSearch.checked, true);
  assert.equal(h.nodes.dualSearch.disabled, false);
  assert.equal(h.nodes.grantDualSearch.disabled, false);
  assert.equal(h.nodes.dualSearchStatus.textContent, '');
  // Loading is still a single local read of both settings keys: no permission
  // request, no worker message and therefore no network.
  assert.deepEqual(h.state.calls, ['get']);
  assert.deepEqual(h.state.getCalls, [['settings', 'aiConfig']]);
  assert.equal(h.permissions().length, 0);
  assert.equal(h.sent('LIST_FREE_MODELS').length, 0);
  assert.ok(!h.state.calls.some(call => Array.isArray(call) && call[0] === 'message'));
});
test('turning the independent dual-search switch off writes only settings.dualSearch', async () => {
  const h = harness({
    settings: {
      provider: 'ai', aiService: 'siliconflow', useContext: false,
      enabled: false, display: 'translation', dualSearch: true
    },
    aiConfig: { ...SAVED_SF }
  });
  await tick();
  const originalConfig = h.state.aiConfig;
  h.clearCalls();
  h.setDualSearch(false);
  // The local preference read starts synchronously; no permission is involved.
  assert.deepEqual(h.state.calls, ['get']);
  await tick();
  assert.deepEqual(h.state.calls, ['get', 'set']);
  assert.deepEqual(h.state.getCalls, [['settings']]);
  assert.equal(h.state.setCalls.length, 1);
  assert.deepEqual(Object.keys(h.state.setCalls[0]), ['settings']);
  assert.equal(h.state.settings.dualSearch, false);
  // The comment service, AI config and the rest of the settings are untouched.
  assert.equal(h.state.settings.provider, 'ai');
  assert.equal(h.state.settings.aiService, 'siliconflow');
  assert.equal(h.state.settings.useContext, false);
  assert.equal(h.state.settings.enabled, false);
  assert.equal(h.state.settings.display, 'translation');
  assert.equal(h.state.aiConfig, originalConfig);
  assert.equal(h.nodes.dualSearch.checked, false);
  assert.equal(h.nodes.dualSearchStatus.dataset.success, 'true');
  assert.ok(h.nodes.dualSearchStatus.textContent.includes('关闭'));
  assert.equal(h.permissions().length, 0);
  assert.ok(!JSON.stringify(h.state.calls).includes(KEY));
});
test('re-checking dual search only stores true and points at the authorization button', async () => {
  const h = harness({ settings: { dualSearch: false } }); await tick();
  assert.equal(h.nodes.dualSearch.checked, false);
  h.clearCalls();
  h.setDualSearch(true);
  await tick();
  assert.deepEqual(h.state.calls, ['get', 'set']);
  assert.deepEqual(h.state.getCalls, [['settings']]);
  assert.equal(h.state.setCalls.length, 1);
  assert.deepEqual(Object.keys(h.state.setCalls[0]), ['settings']);
  assert.equal(h.state.settings.dualSearch, true);
  assert.equal(h.nodes.dualSearch.checked, true);
  // Enabling the preference alone must not request the B站 origin.
  assert.equal(h.permissions().length, 0);
  assert.ok(h.nodes.dualSearchStatus.textContent.includes('授权'));
  assert.equal(h.nodes.grantDualSearch.disabled, false);
});
test('granting dual search requests one B站 origin inside the gesture and merges only dualSearch', async () => {
  const cases = [
    {
      label: 'SiliconFlow',
      settings: {
        provider: 'ai', aiService: 'siliconflow', useContext: false,
        enabled: false, display: 'translation', dualSearch: false
      },
      aiConfig: { ...SAVED_SF }
    },
    {
      label: 'OpenRouter',
      settings: {
        provider: 'ai', aiService: 'openrouter', useContext: true,
        enabled: true, display: 'bilingual', dualSearch: false
      },
      aiConfig: { ...SAVED_OR }
    }
  ];
  for (const item of cases) {
    const h = harness({ settings: item.settings, aiConfig: item.aiConfig });
    await tick();
    const originalConfig = h.state.aiConfig;
    h.clearCalls();
    h.grantDualSearch();
    // The permission request is synchronous inside the click gesture: it is the
    // very first recorded action, before any storage read or await.
    assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission'], item.label);
    assert.deepEqual(JSON.parse(JSON.stringify(h.permissions()[0][1])), { origins: [DUAL_ORIGIN] }, item.label);
    assert.equal(h.nodes.grantDualSearch.disabled, true, item.label);
    await tick();
    assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission', 'get', 'set'], item.label);
    // Only settings is read; aiConfig is never touched and its key never travels.
    assert.deepEqual(h.state.getCalls, [['settings']], item.label);
    assert.equal(h.state.setCalls.length, 1, item.label);
    assert.deepEqual(Object.keys(h.state.setCalls[0]), ['settings'], item.label);
    assert.equal(h.state.settings.dualSearch, true, item.label);
    assert.equal(h.state.settings.provider, 'ai', item.label);
    assert.equal(h.state.settings.aiService, item.settings.aiService, item.label);
    assert.equal(h.state.settings.useContext, item.settings.useContext, item.label);
    assert.equal(h.state.settings.enabled, item.settings.enabled, item.label);
    assert.equal(h.state.settings.display, item.settings.display, item.label);
    assert.equal(h.state.aiConfig, originalConfig, item.label);
    assert.equal(h.nodes.dualSearch.checked, true, item.label);
    assert.equal(h.nodes.grantDualSearch.disabled, false, item.label);
    assert.equal(h.nodes.dualSearchStatus.dataset.success, 'true', item.label);
    assert.ok(h.nodes.dualSearchStatus.textContent.includes('已授权'), item.label);
    assert.ok(!JSON.stringify(h.state.calls).includes(KEY), item.label);
  }
});
test('declining the B站 grant writes nothing and can be retried successfully', async () => {
  const h = harness({ settings: { dualSearch: false } }); await tick();
  h.state.grant = false;
  h.clearCalls();
  h.grantDualSearch();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission']);
  await tick();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission']);
  assert.equal(h.state.setCalls.length, 0);
  assert.equal(h.state.settings.dualSearch, false);
  assert.equal(h.nodes.dualSearch.checked, false);
  assert.equal(h.nodes.dualSearchStatus.dataset.error, 'true');
  assert.ok(h.nodes.dualSearchStatus.textContent.includes('未获得'));
  assert.equal(h.nodes.grantDualSearch.disabled, false);
  // A later gesture may retry and then persist the merged true value.
  h.state.grant = true;
  h.clearCalls();
  h.grantDualSearch();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission']);
  await tick();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission', 'get', 'set']);
  assert.equal(h.state.settings.dualSearch, true);
  assert.equal(h.nodes.dualSearchStatus.dataset.success, 'true');
});
test('saving the AI form preserves an explicitly disabled dual-search preference', async () => {
  const h = harness({ settings: { dualSearch: false } }); await tick();
  assert.equal(h.nodes.dualSearch.checked, false);
  h.chooseAI();
  await h.save();
  assert.equal(h.state.settings.provider, 'ai');
  assert.equal(h.state.settings.dualSearch, false);
  assert.equal(h.nodes.dualSearch.checked, false);
  assert.equal(h.state.aiConfig.apiKey, KEY);
  // The AI form's permission is for its own origin, never the B站 dual-search one.
  assert.ok(h.permissions().every(call => !JSON.stringify(call[1]).includes('index-translate.bilibili.com')));
});
test('the grant button works with no AI config or key while Google is selected and comments are disabled', async () => {
  const h = harness({
    settings: { provider: 'google', enabled: false, dualSearch: false },
    missingAiConfig: true
  });
  await tick();
  assert.equal(h.nodes.providerGoogle.checked, true);
  assert.equal(h.state.aiConfig, undefined);
  assert.equal(h.nodes.apiKey.value, '');
  assert.equal(h.nodes.grantDualSearch.disabled, false);
  h.clearCalls();
  h.grantDualSearch();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission']);
  await tick();
  assert.deepEqual(h.state.calls.map(call => Array.isArray(call) ? call[0] : call), ['permission', 'get', 'set']);
  assert.deepEqual(h.state.getCalls, [['settings']]);
  assert.equal(h.state.setCalls.length, 1);
  assert.deepEqual(Object.keys(h.state.setCalls[0]), ['settings']);
  assert.equal(h.state.settings.dualSearch, true);
  assert.equal(h.state.settings.provider, 'google');
  assert.equal(h.state.settings.enabled, false);
  assert.equal(h.state.aiConfig, undefined);
  assert.ok(!JSON.stringify(h.state.calls).includes(KEY));
});
