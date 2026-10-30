'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const shared = require('../extension/shared.js');
const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
module.exports = function harness(fetchImpl) {
  const handlers = [];
  const data = { local: {}, session: {} };
  const timers = new Set();
  const permissions = { allowed: true, checked: [] };
  const api = area => ({
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, data[area][name]])),
    set: async object => Object.assign(data[area], object),
    remove: async key => { delete data[area][key]; }
  });
  const chrome = {
    storage: { local: api('local'), session: api('session') },
    permissions: { contains: async value => { permissions.checked.push(value); return permissions.allowed; } },
    declarativeNetRequest: { updates: [], async updateDynamicRules(value) { this.updates.push(value); } },
    runtime: { id: 'test', getURL: file => 'chrome-extension://test/' + file, onMessage: { addListener: fn => handlers.push(fn) }, onInstalled: { addListener: () => {} } }
  };
  const context = vm.createContext({ YTC: shared, chrome, importScripts() {}, URL, AbortSignal, TextEncoder, crypto: webcrypto, fetch: fetchImpl,
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/free-router.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/siliconflow.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/indextranslate.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/search-bridge.js'), 'utf8'), context);
  vm.runInContext(source, context);
  const youtube = { url: 'https://www.youtube.com/watch?v=test', tab: { id: 1 } };
  function send(message, sender = youtube) {
    return new Promise((resolve, reject) => {
      const handled = handlers[0](message, sender, resolve);
      if (!handled) reject(new Error('UNAUTHORIZED'));
    });
  }
  return { send, data, permissions, dispose: () => { for (const timer of timers) clearTimeout(timer); }, context };
};
