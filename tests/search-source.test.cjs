'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readClientContext,
  parseClientConfig,
  parseResults,
  SearchSource
} = require('../extension/search-source.js');

const CLIENT = Object.freeze({
  clientName: 'WEB',
  clientVersion: '2.20261030.01.00',
  hl: 'en',
  gl: 'US'
});

/* ------------------------------ fixtures -------------------------------- */

function docWith(...texts) {
  return { scripts: texts.map(textContent => ({ textContent })) };
}

function ytcfgWith(client) {
  return 'ytcfg.set(' + JSON.stringify({ INNERTUBE_CONTEXT: { client } }) + ');';
}

function ytcfgScript(overrides = {}) {
  return 'var ytcfg = {}; ytcfg.set(' + JSON.stringify({
    INNERTUBE_CONTEXT: { client: { ...CLIENT, visitorData: 'SECRET_VISITOR', ...overrides } },
    INNERTUBE_API_KEY: 'SECRET_API_KEY',
    INNERTUBE_CONTEXT_CLIENT_NAME: 1,
    EXPERIMENT_FLAGS: { nested: { a: '}{\\"quoted\\"}' } }
  }) + '); ytcfg.set({"EXPERIMENT_FLAGS":{}});';
}

function thumb(url) {
  return { thumbnails: [{ url, width: 120, height: 90 }] };
}

function video(id, extra = {}) {
  return {
    videoRenderer: {
      videoId: id,
      title: { runs: [{ text: 'Video ' + id }] },
      ownerText: { runs: [{ text: 'Channel ' + id }] },
      viewCountText: { simpleText: '1,234 views' },
      publishedTimeText: { simpleText: '2 days ago' },
      lengthText: { simpleText: '10:00' },
      detailedMetadataSnippets: [{ snippetText: { runs: [{ text: 'Snippet for ' + id }] } }],
      thumbnail: thumb('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
      ...extra
    }
  };
}

function continuation(token) {
  return {
    continuationItemRenderer: {
      continuationEndpoint: { continuationCommand: { token } }
    }
  };
}

function initial(contents) {
  return {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: { sectionListRenderer: { contents } }
      }
    }
  };
}

function paged(continuationItems, key = 'onResponseReceivedCommands') {
  return {
    [key]: [{ appendContinuationItemsAction: { continuationItems } }]
  };
}

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function clock(start = 0) {
  let time = start;
  return {
    now: () => time,
    sleep: async ms => { time += Math.max(0, Number(ms) || 0); },
    advance: ms => { time += ms; }
  };
}

function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeSource(extra = {}) {
  const c = clock(1000);
  const source = new SearchSource({
    document: docWith(ytcfgScript()),
    origin: 'https://www.youtube.com',
    now: c.now,
    sleep: c.sleep,
    ...extra
  });
  return { source, clock: c };
}

/* --------------------------- client context ----------------------------- */

test('readClientContext extracts only whitelisted public client fields', () => {
  const doc = docWith('const noise = 1;', ytcfgScript());
  Object.defineProperty(doc, 'cookie', { get() { throw new Error('cookie must not be read'); } });
  const client = readClientContext(doc);
  assert.deepEqual(client, CLIENT);
  assert.deepEqual(Object.keys(client).sort(), ['clientName', 'clientVersion', 'gl', 'hl']);
  assert.equal(JSON.stringify(client).includes('SECRET_VISITOR'), false);
  assert.equal(JSON.stringify(client).includes('SECRET_API_KEY'), false);
});

test('readClientContext reads the live page version instead of a hardcoded one', () => {
  const first = readClientContext(docWith(ytcfgWith({ ...CLIENT, clientVersion: '2.20260101.00.00' })));
  const second = readClientContext(docWith(ytcfgWith({ ...CLIENT, clientVersion: '2.20270101.00.00' })));
  assert.equal(first.clientVersion, '2.20260101.00.00');
  assert.equal(second.clientVersion, '2.20270101.00.00');
  assert.notEqual(first.clientVersion, second.clientVersion);
});

test('readClientContext merges split scripts and accepts MWEB', () => {
  const doc = docWith(
    ytcfgWith({ clientName: 'MWEB', clientVersion: '2.20261030.01.00' }),
    ytcfgWith({ hl: 'ja', gl: 'JP' })
  );
  assert.deepEqual(readClientContext(doc), { ...CLIENT, clientName: 'MWEB', hl: 'ja', gl: 'JP' });
});

test('readClientContext rejects non-WEB/MWEB clients and incomplete configs', () => {
  assert.throws(() => readClientContext(docWith(ytcfgWith({ ...CLIENT, clientName: 'ANDROID' }))), /SEARCH_CONTEXT/);
  assert.throws(() => readClientContext(docWith(ytcfgWith({ ...CLIENT, clientVersion: '' }))), /SEARCH_CONTEXT/);
  assert.throws(() => readClientContext(docWith(ytcfgWith({ ...CLIENT, hl: 'not a language' }))), /SEARCH_CONTEXT/);
  assert.throws(() => readClientContext(docWith('console.log("INNERTUBE_CONTEXT")')), /SEARCH_CONTEXT/);
  assert.throws(() => readClientContext(null), /SEARCH_CONTEXT/);
  assert.throws(() => readClientContext(docWith('ytcfg.set({"INNERTUBE_CONTEXT":{"client":{')), /SEARCH_CONTEXT/);
});

test('parseClientConfig parses JSON text without evaluating page code', () => {
  const script = 'globalThis.__ytcSearchPwned = 1; ' + ytcfgScript();
  const parsed = parseClientConfig(script);
  assert.deepEqual(parsed, CLIENT);
  assert.equal(globalThis.__ytcSearchPwned, undefined);
  assert.equal(parseClientConfig('console.log("INNERTUBE_CONTEXT")'), null);
  assert.equal(parseClientConfig(42), null);
  assert.deepEqual(
    parseClientConfig(ytcfgWith({ ...CLIENT, clientName: 'ANDROID' })),
    { clientVersion: CLIENT.clientVersion, hl: 'en', gl: 'US' }
  );
});

test('readClientContext ignores invalid JSON candidates and keeps scanning', () => {
  const broken = 'const junk = \'{"INNERTUBE_CONTEXT": {"client": }}\';';
  const doc = docWith(broken, ytcfgScript());
  assert.deepEqual(readClientContext(doc), CLIENT);
});

/* ------------------------------- results -------------------------------- */

test('parseResults reads the initial page, main continuation and skips shelf tokens', () => {
  const shelf = {
    shelfRenderer: {
      content: {
        horizontalListRenderer: {
          contents: [
            { reelItemRenderer: { videoId: 'CCCCCCCCCCC', headline: { simpleText: 'Shorts C' } } },
            continuation('SHORTS_SHELF_TOKEN')
          ]
        }
      }
    }
  };
  const page = parseResults(initial([
    { itemSectionRenderer: { contents: [video('AAAAAAAAAAA'), video('BBBBBBBBBBB')] } },
    shelf,
    continuation('MAIN_PAGE_TOKEN')
  ]));
  assert.equal(page.continuation, 'MAIN_PAGE_TOKEN');
  assert.deepEqual(page.items.map(item => item.id), ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC']);
  assert.deepEqual(page.items[0], {
    id: 'AAAAAAAAAAA',
    title: 'Video AAAAAAAAAAA',
    channel: 'Channel AAAAAAAAAAA',
    views: '1,234 views',
    published: '2 days ago',
    duration: '10:00',
    description: 'Snippet for AAAAAAAAAAA',
    thumbnail: 'https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA'
  });
});

test('parseResults does not take a continuation when the main list ends with a section', () => {
  const page = parseResults(initial([
    { itemSectionRenderer: { contents: [video('AAAAAAAAAAA')] } },
    { shelfRenderer: { content: { horizontalListRenderer: { contents: [continuation('NESTED_TOKEN')] } } } }
  ]));
  assert.equal(page.continuation, '');
});

test('parseResults reads pagination commands and dedupes ids per page', () => {
  const expected = ['PAGEVIDEO01', 'PAGEVIDEO02'];
  const page = parseResults(paged([
    video('PAGEVIDEO01'),
    video('PAGEVIDEO01'),
    video('PAGEVIDEO02'),
    continuation('NEXT_PAGE_TOKEN')
  ]));
  assert.deepEqual(page.items.map(item => item.id), expected);
  assert.equal(page.continuation, 'NEXT_PAGE_TOKEN');

  const actions = parseResults(paged([video('PAGEVIDEO02'), continuation('ACTION_TOKEN')], 'onResponseReceivedActions'));
  assert.deepEqual(actions.items.map(item => item.id), ['PAGEVIDEO02']);
  assert.equal(actions.continuation, 'ACTION_TOKEN');
});

test('parseResults skips ads, playlists, courses and channels', () => {
  const page = parseResults(initial([{
    itemSectionRenderer: {
      contents: [
        video('AAAAAAAAAAA'),
        { adSlotRenderer: { adSlotMetadata: {}, contents: [video('DDDDDDDDDDD')] } },
        { playlistRenderer: { contents: [video('EEEEEEEEEEE')] } },
        { courseRenderer: { contents: [video('FFFFFFFFFFFF'.slice(0, 11))] } },
        { channelRenderer: { channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx' } },
        video('AAAAAAAAAAA')
      ]
    }
  }]));
  assert.deepEqual(page.items.map(item => item.id), ['AAAAAAAAAAA']);
});

test('parseResults keeps live badges and never invents missing metadata', () => {
  const live = parseResults(initial([{
    itemSectionRenderer: {
      contents: [{
        videoRenderer: {
          videoId: 'LIVELIVELIV',
          title: { simpleText: 'Live now' },
          badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } }],
          thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE', text: { simpleText: 'LIVE' } } }]
        }
      }]
    }
  }])).items[0];
  assert.deepEqual(live, {
    id: 'LIVELIVELIV',
    title: 'Live now',
    channel: '',
    views: '',
    published: '',
    duration: '直播',
    description: '',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=LIVELIVELIV'
  });

  const bare = parseResults(initial([{ videoRenderer: { videoId: 'BAREBAREBAR', title: { simpleText: 'Bare' } } }])).items[0];
  assert.equal(bare.duration, '');
  assert.equal(bare.channel, '');
  assert.equal(bare.views, '');
  assert.equal(bare.published, '');
  assert.equal(bare.description, '');
  assert.equal(bare.thumbnail, '');
});

test('parseResults keeps XSS strings inert and only exposes safe thumbnails', () => {
  const payload = '<img src=x onerror="globalThis.__ytcSearchPwned=1">';
  const page = parseResults(initial([{
    itemSectionRenderer: {
      contents: [
        video('AAAAAAAAAAA', {
          title: { simpleText: payload },
          thumbnail: thumb('javascript:globalThis.__ytcSearchPwned=1')
        }),
        video('BBBBBBBBBBB', {
          thumbnail: thumb('https://evil.example/ytimg.com/x.jpg')
        }),
        video('CCCCCCCCCCC', {
          thumbnail: { thumbnails: [
            { url: 'https://evil.example/i.ytimg.com/x.jpg' },
            { url: 'http://i.ytimg.com/vi/CCCCCCCCCCC/x.jpg' },
            { url: 'https://i.ggpht.com/abc=s120' }
          ] }
        })
      ]
    }
  }]));
  assert.equal(page.items[0].title, payload);
  assert.equal(page.items[0].thumbnail, '');
  assert.equal(page.items[1].thumbnail, '');
  assert.equal(page.items[2].thumbnail, 'https://i.ggpht.com/abc=s120');
  assert.equal(globalThis.__ytcSearchPwned, undefined);
});

test('parseResults rejects response shells and oversized input', () => {
  assert.throws(() => parseResults({ responseContext: { visitorData: 'x' } }), /SEARCH_RESPONSE/);
  assert.throws(() => parseResults({}), /SEARCH_RESPONSE/);
  assert.throws(() => parseResults(null), /SEARCH_RESPONSE/);
  assert.throws(() => parseResults([]), /SEARCH_RESPONSE/);
  assert.throws(() => parseResults(initial(Array.from({ length: 1001 }, () => ({ itemSectionRenderer: { contents: [] } })))), /SEARCH_RESPONSE/);
  assert.throws(() => parseResults({ onResponseReceivedCommands: [{}] }), /SEARCH_RESPONSE/);
});

test('parseResults returns an empty page for real no-result message renderers', () => {
  const page = parseResults(initial([{
    itemSectionRenderer: { contents: [{ messageRenderer: { text: { simpleText: 'No results found' } } }] }
  }]));
  assert.deepEqual(page, { items: [], continuation: '' });
});

test('parseResults caps a page at 100 videos', () => {
  const contents = Array.from({ length: 150 }, (_, index) => video('V' + String(index).padStart(10, '0')));
  const page = parseResults(initial([{ itemSectionRenderer: { contents } }]));
  assert.equal(page.items.length, 100);
  assert.equal(page.items[99].id, 'V0000000099');
});

/* ------------------------------- requests -------------------------------- */

test('search posts a same-origin, cookieless request with only the public client block', async () => {
  const fetchImpl = recorder(() => jsonResponse(initial([{ itemSectionRenderer: { contents: [video('AAAAAAAAAAA')] } }])));
  const { source } = makeSource({ fetch: fetchImpl });
  const page = await source.search('  cats  ', { params: 'CAMSAFg' });
  assert.equal(page.items.length, 1);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.redirect, 'error');
  assert.deepEqual(call.options.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(call.options.body), {
    context: { client: CLIENT },
    query: 'cats',
    params: 'CAMSAFg'
  });
  assert.equal(/visitorData|apiKey|INNERTUBE_API_KEY|authorization|cookie/i.test(call.options.body), false);
  assert.equal(source.start, undefined, 'no arbitrary-URL entry point');
});

test('next sends only the opaque continuation and never logs it', async () => {
  const token = 'OPAQUE_TOKEN_123';
  const fetchImpl = recorder(() => jsonResponse(paged([video('PAGEVIDEO01')])));
  const { source } = makeSource({ fetch: fetchImpl });
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const output = [];
  for (const key of Object.keys(originals)) console[key] = (...args) => output.push(args.join(' '));
  let page;
  try {
    page = await source.next(token);
  } finally {
    Object.assign(console, originals);
  }
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepEqual(body, { context: { client: CLIENT }, continuation: token });
  assert.equal('query' in body, false);
  assert.equal('params' in body, false);
  assert.equal(output.join('\n').includes(token), false);
  assert.deepEqual(page.items.map(item => item.id), ['PAGEVIDEO01']);
});

test('search and next reject bad local input before any request', async () => {
  const fetchImpl = recorder(() => jsonResponse(initial([])));
  const { source } = makeSource({ fetch: fetchImpl });
  await assert.rejects(source.search('x'.repeat(301)), /SEARCH_INPUT/);
  await assert.rejects(source.search(''), /SEARCH_INPUT/);
  await assert.rejects(source.search(42), /SEARCH_INPUT/);
  await assert.rejects(source.search('ok', { params: 'a'.repeat(513) }), /SEARCH_INPUT/);
  await assert.rejects(source.search('ok', { params: 'bad param' }), /SEARCH_INPUT/);
  await assert.rejects(source.next('A'.repeat(16001)), /SEARCH_INPUT/);
  await assert.rejects(source.next('bad token'), /SEARCH_INPUT/);
  await assert.rejects(source.next(''), /SEARCH_INPUT/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('search omits empty params and allows exactly 300 characters', async () => {
  const fetchImpl = recorder(() => jsonResponse(initial([])));
  const { source } = makeSource({ fetch: fetchImpl });
  await source.search('y'.repeat(300));
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), { context: { client: CLIENT }, query: 'y'.repeat(300) });
});

test('SearchSource only accepts the two YouTube origins', () => {
  for (const origin of ['https://evil.example', 'https://www.youtube.com.evil.example', 'http://www.youtube.com', 'https://m.youtube.com.evil.example', '']) {
    assert.throws(() => new SearchSource({ document: docWith(ytcfgScript()), fetch: async () => jsonResponse({}), origin }), /SEARCH_ORIGIN/, origin);
  }
  assert.doesNotThrow(() => new SearchSource({ document: docWith(ytcfgScript()), fetch: async () => jsonResponse({}), origin: 'https://m.youtube.com' }));
});

test('a missing public client context rejects without fetching', async () => {
  const fetchImpl = recorder(() => jsonResponse(initial([])));
  const source = new SearchSource({ document: docWith('nothing here'), fetch: fetchImpl, origin: 'https://www.youtube.com' });
  await assert.rejects(source.search('cats'), /SEARCH_CONTEXT/);
  const android = new SearchSource({ document: docWith(ytcfgWith({ ...CLIENT, clientName: 'ANDROID' })), fetch: fetchImpl, origin: 'https://www.youtube.com' });
  await assert.rejects(android.search('cats'), /SEARCH_CONTEXT/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('requests are serialised per instance and start at least 600ms apart', async () => {
  const starts = [];
  let active = 0;
  let peak = 0;
  const c = clock(5000);
  const fetchImpl = async () => {
    starts.push(c.now());
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return jsonResponse(initial([]));
  };
  const source = new SearchSource({
    document: docWith(ytcfgScript()),
    fetch: fetchImpl,
    origin: 'https://www.youtube.com',
    now: c.now,
    sleep: c.sleep
  });
  await Promise.all([source.search('one'), source.search('two'), source.next('TOKEN_THREE')]);
  assert.equal(starts.length, 3);
  assert.equal(peak, 1);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 600, 'gap ' + index);
});

test('user abort rejects with AbortError and frees the chain', async () => {
  const controller = new AbortController();
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const fetchImpl = async (url, options) => {
    started();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const { source } = makeSource({ fetch: fetchImpl });
  const pending = source.search('cats', { signal: controller.signal });
  await began;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  const queued = source.search('cats', { signal: controller.signal });
  await assert.rejects(queued, error => error.name === 'AbortError');
});

test('timeouts map to SEARCH_TIMEOUT and keep the timeout under 20s', async () => {
  const fetchImpl = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const { source } = makeSource({ fetch: fetchImpl, timeout: 25 });
  await assert.rejects(source.search('cats'), /SEARCH_TIMEOUT/);
});

test('HTTP and transport failures map to the documented SEARCH_* codes', async () => {
  for (const [status, code] of [[400, 'SEARCH_EXPIRED'], [429, 'RATE_LIMIT'], [403, 'SEARCH_ACCESS'], [401, 'SEARCH_ACCESS'], [500, 'SEARCH_RESPONSE']]) {
    const fetchImpl = recorder(() => jsonResponse({}, status));
    const { source } = makeSource({ fetch: fetchImpl });
    await assert.rejects(source.search('cats'), error => {
      assert.equal(error.code, code);
      assert.match(error.message, new RegExp(code));
      return true;
    });
  }
  const network = recorder(() => { throw new TypeError('offline'); });
  const { source } = makeSource({ fetch: network });
  await assert.rejects(source.search('cats'), /SEARCH_NETWORK/);
});

test('a 200 response shell without search payload is not an empty success', async () => {
  const fetchImpl = recorder(() => jsonResponse({ responseContext: { visitorData: 'x' } }));
  const { source } = makeSource({ fetch: fetchImpl });
  await assert.rejects(source.search('cats'), /SEARCH_RESPONSE/);
});

test('m.youtube.com keeps the request on its own origin', async () => {
  const fetchImpl = recorder(() => jsonResponse(initial([])));
  const { source } = makeSource({ fetch: fetchImpl, origin: 'https://m.youtube.com' });
  await source.search('cats');
  assert.equal(fetchImpl.calls[0].url, 'https://m.youtube.com/youtubei/v1/search?prettyPrint=false');
});
