'use strict';
// Local-only live probe. Authentication comes from the process environment, never a source file.
const YTC = require('../extension/shared.js');
const { Router } = require('../extension/free-router.js');
const token = process.env.OPENROUTER_TEST_KEY;
if (!token || /^\{\{/.test(token)) { console.log(JSON.stringify({ error: 'NO_LOCAL_AUTH' })); process.exit(1); }
const batch = process.argv.includes('--batch');
const candidates = process.argv.slice(2).filter(arg => arg !== '--batch');
if (!candidates.length || candidates.some(id => id !== 'openrouter/free' && !id.endsWith(':free'))) {
  console.log(JSON.stringify({ error: 'FREE_MODELS_REQUIRED' })); process.exit(1);
}
const data = { local: {}, session: {} };
const area = name => ({
  get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[name][key]])),
  set: async values => Object.assign(data[name], values),
  remove: async key => { delete data[name][key]; }
});
const chrome = { storage: { local: area('local'), session: area('session') }, permissions: { contains: async () => true } };
const costs = [];
const replies = [];
const probeFetch = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (options.method === 'POST' && url.endsWith('/chat/completions')) {
    try {
      const body = await response.clone().json();
      if (typeof body?.usage?.cost === 'number') costs.push(body.usage.cost);
      if (typeof body?.choices?.[0]?.message?.content === 'string') replies.push({ model: body.model, finish_reason: body.choices[0].finish_reason, preview: body.choices[0].message.content.slice(0, 1800) });
    } catch {}
  }
  return response;
};
const router = new Router({ chrome, fetch: probeFetch });
function output(value) { console.log(JSON.stringify(value).replaceAll(token, '[redacted]')); }
(async () => {
  const models = await router.catalog();
  for (const model of candidates) {
    if (!models.some(entry => entry.id === model)) { output({ requested: model, error: 'NOT_VERIFIED_FREE' }); continue; }
    const config = YTC.aiConfig({ baseUrl: 'https://openrouter.ai/api/v1', model, apiKey: token, freeOnly: true });
    data.local = { settings: { ...YTC.DEFAULTS, provider: 'ai', freeMode: true }, aiConfig: config };
    const started = Date.now();
    costs.length = 0; replies.length = 0;
    try {
      const quota = await router.status(config);
      output({ stage: 'quota', used: quota.used, limit: quota.limit, remaining: quota.remaining });
      const samples = batch ? [
        { text: 'This slaps. He really cooked with this one.', context: { title: 'A musician performs an impressive guitar solo', parent: '' } },
        { text: 'Yeah, because rebooting it for the fifth time is totally going to fix it.', context: { title: 'App keeps crashing after the update', parent: 'Just reboot your phone again.' } },
        { text: "Bro really said 'trust me' and missed every shot 💀", context: { title: 'Funny basketball fails', parent: '' } },
        { text: "I'm not even mad, that's impressive.", context: { title: 'An amazingly elaborate prank', parent: '' } },
        { text: 'Same here, been dealing with it since the update.', context: { title: 'App bug discussion', parent: "The app crashes whenever I try to open a video." } },
        { text: 'この動画、何回見ても笑ってしまう', context: { title: 'Funny moments compilation', parent: '' } }
      ] : [{ text: 'This slaps. He really cooked with this one.', context: { title: 'A musician performs an impressive guitar solo', parent: '' } }];
      const results = await Promise.all(samples.map(sample => router.translate(sample.text, sample.context, config, true)));
      output({ requested: model, batch, ok: true, results: results.map((result, index) => ({ input: samples[index].text, model: result.model, text: result.text })), costs: costs.splice(0), seconds: Math.round((Date.now() - started) / 100) / 10 });
    } catch (error) {
      output({ requested: model, ok: false, error: Object.hasOwn(YTC.errors, error.message) ? error.message : 'INTERNAL', diagnostic: YTC.safeDiagnostic(error.diagnostic), costs: costs.splice(0), replies: replies.splice(0), seconds: Math.round((Date.now() - started) / 100) / 10 });
    }
  }
})().catch(error => { output({ error: Object.hasOwn(YTC.errors, error.message) ? error.message : 'TRANSPORT', diagnostic: YTC.safeDiagnostic(error.diagnostic) }); process.exitCode = 1; });
