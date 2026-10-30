'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./worker-harness.cjs');
const YTC = require('../extension/shared.js');

const PAGE = 'https://www.siliconflow.cn/models';
const API = 'https://api.siliconflow.cn';
const ENDPOINT = API + '/v1/chat/completions';
const KEY = 'sf-test-only-key';
const OPTIONS_SENDER = { url: 'chrome-extension://test/options.html' };

function textResponse(body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries({ 'Content-Type': 'text/html; charset=utf-8', ...headers }).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => map.get(String(name).toLowerCase()) ?? null },
    text: async () => body,
    json: async () => JSON.parse(body)
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries({ 'Content-Type': 'application/json', ...headers }).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => map.get(String(name).toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

function baseModel(overrides = {}) {
  return {
    modelId: 'synthetic-test-model-id',
    modelName: 'Qwen/Qwen3-8B',
    mf: 'Qwen',
    desc: 'A general chat model',
    DisplayName: 'Qwen3-8B',
    status: 'normal',
    type: 'text',
    subType: 'chat',
    pricing: [
      { price: '0', specification: 'prompt', unitOfGood: '/ M Tokens' },
      { price: '0', specification: 'completion', unitOfGood: '/ M Tokens' }
    ],
    modelInfo: [{ Level: 0, RPM: 1000, TPM: 50000 }],
    ...overrides
  };
}

function page(models) {
  const payload = '0:["$","div",null,{"data":' + JSON.stringify(models) + '}]';
  return '<!doctype html><html><body><script>self.__next_f.push(' + JSON.stringify([1, payload]) + ');</script></body></html>';
}

function success(content, extra = {}) {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    model: 'Qwen/Qwen3-8B',
    usage: { cost: 0 },
    ...extra
  });
}

function sfConfig(overrides = {}) {
  return {
    service: 'siliconflow',
    baseUrl: API + '/v1',
    model: 'Qwen/Qwen3-8B',
    apiKey: KEY,
    freeOnly: true,
    ...overrides
  };
}

function configure(h, { settings = {}, aiConfig = {} } = {}) {
  h.data.local.settings = { ...YTC.DEFAULTS, provider: 'ai', aiService: 'siliconflow', enabled: true, useContext: true, ...settings };
  h.data.local.aiConfig = { ...sfConfig(), ...aiConfig };
}

function accountResponse(ids) {
  return jsonResponse({ data: ids.map(id => ({ id, object: 'model' })) });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('LIST_SILICON_MODELS is options-only and intersects zero-price catalog with the account without leaking the key', async t => {
  const catalog = [
    baseModel(),
    baseModel({ modelName: 'Qwen/Qwen2.5-7B-Instruct', DisplayName: 'Qwen2.5-7B-Instruct' }),
    baseModel({ modelName: 'Qwen/Qwen3-8B-Paid', DisplayName: 'Qwen3-8B Paid', pricing: [{ price: '1', specification: 'prompt' }, { price: '0', specification: 'completion' }] }),
    baseModel({ modelName: 'Qwen/Qwen3-4B', DisplayName: 'Qwen3-4B', pricing: [{ price: '0', specification: 'prompt' }] })
  ];
  const accountIds = ['Qwen/Qwen3-8B', 'Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen3-8B-Paid', 'Qwen/Qwen3-4B', 'Qwen/Qwen3-Coder-8B'];
  const state = { page: 0, account: 0, pageOptions: [], accountOptions: [] };
  const h = harness(async (url, options = {}) => {
    if (url === PAGE) {
      state.page++;
      state.pageOptions.push(options);
      return textResponse(page(catalog));
    }
    if (url === API + '/v1/models') {
      state.account++;
      state.accountOptions.push(options);
      return accountResponse(accountIds);
    }
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  configure(h);

  await assert.rejects(h.send({ type: 'LIST_SILICON_MODELS' }), /UNAUTHORIZED/);
  assert.equal(state.page + state.account, 0);

  const result = await h.send({ type: 'LIST_SILICON_MODELS' }, OPTIONS_SENDER);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.models, model => model.id).sort(), ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen3-8B'].sort());
  assert.equal(state.page, 1);
  assert.equal(state.account, 1);

  const pageOptions = state.pageOptions[0];
  assert.equal(Object.hasOwn(pageOptions.headers || {}, 'Authorization'), false);
  assert.equal(pageOptions.credentials, 'omit');
  assert.equal(pageOptions.redirect, 'error');
  assert.equal(pageOptions.referrerPolicy, 'no-referrer');

  const accountOptions = state.accountOptions[0];
  assert.deepEqual(Object.keys(accountOptions.headers), ['Authorization']);
  assert.equal(accountOptions.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(accountOptions.credentials, 'omit');
  assert.equal(accountOptions.redirect, 'error');

  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!JSON.stringify(result).includes('Qwen3-8B-Paid'));
  assert.ok(!JSON.stringify(result).includes('Qwen/Qwen3-4B'));
});

test('TRANSLATE with a SiliconFlow config only posts to the SF endpoint, cleans think/JSON output and caches the cleaned text', async t => {
  const state = { urls: [], posts: [] };
  const cleaned = '这太带劲了，他这波发挥太强了。';
  const h = harness(async (url, options = {}) => {
    state.urls.push(url);
    if (url === PAGE) return textResponse(page([baseModel()]));
    if (url === API + '/v1/models') return accountResponse(['Qwen/Qwen3-8B']);
    if (url === ENDPOINT) {
      state.posts.push({ url, options, body: JSON.parse(options.body) });
      return success('<think>I will translate this comment.</think>{"translation":"' + cleaned + '"}');
    }
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  configure(h);

  const text = 'This slaps. He really cooked with this one.';
  const result = await h.send({ type: 'TRANSLATE', text });
  assert.equal(result.ok, true);
  assert.equal(result.text, cleaned);
  assert.equal(result.cached, false);
  assert.equal(result.model, 'Qwen/Qwen3-8B');
  assert.equal(result.engine, 'ai');

  assert.equal(state.posts.length, 1);
  const post = state.posts[0];
  assert.equal(post.url, ENDPOINT);
  assert.equal(post.body.model, 'Qwen/Qwen3-8B');
  assert.equal(post.body.temperature, 0.2);
  assert.equal(post.body.enable_thinking, false);
  assert.equal(post.body.stream, false);
  assert.equal(post.body.provider, undefined);
  assert.equal(post.body.reasoning, undefined);
  assert.equal(post.body.response_format, undefined);
  assert.equal(post.options.headers.Authorization, 'Bearer ' + KEY);
  assert.ok(state.urls.every(url => url.startsWith('https://www.siliconflow.cn/') || url.startsWith('https://api.siliconflow.cn/')));

  const cached = await h.send({ type: 'TRANSLATE', text });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.equal(cached.text, cleaned);
  assert.equal(state.posts.length, 1);

  for (let attempt = 0; attempt < 40 && !h.data.session.translations; attempt++) await delay(50);
  assert.ok(Array.isArray(h.data.session.translations));
  const stored = JSON.stringify(h.data.session.translations);
  assert.ok(stored.includes(cleaned));
  assert.ok(!stored.includes('<think>'));
  assert.ok(!stored.includes('{"translation"'));
});

test('upstream errors and untranslated output are not cached', async t => {
  const text = 'This is a really great video';
  let mode = 'error';
  let posts = 0;
  const h = harness(async (url, options = {}) => {
    if (url === PAGE) return textResponse(page([baseModel()]));
    if (url === API + '/v1/models') return accountResponse(['Qwen/Qwen3-8B']);
    if (url === ENDPOINT) {
      posts++;
      assert.equal(options.headers.Authorization, 'Bearer ' + KEY);
      if (mode === 'error') return jsonResponse({ error: { code: 500, message: 'upstream failed' } }, { status: 500 });
      if (mode === 'untranslated') return success(text);
      return success('这个视频真的很棒。');
    }
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  configure(h);

  const failed = await h.send({ type: 'TRANSLATE', text });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'SF_BUSY');
  assert.equal(posts, 1);
  assert.ok(!JSON.stringify(failed).includes(KEY));

  mode = 'untranslated';
  const untranslated = await h.send({ type: 'TRANSLATE', text });
  assert.equal(untranslated.ok, false);
  assert.equal(untranslated.error, 'OUTPUT_UNTRANSLATED');
  assert.equal(posts, 2);

  mode = 'good';
  const recovered = await h.send({ type: 'TRANSLATE', text });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.cached, false);
  assert.equal(recovered.text, '这个视频真的很棒。');
  assert.equal(posts, 3);
});

test('FREE_STATUS with a saved SiliconFlow config never calls OpenRouter or sends its key', async t => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return jsonResponse({ data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
  });
  t.after(h.dispose);
  configure(h);

  const result = await h.send({ type: 'FREE_STATUS' }, OPTIONS_SENDER);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FREE_ONLY');
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('hand-edited service/base mismatches are rejected before any key-bearing request', async t => {
  const cases = [
    { label: 'service switched to openrouter with the SF base', aiConfig: sfConfig({ service: 'openrouter' }), error: 'FREE_ONLY' },
    { label: 'siliconflow service pointed at the OpenRouter base', aiConfig: sfConfig({ baseUrl: 'https://openrouter.ai/api/v1' }), error: 'SF_NOT_FREE' }
  ];
  for (const entry of cases) {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      return jsonResponse({ data: [] });
    });
    configure(h, { aiConfig: entry.aiConfig });
    const result = await h.send({ type: 'TRANSLATE', text: 'This is a really great video' });
    h.dispose();
    assert.equal(result.ok, false, entry.label);
    assert.equal(result.error, entry.error, entry.label);
    assert.equal(calls, 0, entry.label);
    assert.ok(!JSON.stringify(result).includes(KEY), entry.label);
  }
});

test('a non-zero or incomplete price proof is rejected before POST', async t => {
  const models = [
    baseModel({ modelName: 'Qwen/Qwen3-8B', pricing: [{ price: '1', specification: 'prompt' }, { price: '0', specification: 'completion' }] })
  ];
  let pageCalls = 0;
  let accountCalls = 0;
  let posts = 0;
  const h = harness(async (url) => {
    if (url === PAGE) {
      pageCalls++;
      return textResponse(page(models));
    }
    if (url === API + '/v1/models') {
      accountCalls++;
      return accountResponse(['Qwen/Qwen3-8B']);
    }
    if (url === ENDPOINT) {
      posts++;
      return success('这个视频真的很棒。');
    }
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  configure(h);

  const result = await h.send({ type: 'TRANSLATE', text: 'This is a really great video' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SF_CATALOG');
  assert.equal(pageCalls, 1);
  assert.equal(accountCalls, 0);
  assert.equal(posts, 0);
  assert.ok(!JSON.stringify(result).includes(KEY));
});
