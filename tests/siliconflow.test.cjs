'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/shared.js');
const YTC = globalThis.YTC;
const SF = require('../extension/siliconflow.js');

const PAGE = 'https://www.siliconflow.cn/models';
const API = 'https://api.siliconflow.cn';
const ENDPOINT = API + '/v1/chat/completions';

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

function success(content, extra = {}) {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    model: 'Qwen/Qwen3-8B',
    usage: { cost: 0 },
    ...extra
  });
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

function payloadFor(models) {
  return '0:["$","div",null,{"data":' + JSON.stringify(models) + '}]';
}

function page(models) {
  const payload = payloadFor(models);
  return '<!doctype html><html><body><script>self.__next_f.push(' + JSON.stringify([1, payload]) + ');</script></body></html>';
}

function pageChunks(parts) {
  return '<!doctype html><html><body>' + parts.map(part => '<script>self.__next_f.push(' + JSON.stringify([1, part]) + ');</script>').join('') + '</body></html>';
}

function aiSettings(overrides = {}) {
  return { ...YTC.DEFAULTS, provider: 'ai', enabled: true, useContext: true, ...overrides };
}

function sfConfig(overrides = {}) {
  return {
    service: 'siliconflow',
    baseUrl: API + '/v1',
    model: 'Qwen/Qwen3-8B',
    apiKey: 'sf-test-key',
    freeOnly: true,
    ...overrides
  };
}

function chromeStub({ settings = aiSettings(), aiConfig = sfConfig() } = {}) {
  const local = { settings: { ...settings }, aiConfig: { ...aiConfig } };
  const session = {};
  const checks = [];
  const area = value => ({
    get: async keys => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map(key => [key, value[key]]));
    },
    set: async object => { Object.assign(value, object); },
    remove: async key => { delete value[key]; }
  });
  return {
    localData: local,
    sessionData: session,
    checks,
    storage: { local: area(local), session: area(session) },
    permissions: { contains: async query => { checks.push(query); return true; } }
  };
}

function makeClient({ html = page([baseModel()]), accountIds = ['Qwen/Qwen3-8B'], post, settings, aiConfig } = {}) {
  const calls = [];
  const sleeps = [];
  let clock = 1000000;
  const chrome = chromeStub({ settings, aiConfig });
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === PAGE) return textResponse(html);
    if (url === API + '/v1/models') return jsonResponse({ data: accountIds.map(id => ({ id })) });
    if (url === ENDPOINT) return post ? post(options) : success('这也太带劲了。');
    throw new Error('unexpected URL ' + url);
  };
  const client = new SF.Client({
    chrome,
    fetch,
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; }
  });
  return { client, chrome, calls, sleeps, get clock() { return clock; }, setClock: value => { clock = value; } };
}

test('parseCatalog parses escaped flight JSON, joins chunks, and keeps verified free models', () => {
  const first = baseModel({ desc: 'He said "hello" and wrote {x} then \\ end', DisplayName: 'Qwen3-8B' });
  const second = baseModel({
    modelName: 'Qwen/Qwen3.5-4B',
    DisplayName: 'Qwen3.5-4B',
    modelInfo: [{ Level: 0, RPM: 1000, TPM: 80000 }]
  });
  const payload = payloadFor([first, second]);
  const cut = Math.floor(payload.length / 2);
  const models = SF.parseCatalog(pageChunks([payload.slice(0, cut), payload.slice(cut)]));
  assert.deepEqual(models.map(model => model.id), ['Qwen/Qwen3-8B', 'Qwen/Qwen3.5-4B']);
  assert.equal(models[0].name, 'Qwen3-8B');
  assert.equal(models[0].rpm, 1000);
  assert.equal(models[0].tpm, 50000);
  assert.equal(models[1].tpm, 80000);
});

test('parseCatalog supports a plain JSON fallback in the HTML', () => {
  const html = '<html><script>window.__DATA__ = ' + JSON.stringify({ data: [baseModel()] }) + ';</script></html>';
  assert.deepEqual(SF.parseCatalog(html).map(model => model.id), ['Qwen/Qwen3-8B']);
});

test('parseCatalog rejects invalid pages, Pro models, missing prices, and non-zero prices', () => {
  const bad = [
    '<html><body>nothing here</body></html>',
    '<html><script>self.__next_f.push([1,"{\\"modelId\\":\\"x\\""]);</script></html>',
    page([baseModel({ modelName: 'Pro/Qwen/Qwen2.5-7B-Instruct', DisplayName: 'Pro' })]),
    page([baseModel({ modelName: 'Qwen/Pro/Qwen2.5-7B-Instruct', DisplayName: 'Pro' })]),
    page([baseModel({ modelName: 'Qwen/Qwen3-8B-Pro/', DisplayName: 'Pro' })]),
    page([baseModel({ pricing: [{ price: '0', specification: 'prompt' }] })]),
    page([baseModel({ pricing: [{ price: '0', specification: 'prompt' }, { price: '0.5', specification: 'completion' }] })]),
    page([baseModel({ pricing: [{ price: '0', specification: 'prompt' }, { price: '0', specification: 'completion' }, { price: '0.01', specification: 'request' }] })]),
    page([baseModel({ pricing: [{ price: '', specification: 'prompt' }, { price: '0', specification: 'completion' }] })]),
    page([baseModel({ pricing: [{ price: 0, specification: 'prompt' }, { price: 0, specification: 'completion' }] })]),
    page([baseModel({ status: 'offline' })]),
    page([baseModel({ subType: 'embedding' })]),
    page([baseModel({ modelName: 'Qwen/Qwen3-Coder-8B' })]),
    page([baseModel({ modelName: 'Qwen/Qwen3-Math-8B' })])
  ];
  for (const html of bad) assert.throws(() => SF.parseCatalog(html), error => error.message === 'SF_CATALOG');
});

test('public catalog GET sends no Authorization, checks both origins, and caches for 10 minutes', async () => {
  const h = makeClient();
  const models = await h.client.catalog();
  assert.deepEqual(models.map(model => model.id), ['Qwen/Qwen3-8B']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, PAGE);
  assert.ok(!Object.keys(h.calls[0].options.headers).some(key => /authorization/i.test(key)));
  assert.ok(!JSON.stringify(h.calls[0].options).includes('sf-test-key'));
  assert.deepEqual(h.chrome.checks[0].origins, ['https://www.siliconflow.cn/*', 'https://api.siliconflow.cn/*']);
  await h.client.catalog();
  assert.equal(h.calls.length, 1);
  h.setClock(h.clock + 600001);
  await h.client.catalog();
  assert.equal(h.calls.length, 2);
});

test('available reads the account list with only a Bearer header and intersects verified catalog models', async () => {
  const h = makeClient({ accountIds: ['Qwen/Qwen3-8B', 'Qwen/Qwen3-Coder-8B', 'Qwen/Qwen2.5-7B-Instruct'] });
  const models = await h.client.available(sfConfig());
  assert.deepEqual(models.map(model => model.id), ['Qwen/Qwen3-8B']);
  const call = h.calls.find(entry => entry.url === API + '/v1/models');
  assert.deepEqual(Object.keys(call.options.headers), ['Authorization']);
  assert.equal(call.options.headers.Authorization, 'Bearer sf-test-key');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.redirect, 'error');
  assert.ok([...h.client.availableCache.keys()].every(key => /^[0-9a-f]{64}$/.test(key)));
  assert.ok(!JSON.stringify([...h.client.availableCache.entries()]).includes('sf-test-key'));
  await h.client.available(sfConfig());
  assert.equal(h.calls.filter(entry => entry.url === API + '/v1/models').length, 1);
  h.setClock(h.clock + 300001);
  await h.client.available(sfConfig());
  assert.equal(h.calls.filter(entry => entry.url === API + '/v1/models').length, 2);
});

test('Qwen3 translation sends one comment with the exact free-model protocol and no OpenRouter fields', async () => {
  const h = makeClient();
  const config = sfConfig();
  const text = 'This song really slaps, I love it';
  const result = await h.client.translate(text, { title: 'A title', parent: 'A parent' }, config);
  assert.deepEqual(result, { text: '这也太带劲了。', source: 'auto', model: 'Qwen/Qwen3-8B' });
  const post = h.calls.find(entry => entry.url === ENDPOINT);
  assert.equal(post.options.headers.Authorization, 'Bearer sf-test-key');
  assert.equal(post.options.headers['Content-Type'], 'application/json');
  assert.equal(post.options.credentials, 'omit');
  assert.equal(post.options.redirect, 'error');
  const body = JSON.parse(post.options.body);
  assert.equal(body.model, 'Qwen/Qwen3-8B');
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, YTC.AI_PROMPT);
  assert.deepEqual(JSON.parse(body.messages[1].content), { comment: text, video_title: 'A title', parent_comment: 'A parent' });
  assert.ok(!('provider' in body));
  assert.ok(!('reasoning' in body));
  assert.ok(!JSON.stringify(body).includes('openrouter'));
  assert.ok(!post.options.body.includes('sf-test-key'));
  assert.ok(h.calls.every(entry => [PAGE, API + '/v1/models', ENDPOINT].includes(entry.url)));
});

test('Qwen2.5 omits enable_thinking, bounds max_tokens, and starts requests at least 2100ms apart', async () => {
  const models = [baseModel(), baseModel({ modelName: 'Qwen/Qwen2.5-7B-Instruct', DisplayName: 'Qwen2.5-7B-Instruct (Free)' })];
  const bodies = [];
  const h = makeClient({
    html: page(models),
    accountIds: ['Qwen/Qwen3-8B', 'Qwen/Qwen2.5-7B-Instruct'],
    post: options => { bodies.push(JSON.parse(options.body)); return success('这也太带劲了。'); }
  });
  await h.client.translate('short', {}, sfConfig());
  const second = sfConfig({ model: 'Qwen/Qwen2.5-7B-Instruct' });
  h.chrome.localData.aiConfig = { ...second };
  await h.client.translate('x'.repeat(5000), {}, second);
  assert.equal(bodies[1].model, 'Qwen/Qwen2.5-7B-Instruct');
  assert.ok(!('enable_thinking' in bodies[1]));
  assert.equal(bodies[1].max_tokens, 4096);
  assert.ok(h.sleeps.some(ms => ms >= 2100));
});

test('translation rejects OpenRouter keys/configs before any request', async () => {
  const h = makeClient();
  await assert.rejects(h.client.translate('hello world', {}, { service: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', apiKey: 'or-secret', freeOnly: true }), error => error.message === 'FREE_ONLY');
  await assert.rejects(h.client.translate('hello world', {}, sfConfig({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-secret' })), error => error.message === 'AI_CONFIG');
  await assert.rejects(h.client.translate('hello world', {}, sfConfig({ freeOnly: false })), error => error.message === 'FREE_ONLY');
  assert.equal(h.calls.length, 0);
});

test('disabled provider, disabled AI, changed config, or disabled context sends nothing', async () => {
  const off = makeClient({ settings: aiSettings({ provider: 'google' }) });
  await assert.rejects(off.client.translate('hello world', {}, sfConfig()), error => error.message === 'DISABLED');
  assert.equal(off.calls.length, 0);

  const paused = makeClient({ settings: aiSettings({ enabled: false }) });
  await assert.rejects(paused.client.translate('hello world', {}, sfConfig()), error => error.message === 'DISABLED');
  assert.equal(paused.calls.length, 0);

  const switched = makeClient();
  switched.chrome.localData.aiConfig = { ...sfConfig(), service: 'openrouter', apiKey: 'or-secret' };
  await assert.rejects(switched.client.translate('hello world', {}, sfConfig()), error => error.message === 'DISABLED');
  assert.equal(switched.calls.length, 0);

  const noContext = makeClient({ settings: aiSettings({ useContext: false }) });
  await assert.rejects(noContext.client.translate('hello world', { title: 'private' }, sfConfig()), error => error.message === 'DISABLED');
  assert.equal(noContext.calls.length, 0);
});

test('test mode may bypass paused AI but still requires the same config', async () => {
  const h = makeClient({ settings: aiSettings({ enabled: false }) });
  const result = await h.client.translate('This is a lovely video', {}, sfConfig(), true);
  assert.equal(result.text, '这也太带劲了。');
  assert.equal(h.calls.filter(entry => entry.url === ENDPOINT).length, 1);
  h.chrome.localData.aiConfig = { ...sfConfig(), service: 'openrouter', apiKey: 'or-secret' };
  await assert.rejects(h.client.translate('This is a lovely video', {}, sfConfig(), true), error => error.message === 'DISABLED');
});

test('cleanSingleOutput strips Qwen think blocks and JSON wrappers', async () => {
  const h = makeClient({ post: () => success('<think>private reasoning</think>{"translation":"这太棒了"}') });
  const result = await h.client.translate('This is a really great video', {}, sfConfig());
  assert.equal(result.text, '这太棒了');
  assert.ok(!result.text.includes('reasoning'));
});

test('echoed source is rejected as untranslated', async () => {
  const source = 'This video is really great and I enjoyed it a lot.';
  const h = makeClient({ post: () => success(source) });
  await assert.rejects(h.client.translate(source, {}, sfConfig()), error => error.message === 'OUTPUT_UNTRANSLATED');
  assert.equal(h.calls.filter(entry => entry.url === ENDPOINT).length, 1);
});

test('a paid usage.cost is rejected as SF_NOT_FREE', async () => {
  const h = makeClient({ post: () => success('这也太带劲了。', { usage: { cost: 0.002 } }) });
  await assert.rejects(h.client.translate('This is a really great video', {}, sfConfig()), error => error.message === 'SF_NOT_FREE');
});

test('HTTP statuses map to fixed codes and SF API codes above 599 are not exposed', async () => {
  const cases = [
    [401, 'SF_AUTH'],
    [403, 'SF_ACCESS'],
    [404, 'AI_MODEL'],
    [400, 'SF_PARAMETERS'],
    [503, 'SF_BUSY']
  ];
  for (const [status, code] of cases) {
    const h = makeClient({ post: () => jsonResponse({ error: { code: status === 400 ? 30014 : status, message: 'raw upstream text' } }, { status }) });
    await assert.rejects(h.client.translate('This is a really great video', {}, sfConfig()), error => {
      assert.equal(error.message, code);
      assert.equal(error.diagnostic.stage, 'translate');
      assert.equal(error.diagnostic.status, status);
      if (status === 400) assert.ok(!('apiCode' in error.diagnostic));
      assert.ok(!JSON.stringify(error).includes('raw upstream text'));
      return true;
    });
  }
});

test('429 keeps a retry-after cooldown and queued work is serial with no automatic repeat', async () => {
  let posts = 0;
  const h = makeClient({
    post: () => {
      posts++;
      return jsonResponse({ error: { code: 429 } }, { status: 429, headers: { 'Retry-After': '120' } });
    }
  });
  const [first, second] = await Promise.allSettled([
    h.client.translate('First comment for translation', {}, sfConfig()),
    h.client.translate('Second comment for translation', {}, sfConfig())
  ]);
  assert.equal(posts, 1);
  assert.equal(first.status, 'rejected');
  assert.equal(first.reason.message, 'RATE_LIMIT');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.message, 'RATE_LIMIT');
  assert.ok(h.client.blockedUntil >= h.clock + 60000);
});

test('no verified free model or no account access never POSTs', async () => {
  const paid = baseModel({ pricing: [{ price: '1', specification: 'prompt' }, { price: '1', specification: 'completion' }] });
  const noFree = makeClient({ html: page([paid]) });
  await assert.rejects(noFree.client.translate('This is a really great video', {}, sfConfig()), error => error.message === 'SF_CATALOG');
  assert.equal(noFree.calls.filter(entry => entry.url === ENDPOINT).length, 0);
  assert.equal(noFree.calls.filter(entry => entry.url === API + '/v1/models').length, 0);

  const noAccount = makeClient({ accountIds: [] });
  await assert.rejects(noAccount.client.translate('This is a really great video', {}, sfConfig()), error => error.message === 'AI_MODEL');
  assert.equal(noAccount.calls.filter(entry => entry.url === ENDPOINT).length, 0);
});

test('catalog parse errors are not cached', async () => {
  let pageCalls = 0;
  const chrome = chromeStub();
  const client = new SF.Client({
    chrome,
    fetch: async url => { pageCalls++; return textResponse('<html>no models</html>'); },
    now: () => 1000000,
    sleep: async () => {}
  });
  await assert.rejects(client.catalog(), error => error.message === 'SF_CATALOG');
  await assert.rejects(client.catalog(), error => error.message === 'SF_CATALOG');
  assert.equal(pageCalls, 2);
});

test('request timeout maps to OUTPUT_TIMEOUT without exposing the cause', async () => {
  const h = makeClient({
    post: () => {
      const error = new Error('socket details');
      error.name = 'TimeoutError';
      throw error;
    }
  });
  await assert.rejects(h.client.translate('This is a really great video', {}, sfConfig()), error => {
    assert.equal(error.message, 'OUTPUT_TIMEOUT');
    assert.ok(!JSON.stringify(error).includes('socket details'));
    return true;
  });
});
