(() => {
  const listeners = [];
  const messages = [];
  let prefs = { enabled: true, display: 'bilingual', skipChinese: true };
  let retried = false;
  const storageListeners = [];
  window.testAPI = {
    calls: [], messages, delay: 60,
    // Test-only knobs: `hang` makes sendMessage never settle, `watchdog` is the
    // shortened stand-in for the production 100s timeout. Production content.js
    // hard-codes 100000 and reads nothing from testAPI.
    hang: false,
    watchdog: 4000,
    watchdogCalls: 0,
    async setPrefs(next) {
      const oldValue = prefs;
      prefs = { ...prefs, ...next };
      storageListeners.forEach(fn => fn({ settings: { oldValue, newValue: prefs } }, 'local'));
    },
    status() { let result; listeners.forEach(fn => fn({ type: 'GET_STATUS' }, {}, value => { result = value; })); return result; },
    retry() { let result; listeners.forEach(fn => fn({ type: 'RETRY_FAILED' }, {}, value => { result = value; })); return result; }
  };
  const nativeSetTimeout = window.setTimeout.bind(window);
  // Test-only shim: shrink the exact production watchdog delay so a hang can be
  // exercised in milliseconds. Only this fixture touches setTimeout.
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 100000) testAPI.watchdogCalls++;
    return nativeSetTimeout(callback, delay === 100000 ? testAPI.watchdog : delay, ...args);
  };
  window.chrome = {
    storage: { local: { get: async () => ({ settings: prefs }) }, onChanged: { addListener: fn => storageListeners.push(fn) } },
    runtime: { onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: message => {
      testAPI.calls.push(message.text);
      testAPI.messages.push(message);
      if (testAPI.hang) return new Promise(() => {});
      return (async () => {
        await new Promise(resolve => nativeSetTimeout(resolve, testAPI.delay));
        if (message.text === 'Retry me' && !retried) { retried = true; return { ok: false, error: 'NETWORK' }; }
        return { ok: true, source: 'en', text: message.text === 'Literal HTML' ? '<img src=x onerror="window.pwned=true">' : '中文译文：' + message.text };
      })();
    } }
  };
})();
