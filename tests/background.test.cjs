'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shared = require('../extension/shared.js');
const harness = require('./worker-harness.cjs');
const success = text => ({ ok: true, status: 200, json: async () => [[text, 'en']] });

test('background deduplicates requests, caches responses and omits credentials', async t => {
  let calls = 0;
  const h = harness(async (url, options) => {
    calls++;
    assert.equal(new URL(url).origin, 'https://clients5.google.com');
    assert.equal(new URL(url).searchParams.get('tl'), 'zh-CN');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    await new Promise(resolve => setTimeout(resolve, 20));
    return success('你好');
  });
  t.after(h.dispose);
  const results = await Promise.all([h.send({ type: 'TRANSLATE', text: 'hello' }), h.send({ type: 'TRANSLATE', text: 'hello' })]);
  assert.equal(results[0].text, '你好');
  assert.equal(calls, 1);
  assert.equal((await h.send({ type: 'TRANSLATE', text: 'hello' })).cached, true);
  await h.send({ type: 'CLEAR_CACHE' }, { url: 'chrome-extension://test/popup.html' });
  assert.equal((await h.send({ type: 'TRANSLATE', text: 'hello' })).cached, false);
  assert.equal(calls, 2);
});

test('disabled setting and oversized comments do not send text', async t => {
  let calls = 0;
  const h = harness(async () => { calls++; return success('结果'); });
  t.after(h.dispose);
  h.data.local.settings = { enabled: false };
  assert.equal((await h.send({ type: 'TRANSLATE', text: 'hello' })).error, 'DISABLED');
  h.data.local.settings = { enabled: true };
  assert.equal((await h.send({ type: 'TRANSLATE', text: 'a'.repeat(12001) })).error, 'TOO_LONG');
  assert.equal(calls, 0);
});

test('only the popup can clear cache and only YouTube content can translate', async t => {
  const h = harness(async () => success('结果'));
  t.after(h.dispose);
  await assert.rejects(h.send({ type: 'CLEAR_CACHE' }), /UNAUTHORIZED/);
  for (const url of ['https://www.youtube.com.evil.test/', 'http://www.youtube.com/', 'https://example.com/']) {
    await assert.rejects(h.send({ type: 'TRANSLATE', text: 'hello' }, { url, tab: { id: 1 } }), /UNAUTHORIZED/);
  }
});

test('429 response starts cooldown without hammering the translation service', async t => {
  let calls = 0;
  const h = harness(async () => { calls++; return { ok: false, status: 429 }; });
  t.after(h.dispose);
  assert.equal((await h.send({ type: 'TRANSLATE', text: 'one' })).error, 'RATE_LIMIT');
  assert.equal((await h.send({ type: 'TRANSLATE', text: 'two' })).error, 'RATE_LIMIT');
  assert.equal(calls, 1);
});

test('network and malformed response failures become actionable errors', async t => {
  const network = harness(async () => { throw new TypeError('Failed to fetch'); });
  const malformed = harness(async () => ({ ok: true, json: async () => ({ error: true }) }));
  t.after(network.dispose); t.after(malformed.dispose);
  assert.equal((await network.send({ type: 'TRANSLATE', text: 'one' })).error, 'NETWORK');
  assert.equal((await malformed.send({ type: 'TRANSLATE', text: 'one' })).error, 'RESPONSE');
});

test('clearing cache while a translation is running prevents it from being stored', async t => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = () => resolve(success('完成')); }));
  t.after(h.dispose);
  const request = h.send({ type: 'TRANSLATE', text: 'running' });
  for (let attempt = 0; !finish && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof finish, 'function');
  await h.send({ type: 'CLEAR_CACHE' }, { url: 'chrome-extension://test/popup.html' });
  finish();
  assert.equal((await request).ok, true);
  assert.equal(vm.runInContext('cache.size', h.context), 0);
  assert.equal(h.data.session.translations, undefined);
});
