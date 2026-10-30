'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../extension/shared.js');

const ORIGIN = 'https://index-translate.bilibili.com';
const BASE = ORIGIN + '/v1';
const ENDPOINT = BASE + '/chat/completions';
const MODELS = ['Index-Translate-2B', 'Index-Translate-9B', 'Index-Translate-35B-A3B'];
const DEFAULT_MODEL = MODELS[2];

const QUERY_HEAD = '请将以下中文搜索词翻译成自然英文搜索词，并且严格遵循所有约束要求。\n\n【源文】\n';
const TITLE_HEAD = '请将以下 YouTube 视频标题翻译成自然简体中文，并且严格遵循所有约束要求。\n\n【源文】\n';

/* The parent shared module owns the dualSearch preference. Until that field
 * lands in shared.settings, preserve it locally so the client contract can be
 * tested on its own; once shared keeps the field this wrapper is bypassed. */
function makeYTC() {
  let keepsDual = false;
  try { keepsDual = shared.settings({ dualSearch: true }).dualSearch === true; } catch { keepsDual = false; }
  if (keepsDual) return shared;
  return {
    ...shared,
    settings(value = {}) {
      const prefs = shared.settings(value);
      prefs.dualSearch = value && typeof value === 'object' && typeof value.dualSearch === 'boolean'
        ? value.dualSearch
        : true;
      return prefs;
    }
  };
}

const YTC = makeYTC();
globalThis.YTC = YTC;
const IX = require('../extension/indextranslate.js');

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

function catalogResponse(ids = MODELS) {
  return jsonResponse({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) });
}

function completion(content, { finish = 'stop', ...extra } = {}) {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: finish }],
    model: DEFAULT_MODEL,
    ...extra
  });
}

function indexConfig(overrides = {}) {
  return {
    service: 'indextranslate',
    baseUrl: BASE,
    model: DEFAULT_MODEL,
    apiKey: '',
    freeOnly: true,
    ...overrides
  };
}

function aiSettings(overrides = {}) {
  return { ...YTC.DEFAULTS, provider: 'ai', enabled: true, useContext: true, dualSearch: true, ...overrides };
}

function chromeStub({ settings = aiSettings(), aiConfig = indexConfig(), allowed = true } = {}) {
  const local = { settings: { ...settings }, aiConfig: { ...aiConfig } };
  const reads = [];
  const writes = [];
  const checks = [];
  const area = (name, value) => ({
    get: async keys => {
      const list = Array.isArray(keys) ? keys : [keys];
      reads.push({ area: name, keys: list.slice() });
      const out = {};
      for (const key of list) if (key in value) out[key] = value[key];
      return out;
    },
    set: async object => {
      writes.push({ area: name, keys: Object.keys(object) });
      Object.assign(value, object);
    },
    remove: async key => { delete value[key]; }
  });
  return {
    localData: local,
    reads,
    writes,
    checks,
    storage: { local: area('local', local), session: area('session', {}) },
    permissions: { contains: async query => { checks.push(query); return allowed; } }
  };
}

function makeClient({ models, post, settings, aiConfig, allowed = true } = {}) {
  const calls = [];
  const sleeps = [];
  let clock = 1000000;
  const chrome = chromeStub({ settings, aiConfig, allowed });
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === BASE + '/models') return typeof models === 'function' ? models() : models || catalogResponse();
    if (url === ENDPOINT) return post ? post(options) : completion('这是默认译文。');
    throw new Error('unexpected URL ' + url);
  };
  const client = new IX.Client({
    chrome,
    fetch,
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; }
  });
  return {
    client,
    chrome,
    calls,
    sleeps,
    get clock() { return clock; },
    advance: ms => { clock += ms; },
    posts: () => calls.filter(entry => entry.url === ENDPOINT)
  };
}

function assertNoIdentity(options) {
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal);
  for (const name of Object.keys(options.headers || {})) {
    assert.ok(!/authorization|cookie|referer|user-agent/i.test(name), name);
  }
}

function bodyOf(post) { return JSON.parse(post.options.body); }
function contentOf(post) { return bodyOf(post).messages[0].content; }

test('search works while comments are paused and the provider is not AI', async () => {
  const h = makeClient({
    settings: aiSettings({ enabled: false, provider: 'google' }),
    aiConfig: { service: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', apiKey: 'legacy-secret', freeOnly: true },
    post: () => completion('wireless noise cancelling headphones recommendation')
  });
  const result = await h.client.translateQuery('无线降噪耳机推荐');
  assert.deepEqual(result, {
    text: 'wireless noise cancelling headphones recommendation',
    model: DEFAULT_MODEL,
    source: 'auto'
  });

  const post = h.posts()[0];
  assertNoIdentity(post.options);
  assert.deepEqual(post.options.headers, { 'Content-Type': 'application/json' });
  const body = bodyOf(post);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.temperature, 0);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.ok(body.messages[0].content.startsWith(QUERY_HEAD + '无线降噪耳机推荐'));
  assert.ok(body.messages[0].content.includes('保留产品名、型号、版本、年份，不新增条件，不扩写主题'));
  assert.ok(body.messages[0].content.includes('只输出英文检索词，不解释，不使用 JSON'));
  assert.ok(!body.messages[0].content.includes('翻译成中文'));
  assert.ok(!post.options.body.includes('legacy-secret'));
  assert.ok(!post.options.body.includes('openrouter/free'));

  // The legacy aiConfig (including its key) is never read by the search path.
  assert.ok(h.chrome.reads.length > 0);
  for (const read of h.chrome.reads) {
    assert.equal(read.area, 'local');
    assert.deepEqual(read.keys, ['settings']);
  }
  assert.deepEqual(h.chrome.writes, []);
});

test('dualSearch false blocks query and title before any request', async () => {
  const h = makeClient({ settings: aiSettings({ dualSearch: false }) });
  await assert.rejects(h.client.translateQuery('无线耳机'), error => error.message === 'DISABLED');
  await assert.rejects(h.client.translateTitle('一个视频标题'), error => error.message === 'DISABLED');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.chrome.writes, []);
});

test('a false isCurrent guard blocks a queued search and its stale title', async () => {
  const blocked = makeClient();
  await assert.rejects(
    blocked.client.translateQuery('无线耳机', { isCurrent: () => false }),
    error => error.message === 'DISABLED'
  );
  assert.equal(blocked.calls.length, 0);

  // The guard is re-checked after pacing and immediately before the POST.
  const stale = makeClient();
  let checks = 0;
  await assert.rejects(
    stale.client.translateTitle('一个视频标题', { query: '搜索词', isCurrent: () => checks++ < 2 }),
    error => error.message === 'DISABLED'
  );
  assert.equal(stale.posts().length, 0);
  assert.ok(checks >= 3);
});

test('query and title use different prompts and the title keeps the query as context only', async () => {
  const h = makeClient({
    post: options => {
      const content = JSON.parse(options.body).messages[0].content;
      return completion(content.startsWith(QUERY_HEAD) ? 'noise cancelling headphones review' : '一款耳机的自然中文标题');
    }
  });
  const queryResult = await h.client.translateQuery('降噪耳机 评测');
  const titleResult = await h.client.translateTitle('Best Noise Cancelling Headphones Review 2025', { query: '降噪耳机 评测' });
  assert.equal(queryResult.text, 'noise cancelling headphones review');
  assert.equal(titleResult.text, '一款耳机的自然中文标题');

  const [queryPost, titlePost] = h.posts();
  const queryContent = contentOf(queryPost);
  const titleContent = contentOf(titlePost);
  assert.notEqual(queryContent, titleContent);
  assert.ok(queryContent.startsWith(QUERY_HEAD));
  assert.ok(titleContent.startsWith(TITLE_HEAD + 'Best Noise Cancelling Headphones Review 2025'));
  assert.ok(titleContent.includes('【上下文】（仅供理解，不要翻译）\n搜索词：降噪耳机 评测'));
  assert.ok(!titleContent.includes('视频标题：降噪耳机 评测'));
  assert.ok(titleContent.includes('保留专名、品牌、型号、数字'));
  assert.ok(titleContent.includes('不要翻译上下文'));
  assert.ok(!titleContent.includes('翻译成英文搜索词'));
  assert.equal(bodyOf(queryPost).model, DEFAULT_MODEL);
  assert.equal(bodyOf(titlePost).model, DEFAULT_MODEL);
});

test('query rejects an unchanged source, a non-Latin answer and a runaway answer', async () => {
  const source = '无线降噪耳机推荐';
  const exact = makeClient({ post: () => completion(source) });
  await assert.rejects(exact.client.translateQuery(source), error => {
    assert.equal(error.message, 'OUTPUT_UNTRANSLATED');
    assert.equal(error.diagnostic.stage, 'format');
    return true;
  });

  const chinese = makeClient({ post: () => completion('完全中文的检索结果') });
  await assert.rejects(chinese.client.translateQuery(source), error => error.message === 'OUTPUT_UNTRANSLATED');

  const runaway = makeClient({ post: () => completion('a'.repeat(501)) });
  await assert.rejects(runaway.client.translateQuery(source), error => error.message === 'OUTPUT_UNTRANSLATED');

  const good = makeClient({ post: () => completion('wireless noise cancelling headphone recommendation') });
  const result = await good.client.translateQuery(source);
  assert.equal(result.text, 'wireless noise cancelling headphone recommendation');
  assert.equal(result.source, 'auto');
});

test('query keeps existing English model names in the source and title cleans fenced JSON', async () => {
  const h = makeClient({
    post: options => {
      const content = JSON.parse(options.body).messages[0].content;
      return content.startsWith(QUERY_HEAD)
        ? completion('iPhone 15 Pro Max review')
        : completion('```json\n{"translation":"iPhone 15 Pro 深度评测"}\n```');
    }
  });
  const query = await h.client.translateQuery('iPhone 15 Pro Max 评测');
  assert.equal(query.text, 'iPhone 15 Pro Max review');
  const title = await h.client.translateTitle('iPhone 15 Pro Max Review', { query: 'iPhone 15 Pro Max 评测' });
  assert.equal(title.text, 'iPhone 15 Pro 深度评测');
});

test('search length limits are enforced before any network call', async () => {
  const h = makeClient();
  await assert.rejects(h.client.translateQuery('x'.repeat(301)), error => error.message === 'TOO_LONG');
  await assert.rejects(h.client.translateTitle('x'.repeat(501)), error => error.message === 'TOO_LONG');
  await assert.rejects(h.client.translateQuery('   '), error => error.message === 'RESPONSE');
  await assert.rejects(h.client.translateTitle('   '), error => error.message === 'RESPONSE');
  assert.equal(h.calls.length, 0);
});

test('concurrent query and title jobs share the single one-second pacing slot', async () => {
  const starts = [];
  const h = makeClient({
    post: options => {
      starts.push(h.clock);
      const content = JSON.parse(options.body).messages[0].content;
      return completion(content.startsWith(QUERY_HEAD) ? 'english search terms' : '自然中文标题');
    }
  });
  const query = h.client.translateQuery('中文搜索词');
  const title = h.client.translateTitle('An English Video Title', { query: '中文搜索词' });
  const [queryResult, titleResult] = await Promise.all([query, title]);
  assert.equal(queryResult.text, 'english search terms');
  assert.equal(titleResult.text, '自然中文标题');
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 1000);
  assert.ok(h.sleeps.includes(1000));
});

test('the comment context guard is preserved while search supplies its own material', async () => {
  const h = makeClient({
    settings: aiSettings({ useContext: false }),
    post: () => completion('english search terms')
  });
  await assert.rejects(
    h.client.translate('This is a lovely video', { title: 'private title' }, indexConfig()),
    error => error.message === 'DISABLED'
  );
  assert.equal(h.posts().length, 0);

  // Search has its own source and query context; it does not depend on the
  // comment useContext preference, comments.enabled or comments.provider.
  const result = await h.client.translateQuery('无线耳机');
  assert.equal(result.text, 'english search terms');
  assert.equal(h.posts().length, 1);
});

test('search is fixed to the public 35B preset and ignores a stored key', async () => {
  const h = makeClient({
    settings: aiSettings({ dualSearch: true }),
    aiConfig: indexConfig({ model: 'Index-Translate-2B', apiKey: 'stored-secret' }),
    post: () => completion('portable projector recommendation')
  });
  const result = await h.client.translateQuery('便携投影仪推荐');
  assert.equal(result.model, DEFAULT_MODEL);
  const post = h.posts()[0];
  const body = bodyOf(post);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.messages.length, 1);
  assert.ok(!post.options.body.includes('stored-secret'));
  assert.ok(!post.options.body.includes('Index-Translate-2B'));
  assert.ok(h.chrome.reads.every(read => read.keys.length === 1 && read.keys[0] === 'settings'));
  assert.deepEqual(h.chrome.writes, []);
});

test('search jobs are serialized through the same pending queue and cap', async () => {
  const h = makeClient();
  h.client.pending = Array.from({ length: 80 }, () => ({}));
  await assert.rejects(h.client.translateQuery('无线耳机'), error => error.message === 'BUSY');
  assert.equal(h.calls.length, 0);
});
