'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const YTC = require('../extension/shared.js');

test('settings sanitize invalid storage and preserve explicit preferences', () => {
  assert.deepEqual(YTC.settings(null), YTC.DEFAULTS);
  assert.deepEqual(YTC.settings({ enabled: 'false', display: 'bad' }), YTC.DEFAULTS);
  assert.deepEqual(YTC.settings({ enabled: false, display: 'translation', skipChinese: false }), { ...YTC.DEFAULTS, enabled: false, display: 'translation', skipChinese: false });
});
test('skip Chinese and symbol-only comments, keep other languages', () => {
  for (const text of ['谢谢分享！', '这段视频真的是太好看了 great', '🎉🔥 123', 'https://example.com @user']) assert.equal(YTC.shouldTranslate(text), false, text);
  for (const text of ['Thank you!', '素晴らしい作品ですね', '한국어 댓글입니다', 'Спасибо', 'This is great 你好']) assert.equal(YTC.shouldTranslate(text), true, text);
  assert.equal(YTC.shouldTranslate('中文', false), true);
});
test('splitting preserves paragraphs and Unicode without surrogate damage', () => {
  const input = ('Hello world! 😀 一段话。\n'.repeat(300)).trim();
  const parts = YTC.splitText(input);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), input);
  for (const part of parts) {
    assert.ok(Array.from(part).length <= 1400);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part));
  }
});
test('Google response parser handles multi-segment text and rejects invalid payloads', () => {
  assert.deepEqual(YTC.parseTranslation([[['你好', 'hello'], ['世界', 'world']], null, 'en']), { text: '你好世界', source: 'en' });
  for (const value of [null, {}, [], [[]], [[null]], [['invalid']]]) assert.throws(() => YTC.parseTranslation(value), /RESPONSE/);
});
