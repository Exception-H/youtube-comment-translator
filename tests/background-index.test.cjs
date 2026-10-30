'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./worker-harness.cjs');
const YTC = require('../extension/shared.js');

const ORIGIN = 'https://index-translate.bilibili.com';
const BASE = ORIGIN + '/v1';
const CATALOG = BASE + '/models';
const ENDPOINT = BASE + '/chat/completions';
const MODEL = 'Index-Translate-35B-A3B';
const SAMPLE = 'This slaps. He really cooked with this one.';
const SAMPLE_TITLE = 'A musician performs an impressive guitar solo';
const CLEAN = '这太带劲了，他这波发挥太强了。';
const OPTIONS_SENDER = { url: 'chrome-extension://test/options.html' };

function rawResponse(body, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  const map = new Map(Object.entries({ 'Content-Type': contentType, ...headers }).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => map.get(String(name).toLowerCase()) ?? null },
    text: async () => body,
    json: async () => JSON.parse(body)
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return rawResponse(JSON.stringify(body), { status, contentType: 'application/json', headers });
}

function catalogResponse(ids = [MODEL]) {
  return jsonResponse({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) });
}

function completion(content, { model = MODEL, finish = 'stop', ...extra } = {}) {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: finish }],
    model,
    ...extra
  });
}

function indexConfig(overrides = {}) {
  return { service: 'indextranslate', baseUrl: BASE, model: MODEL, apiKey: '', freeOnly: true, ...overrides };
}

function configure(h, { settings = {}, aiConfig = {} } = {}) {
  h.data.local.settings = {
    ...YTC.DEFAULTS,
    enabled: true,
    provider: 'ai',
    useContext: true,
    freeMode: false,
    aiService: 'indextranslate',
    ...settings
  };
  h.data.local.aiConfig = { ...indexConfig(), ...aiConfig };
}

function authorization(call) {
  return call.options.headers?.Authorization;
}

test('TRANSLATE uses the official keyless index endpoint, one user prompt and cleanSingleOutput', async t => {
  const calls = [];
  const responseBody = {
    choices: [{ message: { content: '<think>translate it</think>{"translation":"' + CLEAN + '"}' }, finish_reason: 'stop' }],
    model: MODEL,
    usage: { cost: 0 }
  };
  const h = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === CATALOG) return catalogResponse();
    if (url === ENDPOINT) return jsonResponse(responseBody);
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  // A stale key from another service must be dropped by the shared normalizer.
  configure(h, { aiConfig: { apiKey: 'legacy-openrouter-key' } });

  const context = { title: SAMPLE_TITLE, parent: 'Have you heard this yet?' };
  const result = await h.send({ type: 'TRANSLATE', text: SAMPLE, context });

  assert.equal(result.ok, true);
  assert.equal(result.text, YTC.cleanSingleOutput(responseBody, SAMPLE).text);
  assert.equal(result.text, CLEAN);
  assert.equal(result.cached, false);
  assert.equal(result.engine, 'ai');
  assert.equal(result.model, MODEL);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.url), [CATALOG, ENDPOINT]);
  assert.equal(authorization(calls[0]), undefined);
  assert.equal(authorization(calls[1]), undefined);

  const get = calls[0].options;
  assert.equal(get.method, 'GET');
  assert.equal(get.headers, undefined);
  assert.equal(get.credentials, 'omit');
  assert.equal(get.referrerPolicy, 'no-referrer');
  assert.equal(get.redirect, 'error');

  const post = calls[1].options;
  assert.equal(post.method, 'POST');
  assert.deepEqual(Object.keys(post.headers), ['Content-Type']);
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(post.credentials, 'omit');
  assert.equal(post.referrerPolicy, 'no-referrer');
  assert.equal(post.redirect, 'error');

  const body = JSON.parse(post.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(typeof body.max_tokens, 'number');
  assert.deepEqual(Object.keys(body).sort(), ['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, h.context.YTCIndex.buildPrompt(SAMPLE, context));
  assert.equal(body.messages.some(message => message.role === 'system'), false);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.provider, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.enable_thinking, undefined);

  const prompt = body.messages[0].content;
  assert.ok(prompt.startsWith('请将以下文本翻译成中文'));
  assert.ok(prompt.includes('【源文】\n' + SAMPLE));
  assert.ok(prompt.includes('【上下文】（仅供理解，不要翻译）'));
  assert.ok(prompt.includes('视频标题：' + SAMPLE_TITLE));
  assert.ok(prompt.includes('父评论：Have you heard this yet?'));
  assert.ok(prompt.indexOf(SAMPLE) < prompt.indexOf('【约束要求】'));
  assert.ok(prompt.indexOf('【约束要求】') < prompt.indexOf('【上下文】'));
  assert.ok(!JSON.stringify(result).includes('legacy-openrouter-key'));
});

test('TEST_AI sends only the fixed sample context without a key, and the next identical TRANSLATE is cached', async t => {
  const calls = [];
  const posts = [];
  const h = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === CATALOG) return catalogResponse();
    if (url === ENDPOINT) {
      posts.push(JSON.parse(options.body));
      return completion(CLEAN);
    }
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  configure(h);

  const tested = await h.send({ type: 'TEST_AI' }, OPTIONS_SENDER);
  assert.equal(tested.ok, true);
  assert.equal(tested.text, CLEAN);
  assert.equal(tested.model, MODEL);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].messages.length, 1);
  assert.equal(posts[0].messages[0].role, 'user');
  assert.equal(posts[0].messages[0].content, h.context.YTCIndex.buildPrompt(SAMPLE, { title: SAMPLE_TITLE, parent: '' }));
  assert.ok(posts[0].messages[0].content.includes(SAMPLE));
  assert.ok(!posts[0].messages[0].content.includes('youtube.com'));
  assert.ok(!posts[0].messages[0].content.includes('v=test'));
  assert.equal(authorization(calls[1]), undefined);

  const cached = await h.send({ type: 'TRANSLATE', text: SAMPLE, context: { title: SAMPLE_TITLE, parent: '' } });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.equal(cached.text, CLEAN);
  assert.equal(posts.length, 1);
  assert.equal(calls.filter(call => call.url === ENDPOINT).length, 1);
  assert.equal(calls.filter(call => call.url === CATALOG).length, 1);
});

test('switching from OpenRouter to the index preset never reuses or forwards the other key', async t => {
  const calls = [];
  const h = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === CATALOG) return catalogResponse();
    if (url === ENDPOINT) return completion(CLEAN);
    if (url === 'https://openrouter.ai/api/v1/chat/completions') return completion('这是一条测试评论。');
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);

  h.data.local.settings = { ...YTC.DEFAULTS, enabled: true, provider: 'ai', useContext: true, freeMode: false, aiService: 'openrouter' };
  h.data.local.aiConfig = { service: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemma-4-31b-it', apiKey: 'or-test-only-key', freeOnly: false };

  const orResult = await h.send({ type: 'TRANSLATE', text: 'This is a test comment', context: {} });
  assert.equal(orResult.ok, true);
  const orCall = calls.find(call => call.url === 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(authorization(orCall), 'Bearer or-test-only-key');

  h.data.local.settings = { ...h.data.local.settings, aiService: 'indextranslate' };
  h.data.local.aiConfig = { ...indexConfig(), apiKey: 'or-test-only-key' };
  const indexResult = await h.send({ type: 'TRANSLATE', text: 'Another English comment here', context: {} });
  assert.equal(indexResult.ok, true);

  const indexGet = calls.find(call => call.url === CATALOG);
  const indexPost = calls.find(call => call.url === ENDPOINT);
  assert.equal(indexGet.options.headers, undefined);
  assert.equal(authorization(indexPost), undefined);
  assert.ok(!JSON.stringify(indexPost).includes('or-test-only-key'));
  assert.ok(!JSON.stringify(indexResult).includes('or-test-only-key'));
});

test('an index service pointed at a foreign endpoint is rejected before any fetch', async t => {
  const calls = [];
  const h = harness(async url => {
    calls.push(url);
    return catalogResponse();
  });
  t.after(h.dispose);
  configure(h, { aiConfig: { baseUrl: 'https://index-translate.example.com/v1', apiKey: 'index-test-only-key' } });

  const result = await h.send({ type: 'TRANSLATE', text: SAMPLE, context: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INDEX_CONFIG');
  assert.equal(calls.length, 0);
  assert.equal(result.diagnostic, undefined);
  assert.ok(!JSON.stringify(result).includes('index-test-only-key'));
  assert.ok(!JSON.stringify(result).includes('index-translate.example.com'));
});

test('an official index URL is canonicalized under a custom service and never sends its legacy key', async t => {
  const calls = [];
  const posts = [];
  const h = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === CATALOG) return catalogResponse();
    if (url === ENDPOINT) {
      posts.push(JSON.parse(options.body));
      return completion(CLEAN);
    }
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  configure(h, { settings: { aiService: 'custom' }, aiConfig: { service: 'custom', apiKey: 'custom-legacy-key' } });

  const result = await h.send({ type: 'TRANSLATE', text: SAMPLE, context: {} });
  assert.equal(result.ok, true);
  assert.equal(result.text, CLEAN);
  assert.deepEqual(calls.map(call => call.url), [CATALOG, ENDPOINT]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].model, MODEL);
  assert.equal(authorization(calls[1]), undefined);
  assert.ok(!JSON.stringify(calls).includes('custom-legacy-key'));
  assert.ok(!JSON.stringify(result).includes('custom-legacy-key'));
});

test('failed index requests are not cached, and 8001..12000 characters are rejected before any fetch', async t => {
  const calls = [];
  let posts = 0;
  const h = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === CATALOG) return catalogResponse();
    if (url === ENDPOINT) {
      posts++;
      return posts === 1
        ? jsonResponse({ error: { message: 'raw upstream failure' } }, { status: 500 })
        : completion(CLEAN);
    }
    throw new Error('unexpected request: ' + url);
  });
  t.after(h.dispose);
  configure(h);

  const failed = await h.send({ type: 'TRANSLATE', text: SAMPLE, context: {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'INDEX_SERVICE');
  assert.equal(posts, 1);

  const retried = await h.send({ type: 'TRANSLATE', text: SAMPLE, context: {} });
  assert.equal(retried.ok, true);
  assert.equal(retried.cached, false);
  assert.equal(posts, 2);
  assert.equal(calls.filter(call => call.url === CATALOG).length, 1);

  const before = calls.length;
  // The worker still allows 12000 characters; the index client's own limit is 8000.
  for (const length of [8001, 12000, 12001]) {
    const tooLong = await h.send({ type: 'TRANSLATE', text: 'a'.repeat(length), context: {} });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.error, 'TOO_LONG');
    assert.equal(calls.length, before);
  }
});

test('index status failures expose only mapped messages and sanitized diagnostics', async t => {
  const cases = [
    [400, 'INDEX_PARAMETERS'],
    [401, 'INDEX_ACCESS'],
    [404, 'AI_MODEL'],
    [500, 'INDEX_SERVICE'],
    [503, 'INDEX_BUSY']
  ];
  await Promise.all(cases.map(async ([status, expected]) => {
    const h = harness(async url => {
      if (url === CATALOG) return catalogResponse();
      if (url === ENDPOINT) return jsonResponse({ error: { message: 'RAW-' + status + ' sk-live-secret' } }, { status });
      throw new Error('unexpected request: ' + url);
    });
    t.after(h.dispose);
    configure(h);

    const result = await h.send({ type: 'TRANSLATE', text: SAMPLE, context: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
    assert.deepEqual(result.diagnostic, { stage: 'translate', status, contentType: 'json' });
    assert.deepEqual(Object.keys(result.diagnostic).sort(), ['contentType', 'stage', 'status']);
    assert.equal(Object.hasOwn(YTC.errors, result.error), true);
    const message = YTC.errorText(result);
    assert.ok(message.startsWith(YTC.errors[expected]));
    assert.ok(!message.includes('RAW-' + status));
    const json = JSON.stringify(result);
    assert.ok(!json.includes('RAW-' + status));
    assert.ok(!json.includes('sk-live-secret'));
    assert.equal(Object.hasOwn(result, 'text'), false);
  }));
});
