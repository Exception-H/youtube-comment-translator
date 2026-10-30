'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const YTC = require('../extension/shared.js');

function reply(content, extra = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content, ...extra }
    }]
  };
}
function clean(content, original) {
  return YTC.cleanSingleOutput(reply(content), original).text;
}
function codeOf(fn) {
  try { fn(); } catch (error) { return error.message; }
  return null;
}

test('strips a complete leading think or analysis block only', () => {
  assert.equal(clean('<think>先看语气，再翻译</think>\n{"translation":"太带劲了"}'), '太带劲了');
  assert.equal(clean('<analysis>检查上下文</analysis>\n{"text":"这段真不错"}'), '这段真不错');
  assert.equal(clean('<THINK>upper case</THINK>译文'), '译文');
  assert.equal(clean('<think>a</think><think>b</think>译文'), '译文');
  assert.equal(clean('先说一句<think>这里不是开头</think>译文'), '先说一句<think>这里不是开头</think>译文');
});

test('empty think blocks are dropped and empty output falls back to RESPONSE', () => {
  assert.equal(clean('<think></think> 你好'), '你好');
  assert.equal(clean('<think>   </think>\n你好'), '你好');
  assert.equal(codeOf(() => clean('<think>   </think>')), 'RESPONSE');
  assert.equal(codeOf(() => clean('<think></think>')), 'RESPONSE');
});

test('an unclosed leading reasoning block is OUTPUT_FORMAT, never passed through', () => {
  for (const content of ['<think>没有闭合 你好', '<analysis>只写了一半', '<think>reasoning</analysis>译文']) {
    const error = codeOf(() => clean(content));
    assert.equal(error, 'OUTPUT_FORMAT', content);
  }
});

test('unwraps a fence around the whole output but leaves other code untouched', () => {
  assert.equal(clean('```json\n{"translation":"你好"}\n```'), '你好');
  assert.equal(clean('```text\n你好\n```'), '你好');
  assert.equal(clean('```markdown\n**你好**\n```'), '**你好**');
  assert.equal(clean('```\n你好\n```'), '你好');
  assert.equal(clean('```txt\n你好\n```'), '你好');
  assert.equal(clean('<think>草稿</think>\n```json\n{"translation":"好"}\n```'), '好');
  const javascript = '```javascript\nconst answer = 42;\n```';
  assert.equal(clean(javascript), javascript);
  const unclosed = '```text\n你好';
  assert.equal(clean(unclosed), unclosed);
  const midText = '先运行 `npm test`\n```bash\nnode --test\n```';
  assert.equal(clean(midText), midText);
});

test('extracts one translation field from a JSON object output', () => {
  assert.equal(clean('{"translation":"你好"}'), '你好');
  assert.equal(clean('{"text":"你好"}'), '你好');
  assert.equal(clean('{"translatedText":"你好"}'), '你好');
  assert.equal(clean('{"translation":"你好","source":"en"}'), '你好');
  assert.equal(clean('{"translation":" 你好 "}'), '你好');
  assert.equal(clean('{"translation":"你好","count":1,"ok":true,"note":null}'), '你好');
});

test('rejects arrays, ambiguous objects and nested arbitrary structures', () => {
  for (const content of [
    '["你好"]',
    '{"translations":[{"id":"a","text":"你好"}]}',
    '{"translation":"a","text":"b"}',
    '{"translation":123}',
    '{"translation":""}',
    '{"translation":null}',
    '{"translation":"你好","extra":{"a":1}}',
    '{"foo":"bar"}'
  ]) assert.equal(clean(content), content, content);
});

test('restores a JSON string literal and one leading label', () => {
  assert.equal(clean('"你好"'), '你好');
  assert.equal(clean('"他说：\\"走吧\\""'), '他说："走吧"');
  assert.equal(clean('译文：你好'), '你好');
  assert.equal(clean('翻译: 你好'), '你好');
  assert.equal(clean('Translation: Hello world'), 'Hello world');
  assert.equal(clean('{"translation":"译文：你好"}'), '你好');
  assert.equal(clean('"译文：你好"'), '你好');
  assert.equal(clean('译文：'), '译文：');
  assert.equal(clean('翻译：这句话的翻译：这里'), '这句话的翻译：这里');
});

test('does not delete real sentences, trailing notes or trailing explanations', () => {
  for (const content of [
    '这句话的翻译：见下文。',
    '你好（注：这是意译）',
    '他笑着说：Translation: 只是玩笑',
    '先运行 npm test，再提交代码。',
    'Use `console.log("hi")` to debug.',
    'const label = "译文：";'
  ]) assert.equal(clean(content), content, content);
});

test('HTML and script text stay inert strings', () => {
  assert.equal(clean('<think>包装</think><b>你好</b> & "x"'), '<b>你好</b> & "x"');
  assert.equal(clean('```text\n<script>alert(1)</script>\n```'), '<script>alert(1)</script>');
  assert.equal(clean('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('a long echoed English sentence is OUTPUT_UNTRANSLATED', () => {
  const source = 'This video is absolutely fantastic and I loved every minute of it';
  assert.equal(codeOf(() => clean(source, source)), 'OUTPUT_UNTRANSLATED');
  assert.equal(codeOf(() => clean('  ' + source + '\n', source)), 'OUTPUT_UNTRANSLATED');
  assert.equal(codeOf(() => clean('{"translation":"' + source + '"}', source)), 'OUTPUT_UNTRANSLATED');
  assert.equal(clean('这个视频真是太棒了，每一分钟我都喜欢。', source), '这个视频真是太棒了，每一分钟我都喜欢。');
});

test('short names, short phrases and URLs are allowed to stay identical', () => {
  for (const source of ['PewDiePie', 'Great video', 'lol same', 'MrBeast', 'ありがとう', 'すごい', 'https://example.com/watch?v=abc']) {
    assert.equal(clean(source, source), source, source);
  }
});

test('echoed Japanese and Korean sentences are rejected', () => {
  for (const source of ['この動画は本当に素晴らしいですね', '이 영상은 정말 멋집니다']) {
    assert.equal(codeOf(() => clean(source, source)), 'OUTPUT_UNTRANSLATED', source);
  }
});

test('reasoning_content never enters the cleaned text', () => {
  const data = reply('你好', { reasoning_content: '<think>内部推理不应展示</think>' });
  assert.equal(YTC.cleanSingleOutput(data).text, '你好');
  const hiddenOnly = reply('', { reasoning_content: '<think>只有推理</think>' });
  assert.equal(codeOf(() => YTC.cleanSingleOutput(hiddenOnly)), 'RESPONSE');
  assert.equal(YTC.cleanSingleOutput(reply([{ type: 'text', text: '数组译文' }], { reasoning_content: 'x' })).text, '数组译文');
  assert.equal(codeOf(() => YTC.cleanSingleOutput(reply('没翻完', { reasoning_content: '' }))), null);
  const truncated = reply('没翻完');
  truncated.choices[0].finish_reason = 'length';
  assert.equal(codeOf(() => YTC.cleanSingleOutput(truncated)), 'RESPONSE');
});

test('cleaning that empties the output reuses the original RESPONSE error', () => {
  for (const content of ['<think>只有分析</think>', '```json\n```', '```text\n\n```', '```\n```']) {
    assert.equal(codeOf(() => clean(content)), 'RESPONSE', content);
  }
});

test('a source that is itself a think or analysis sample is preserved', () => {
  const source = '<think>example</think>';
  assert.equal(clean('<think>example</think> 这是示例', source), '<think>example</think> 这是示例');
  assert.equal(codeOf(() => clean('<think>example', '<think>example')), null);
  assert.equal(clean('<analysis>草稿</analysis>', '<analysis>草稿</analysis>'), '<analysis>草稿</analysis>');
});

test('user JSON or quoted code in the source is not swallowed', () => {
  assert.equal(clean('{"text":"hello"}', '{"text":"hello"}'), '{"text":"hello"}');
  assert.equal(clean('"hello"', '"hello"'), '"hello"');
  assert.equal(clean('{"translation":"你好"}', '{"translation":"你好"}'), '{"translation":"你好"}');
});

test('new error codes are fixed Chinese messages with no raw output', () => {
  for (const code of ['OUTPUT_FORMAT', 'OUTPUT_UNTRANSLATED', 'OUTPUT_TIMEOUT']) {
    assert.ok(Object.hasOwn(YTC.errors, code), code);
    assert.match(YTC.errors[code], /[\u4e00-\u9fff]/);
    assert.equal(YTC.errors[code].includes('```'), false);
  }
  assert.deepEqual(YTC.cleanSingleOutput(reply('<think>x</think>你好')), { text: '你好', source: 'auto' });
});

test('existing parseAI contract is unchanged', () => {
  assert.equal(YTC.parseAI(reply('原文')).text, '原文');
  assert.equal(codeOf(() => YTC.parseAI(reply(''))), 'RESPONSE');
  const truncated = reply('没翻完');
  truncated.choices[0].finish_reason = 'length';
  assert.equal(codeOf(() => YTC.parseAI(truncated)), 'RESPONSE');
  assert.equal(codeOf(() => YTC.cleanSingleOutput(null)), 'RESPONSE');
});
