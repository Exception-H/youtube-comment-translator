'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./worker-harness.cjs');
const YTC = require('../extension/shared.js');
const textModel = id => ({ id, name: id, pricing: { prompt: '0', completion: '0', request: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
const routerModel = textModel('openrouter/free');
const nvidiaModel = textModel('nvidia/nemotron-3.5-lightning:free');
const safetyModel = textModel('acme/safety-classifier:free');
const freeCatalog = [routerModel, nvidiaModel];
const success = value => ({ ok: true, status: 200, json: async () => value });
const options = { url: 'chrome-extension://test/options.html' };
function enable(h, model = 'openrouter/free') {
  h.data.local.settings = { ...YTC.DEFAULTS, provider: 'ai', freeMode: true };
  h.data.local.aiConfig = { baseUrl: 'https://openrouter.ai/api/v1', model, apiKey: 'test-only-key', freeOnly: true };
}
test('test translation succeeds with plain text and does not require JSON or provider filtering', async t => {
  const h = harness(async (url, options) => {
    if (url.endsWith('/models')) return success({ data: freeCatalog });
    if (url.endsWith('/key')) return success({ data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
    const body = JSON.parse(options.body);
    assert.equal(body.model, nvidiaModel.id);
    assert.deepEqual(body.provider, { max_price: { prompt: '0', completion: '0' }, allow_fallbacks: true });
    assert.equal(body.response_format, undefined);
    assert.equal(typeof JSON.parse(body.messages[1].content).comment, 'string');
    return success({ model: 'google/gemma-4-31b-it:free', usage: { cost: 0 }, choices: [{ message: { content: '这也太带劲了，他这次真秀了一手。' }, finish_reason: 'stop' }] });
  });
  t.after(h.dispose); enable(h);
  const result = await h.send({ type: 'TEST_AI' }, options);
  assert.equal(result.ok, true);
  assert.equal(result.text, '这也太带劲了，他这次真秀了一手。');
});
test('HTTP failures reach options with allowlisted diagnostics and no upstream message or key', async t => {
  const cases = [[400, 'FREE_PARAMETERS'], [422, 'FREE_PARAMETERS'], [401, 'AI_AUTH'], [403, 'FREE_ACCESS'], [502, 'FREE_UPSTREAM'], [503, 'FREE_NO_PROVIDER']];
  await Promise.all(cases.map(async ([status, code]) => {
    const h = harness(async url => {
      if (url.endsWith('/models')) return success({ data: freeCatalog });
      if (url.endsWith('/key')) return success({ data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
      return { ok: false, status, json: async () => ({ error: { code: status, message: 'do not leak test-only-key or comment text' } }) };
    });
    t.after(h.dispose); enable(h, nvidiaModel.id);
    const result = await h.send({ type: 'TEST_AI' }, options);
    assert.equal(result.error, code);
    assert.equal(result.diagnostic.stage, 'translate');
    assert.equal(result.diagnostic.status, status);
    assert.equal(result.diagnostic.apiCode, status);
    assert.ok(!JSON.stringify(result).includes('test-only-key'));
    assert.ok(!JSON.stringify(result).includes('comment text'));
  }));
});
test('real background message chain combines six comments, caches each translation and retains actual model', async t => {
  let posts = 0;
  const h = harness(async (url, options) => {
    if (url.endsWith('/models')) { assert.ok(!options.headers.Authorization); return success({ data: freeCatalog }); }
    if (url.endsWith('/key')) return success({ data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    posts++;
    const body = JSON.parse(options.body);
    const items = JSON.parse(body.messages[1].content).items;
    assert.equal(items.length, 6);
    return success({ model: 'google/gemma-4-31b-it:free', usage: { cost: 0 }, choices: [{ message: { content: JSON.stringify({ translations: items.map(item => ({ id: item.id, text: '译文：' + item.comment })) }) }, finish_reason: 'stop' }] });
  });
  t.after(h.dispose); enable(h);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => h.send({ type: 'TRANSLATE', text: 'Comment ' + index, context: { title: 'Video' } })));
  assert.equal(posts, 1);
  results.forEach((result, index) => { assert.equal(result.ok, true); assert.equal(result.text, '译文：Comment ' + index); assert.equal(result.model, 'google/gemma-4-31b-it:free'); });
  const cached = await h.send({ type: 'TRANSLATE', text: 'Comment 0', context: { title: 'Video' } });
  assert.equal(cached.cached, true); assert.equal(cached.model, results[0].model); assert.equal(posts, 1);
});
test('free catalog and quota settings messages are options-only and never include key in returned metadata', async t => {
  const h = harness(async url => url.endsWith('/models') ? success({ data: freeCatalog }) : success({ data: { free_model_daily_requests: { used: 7, limit: 50, remaining: 43 } } }));
  t.after(h.dispose); enable(h);
  for (const type of ['LIST_FREE_MODELS', 'FREE_STATUS']) await assert.rejects(h.send({ type }), /UNAUTHORIZED/);
  const catalog = await h.send({ type: 'LIST_FREE_MODELS' }, options);
  assert.deepEqual(catalog.models.map(model => model.id), freeCatalog.map(model => model.id));
  const status = await h.send({ type: 'FREE_STATUS' }, options);
  assert.equal(status.used, 7); assert.equal(status.remaining, 43);
  assert.ok(!JSON.stringify(status).includes('test-only-key'));
});
test('automatic openrouter/free mode picks a general :free model, never the router or a safety classifier, and translates to Chinese', async t => {
  const posts = [];
  const h = harness(async (url, options) => {
    if (url.endsWith('/models')) { assert.ok(!options.headers.Authorization); return success({ data: [routerModel, safetyModel, nvidiaModel] }); }
    if (url.endsWith('/key')) return success({ data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(options.body);
    posts.push(body);
    return success({ model: nvidiaModel.id, usage: { cost: 0 }, choices: [{ message: { content: '这条评论被翻译成了中文。' }, finish_reason: 'stop' }] });
  });
  t.after(h.dispose); enable(h);
  const result = await h.send({ type: 'TEST_AI' }, options);
  assert.equal(posts.length, 1);
  const body = posts[0];
  assert.equal(body.model, nvidiaModel.id);
  assert.ok(!/safety|openrouter\/free/i.test(body.model));
  assert.deepEqual(body.provider, { max_price: { prompt: '0', completion: '0' }, allow_fallbacks: true });
  assert.equal(body.response_format, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.text, '这条评论被翻译成了中文。');
  assert.ok(!JSON.stringify(result).includes('test-only-key'));
});
