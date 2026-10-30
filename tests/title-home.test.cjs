'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../extension/shared.js');
const home = require('../extension/home-titles.js');

globalThis.YTC = shared;
const Bridge = require('../extension/search-bridge.js');

function controller({ dualSearch = true, permitted = true } = {}) {
  const calls = [];
  const store = { local: { settings: { dualSearch } }, session: {} };
  const area = name => ({
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, store[name][k]])),
    set: async o => Object.assign(store[name], o),
    remove: async k => { delete store[name][k]; }
  });
  const chrome = {
    storage: { local: area('local'), session: area('session') },
    permissions: { contains: async () => permitted },
    tabs: { create: async () => {} },
    runtime: { getURL: p => 'chrome-extension://test/' + p, openOptionsPage: async () => {} }
  };
  const client = {
    async translateTitle(text) { calls.push(text); return { text: '译名：' + text, model: 'Index-Translate-35B-A3B' }; }
  };
  const c = new Bridge.Controller({ chrome, client, prepare: async () => {}, now: () => 1000 });
  return { c, calls, store };
}
const HOME = { url: 'https://www.youtube.com/', tab: { id: 7 } };

test('homepage title helpers translate English and skip Chinese', () => {
  assert.equal(home.shouldTranslateTitle('How to fix Windows 11 lag'), true);
  assert.equal(home.shouldTranslateTitle('如何修复 Windows 11 卡顿'), false);
  assert.equal(home.shouldTranslateTitle('   '), false);
  assert.equal(home.pickTitleText('  A   B  '), 'A B');
  assert.ok(home.pickTitleText('x'.repeat(900)).length <= 500);
  assert.equal(home.isHomePath('/'), true);
  assert.equal(home.isHomePath('/feed/subscriptions'), true);
  assert.equal(home.isHomePath('/results'), false);
});

test('homepage title translation needs no search session and caches by text', async () => {
  const { c, calls } = controller();
  const first = await c.handle({ type: 'TITLE_TRANSLATE', text: 'Great guitar solo' }, HOME);
  assert.equal(first.ok, true);
  assert.equal(first.text, '译名：Great guitar solo');
  assert.equal(first.cached, false);
  const second = await c.handle({ type: 'TITLE_TRANSLATE', text: 'Great guitar solo' }, HOME);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
});

test('homepage title translation is gated by dual search and permission', async () => {
  const off = controller({ dualSearch: false });
  await assert.rejects(off.c.handle({ type: 'TITLE_TRANSLATE', text: 'Hello world' }, HOME), /DISABLED/);
  assert.equal(off.calls.length, 0);
  const denied = controller({ permitted: false });
  await assert.rejects(denied.c.handle({ type: 'TITLE_TRANSLATE', text: 'Hello world' }, HOME), /AI_PERMISSION/);
  assert.equal(denied.calls.length, 0);
});

test('homepage title translation rejects non-YouTube senders and empty text', async () => {
  const { c } = controller();
  await assert.rejects(c.handle({ type: 'TITLE_TRANSLATE', text: 'Hello' }, { url: 'https://example.com/', tab: { id: 1 } }), /SEARCH_SESSION/);
  await assert.rejects(c.handle({ type: 'TITLE_TRANSLATE', text: '   ' }, HOME), /TOO_LONG/);
});
