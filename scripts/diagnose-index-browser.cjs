'use strict';
globalThis.YTC = require('../extension/shared.js');
const { buildPrompt } = require('../extension/indextranslate.js');
const body = JSON.stringify({ model: 'Index-Translate-35B-A3B', messages: [{ role: 'user', content: buildPrompt('This slaps. He really cooked with this one.', { title: 'A musician performs an impressive guitar solo', parent: '' }) }], temperature: 0, max_tokens: 512, stream: false, chat_template_kwargs: { enable_thinking: false } });
const cases = [
  ['plain', {}],
  ['extension-origin', { Origin: 'chrome-extension://eehacjkfnlglocpoiohjljjbeejefaci' }],
  ['headless-agent', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.0.0 Safari/537.36' }]
];
(async () => {
  for (const [name, headers] of cases) {
    try {
      const response = await fetch('https://index-translate.bilibili.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25000) });
      const data = await response.json().catch(() => null);
      console.log(JSON.stringify({ name, status: response.status, contentType: response.headers.get('content-type'), text: data?.choices?.[0]?.message?.content || '' }));
    } catch (error) { console.log(JSON.stringify({ name, error: error.name })); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
})();
