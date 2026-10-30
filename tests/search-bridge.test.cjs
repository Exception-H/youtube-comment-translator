'use strict';
/* Tests for the search-only translation bridge (extension/search-bridge.js).
 *
 * No real network and no real key is used:
 *  - the Controller tests inject a stub Bilibili client and a chrome stub;
 *  - the real Index-Translate client tests use a fake fetch;
 *  - the background tests drive the real worker pipeline in a VM through
 *    tests/worker-harness.cjs (which imports search-bridge.js and builds the
 *    same `searchBridge` controller the worker uses).
 *
 * Includes the regression for late messages arriving after SEARCH_END.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./worker-harness.cjs');
const shared = require('../extension/shared.js');

globalThis.YTC = shared;
const Bridge = require('../extension/search-bridge.js');
const Index = require('../extension/indextranslate.js');

const ORIGIN = 'https://index-translate.bilibili.com';
const BASE = ORIGIN + '/v1';
const CATALOG = BASE + '/models';
const ENDPOINT = BASE + '/chat/completions';
const MODEL = 'Index-Translate-35B-A3B';
const QUERY = '电脑卡顿';
const TTL = 6 * 60 * 60 * 1000;

/* The two search prompts are intentionally different from the comment prompt. */
const QUERY_HEAD = '请将以下中文搜索词翻译成自然英文搜索词，并且严格遵循所有约束要求。\n\n【源文】\n';
const TITLE_HEAD = '请将以下 YouTube 视频标题翻译成自然简体中文，并且严格遵循所有约束要求。\n\n【源文】\n';

const SENDER = {
  url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(QUERY),
  tab: { id: 1 }
};

/* ------------------------------------------------------------------ utils */

const created = [];
after(() => {
  for (const controller of created) {
    if (controller.timer) {
      clearTimeout(controller.timer);
      controller.timer = null;
    }
  }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeout = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await delay(5);
  }
}

function sender(query = QUERY, tabId = 1, options = {}) {
  const { path = '/results', host = 'www.youtube.com', protocol = 'https:', withQuery = true } = options;
  const search = withQuery ? '?search_query=' + encodeURIComponent(query) : '';
  return { url: protocol + '//' + host + path + search, tab: { id: tabId } };
}

function startMessage(session = 's1') {
  return { type: 'SEARCH_START', session };
}

function endMessage(session = 's1') {
  return { type: 'SEARCH_END', session };
}

function queryMessage({ text = QUERY, query = QUERY, session = 's1' } = {}) {
  return { type: 'SEARCH_TRANSLATE', purpose: 'query', text, query, session };
}

function titleMessage({ text = 'My PC is slow', query = QUERY, session = 's1' } = {}) {
  return { type: 'SEARCH_TRANSLATE', purpose: 'title', text, query, session };
}

/* ----------------------------------------------------------------- stubs */

function makeChrome({ settings = { dualSearch: true }, session = {}, allowed = true, local = null } = {}) {
  const localStore = local ? { ...local } : { settings };
  const sessionStore = { ...session };
  const state = { allowed };
  const checks = [];
  const writes = [];
  const opened = [];
  const area = (store, name) => ({
    get: async keys => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
      return out;
    },
    set: async object => {
      writes.push({ area: name, object });
      Object.assign(store, object);
    },
    remove: async key => { delete store[key]; }
  });
  const chrome = {
    storage: { local: area(localStore, 'local'), session: area(sessionStore, 'session') },
    permissions: { contains: async value => { checks.push(value); return state.allowed; } },
    tabs: {
      create: async options => {
        const url = String(options && options.url);
        opened.push(url);
        // The bridge must only ever open its own options page, never a web page.
        if (!url.startsWith('chrome-extension://test/options.html')) throw new Error('EXTERNAL_NAVIGATION');
        return { id: 9 };
      }
    },
    runtime: { id: 'test', getURL: file => 'chrome-extension://test/' + file }
  };
  return { chrome, local: localStore, session: sessionStore, state, checks, writes, opened };
}

function makeClient(handler) {
  const calls = [];
  const run = async (purpose, text, options = {}) => {
    const call = { purpose, text, query: options.query, isCurrent: options.isCurrent };
    calls.push(call);
    if (handler) return handler(call);
    return purpose === 'query'
      ? { text: 'slow computer', model: 'stub-model' }
      : { text: '电脑很卡', model: 'stub-model' };
  };
  return {
    calls,
    translateQuery: (text, options) => run('query', text, options),
    translateTitle: (text, options) => run('title', text, options)
  };
}

function makeController({ chrome: chromeOptions = {}, client, prepare, now } = {}) {
  const env = makeChrome(chromeOptions);
  const usedClient = client || makeClient();
  const prepareCalls = [];
  const prepareImpl = async () => {
    prepareCalls.push(true);
    if (prepare) await prepare();
  };
  const controller = new Bridge.Controller({
    chrome: env.chrome,
    client: usedClient,
    prepare: prepareImpl,
    now: now || Date.now
  });
  created.push(controller);
  return { ...env, controller, client: usedClient, prepareCalls };
}

/* --------------------------------------------------- message/sender rules */

test('only the four search bridge message types are accepted', async () => {
  const { controller, client } = makeController();
  for (const type of ['SEARCH_START', 'SEARCH_END', 'SEARCH_TRANSLATE', 'OPEN_DUAL_SETTINGS']) {
    assert.equal(controller.accepts(type), true);
  }
  for (const type of ['TRANSLATE', 'TEST_AI', 'CLEAR_CACHE', 'SEARCH_RESULTS', undefined, null]) {
    await assert.rejects(controller.handle({ type }, SENDER), /SEARCH_SESSION/);
  }
  assert.equal(client.calls.length, 0);
});

test('a real https YouTube /results URL with a Chinese search_query and an integer tab id is required', async () => {
  const { controller, client, opened } = makeController();
  assert.deepEqual(await controller.handle(startMessage('s1'), SENDER), { ok: true });

  const badSenders = [
    { url: 'https://example.com/results?search_query=' + encodeURIComponent(QUERY), tab: { id: 1 } },
    { url: SENDER.url },
    { url: 'chrome-extension://test/options.html', tab: { id: 1 } },
    { url: 'http://www.youtube.com/results?search_query=' + encodeURIComponent(QUERY), tab: { id: 1 } },
    { url: 'https://www.youtube.com/watch?v=x', tab: { id: 1 } },
    { url: 'https://www.youtube.com/results', tab: { id: 1 } },
    { url: 'https://www.youtube.com/results?search_query=computer', tab: { id: 1 } },
    { url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent('电'.repeat(301)), tab: { id: 1 } },
    { url: 'https://evil-youtube.com/results?search_query=' + encodeURIComponent(QUERY), tab: { id: 1 } },
    { url: SENDER.url, tab: { id: '1' } },
    { url: 'not a url', tab: { id: 1 } }
  ];
  for (const badSender of badSenders) {
    await assert.rejects(controller.handle(startMessage('s2'), badSender), /SEARCH_SESSION/);
  }
  // The browser also accepts the unencoded form of the same URL.
  assert.deepEqual(
    await controller.handle(startMessage('raw'), {
      url: 'https://www.youtube.com/results?search_query=' + QUERY,
      tab: { id: 1 }
    }),
    { ok: true }
  );
  assert.equal(client.calls.length, 0);
  assert.deepEqual(opened, []);
});

test('sessions must be short opaque ids', async () => {
  const { controller, client } = makeController();
  for (const session of ['', 'has space', 'a'.repeat(81), 'bad/slash', 7, null, undefined]) {
    await assert.rejects(controller.handle({ type: 'SEARCH_START', session }, SENDER), /SEARCH_SESSION/);
  }
  assert.equal(client.calls.length, 0);
});

/* ------------------------------------------------ dual-search preference */

test('search translation ignores comments.enabled and provider; only dualSearch gates it', async () => {
  const { controller, client } = makeController({
    chrome: { settings: { enabled: false, provider: 'google', dualSearch: true } }
  });
  await controller.handle(startMessage('s1'), SENDER);
  const result = await controller.handle(titleMessage(), SENDER);
  assert.equal(result.ok, true);
  assert.equal(result.text, '电脑很卡');
  assert.equal(result.cached, false);
  assert.equal(client.calls.length, 1);
});

test('dualSearch false rejects start and translate but still allows SEARCH_END', async () => {
  const { controller, client } = makeController({
    chrome: { settings: { enabled: true, provider: 'ai', dualSearch: false } }
  });
  await assert.rejects(controller.handle(startMessage('s1'), SENDER), /DISABLED/);
  await assert.rejects(controller.handle(titleMessage(), SENDER), /DISABLED/);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(await controller.handle(endMessage('s1'), SENDER), { ok: true });
});

test('missing settings fall back to the default dualSearch=true', async () => {
  const { controller, client } = makeController({ chrome: { local: {} } });
  await controller.handle(startMessage('s1'), SENDER);
  const result = await controller.handle(titleMessage(), SENDER);
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 1);
});

/* --------------------------------------------- session ownership / races */

test('a newer session replaces the old one, and the old session cannot translate', async () => {
  const { controller, client } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  await controller.handle(startMessage('s2'), SENDER);
  await assert.rejects(controller.handle(titleMessage({ session: 's1' }), SENDER), /SEARCH_SESSION/);
  assert.equal(client.calls.length, 0);
  assert.equal(controller.active(1, 's2'), true);
});

test('switching sessions before the client is called prevents the POST and the cache write', async () => {
  const { controller, client } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  const pending = controller.handle(titleMessage({ session: 's1' }), SENDER);
  // The new SEARCH_START wins the race while the old job is still awaiting its digest.
  await controller.handle(startMessage('s2'), SENDER);
  await assert.rejects(pending, /SEARCH_SESSION/);
  assert.equal(client.calls.length, 0);
  assert.equal(controller.cache.size, 0);
  const result = await controller.handle(titleMessage({ session: 's2' }), SENDER);
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 1);
});

test('a session switch during an in-flight client call rejects and does not cache', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = makeClient(async () => {
    await gate;
    return { text: '电脑很卡', model: 'stub-model' };
  });
  const { controller } = makeController({ client });
  await controller.handle(startMessage('s1'), SENDER);
  const pending = controller.handle(titleMessage({ session: 's1' }), SENDER);
  await waitFor(() => client.calls.length === 1);
  await controller.handle(startMessage('s2'), SENDER);
  release();
  await assert.rejects(pending, /SEARCH_SESSION/);
  assert.equal(controller.cache.size, 0);
  const result = await controller.handle(titleMessage({ session: 's2' }), SENDER);
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 2);
});

test('an old SEARCH_END never clears the newer session', async () => {
  const { controller } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  await controller.handle(startMessage('s2'), SENDER);
  assert.deepEqual(await controller.handle(endMessage('s1'), SENDER), { ok: true });
  assert.equal(controller.active(1, 's2'), true);
  const result = await controller.handle(titleMessage({ session: 's2' }), SENDER);
  assert.equal(result.ok, true);
});

test('SEARCH_END removes the matching session', async () => {
  const { controller } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  await controller.handle(endMessage('s1'), SENDER);
  assert.equal(controller.active(1, 's1'), false);
  assert.equal(controller.sessions.has(1), false);
});

test('one tab never overwrites another tab, and ending one tab leaves the other alone', async () => {
  const { controller, client } = makeController();
  const queryA = '电脑卡顿';
  const queryB = '手机卡顿';
  const tabA = sender(queryA, 1);
  const tabB = sender(queryB, 2);
  await controller.handle(startMessage('a'), tabA);
  await controller.handle(startMessage('b'), tabB);
  assert.equal(controller.active(1, 'a'), true);
  assert.equal(controller.active(2, 'b'), true);

  const first = await controller.handle(titleMessage({ text: 'My PC is slow', query: queryA, session: 'a' }), tabA);
  const second = await controller.handle(titleMessage({ text: 'My phone is slow', query: queryB, session: 'b' }), tabB);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(client.calls.length, 2);

  await controller.handle(endMessage('b'), tabB);
  assert.equal(controller.active(2, 'b'), false);
  const again = await controller.handle(titleMessage({ text: 'My PC is slow', query: queryA, session: 'a' }), tabA);
  assert.equal(again.cached, true);
});

test('after a worker restart a legitimate current title rebuilds the lost session', async () => {
  // A fresh Controller has an empty sessions map, like a restarted service worker.
  const { controller, client } = makeController();
  const result = await controller.handle(titleMessage({ session: 'fresh' }), SENDER);
  assert.equal(result.ok, true);
  assert.equal(controller.active(1, 'fresh'), true);
  await assert.rejects(controller.handle(titleMessage({ session: 'older' }), SENDER), /SEARCH_SESSION/);
  assert.equal(client.calls.length, 1);
});

/* ------------------------------------------------------- input contracts */

test('query text must equal the source query; title may differ', async () => {
  const { controller, client } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  await assert.rejects(controller.handle(queryMessage({ text: '手机卡顿' }), SENDER), /SEARCH_SESSION/);
  await assert.rejects(controller.handle(titleMessage({ query: '手机卡顿' }), SENDER), /SEARCH_SESSION/);
  await assert.rejects(controller.handle(queryMessage({ query: '' }), SENDER), /SEARCH_SESSION/);
  const title = await controller.handle(titleMessage({ text: 'Completely different title' }), SENDER);
  assert.equal(title.ok, true);
  assert.equal(client.calls.length, 1);
});

test('length limits follow the purpose, not one shared number', async () => {
  const { controller, client } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  // 301 characters for a query rewrite is too long.
  await assert.rejects(controller.handle(queryMessage({ text: '电'.repeat(301) }), SENDER), /TOO_LONG/);
  // 501 characters for a title is too long.
  await assert.rejects(controller.handle(titleMessage({ text: 'a'.repeat(501) }), SENDER), /TOO_LONG/);
  // 500 characters for a title is fine.
  const longTitle = await controller.handle(titleMessage({ text: 'a'.repeat(500) }), SENDER);
  assert.equal(longTitle.ok, true);
  // An invalid purpose is reported as TOO_LONG by the current implementation.
  await assert.rejects(
    controller.handle({ type: 'SEARCH_TRANSLATE', purpose: 'caption', text: 'x', query: QUERY, session: 's1' }, SENDER),
    /TOO_LONG/
  );
  // Whitespace-only text is rejected before any client call.
  await assert.rejects(controller.handle(titleMessage({ text: '   ' }), SENDER), /TOO_LONG/);
  assert.equal(client.calls.length, 1);
});

test('a 300-character query is the accepted maximum, and a 301-character title is still allowed', async () => {
  const longQuery = '电'.repeat(300);
  const longSender = sender(longQuery, 1);
  const { controller, client } = makeController();
  await controller.handle(startMessage('s1'), longSender);
  const title = await controller.handle(titleMessage({ text: 'a'.repeat(301), query: longQuery }), longSender);
  assert.equal(title.ok, true);
  const query = await controller.handle(queryMessage({ text: longQuery, query: longQuery }), longSender);
  assert.equal(query.ok, true);
  await assert.rejects(
    controller.handle(queryMessage({ text: longQuery + 'a', query: longQuery }), longSender),
    /TOO_LONG/
  );
  assert.equal(client.calls.length, 2);
});

/* -------------------------------------------------- cache keys and cache */

test('query and title use different cache keys, and title keeps the original query context', async () => {
  const { controller, client } = makeController();
  await controller.handle(startMessage('s1'), SENDER);

  const queryKey = await controller.key('query', QUERY, QUERY);
  const titleKey = await controller.key('title', QUERY, QUERY);
  const otherQueryKey = await controller.key('title', QUERY, '手机卡顿');
  assert.match(queryKey, /^[a-f0-9]{64}$/);
  assert.notEqual(queryKey, titleKey);
  assert.notEqual(titleKey, otherQueryKey);

  const queryResult = await controller.handle(queryMessage(), SENDER);
  const titleResult = await controller.handle(titleMessage({ text: QUERY }), SENDER);
  assert.equal(queryResult.cached, false);
  assert.equal(titleResult.cached, false);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].purpose, 'query');
  assert.equal(client.calls[1].purpose, 'title');
  assert.equal(client.calls[1].query, QUERY);

  const titleAgain = await controller.handle(titleMessage({ text: QUERY }), SENDER);
  assert.equal(titleAgain.cached, true);
  assert.equal(client.calls.length, 2);
});

test('a persisted session cache is reused by a restarted controller', async () => {
  const seedController = makeController().controller;
  const key = await seedController.key('title', 'My PC is slow', QUERY);
  const seeded = {
    searchTranslations: [[key, { text: '电脑很卡', model: 'stub-model', time: Date.now() - 1000 }]]
  };
  const { controller, client } = makeController({ chrome: { session: seeded } });
  await controller.handle(startMessage('s1'), SENDER);
  const result = await controller.handle(titleMessage(), SENDER);
  assert.equal(result.ok, true);
  assert.equal(result.cached, true);
  assert.equal(result.text, '电脑很卡');
  assert.equal(client.calls.length, 0);
});

test('an expired persisted entry is ignored', async () => {
  const seedController = makeController().controller;
  const key = await seedController.key('title', 'My PC is slow', QUERY);
  const seeded = {
    searchTranslations: [[key, { text: '旧译文', model: 'stub-model', time: Date.now() - TTL - 1000 }]]
  };
  const { controller, client } = makeController({ chrome: { session: seeded } });
  await controller.handle(startMessage('s1'), SENDER);
  const result = await controller.handle(titleMessage(), SENDER);
  assert.equal(result.cached, false);
  assert.equal(result.text, '电脑很卡');
  assert.equal(client.calls.length, 1);
});

test('failed translations are never cached', async () => {
  let attempts = 0;
  const client = makeClient(() => {
    attempts++;
    if (attempts === 1) throw new Error('INDEX_SERVICE');
    return { text: '电脑很卡', model: 'stub-model' };
  });
  const { controller } = makeController({ client });
  await controller.handle(startMessage('s1'), SENDER);
  await assert.rejects(controller.handle(titleMessage(), SENDER), /INDEX_SERVICE/);
  const result = await controller.handle(titleMessage(), SENDER);
  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.equal(attempts, 2);
});

test('the cache TTL is enforced with an injected clock', async () => {
  let now = 1000;
  const { controller, client } = makeController({ now: () => now });
  await controller.handle(startMessage('s1'), SENDER);
  await controller.handle(titleMessage(), SENDER);
  assert.equal(client.calls.length, 1);

  now += TTL - 1;
  const stillCached = await controller.handle(titleMessage(), SENDER);
  assert.equal(stillCached.cached, true);
  assert.equal(client.calls.length, 1);

  now += 1;
  const expired = await controller.handle(titleMessage(), SENDER);
  assert.equal(expired.cached, false);
  assert.equal(client.calls.length, 2);
});

/* ------------------------------------- permission and header preparation */

test('permissions.contains false returns AI_PERMISSION without calling prepare or the client', async () => {
  const { controller, client, checks, state, prepareCalls } = makeController({ chrome: { allowed: false } });
  await controller.handle(startMessage('s1'), SENDER);
  await assert.rejects(controller.handle(titleMessage(), SENDER), /AI_PERMISSION/);
  assert.equal(client.calls.length, 0);
  assert.equal(prepareCalls.length, 0);
  assert.deepEqual(checks[0], { origins: [ORIGIN + '/*'] });

  state.allowed = true;
  const result = await controller.handle(titleMessage(), SENDER);
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 1);
});

test('a rejected prepare() is retried instead of cached', async () => {
  const { controller, client, prepareCalls } = makeController({
    prepare: async () => { throw new Error('INDEX_CONFIG'); }
  });
  await controller.handle(startMessage('s1'), SENDER);
  await assert.rejects(controller.handle(titleMessage(), SENDER), /INDEX_CONFIG/);
  await assert.rejects(controller.handle(titleMessage(), SENDER), /INDEX_CONFIG/);
  assert.equal(prepareCalls.length, 2);
  assert.equal(client.calls.length, 0);
});

/* --------------------------------------------------------------- clearing */

test('clear() removes the persisted searchTranslations entry and the memory cache', async () => {
  const { controller, session } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  await controller.handle(titleMessage(), SENDER);
  await delay(450);
  assert.ok(Array.isArray(session.searchTranslations));
  assert.equal(session.searchTranslations.length, 1);

  await controller.clear();
  assert.equal('searchTranslations' in session, false);
  assert.equal(controller.cache.size, 0);
});

test('a translation that finishes after clear() cannot restore the old cache', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = makeClient(async () => {
    await gate;
    return { text: '电脑很卡', model: 'stub-model' };
  });
  const { controller, session, writes } = makeController({ client });
  await controller.handle(startMessage('s1'), SENDER);
  const pending = controller.handle(titleMessage(), SENDER);
  await waitFor(() => client.calls.length === 1);

  await controller.clear();
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(controller.cache.size, 0);

  await delay(450);
  assert.equal('searchTranslations' in session, false);
  assert.equal(
    writes.filter(entry => entry.area === 'session' && entry.object && 'searchTranslations' in entry.object).length,
    0
  );

  const retry = await controller.handle(titleMessage(), SENDER);
  assert.equal(retry.cached, false);
  assert.equal(client.calls.length, 2);
});

/* ----------------------------------------------------- dual settings page */

test('OPEN_DUAL_SETTINGS opens only the extension options page', async () => {
  const { controller, opened } = makeController();
  assert.deepEqual(await controller.handle({ type: 'OPEN_DUAL_SETTINGS' }, SENDER), { ok: true });
  assert.deepEqual(opened, ['chrome-extension://test/options.html#dual-search']);
  // A non-YouTube page (options/popup) cannot trigger it.
  await assert.rejects(
    controller.handle({ type: 'OPEN_DUAL_SETTINGS' }, { url: 'chrome-extension://test/options.html', tab: { id: 1 } }),
    /SEARCH_SESSION/
  );
});

test('OPEN_DUAL_SETTINGS falls back to openOptionsPage when tabs.create is unavailable', async () => {
  const env = makeChrome();
  delete env.chrome.tabs;
  let openedPage = 0;
  env.chrome.runtime.openOptionsPage = async () => { openedPage++; };
  const controller = new Bridge.Controller({
    chrome: env.chrome,
    client: makeClient(),
    prepare: async () => {},
    now: Date.now
  });
  created.push(controller);
  assert.deepEqual(await controller.handle({ type: 'OPEN_DUAL_SETTINGS' }, SENDER), { ok: true });
  assert.equal(openedPage, 1);
});

/* ------------------------------------------------ real Index client tests */

function clientChrome({ allowed = true, settings = { dualSearch: true }, aiConfig = null, reads = [] } = {}) {
  const state = { allowed, settings, aiConfig };
  const checks = [];
  const chrome = {
    storage: {
      local: {
        get: async keys => {
          const list = Array.isArray(keys) ? keys : [keys];
          reads.push(list);
          const out = {};
          for (const key of list) {
            if (key === 'settings') out.settings = state.settings;
            if (key === 'aiConfig' && state.aiConfig) out.aiConfig = state.aiConfig;
          }
          return out;
        }
      }
    },
    permissions: { contains: async value => { checks.push(value); return state.allowed; } }
  };
  return { chrome, state, checks };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => body
  };
}

function catalogBody(ids = [MODEL]) {
  return { object: 'list', data: ids.map(id => ({ id, object: 'model' })) };
}

function completionBody(content) {
  return { choices: [{ message: { content }, finish_reason: 'stop' }], model: MODEL };
}

test('the real client uses the fixed keyless Index-Translate-35B preset with no auth header', async () => {
  const requests = [];
  const reads = [];
  const { chrome, checks } = clientChrome({
    settings: { enabled: false, provider: 'google', dualSearch: true },
    reads
  });
  const client = new Index.Client({
    chrome,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === CATALOG) return jsonResponse(catalogBody());
      const body = JSON.parse(options.body);
      const prompt = body.messages[0].content;
      return jsonResponse(completionBody(prompt.includes('中文搜索词') ? 'slow computer' : '我的电脑很卡'));
    },
    sleep: async () => {},
    now: () => Date.now()
  });

  const title = await client.translateTitle('My PC is slow', { isCurrent: () => true, query: QUERY });
  assert.equal(title.text, '我的电脑很卡');
  const query = await client.translateQuery(QUERY, { isCurrent: () => true });
  assert.equal(query.text, 'slow computer');

  const catalogRequest = requests.find(request => request.url === CATALOG);
  assert.ok(catalogRequest);
  assert.equal(catalogRequest.options.method, 'GET');
  assert.equal(catalogRequest.options.credentials, 'omit');
  assert.equal(catalogRequest.options.referrerPolicy, 'no-referrer');
  assert.equal(catalogRequest.options.headers, undefined);

  const posts = requests.filter(request => request.url === ENDPOINT);
  assert.equal(posts.length, 2);
  for (const { options } of posts) {
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(Object.keys(options.headers), ['Content-Type']);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0);
    assert.ok(!JSON.stringify(options).includes('Authorization'));
    assert.ok(!JSON.stringify(body).includes('apiKey'));
  }

  const titlePrompt = JSON.parse(posts[0].options.body).messages[0].content;
  assert.ok(titlePrompt.startsWith(TITLE_HEAD));
  assert.ok(titlePrompt.includes('搜索词：' + QUERY));
  assert.ok(!titlePrompt.includes('请将以下文本翻译成中文'));

  const queryPrompt = JSON.parse(posts[1].options.body).messages[0].content;
  assert.ok(queryPrompt.startsWith(QUERY_HEAD));
  assert.ok(!queryPrompt.includes('【上下文】'));

  assert.deepEqual(checks[0], { origins: [ORIGIN + '/*'] });
  // The search path must never read the comment service config/key.
  assert.ok(reads.every(keys => !keys.includes('aiConfig')));
});

test('the real client returns AI_PERMISSION without any fetch when permission is missing', async () => {
  const requests = [];
  const { chrome } = clientChrome({ allowed: false });
  const client = new Index.Client({
    chrome,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse(catalogBody());
    },
    sleep: async () => {}
  });
  await assert.rejects(client.translateQuery(QUERY, { isCurrent: () => true }), /AI_PERMISSION/);
  assert.equal(requests.length, 0);
});

test('the real client refuses a catalog that does not advertise the fixed model', async () => {
  const requests = [];
  const { chrome } = clientChrome();
  const client = new Index.Client({
    chrome,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse(catalogBody(['Index-Translate-2B']));
    },
    sleep: async () => {}
  });
  await assert.rejects(client.translateTitle('My PC is slow', { isCurrent: () => true, query: QUERY }), /AI_MODEL/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, CATALOG);
});

test('the real client obeys dualSearch and the caller guard before any fetch', async () => {
  const disabledRequests = [];
  const disabled = clientChrome({ settings: { dualSearch: false } });
  const disabledClient = new Index.Client({
    chrome: disabled.chrome,
    fetch: async (url, options = {}) => {
      disabledRequests.push({ url, options });
      return jsonResponse(catalogBody());
    },
    sleep: async () => {}
  });
  await assert.rejects(disabledClient.translateQuery(QUERY, { isCurrent: () => true }), /DISABLED/);
  assert.equal(disabledRequests.length, 0);

  const guardedRequests = [];
  const guarded = clientChrome();
  const guardedClient = new Index.Client({
    chrome: guarded.chrome,
    fetch: async (url, options = {}) => {
      guardedRequests.push({ url, options });
      return jsonResponse(catalogBody());
    },
    sleep: async () => {}
  });
  await assert.rejects(guardedClient.translateTitle('My PC is slow', { isCurrent: () => false, query: QUERY }), /DISABLED/);
  assert.equal(guardedRequests.length, 0);
});

test('a queued title whose guard expires is never POSTed by the real client', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const guard = { current: true };
  let posts = 0;
  const { chrome } = clientChrome();
  const client = new Index.Client({
    chrome,
    fetch: async (url, options = {}) => {
      if (url === CATALOG) return jsonResponse(catalogBody());
      posts++;
      await gate;
      return jsonResponse(completionBody('我的电脑很卡'));
    },
    sleep: async () => {},
    now: () => Date.now()
  });

  const first = client.translateTitle('My PC is slow', { isCurrent: () => guard.current, query: QUERY });
  const second = client.translateTitle('My phone is slow', { isCurrent: () => guard.current, query: QUERY });
  await waitFor(() => posts === 1);
  guard.current = false;
  release();
  const result = await first;
  assert.equal(result.text, '我的电脑很卡');
  await assert.rejects(second, /DISABLED/);
  assert.equal(posts, 1);
});

/* ------------------------------------------------ background VM pipeline */

function vmResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => body
  };
}

function indexFetch(requests, contentFor = () => '我的电脑很卡') {
  return async (url, options = {}) => {
    requests.push({ url, options });
    if (url === CATALOG) return vmResponse(catalogBody());
    if (url === ENDPOINT) {
      const prompt = JSON.parse(options.body).messages[0].content;
      return vmResponse(completionBody(contentFor(prompt)));
    }
    throw new Error('unexpected request ' + url);
  };
}

test('background pipeline: search works while comments are disabled and caches in storage.session', async () => {
  const requests = [];
  const worker = harness(indexFetch(requests));
  try {
    worker.data.local.settings = { enabled: false, provider: 'google', dualSearch: true };
    const tabSender = { url: SENDER.url, tab: { id: 1 } };
    // Responses come from the VM realm, so compare plain copies.
    assert.deepEqual({ ...(await worker.send(startMessage('s1'), tabSender)) }, { ok: true });

    const first = await worker.send(titleMessage({ session: 's1' }), tabSender);
    assert.equal(first.ok, true);
    assert.equal(first.text, '我的电脑很卡');
    assert.equal(first.cached, false);

    const posts = requests.filter(request => request.url === ENDPOINT);
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].options.body);
    assert.equal(body.model, MODEL);
    assert.equal(posts[0].options.headers.Authorization, undefined);
    assert.equal(posts[0].options.credentials, 'omit');
    assert.ok(body.messages[0].content.includes('搜索词：' + QUERY));
    // The search path never touches google/ai endpoints.
    assert.ok(requests.every(request => request.url.startsWith(ORIGIN)));

    const rule = worker.context.chrome.declarativeNetRequest.updates[0];
    assert.equal(rule.removeRuleIds[0], 14001);
    assert.equal(rule.addRules[0].action.requestHeaders[0].header, 'origin');
    assert.equal(rule.addRules[0].action.requestHeaders[0].operation, 'remove');
    assert.ok(rule.addRules[0].condition.regexFilter.includes('index-translate\\.bilibili\\.com'));

    const second = await worker.send(titleMessage({ session: 's1' }), tabSender);
    assert.equal(second.cached, true);
    assert.equal(requests.filter(request => request.url === ENDPOINT).length, 1);

    await delay(450);
    assert.ok(Array.isArray(worker.data.session.searchTranslations));
    assert.equal(worker.data.session.searchTranslations.length, 1);
  } finally {
    worker.dispose();
  }
});

test('background rejects search traffic when dualSearch is off', async () => {
  const requests = [];
  const worker = harness(indexFetch(requests));
  try {
    worker.data.local.settings = { enabled: true, provider: 'ai', dualSearch: false };
    const tabSender = { url: SENDER.url, tab: { id: 1 } };
    assert.deepEqual({ ...(await worker.send(startMessage('s1'), tabSender)) }, { ok: false, error: 'DISABLED' });
    assert.deepEqual({ ...(await worker.send(titleMessage({ session: 's1' }), tabSender)) }, { ok: false, error: 'DISABLED' });
    assert.equal(requests.length, 0);
  } finally {
    worker.dispose();
  }
});

test('background refuses options pages and senders without a tab', async () => {
  const worker = harness(indexFetch([]));
  try {
    const optionsSender = { url: 'chrome-extension://test/options.html', tab: { id: 1 } };
    await assert.rejects(worker.send(startMessage('s1'), optionsSender), /UNAUTHORIZED/);
    await assert.rejects(worker.send(startMessage('s1'), { url: SENDER.url }), /UNAUTHORIZED/);
    await assert.rejects(worker.send({ type: 'OPEN_DUAL_SETTINGS' }, { url: SENDER.url }), /UNAUTHORIZED/);
  } finally {
    worker.dispose();
  }
});

test('background OPEN_DUAL_SETTINGS only opens the extension options page', async () => {
  const opened = [];
  const worker = harness(indexFetch([]));
  try {
    worker.context.chrome.tabs = {
      create: async options => {
        const url = String(options && options.url);
        opened.push(url);
        if (!url.startsWith('chrome-extension://test/options.html')) throw new Error('EXTERNAL_NAVIGATION');
        return { id: 2 };
      }
    };
    assert.deepEqual(
      { ...(await worker.send({ type: 'OPEN_DUAL_SETTINGS' }, { url: SENDER.url, tab: { id: 1 } })) },
      { ok: true }
    );
    assert.deepEqual(opened, ['chrome-extension://test/options.html#dual-search']);
  } finally {
    worker.dispose();
  }
});

test('background CLEAR_CACHE removes both translation caches', async () => {
  const requests = [];
  const worker = harness(indexFetch(requests));
  try {
    worker.data.local.settings = { dualSearch: true };
    const tabSender = { url: SENDER.url, tab: { id: 1 } };
    await worker.send(startMessage('s1'), tabSender);
    await worker.send(titleMessage({ session: 's1' }), tabSender);
    await delay(450);
    assert.ok(Array.isArray(worker.data.session.searchTranslations));

    const optionsSender = { url: 'chrome-extension://test/options.html', tab: { id: 1 } };
    assert.deepEqual({ ...(await worker.send({ type: 'CLEAR_CACHE' }, optionsSender)) }, { ok: true });
    assert.equal('searchTranslations' in worker.data.session, false);
    assert.equal('translations' in worker.data.session, false);
  } finally {
    worker.dispose();
  }
});

test('background retries prepareIndexHeaders after a rejected header rule instead of caching it', async () => {
  const requests = [];
  let deny = true;
  const worker = harness(indexFetch(requests));
  try {
    worker.data.local.settings = { dualSearch: true };
    const dnr = worker.context.chrome.declarativeNetRequest;
    let updates = 0;
    dnr.updateDynamicRules = async value => {
      updates++;
      dnr.updates.push(value);
      if (deny) throw new Error('denied');
    };
    const tabSender = { url: SENDER.url, tab: { id: 1 } };
    await worker.send(startMessage('s1'), tabSender);

    const first = await worker.send(titleMessage({ session: 's1' }), tabSender);
    assert.equal(first.ok, false);
    assert.equal(first.error, 'INDEX_CONFIG');
    assert.equal(requests.length, 0);

    deny = false;
    const second = await worker.send(titleMessage({ session: 's1' }), tabSender);
    assert.equal(second.ok, true);
    assert.equal(updates, 2);
    assert.equal(requests.filter(request => request.url === ENDPOINT).length, 1);
  } finally {
    worker.dispose();
  }
});

/* ------------------------------------------------------------ source bug */

/* Ending a view is final even if a translation message arrives late. */
test('SEARCH_END stays final for the ended session', async () => {
  const { controller } = makeController();
  await controller.handle(startMessage('s1'), SENDER);
  await controller.handle(endMessage('s1'), SENDER);
  await assert.rejects(controller.handle(titleMessage({ session: 's1' }), SENDER), /SEARCH_SESSION/);
});
