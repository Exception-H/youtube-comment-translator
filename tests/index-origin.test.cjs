'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./worker-harness.cjs');

test('Index compatibility rule removes only Origin from this extension official POST endpoint', async t => {
  const h = harness(async () => { throw new Error('No network expected'); });
  t.after(h.dispose);
  await Promise.all([h.context.prepareIndexHeaders(), h.context.prepareIndexHeaders()]);
  const updates = JSON.parse(JSON.stringify(h.context.chrome.declarativeNetRequest.updates));
  assert.equal(updates.length, 1);
  const rule = updates[0].addRules[0];
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'origin', operation: 'remove' }]);
  assert.deepEqual(rule.condition.initiatorDomains, ['test']);
  assert.deepEqual(rule.condition.requestMethods, ['post']);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  const pattern = new RegExp(rule.condition.regexFilter);
  assert.equal(pattern.test('https://index-translate.bilibili.com/v1/chat/completions'), true);
  for (const url of ['https://index-translateXbilibiliXcom/v1/chat/completions', 'https://evil.example/v1/chat/completions', 'https://index-translate.bilibili.com/v1/models', 'https://index-translate.bilibili.com/site/translate.html', 'https://index-translate.bilibili.com/v1/chat/completions?url=evil']) assert.equal(pattern.test(url), false, url);
});

test('failed compatibility rule setup can be retried and returns no raw error', async t => {
  const h = harness(async () => { throw new Error('No network expected'); });
  t.after(h.dispose);
  let attempts = 0;
  h.context.chrome.declarativeNetRequest.updateDynamicRules = async () => { if (++attempts === 1) throw new Error('private browser failure'); };
  await assert.rejects(h.context.prepareIndexHeaders(), /^Error: INDEX_CONFIG$/);
  await h.context.prepareIndexHeaders();
  assert.equal(attempts, 2);
});
