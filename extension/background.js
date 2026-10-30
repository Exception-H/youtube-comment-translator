'use strict';
importScripts('shared.js', 'free-router.js', 'siliconflow.js', 'indextranslate.js', 'search-bridge.js');
const freeRouter = new YTCFree.Router({ chrome, fetch: (...args) => fetch(...args) });
const siliconClient = new YTCSilicon.Client({ chrome, fetch: (...args) => fetch(...args) });
const indexClient = new YTCIndex.Client({ chrome, fetch: (...args) => fetch(...args) });
let indexHeadersReady;
function prepareIndexHeaders() {
  if (indexHeadersReady) return indexHeadersReady;
  if (!chrome.declarativeNetRequest?.updateDynamicRules || !chrome.runtime.id) return Promise.reject(new Error('INDEX_CONFIG'));
  // The official anonymous client omits Origin. Chrome adds its extension origin,
  // which the public endpoint rejects with HTTP 412. Scope this compatibility rule
  // to this extension's own POSTs to the one official endpoint; never alter UA/auth.
  const rule = {
    id: 14001, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      initiatorDomains: [chrome.runtime.id],
      regexFilter: '^https://index-translate\\.bilibili\\.com/v1/chat/completions$',
      requestMethods: ['post'], resourceTypes: ['xmlhttprequest']
    }
  };
  indexHeadersReady = Promise.resolve().then(() => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [14001], addRules: [rule] }))
    .catch(() => { indexHeadersReady = null; throw new Error('INDEX_CONFIG'); });
  return indexHeadersReady;
}

const searchBridge = new YTCSearchBridge.Controller({ chrome, client: indexClient, prepare: prepareIndexHeaders });

const MAX_CACHE = 600;
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map();
const inflight = new Map();
const queue = [];
const cooldowns = new Map();
let active = 0;
let nextRequestAt = 0;
let cacheEpoch = 0;
let saveTimer;
let saveChain = Promise.resolve();
const ready = chrome.storage.session.get('translations').then(({ translations }) => {
  const now = Date.now();
  if (Array.isArray(translations)) {
    for (const entry of translations.slice(-MAX_CACHE)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1]?.text === 'string' && now - entry[1].time < TTL) cache.set(entry[0], entry[1]);
    }
  }
  trimCache();
}).catch(() => {});

function trimCache() {
  let units = 0;
  for (const [key, value] of cache) units += key.length + value.text.length;
  while (cache.size > MAX_CACHE || units > 250000) {
    const [key, value] = cache.entries().next().value;
    units -= key.length + value.text.length;
    cache.delete(key);
  }
}
function persistCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot = Array.from(cache);
    saveChain = saveChain.catch(() => {}).then(() => chrome.storage.session.set({ translations: snapshot })).catch(() => {});
  }, 500);
}
function schedule(task) {
  if (queue.length >= 80) return Promise.reject(new Error('BUSY'));
  return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
}
function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    job.task().then(job.resolve, job.reject).finally(() => { active--; pump(); });
  }
}
async function request(url, options, service, ai = false) {
  if (Date.now() < (cooldowns.get(service) || 0)) throw new Error('RATE_LIMIT');
  const slot = Math.max(Date.now(), nextRequestAt);
  nextRequestAt = slot + 450;
  const wait = slot - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  if (Date.now() < (cooldowns.get(service) || 0)) throw new Error('RATE_LIMIT');
  let response;
  try {
    response = await fetch(url, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(ai ? 25000 : 12000) });
  } catch { throw new Error('NETWORK'); }
  if (response.status === 429) {
    cooldowns.set(service, Date.now() + 60000);
    throw new Error('RATE_LIMIT');
  }
  if (ai && [401, 403].includes(response.status)) throw new Error('AI_AUTH');
  if (ai && response.status === 402) throw new Error('AI_QUOTA');
  if (ai && response.status === 404) throw new Error('AI_MODEL');
  if (ai && response.status === 400) throw new Error('AI_CONFIG');
  if (!response.ok) throw new Error('SERVICE');
  try { return await response.json(); } catch { throw new Error('RESPONSE'); }
}
async function fetchGoogle(text) {
  const url = new URL('https://clients5.google.com/translate_a/t');
  for (const [key, value] of Object.entries({ client: 'dict-chrome-ex', sl: 'auto', tl: 'zh-CN', q: text })) url.searchParams.set(key, value);
  return YTC.parseTranslation(await request(url.href, {}, 'google'));
}
async function fetchAI(text, context, config, test = false) {
  if (YTC.isIndexConfig(config)) { await prepareIndexHeaders(); return indexClient.translate(text, context, config, test); }
  if (YTC.isSiliconConfig(config)) return siliconClient.translate(text, context, config, test);
  if (YTC.isFreeConfig(config)) return freeRouter.translate(text, context, config, test);
  const url = YTC.aiEndpoint(config.baseUrl);
  if (!config.model || !config.apiKey) throw new Error('AI_CONFIG');
  const allowed = await chrome.permissions.contains({ origins: [YTC.endpointOrigin(config.baseUrl)] });
  if (!allowed) throw new Error('AI_PERMISSION');
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: YTC.AI_PROMPT },
      { role: 'user', content: JSON.stringify({ video_title: context.title, parent_comment: context.parent, comment: text }) }
    ],
    stream: false
  };
  return YTC.cleanSingleOutput(await request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify(payload)
  }, 'ai:' + new URL(url).origin, true), text);
}
async function cacheKey(text, prefs, context, config) {
  // Hash the identity, including account/config/prompt version; never persist the API key or raw context in cache keys.
  const identity = JSON.stringify(['v1.4-index-translate-canonical', prefs.provider, text, context, config]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function translate(text, rawContext = {}, { force = false, test = false } = {}) {
  await ready;
  const value = YTC.normalize(text);
  if (!value || value.length > 12000) throw new Error('TOO_LONG');
  const stored = await chrome.storage.local.get(['settings', 'aiConfig']);
  const prefs = YTC.settings(stored.settings);
  if (!prefs.enabled && !test) throw new Error('DISABLED');
  if (test && prefs.provider !== 'ai') throw new Error('AI_CONFIG');
  const config = prefs.provider === 'ai' ? YTC.aiConfig(stored.aiConfig) : null;
  const context = prefs.provider === 'ai' && prefs.useContext ? YTC.context(rawContext) : { title: '', parent: '' };
  if (config) {
    YTC.aiEndpoint(config.baseUrl);
    if (!config.model || (!YTC.isIndexConfig(config) && !config.apiKey)) throw new Error('AI_CONFIG');
    if (YTC.isIndexConfig(config)) YTC.validateIndexConfig(config);
    else if (YTC.isSiliconConfig(config)) YTC.validateSiliconConfig(config);
    else if (YTC.isFreeConfig(config)) YTC.validateFreeConfig(config);
  }
  const key = await cacheKey(value, prefs, context, config);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.time < TTL) {
    cache.delete(key); cache.set(key, cached);
    return { text: cached.text, source: cached.source, model: cached.model || '', engine: prefs.provider, cached: true };
  }
  cache.delete(key);
  if (inflight.has(key)) return inflight.get(key);
  const epoch = cacheEpoch;
  const task = async () => {
    const current = YTC.settings((await chrome.storage.local.get('settings')).settings);
    if (!current.enabled && !test) throw new Error('DISABLED');
    // Do not send queued text using an obsolete provider/account after a configuration change.
    const latest = await chrome.storage.local.get(['settings', 'aiConfig']);
    const latestPrefs = YTC.settings(latest.settings);
    const latestConfig = latestPrefs.provider === 'ai' ? YTC.aiConfig(latest.aiConfig) : null;
    if (latestPrefs.provider !== prefs.provider || latestPrefs.useContext !== prefs.useContext || JSON.stringify(latestConfig) !== JSON.stringify(config)) throw new Error('DISABLED');
    let result = '';
    let source = 'auto';
    let model = config?.model || '';
    if (config) {
      const translated = await fetchAI(value, context, config, test);
      result = translated.text; source = translated.source; model = translated.model || config.model;
    } else {
      for (const part of YTC.splitText(value)) {
        const fresh = YTC.settings((await chrome.storage.local.get('settings')).settings);
        if (!fresh.enabled || fresh.provider !== 'google') throw new Error('DISABLED');
        const translated = await fetchGoogle(part);
        result += translated.text; source = translated.source;
      }
    }
    if (epoch === cacheEpoch) {
      cache.set(key, { text: result, source, model, time: Date.now() });
      trimCache(); persistCache();
    }
    return { text: result, source, model, engine: prefs.provider, cached: false };
  };
  const promise = YTC.isFreeConfig(config) ? task() : schedule(task);
  inflight.set(key, promise);
  try { return await promise; }
  finally { if (inflight.get(key) === promise) inflight.delete(key); }
}
function youtubeSender(sender) {
  try {
    const url = new URL(sender.url || '');
    return url.protocol === 'https:' && ['www.youtube.com', 'm.youtube.com'].includes(url.hostname) && Boolean(sender.tab);
  } catch { return false; }
}
function pageSender(sender, page) { return sender.url === chrome.runtime.getURL(page + '.html'); }
function failure(error) {
  const result = { ok: false, error: Object.hasOwn(YTC.errors, error.message) ? error.message : 'SERVICE' };
  const diagnostic = YTC.safeDiagnostic(error?.diagnostic);
  if (diagnostic) result.diagnostic = diagnostic;
  return result;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (searchBridge.accepts(message?.type)) {
    if (!youtubeSender(sender)) return false;
    searchBridge.handle(message, sender).then(respond, error => respond(failure(error)));
    return true;
  }
  if (pageSender(sender, 'options') && message?.type === 'LIST_SILICON_MODELS') {
    (async () => {
      const saved = await chrome.storage.local.get(['settings', 'aiConfig']);
      const config = YTC.aiConfig(saved.aiConfig);
      if (YTC.settings(saved.settings).provider !== 'ai') throw new Error('AI_CONFIG');
      YTC.validateSiliconConfig(config);
      const models = await siliconClient.available(config);
      respond({ ok: true, models });
    })().catch(error => respond(failure(error)));
    return true;
  }
  if (pageSender(sender, 'options') && message?.type === 'LIST_FREE_MODELS') {
    freeRouter.catalog(true).then(models => respond({ ok: true, models }), error => respond(failure(error)));
    return true;
  }
  if (pageSender(sender, 'options') && message?.type === 'FREE_STATUS') {
    (async () => {
      const saved = await chrome.storage.local.get(['settings', 'aiConfig']);
      const config = YTC.aiConfig(saved.aiConfig);
      if (YTC.settings(saved.settings).provider !== 'ai' || !YTC.isFreeConfig(config)) throw new Error('FREE_ONLY');
      const status = await freeRouter.status(config, true);
      respond({ ok: true, used: status.used, limit: status.limit, remaining: status.remaining, estimated: status.estimated });
    })().catch(error => respond(failure(error)));
    return true;
  }
  if (message?.type === 'TRANSLATE' && youtubeSender(sender)) {
    if (typeof message.text !== 'string') { respond({ ok: false, error: 'RESPONSE' }); return; }
    translate(message.text, message.context, { force: message.force === true }).then(result => respond({ ok: true, ...result }), error => respond(failure(error)));
    return true;
  }
  if (message?.type === 'TEST_AI' && pageSender(sender, 'options')) {
    translate('This slaps. He really cooked with this one.', { title: 'A musician performs an impressive guitar solo', parent: '' }, { force: true, test: true })
      .then(result => respond({ ok: true, text: result.text, model: result.model || '' }), error => respond(failure(error)));
    return true;
  }
  if (message?.type === 'CLEAR_CACHE' && (pageSender(sender, 'popup') || pageSender(sender, 'options'))) {
    (async () => {
      await ready; cacheEpoch++; cache.clear(); clearTimeout(saveTimer);
      saveChain = saveChain.catch(() => {}).then(() => chrome.storage.session.remove('translations'));
      await saveChain; await searchBridge.clear(); respond({ ok: true });
    })().catch(() => respond({ ok: false, error: 'SERVICE' }));
    return true;
  }
});
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: YTC.settings(current.settings) });
});
