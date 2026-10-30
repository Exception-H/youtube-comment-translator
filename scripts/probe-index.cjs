'use strict';
// Anonymous production-client probe. No environment secrets or browser profile are used.
const YTC = require('../extension/shared.js');
const { Client } = require('../extension/indextranslate.js');
const config = YTC.aiConfig({ service: 'indextranslate', baseUrl: 'https://index-translate.bilibili.com/v1', model: 'Index-Translate-35B-A3B', apiKey: '', freeOnly: true });
const local = { settings: { ...YTC.DEFAULTS, provider: 'ai', aiService: 'indextranslate', freeMode: false }, aiConfig: config };
const chrome = { storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, local[key]])) } }, permissions: { contains: async () => true } };
let posts = 0;
const checkedFetch = async (url, options = {}) => {
  if (new URL(url).origin !== 'https://index-translate.bilibili.com') throw new Error('UNEXPECTED_ORIGIN');
  if (Object.keys(options.headers || {}).some(name => /^(authorization|cookie)$/i.test(name))) throw new Error('AUTH_MUST_BE_ABSENT');
  if (options.method === 'POST') posts++;
  return fetch(url, options);
};
const samples = [
  { text: "Bro really said 'trust me' and missed every shot 💀", context: { title: 'Funny basketball fails', parent: '' } },
  { text: 'Same here, been dealing with it since the update.', context: { title: 'App bug discussion', parent: 'The app crashes whenever I try to open a video.' } },
  { text: 'この動画、何回見ても笑ってしまう', context: { title: 'Funny moments compilation', parent: '' } }
];
const client = new Client({ chrome, fetch: checkedFetch });
(async () => {
  for (const sample of samples) {
    const start = Date.now();
    try {
      const result = await client.translate(sample.text, sample.context, config, true);
      console.log(JSON.stringify({ ok: true, source: sample.text, model: result.model, translation: result.text, seconds: Math.round((Date.now() - start) / 10) / 100 }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: Object.hasOwn(YTC.errors, error.message) ? error.message : 'PROBE_FAILURE', diagnostic: YTC.safeDiagnostic(error.diagnostic) }));
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({ anonymous: true, posts }));
})().catch(() => { console.log(JSON.stringify({ error: 'PROBE_FAILURE' })); process.exitCode = 1; });
