'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const EXTENSION = path.join(__dirname, '..', 'extension');
const sharedSource = fs.readFileSync(path.join(EXTENSION, 'shared.js'), 'utf8');
const routerSource = fs.readFileSync(path.join(EXTENSION, 'free-router.js'), 'utf8');

const ORIGIN = 'https://openrouter.ai';
const MODELS_URL = ORIGIN + '/api/v1/models';
const KEY_URL = ORIGIN + '/api/v1/key';
const CHAT_URL = ORIGIN + '/api/v1/chat/completions';
const FREE_MODEL = 'openrouter/free';
const NVIDIA = 'nvidia/nemotron-3.5-lightning:free';
const GEMMA = 'google/gemma-4-31b-it:free';
const GEMMA_SMALL = 'google/gemma-4-26b-a4b-it:free';
const XING = 'xingchen-agi/xing4.0-29b-a4b:free';
const FIXED_MODEL = 'meta/llama-3.1-8b:free';
const API_KEY = 'test-only-key';
const PAID_MODELS = ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001', 'meta-llama/llama-3.1-405b-instruct'];

// Load the real sources into a fresh vm realm per test: no network, no globals leaking between tests.
function loadExtension() {
  const context = vm.createContext({
    URL,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(sharedSource, context, { filename: 'shared.js' });
  vm.runInContext(routerSource, context, { filename: 'free-router.js' });
  return { context, YTC: context.YTC, YTCFree: context.YTCFree };
}

function textModel(id, pricing = { prompt: '0', completion: '0' }, architecture = { input_modalities: ['text'], output_modalities: ['text'] }) {
  return { id, name: id, pricing, architecture };
}

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null) },
    json: async () => payload
  };
}

function completion(translations, overrides = {}) {
  return response(200, {
    choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: 'stop' }],
    model: overrides.model ?? NVIDIA,
    usage: { cost: 0 },
    ...overrides
  });
}

function plain(text, overrides = {}) {
  return response(200, {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    model: overrides.model ?? NVIDIA,
    usage: { cost: 0 },
    ...overrides
  });
}

// The router now sends a single job as a plain-text request and batches as items JSON.
// A successful single answer is a real Chinese translation (with a label the router must strip),
// never the English source echoed back: an echo is rejected as untranslated.
function defaultChat(entry) {
  const input = JSON.parse(entry.body.messages[1].content);
  const model = entry.body.model;
  if (Array.isArray(input.items)) return completion(input.items.map(item => ({ id: item.id, text: `译文：${item.comment}` })), { model });
  return plain('译文：太带劲了，他这波真强。', { model });
}

function aiContent(text, finish = 'stop') {
  return { choices: [{ message: { content: text }, finish_reason: finish }] };
}

function batchContent(translations) {
  return aiContent(JSON.stringify({ translations }));
}

function rejected(results, index, pattern) {
  assert.equal(results[index].status, 'rejected', `job ${index} should reject`);
  assert.match(results[index].reason.message, pattern);
}

// A Router harness with a fake clock, hand-driven timers and an in-memory chrome mock.
function makeHarness(options = {}) {
  const { context, YTC, YTCFree } = loadExtension();
  const clock = { now: options.start ?? 0 };
  const timers = [];
  let timerSeq = 0;
  const data = { local: {}, session: {} };
  const permissions = { allowed: options.permission !== false, calls: [] };
  const calls = [];

  const area = areaName => ({
    get: async key => {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const name of keys) out[name] = data[areaName][name];
      return out;
    },
    set: async object => { Object.assign(data[areaName], object); },
    remove: async key => { delete data[areaName][key]; }
  });
  const chrome = {
    storage: { local: area('local'), session: area('session') },
    permissions: {
      contains: async request => { permissions.calls.push(request); return permissions.allowed; }
    }
  };

  const sleep = ms => { clock.now += Math.max(0, Number(ms) || 0); return Promise.resolve(); };
  const setTimer = (fn, ms) => {
    const id = ++timerSeq;
    timers.push({ id, at: clock.now + Math.max(0, Number(ms) || 0), fn });
    return id;
  };

  const config = YTC.aiConfig({
    baseUrl: options.baseUrl ?? ORIGIN + '/api/v1',
    model: options.model ?? FREE_MODEL,
    apiKey: options.apiKey ?? API_KEY,
    freeOnly: true
  });
  data.local.settings = { ...YTC.DEFAULTS, provider: 'ai', enabled: options.enabled !== false };
  data.local.aiConfig = { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, freeOnly: config.freeOnly };

  // The verified default catalog carries the general-purpose :free candidates the
  // automatic mode may select; the server-side openrouter/free router is never sent.
  const catalogModels = options.catalogModels ?? [FREE_MODEL, NVIDIA, GEMMA, FIXED_MODEL];
  const quota = options.quota ?? { used: 0, limit: 50, remaining: 50 };
  const modelsHandler = options.models ?? (() => response(200, { data: catalogModels.map(id => textModel(id)) }));
  const keyHandler = options.key ?? (() => response(200, { data: { free_model_daily_requests: quota } }));
  const chatHandler = options.chat ?? defaultChat;

  const fetch = async (url, init = {}) => {
    const entry = {
      url,
      init,
      at: clock.now,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null
    };
    calls.push(entry);
    if (url === MODELS_URL) return modelsHandler(entry);
    if (url === KEY_URL) return keyHandler(entry);
    if (url === CHAT_URL) return chatHandler(entry);
    throw new Error('UNEXPECTED_FETCH ' + url);
  };

  const router = new YTCFree.Router({ chrome, fetch, now: () => clock.now, sleep, setTimer });

  function fireTimers() {
    let fired = 0;
    while (timers.length) {
      const timer = timers.shift();
      clock.now = Math.max(clock.now, timer.at);
      timer.fn();
      fired++;
    }
    return fired;
  }

  async function translateAll(items, { test: isTest = false, config: override } = {}) {
    const jobs = items.map(item => router.translate(
      item.text,
      item.context || { title: '', parent: '' },
      override || config,
      isTest
    ));
    fireTimers();
    return Promise.allSettled(jobs);
  }

  return {
    context,
    YTC,
    YTCFree,
    router,
    config,
    chrome,
    data,
    permissions,
    calls,
    clock,
    timers,
    fireTimers,
    translateAll,
    posts: () => calls.filter(call => call.url === CHAT_URL)
  };
}

test('automatic mode prefers the stronger measured free candidate when present', () => {
  const { YTC } = loadExtension();
  const ids = [NVIDIA, 'nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'];
  assert.deepEqual(Array.from(YTC.translationModels(ids.map(id => ({ id, name: id }))), item => item.id), ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free', NVIDIA]);
});
test('only an untranslated item is retried while successful batch items are preserved', async () => {
  const japanese = 'この動画、何回見ても笑ってしまう';
  const h = makeHarness({ chat: entry => {
    const input = JSON.parse(entry.body.messages[1].content);
    if (input.items) return completion(input.items.map(item => ({ id: item.id, text: item.comment === japanese ? japanese : '已经翻好的中文' })));
    assert.equal(input.comment, japanese);
    return plain('这个视频看多少遍都会笑。');
  } });
  const results = await h.translateAll([{ text: 'A great video' }, { text: japanese }]);
  assert.equal(h.posts().length, 2);
  assert.equal(results[0].value.text, '已经翻好的中文');
  assert.equal(results[1].value.text, '这个视频看多少遍都会笑。');
  assert.equal(JSON.parse(h.posts()[1].body.messages[1].content).items, undefined);
});
test('obvious reversed missed-every-shot meaning is not shown as a successful translation', async () => {
  const h = makeHarness({ chat: entry => entry.body.model === NVIDIA ? plain('他说相信我，结果每投必中。') : plain('他说相信我，结果一球都没进。') });
  const result = await h.translateAll([{ text: "He said trust me and missed every shot", context: { title: 'Basketball fail', parent: '' } }]);
  assert.equal(h.posts().length, 2);
  assert.equal(result[0].value.text, '他说相信我，结果一球都没进。');
});
test('basketball shots are not silently accepted as archery when the model mistranslates them', async () => {
  const h = makeHarness({ chat: entry => entry.body.model === NVIDIA ? plain('他每一箭都射偏了。') : plain('他每次投篮都没进。') });
  const result = await h.translateAll([{ text: 'He missed his shots', context: { title: 'Basketball fails', parent: '' } }]);
  assert.equal(h.posts().length, 2);
  assert.equal(result[0].value.text, '他每次投篮都没进。');
});
test('1 free catalog keeps only verified zero-price text models and rejects paid namesakes, non-text and safety/code models', () => {
  const { YTC } = loadExtension();
  const included = [
    textModel('openrouter/free'),
    textModel('meta/llama-3.1-8b:free'),
    { ...textModel('acme/zero:free'), name: 'x'.repeat(300) }
  ];
  const excluded = [
    textModel('openai/gpt-4o'), // not a :free id
    textModel('openai/gpt-4o:free', { prompt: '0.0000025', completion: '0.00001' }), // paid namesake with :free suffix
    { ...textModel('acme/no-price:free'), pricing: undefined },
    textModel('acme/request-fee:free', { prompt: '0', completion: '0', request: '0.001' }),
    textModel('acme/image-in:free', { prompt: '0', completion: '0' }, { input_modalities: ['image'], output_modalities: ['text'] }),
    textModel('acme/image-out:free', { prompt: '0', completion: '0' }, { input_modalities: ['text'], output_modalities: ['image'] }),
    textModel('acme/content-safety:free'),
    textModel('acme/guard:free'),
    textModel('acme/code:free'),
    textModel('acme/coding:free'),
    textModel('acme/model:free-trial'),
    { id: 42, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }
  ];

  const models = YTC.freeModels({ data: [...included, ...excluded] });
  assert.deepEqual(Array.from(models, model => model.id), ['openrouter/free', 'meta/llama-3.1-8b:free', 'acme/zero:free']);
  assert.equal(models.find(model => model.id === 'acme/zero:free').name.length, 180);

  // A paid model that reuses the free router id must be refused even when it is the only entry.
  assert.deepEqual(
    Array.from(YTC.freeModels({ data: [textModel('openrouter/free', { prompt: '0.000001', completion: '0' })] }), model => model.id),
    []
  );
  assert.deepEqual(Array.from(YTC.freeModels({ data: 'not-a-catalog' }), model => model.id), []);
  assert.deepEqual(Array.from(YTC.freeModels(null), model => model.id), []);
});

test('2 validateFreeConfig accepts only the OpenRouter free route and refuses paid, auto and hostile endpoints', () => {
  const { YTC } = loadExtension();
  const base = ORIGIN + '/api/v1';

  assert.equal(YTC.validateFreeConfig({ baseUrl: base, model: FREE_MODEL }), true);
  assert.equal(YTC.validateFreeConfig({ baseUrl: base + '/', model: FIXED_MODEL }), true);
  assert.equal(YTC.validateFreeConfig({ baseUrl: base + '/chat/completions', model: 'x-ai/gpt-oss-120b:free' }), true);

  for (const model of ['openai/gpt-4o', 'openrouter/auto', 'meta/llama-3.1-8b', 'openrouter/free ', '', ':free', 'meta/llama:free:extra']) {
    assert.throws(() => YTC.validateFreeConfig({ baseUrl: base, model }), /FREE_ONLY/, `model ${JSON.stringify(model)}`);
  }

  // Endpoints that parse but are not exactly OpenRouter.
  for (const baseUrl of [
    'https://openrouter.ai.evil.test/api/v1',
    'https://evil.test/openrouter.ai/api/v1',
    'https://evil.test/api/v1'
  ]) {
    assert.throws(() => YTC.validateFreeConfig({ baseUrl, model: FREE_MODEL }), /FREE_ONLY/, baseUrl);
  }

  // Endpoints rejected outright by aiEndpoint (credentials, query, hash, plaintext, non-http).
  for (const baseUrl of [
    (() => { const url = new URL(ORIGIN + '/api/v1'); url.username = 'test-user'; url.password = 'test-password'; return url.href; })(),
    ORIGIN + '/api/v1?token=1',
    ORIGIN + '/api/v1#frag',
    'http://openrouter.ai/api/v1',
    'javascript:alert(1)',
    'file:///etc/passwd'
  ]) {
    assert.throws(() => YTC.validateFreeConfig({ baseUrl, model: FREE_MODEL }), /AI_CONFIG/, baseUrl);
  }

  // The router refuses to even queue an unverified paid configuration.
  const h = makeHarness();
  const paid = h.YTC.aiConfig({ baseUrl: base, model: 'openai/gpt-4o', apiKey: API_KEY, freeOnly: false });
  assert.throws(() => h.router.translate('hello', { title: '', parent: '' }, paid, false), /FREE_ONLY/);
  assert.equal(h.router.pending.length, 0);
  assert.equal(h.calls.length, 0);
});

test('3 parseBatch maps translations by id, rejects malformed/truncated batches and never executes HTML', () => {
  const { YTCFree, context } = loadExtension();
  const parseBatch = YTCFree.parseBatch;

  const map = parseBatch(batchContent([{ id: 'b', text: ' B ' }, { id: 'a', text: 'A' }]), ['a', 'b']);
  assert.equal(map.size, 2);
  assert.equal(map.get('a'), 'A');
  assert.equal(map.get('b'), 'B');

  const fenced = parseBatch(aiContent('```json\n{"translations":[{"id":"0","text":"零"}]}\n```'), ['0']);
  assert.equal(fenced.get('0'), '零');

  const parts = aiContent('ignored');
  parts.choices[0].message.content = [
    { type: 'text', text: '{"translations":[' },
    { type: 'text', text: '{"id":"0","text":"一"}]}' }
  ];
  assert.equal(parseBatch(parts, ['0']).get('0'), '一');

  // The function only returns strings; HTML payloads must never be evaluated.
  context.__htmlRan = 0;
  const html = '<img src=x onerror="globalThis.__htmlRan=1"><script>globalThis.__htmlRan=2</script>';
  const parsed = parseBatch(batchContent([{ id: '0', text: html }]), ['0']);
  assert.equal(typeof parsed.get('0'), 'string');
  assert.equal(parsed.get('0'), html);
  assert.equal(context.__htmlRan, 0);

  assert.throws(() => parseBatch(batchContent([{ id: '0', text: 'x' }]), ['0', '1']), /FREE_BATCH/);
  assert.throws(() => parseBatch(batchContent([{ id: '0', text: 'x' }, { id: '0', text: 'y' }]), ['0', '1']), /FREE_BATCH/);
  assert.throws(() => parseBatch(batchContent([{ id: '0', text: 'x' }, { id: '1' }]), ['0', '1']), /FREE_BATCH/);
  assert.throws(() => parseBatch(batchContent([{ id: '0', text: '   ' }, { id: '1', text: 'y' }]), ['0', '1']), /FREE_BATCH/);
  assert.throws(() => parseBatch(batchContent([{ id: '0', text: 'x' }, { id: '9', text: 'y' }]), ['0', '1']), /FREE_BATCH/);
  assert.throws(() => parseBatch(batchContent([{ id: 0, text: 'x' }, { id: '1', text: 'y' }]), ['0', '1']), /FREE_BATCH/);
  assert.throws(() => parseBatch(batchContent([{ id: '0', text: 'x' }, { id: '1', text: 'y' }, { id: '2', text: 'z' }]), ['0', '1']), /FREE_BATCH/);
  assert.throws(() => parseBatch(aiContent('not json'), ['0']), /FREE_BATCH/);
  assert.throws(() => parseBatch(aiContent('{"translations":"no"}'), ['0']), /FREE_BATCH/);
  assert.throws(() => parseBatch(aiContent(JSON.stringify({ translations: [{ id: '0', text: 'x' }] }), 'length'), ['0']), /RESPONSE/);
  assert.throws(() => parseBatch(aiContent(''), ['0']), /RESPONSE/);
});

test('leading complete batch JSON with trailing prose is accepted without leaking explanations', () => {
  const { YTCFree } = loadExtension();
  const text = '右括号 } 和引用 "词语" 不应提前结束。';
  const body = JSON.stringify({ translations: [{ id: '0', text }] }) + '\n\n**解释**：这里是模型多余说明。';
  const result = YTCFree.parseBatch(aiContent(body), ['0']);
  assert.equal(result.get('0'), text);
  assert.throws(() => YTCFree.parseBatch(aiContent('解释：' + body), ['0']), /FREE_BATCH/);
  assert.throws(() => YTCFree.parseBatch(aiContent(JSON.stringify({ translations: [{ id: 'wrong', text }] }) + '\nnotes'), ['0']), /FREE_BATCH/);
});
test('4 six comments with distinct context become one zero-price request that keeps each context', async () => {
  const h = makeHarness();
  const items = Array.from({ length: 6 }, (_, index) => ({
    text: `comment ${index} — this slaps`,
    context: { title: `video ${index}`, parent: `parent ${index}` }
  }));

  const results = await h.translateAll(items);

  assert.equal(h.posts().length, 1);
  assert.equal(h.calls.filter(call => call.url === MODELS_URL).length, 1);
  assert.equal(h.calls.filter(call => call.url === KEY_URL).length, 1);

  const post = h.posts()[0];
  assert.equal(post.method, 'POST');
  assert.equal(post.init.credentials, 'omit');
  assert.equal(post.init.redirect, 'error');
  assert.equal(post.init.headers.Authorization, 'Bearer ' + API_KEY);
  assert.equal(post.init.headers['Content-Type'], 'application/json');

  const body = post.body;
  // Automatic mode must resolve a verified :free model locally, never the random server router.
  assert.equal(body.model, NVIDIA);
  assert.notEqual(body.model, FREE_MODEL);
  assert.equal(body.stream, false);
  assert.equal(body.reasoning.enabled, false);
  assert.equal(body.reasoning.exclude, true);
  // Zero price is always enforced as a string cap, even for the automatic mode.
  assert.equal(body.provider.allow_fallbacks, true);
  assert.equal(body.provider.max_price.prompt, '0');
  assert.equal(body.provider.max_price.completion, '0');
  assert.equal(typeof body.provider.max_price.prompt, 'string');
  assert.equal(typeof body.provider.max_price.completion, 'string');
  assert.equal(body.response_format, undefined);
  assert.ok(body.messages[0].content.includes('不可信'));
  assert.ok(body.messages[0].content.includes('批量评论'), 'batched jobs must carry the batch instructions');

  const input = JSON.parse(body.messages[1].content);
  assert.equal(input.items.length, 6);
  input.items.forEach((item, index) => {
    assert.equal(item.id, String(index));
    assert.equal(item.comment, items[index].text);
    assert.equal(item.video_title, items[index].context.title);
    assert.equal(item.parent_comment, items[index].context.parent);
  });

  // No paid model id or fallback target may leak into the request.
  const serialized = JSON.stringify(body);
  for (const paid of PAID_MODELS) assert.ok(!serialized.includes(paid), paid);

  results.forEach((result, index) => {
    assert.equal(result.status, 'fulfilled');
    assert.equal(result.value.text, '译文：' + items[index].text);
    assert.equal(result.value.source, 'auto');
    assert.equal(result.value.model, NVIDIA);
  });

  // Requests never leave OpenRouter and never carry the key in the URL.
  assert.ok(h.calls.every(call => call.url.startsWith(ORIGIN + '/')));
  assert.ok(h.calls.every(call => !call.url.includes(API_KEY)));
});

test('5 more than six comments split into two paced requests with at least 3200ms between starts', async () => {
  const h = makeHarness();
  const startedAt = h.clock.now;
  const items = Array.from({ length: 8 }, (_, index) => ({
    text: `comment ${index}`,
    context: { title: `video ${index}`, parent: `parent ${index}` }
  }));

  const results = await h.translateAll(items);
  const posts = h.posts();

  assert.equal(posts.length, 2);
  assert.ok(posts[0].at - startedAt >= 3200, `first start ${posts[0].at - startedAt}`);
  assert.ok(posts[1].at - posts[0].at >= 3200, `gap ${posts[1].at - posts[0].at}`);

  assert.equal(JSON.parse(posts[0].body.messages[1].content).items.length, 6);
  assert.equal(JSON.parse(posts[1].body.messages[1].content).items.length, 2);
  assert.ok(posts.every(post => post.body.model === NVIDIA));

  assert.equal(results.length, 8);
  results.forEach((result, index) => {
    assert.equal(result.status, 'fulfilled');
    assert.equal(result.value.text, '译文：' + items[index].text);
  });
  assert.equal(h.data.session.freeQuota.used, 2);
});

test('6 an exhausted daily quota sends no chat request and rejects with FREE_DAILY', async () => {
  const h = makeHarness({ quota: { used: 50, limit: 50, remaining: 0 } });

  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  rejected(results, 0, /FREE_DAILY/);
  assert.equal(h.posts().length, 0);
  assert.equal(h.calls.filter(call => call.url === KEY_URL).length, 1);
  assert.equal(h.data.session.freeQuota.remaining, 0);
  assert.equal(h.data.session.freeQuota.used, 50);
});

test('7 a 429 blocks further attempts without a storm and without a paid fallback', async () => {
  const h = makeHarness({ chat: () => response(429, {}, { 'Retry-After': '1' }) });
  const item = { text: 'hello', context: { title: 't', parent: '' } };

  const first = await h.translateAll([item]);
  rejected(first, 0, /RATE_LIMIT/);
  assert.equal(h.posts().length, 1);

  const blockedUntil = h.data.session.freeBlockedUntil;
  assert.equal(blockedUntil, h.posts()[0].at + 60000);
  assert.equal(h.router.blockedUntil, blockedUntil);

  const second = await h.translateAll([item]);
  rejected(second, 0, /RATE_LIMIT/);
  assert.equal(h.posts().length, 1, 'blocked attempt must not send another POST');
  assert.ok(h.calls.every(call => call.url.startsWith(ORIGIN + '/')));
  assert.ok(h.posts().every(post => post.body.model === NVIDIA));
  const serialized = JSON.stringify(h.posts().map(post => post.body));
  for (const paid of PAID_MODELS) assert.ok(!serialized.includes(paid), paid);
});

test('8 an unverifiable catalog or an unlisted fixed model sends no chat request', async () => {
  // Catalog lacks the openrouter/free sentinel.
  const missingSentinel = makeHarness({ catalogModels: [FIXED_MODEL] });
  const noSentinel = await missingSentinel.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);
  rejected(noSentinel, 0, /FREE_CATALOG/);
  assert.equal(missingSentinel.posts().length, 0);

  // Catalog request fails at the service.
  const brokenCatalog = makeHarness({ models: () => response(500, {}) });
  const broken = await brokenCatalog.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);
  rejected(broken, 0, /SERVICE/);
  assert.equal(brokenCatalog.posts().length, 0);

  // A syntactically valid :free model that is not in the verified catalog.
  const unlisted = makeHarness({ model: 'meta/unknown:free' });
  const unlistedResults = await unlisted.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);
  rejected(unlistedResults, 0, /FREE_ONLY/);
  assert.equal(unlisted.posts().length, 0);
  assert.equal(unlisted.calls.filter(call => call.url === KEY_URL).length, 0);
});

test('9 persisted quota state carries no plaintext API key', async () => {
  const h = makeHarness();
  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: 'p' } }]);
  assert.equal(results[0].status, 'fulfilled');

  const sessionJson = JSON.stringify(h.data.session);
  assert.ok(!sessionJson.includes(API_KEY));
  assert.ok(!sessionJson.includes('sk-or-'));
  assert.ok(!sessionJson.includes('Bearer'));

  const quota = h.data.session.freeQuota;
  assert.ok(quota);
  assert.equal(quota.id, createHash('sha256').update(API_KEY, 'utf8').digest('hex'));
  assert.equal(quota.id.length, 64);
  assert.equal(quota.used, 1);
  assert.equal(quota.limit, 50);
  assert.equal(quota.remaining, 49);
  assert.equal(quota.estimated, false);
  assert.ok(!('apiKey' in quota));
  assert.equal(h.data.session.freeLastStart, h.posts()[0].at);
  assert.equal(typeof h.data.session.freeLastStart, 'number');
});

test('10 TEST jobs run while disabled, normal jobs then fail with DISABLED and send nothing', async () => {
  const h = makeHarness({ enabled: false });
  const item = { text: 'hello', context: { title: 't', parent: '' } };

  const tested = await h.translateAll([item], { test: true });
  assert.equal(tested[0].status, 'fulfilled');
  assert.equal(h.posts().length, 1);

  const normal = await h.translateAll([item]);
  rejected(normal, 0, /DISABLED/);
  assert.equal(h.posts().length, 1, 'disabled request must not reach the network');
});

test('11 a single job sends the minimal plain-text request and returns a clean Chinese translation, not an echo', async () => {
  const h = makeHarness();
  const text = 'this slaps — he cooked';
  const results = await h.translateAll([{ text, context: { title: 'video', parent: 'parent' } }]);

  assert.equal(h.posts().length, 1);
  const body = h.posts()[0].body;
  assert.equal(body.model, NVIDIA);
  assert.notEqual(body.model, FREE_MODEL, 'the automatic sentinel must never reach the server');
  assert.equal(body.stream, false);
  assert.equal(body.provider.allow_fallbacks, true);
  assert.equal(body.provider.max_price.prompt, '0');
  assert.equal(body.provider.max_price.completion, '0');
  assert.equal(typeof body.provider.max_price.prompt, 'string');
  assert.equal(typeof body.provider.max_price.completion, 'string');
  assert.equal(body.response_format, undefined, 'the router must not force a global response_format');
  assert.equal(body.reasoning.enabled, false);
  assert.equal(body.reasoning.exclude, true);
  assert.ok(!body.messages[0].content.includes('批量评论'), 'single job must not add the batch prompt');

  const input = JSON.parse(body.messages[1].content);
  assert.deepEqual(Object.keys(input).sort(), ['comment', 'parent_comment', 'video_title']);
  assert.equal(input.comment, text);
  assert.equal(input.video_title, 'video');
  assert.equal(input.parent_comment, 'parent');

  // The plain answer is not parsed as a batch; the leading "译文：" label is stripped
  // and a genuine Chinese translation is returned instead of the English source.
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value.text, '太带劲了，他这波真强。');
  assert.notEqual(results[0].value.text, text, 'the source must never be echoed back as the translation');
  assert.match(results[0].value.text, /[\u4e00-\u9fff]/);
  assert.equal(results[0].value.source, 'auto');
  assert.equal(results[0].value.model, NVIDIA);
});

test('12 a fixed :free model keeps the explicit string zero-price cap', async () => {
  const h = makeHarness({ model: FIXED_MODEL });
  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  assert.equal(results[0].status, 'fulfilled');
  const body = h.posts()[0].body;
  assert.equal(body.model, FIXED_MODEL);
  assert.equal(body.provider.allow_fallbacks, true);
  assert.equal(body.provider.max_price.prompt, '0');
  assert.equal(body.provider.max_price.completion, '0');
  assert.equal(typeof body.provider.max_price.prompt, 'string');
  assert.equal(typeof body.provider.max_price.completion, 'string');
  assert.equal(body.response_format, undefined);
});

test('13 HTTP statuses map to actionable free-route errors with safe diagnostics', async () => {
  const cases = [
    [400, /FREE_PARAMETERS/],
    [422, /FREE_PARAMETERS/],
    [502, /FREE_UPSTREAM/],
    [503, /FREE_NO_PROVIDER/],
    [403, /FREE_ACCESS/],
    [401, /AI_AUTH/]
  ];
  for (const [status, pattern] of cases) {
    // A fixed model keeps the terminal error stable: automatic mode would retry another candidate.
    const h = makeHarness({ model: FIXED_MODEL, chat: () => response(status, { error: { code: status, message: 'upstream refused the request' } }) });
    const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);
    rejected(results, 0, pattern);
    const diag = results[0].reason.diagnostic;
    assert.equal(diag.stage, 'translate', `status ${status}`);
    assert.equal(diag.status, status, `status ${status}`);
    assert.equal(diag.apiCode, status, `status ${status}`);
    assert.equal(h.posts().length, 1);
    assert.equal(h.posts()[0].body.model, FIXED_MODEL);
  }
});

test('14 an HTTP 200 body carrying error.code 503 keeps the API code and leaks no private message', async () => {
  const secret = 'internal upstream trace sk-or-secret';
  const h = makeHarness({ model: FIXED_MODEL, chat: () => response(200, { error: { code: 503, message: secret } }) });
  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  rejected(results, 0, /FREE_NO_PROVIDER/);
  const diag = results[0].reason.diagnostic;
  assert.deepEqual(Object.keys(diag).sort(), ['apiCode', 'contentType', 'stage', 'status']);
  assert.equal(diag.stage, 'translate');
  assert.equal(diag.status, 200);
  assert.equal(diag.apiCode, 503);
  assert.equal(diag.contentType, 'other');
  assert.ok(!JSON.stringify(diag).includes(secret));
  assert.ok(!JSON.stringify(diag).includes('sk-or'));
  assert.ok(!results[0].reason.message.includes(secret));
});

test('15 a privacy/data-policy refusal is reported as FREE_POLICY, not auth', async () => {
  const message = 'No endpoints found matching your data policy (zero data retention). Enable prompt training in privacy settings.';
  for (const status of [403, 404]) {
    const h = makeHarness({ model: FIXED_MODEL, chat: () => response(status, { error: { message } }) });
    const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);
    rejected(results, 0, /FREE_POLICY/);
    assert.doesNotMatch(results[0].reason.message, /AI_AUTH|FREE_ACCESS/);
    assert.equal(results[0].reason.diagnostic.status, status);
    assert.equal(results[0].reason.diagnostic.stage, 'translate');
  }
});

test('16 TimeoutError maps to FREE_TIMEOUT while other network failures map to NETWORK', async () => {
  const item = { text: 'hello', context: { title: 't', parent: '' } };
  const throwNamed = name => () => { const error = new Error(name); error.name = name; throw error; };

  const timeout = makeHarness({ model: FIXED_MODEL, chat: throwNamed('TimeoutError') });
  const timed = await timeout.translateAll([item]);
  rejected(timed, 0, /FREE_TIMEOUT/);
  assert.equal(timed[0].reason.diagnostic.stage, 'translate');

  const abort = makeHarness({ model: FIXED_MODEL, chat: throwNamed('AbortError') });
  const aborted = await abort.translateAll([item]);
  rejected(aborted, 0, /FREE_TIMEOUT/);
  assert.equal(aborted[0].reason.diagnostic.stage, 'translate');

  const offline = makeHarness({ model: FIXED_MODEL, chat: () => { throw new TypeError('fetch failed'); } });
  const net = await offline.translateAll([item]);
  rejected(net, 0, /NETWORK/);
  assert.doesNotMatch(net[0].reason.message, /FREE_TIMEOUT/);
  assert.equal(net[0].reason.diagnostic.stage, 'translate');
});

test('17 an HTML body that fails JSON parsing becomes RESPONSE with an html diagnostic', async () => {
  const html = {
    ok: true,
    status: 200,
    headers: { get: name => (/^content-type$/i.test(name) ? 'text/html; charset=utf-8' : null) },
    json: async () => { throw new SyntaxError('Unexpected token <'); }
  };
  const h = makeHarness({ model: FIXED_MODEL, chat: () => html });
  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  rejected(results, 0, /RESPONSE/);
  const diag = results[0].reason.diagnostic;
  assert.equal(diag.stage, 'translate');
  assert.equal(diag.status, 200);
  assert.equal(diag.contentType, 'html');
  assert.deepEqual(Object.keys(diag).sort(), ['contentType', 'stage', 'status']);
});

test('18 symbolic rate_limit_exceeded and daily hints both trigger the cooldown', async () => {
  const cases = [
    [{ error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded' } }, /RATE_LIMIT/],
    [{ error: { code: 'rate_limit_exceeded', message: 'You have reached your daily request limit' } }, /FREE_DAILY/]
  ];
  for (const [payload, pattern] of cases) {
    const h = makeHarness({ model: FIXED_MODEL, chat: () => response(429, payload) });
    const item = { text: 'hello', context: { title: 't', parent: '' } };

    const first = await h.translateAll([item]);
    rejected(first, 0, pattern);
    assert.equal(first[0].reason.diagnostic.status, 429);
    assert.equal(h.posts().length, 1);

    const blockedUntil = h.data.session.freeBlockedUntil;
    assert.equal(blockedUntil, h.posts()[0].at + 60000);
    assert.equal(h.router.blockedUntil, blockedUntil);

    const second = await h.translateAll([item]);
    rejected(second, 0, /RATE_LIMIT/);
    assert.equal(h.posts().length, 1, 'cooldown must block another POST');
  }
});

test('19 automatic candidate ordering prefers verified general :free models and excludes classifiers, code, math and embeddings', () => {
  const { YTC } = loadExtension();
  const ordered = YTC.translationModels([
    textModel(FREE_MODEL),
    textModel(GEMMA),
    textModel(NVIDIA),
    textModel(XING),
    textModel(GEMMA_SMALL),
    textModel('nvidia/nemotron-3.5-lightning-safety:free'),
    textModel('nvidia/nemotron-content-safety:free'),
    textModel('qwen/qwen3-code:free'),
    textModel('deepseek/deepseek-math:free'),
    textModel('mistralai/mistral-embed:free'),
    textModel(FIXED_MODEL)
  ].map(model => ({ ...model, name: model.id })));

  assert.deepEqual(
    Array.from(ordered, model => model.id),
    [NVIDIA, GEMMA, GEMMA_SMALL, XING],
    'priority order must start with the verified general candidates'
  );
  assert.ok(ordered.every(model => model.id.endsWith(':free')));
  assert.ok(ordered.every(model => !/safety|guard|code|math|embed|rerank/i.test(model.id)));
});

test('20 automatic mode resolves a verified general :free model locally and never sends the openrouter/free sentinel', async () => {
  const h = makeHarness({ catalogModels: [FREE_MODEL, 'nvidia/nemotron-3.5-lightning-safety:free', NVIDIA, GEMMA] });
  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  assert.equal(results[0].status, 'fulfilled');
  const body = h.posts()[0].body;
  assert.equal(body.model, NVIDIA, 'the safety classifier listed first must be skipped');
  assert.notEqual(body.model, FREE_MODEL);
  assert.deepEqual(body.provider, { max_price: { prompt: '0', completion: '0' }, allow_fallbacks: true });
  assert.equal(results[0].value.model, NVIDIA);
});

test('21 an upstream 429 switches from Nvidia to Gemma with at least 3200ms between attempts and no global block', async () => {
  const h = makeHarness({
    catalogModels: [FREE_MODEL, NVIDIA, GEMMA],
    chat: entry => (entry.body.model === NVIDIA
      ? response(429, { error: { code: 429, message: 'upstream temporarily rate limited' } })
      : plain('译文：上游恢复', { model: entry.body.model }))
  });

  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value.text, '上游恢复', 'the "译文：" label must be stripped from a single answer');
  assert.equal(results[0].value.model, GEMMA);

  const posts = h.posts();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.model, NVIDIA);
  assert.equal(posts[1].body.model, GEMMA);
  assert.ok(posts[1].at - posts[0].at >= 3200, `switch gap ${posts[1].at - posts[0].at}`);

  // A per-model upstream 429 must not trip the global cooldown.
  assert.equal(h.router.blockedUntil, 0);
  assert.equal(h.data.session.freeBlockedUntil, undefined);
  assert.ok(h.router.modelCooldowns.get(NVIDIA) > h.clock.now, 'the failed model must stay cooling down');
});

test('22 a global 429 does not switch models and still blocks further requests', async () => {
  const h = makeHarness({
    catalogModels: [FREE_MODEL, NVIDIA, GEMMA],
    chat: () => response(429, { error: { code: 429, message: 'Rate limit exceeded' } })
  });

  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  rejected(results, 0, /RATE_LIMIT/);
  assert.equal(h.posts().length, 1, 'a global 429 must not try another model');
  assert.equal(h.posts()[0].body.model, NVIDIA);
  assert.equal(h.router.modelCooldowns.size, 0);
  assert.equal(h.router.blockedUntil, h.posts()[0].at + 60000);
});

test('23 a classifier answer is never shown to the user and switches to the next candidate', async () => {
  const h = makeHarness({
    catalogModels: [FREE_MODEL, NVIDIA, GEMMA],
    chat: entry => (entry.body.model === NVIDIA
      ? plain('User Safety: safe', { model: NVIDIA })
      : plain('译文：正常结果', { model: entry.body.model }))
  });

  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value.text, '正常结果', 'the "译文：" label must be stripped from a single answer');
  assert.doesNotMatch(results[0].value.text, /user\s+safety|safety/i);
  assert.equal(results[0].value.model, GEMMA);
  assert.equal(h.posts().length, 2);
  assert.equal(h.posts()[0].body.model, NVIDIA);
  assert.equal(h.posts()[1].body.model, GEMMA);
});

test('24 automatic mode stops after three attempts, stays free and never leaks a paid id', async () => {
  const h = makeHarness({
    catalogModels: [FREE_MODEL, NVIDIA, GEMMA, GEMMA_SMALL, XING, ...PAID_MODELS],
    chat: () => response(502, { error: { code: 502, message: 'upstream failure' } })
  });

  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  rejected(results, 0, /FREE_UPSTREAM/);
  const posts = h.posts();
  assert.equal(posts.length, 3, 'automatic mode must cap retries at three attempts');
  assert.deepEqual(posts.map(post => post.body.model), [NVIDIA, GEMMA, GEMMA_SMALL]);
  assert.ok(posts.every(post => post.body.model.endsWith(':free')));
  assert.ok(posts.every(post => post.body.model !== FREE_MODEL));

  const serialized = JSON.stringify(posts.map(post => post.body));
  for (const paid of PAID_MODELS) assert.ok(!serialized.includes(paid), paid);
});

test('a long English sentence echoed back is rejected as untranslated instead of being shown', async () => {
  const source = 'This video is absolutely hilarious and I have watched it five times already.';
  const h = makeHarness({
    catalogModels: [FREE_MODEL, NVIDIA, GEMMA, GEMMA_SMALL],
    // Every candidate echoes the source verbatim: this must never become a displayed translation.
    chat: entry => plain(source, { model: entry.body.model })
  });

  const results = await h.translateAll([{ text: source, context: { title: 't', parent: '' } }]);

  rejected(results, 0, /OUTPUT_UNTRANSLATED/);
  assert.equal(results[0].value, undefined, 'an echoed source must not be delivered as a result');
  const posts = h.posts();
  assert.equal(posts.length, 3, 'automatic mode must keep its three-attempt cap for untranslated output');
  assert.deepEqual(posts.map(post => post.body.model), [NVIDIA, GEMMA, GEMMA_SMALL]);
  assert.ok(posts.every(post => post.body.model.endsWith(':free')), 'echo rejection must stay on the free route');
  assert.ok(posts.every(post => post.body.provider.max_price.prompt === '0' && post.body.provider.max_price.completion === '0'));
  // Each candidate that gets retried is cooled down so the next attempt picks another model;
  // the terminal third attempt has no retry left, so only the first two stay cooled.
  assert.ok(h.router.modelCooldowns.has(NVIDIA));
  assert.ok(h.router.modelCooldowns.has(GEMMA));
});

test('25 a fixed :free model never switches models after an upstream failure', async () => {
  const h = makeHarness({
    model: NVIDIA,
    catalogModels: [FREE_MODEL, NVIDIA, GEMMA],
    chat: () => response(502, { error: { code: 502, message: 'upstream failure' } })
  });

  const results = await h.translateAll([{ text: 'hello', context: { title: 't', parent: '' } }]);

  rejected(results, 0, /FREE_UPSTREAM/);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.model, NVIDIA);
  assert.equal(h.router.modelCooldowns.size, 0);
});
