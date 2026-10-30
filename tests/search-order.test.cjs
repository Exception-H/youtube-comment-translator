'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../extension/shared.js');
globalThis.YTC = shared;
const Bridge = require('../extension/search-bridge.js');

const QUERY = '电脑卡顿';
const SENDER = { url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(QUERY), tab: { id: 9 } };

function controller() {
  const store = { local: { settings: { dualSearch: true } }, session: {} };
  const area = name => ({
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, store[name][k]])),
    set: async o => Object.assign(store[name], o),
    remove: async k => { delete store[name][k]; }
  });
  const chrome = {
    storage: { local: area('local'), session: area('session') },
    permissions: { contains: async () => true },
    tabs: { create: async () => {} },
    runtime: { getURL: p => 'chrome-extension://test/' + p, openOptionsPage: async () => {} }
  };
  const client = { async translateQuery(text) { return { text: 'english ' + text, model: 'Index-Translate-35B-A3B' }; } };
  return new Bridge.Controller({ chrome, client, prepare: async () => {}, now: () => 1000 });
}

const start = (session, seq) => ({ type: 'SEARCH_START', session, seq });
const query = (session, seq) => ({ type: 'SEARCH_TRANSLATE', purpose: 'query', text: QUERY, query: QUERY, session, seq });

test('a stale sender URL still works because the query comes from the message', async () => {
  const c = controller();
  const stale = { url: 'https://www.youtube.com/', tab: { id: 11 } };
  const start = await c.handle({ type: 'SEARCH_START', session: 'spa', seq: 500, query: QUERY }, stale);
  assert.equal(start.ok, true);
  const result = await c.handle({ type: 'SEARCH_TRANSLATE', purpose: 'query', text: QUERY, query: QUERY, session: 'spa', seq: 500 }, stale);
  assert.equal(result.ok, true);
});

test('a non-YouTube sender is still rejected even with a query', async () => {
  const c = controller();
  await assert.rejects(
    c.handle({ type: 'SEARCH_START', session: 'x', seq: 1, query: QUERY }, { url: 'https://example.com/', tab: { id: 2 } }),
    /SEARCH_SESSION/
  );
});

test('a late START from an older view cannot overwrite the newer session', async () => {
  const c = controller();
  await c.handle(start('new', 200), SENDER);
  await assert.rejects(c.handle(start('old', 100), SENDER), /SEARCH_SESSION/);
  assert.equal(c.sessions.get(9).session, 'new');
  const ok = await c.handle(query('new', 200), SENDER);
  assert.equal(ok.ok, true);
});

test('a translation from an older view is rejected after a newer one starts', async () => {
  const c = controller();
  await c.handle(start('old', 100), SENDER);
  await c.handle(start('new', 200), SENDER);
  await assert.rejects(c.handle(query('old', 100), SENDER), /SEARCH_SESSION/);
  const ok = await c.handle(query('new', 200), SENDER);
  assert.equal(ok.ok, true);
});

test('messages without a sequence keep the legacy last-writer-wins behavior', async () => {
  const c = controller();
  await c.handle({ type: 'SEARCH_START', session: 'a' }, SENDER);
  await c.handle({ type: 'SEARCH_START', session: 'b' }, SENDER);
  assert.equal(c.sessions.get(9).session, 'b');
  const ok = await c.handle({ type: 'SEARCH_TRANSLATE', purpose: 'query', text: QUERY, query: QUERY, session: 'b' }, SENDER);
  assert.equal(ok.ok, true);
});
