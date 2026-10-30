window.runChecks = async function () {
  const tests = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  // Observe the error codes content.js hands to YTC.errorText so the timeout
  // assertions do not depend on the wording of shared.js.
  const errorCodes = [];
  const nativeErrorText = YTC.errorText;
  YTC.errorText = response => { errorCodes.push(response?.error); return nativeErrorText(response); };
  // Computed through the original function so it is not recorded as a page render.
  const timeoutText = nativeErrorText({ error: 'OUTPUT_TIMEOUT' });
  const until = async (predicate, message) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 5000) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 35));
    }
  };
  const run = async (name, fn) => {
    try { await fn(); tests.push({ name, passed: true }); }
    catch (error) { tests.push({ name, passed: false, error: error.message }); }
  };
  const block = id => document.querySelector('#' + id + ' .ytcc-translation');
  const make = (id, text, parent = document.querySelector('#comments')) => {
    const item = document.createElement('ytd-comment-view-model'); item.id = id;
    const node = document.createElement('div'); node.id = 'content-text'; node.textContent = text;
    item.append(node); parent.prepend(item); return item;
  };
  await run('translate visible foreign comments and skip Chinese', async () => {
    await until(() => block('english')?.dataset.state === 'done' && block('japanese')?.dataset.state === 'done', 'initial translation missing');
    assert(!block('chinese'), 'Chinese comment was sent');
    assert(!testAPI.calls.includes('Far away comment'), 'offscreen comment was sent');
  });
  await run('render translation text without interpreting HTML', async () => {
    await until(() => block('unsafe')?.dataset.state === 'done', 'unsafe sample not translated');
    assert(!block('unsafe').querySelector('img') && !window.pwned, 'HTML was executed');
    assert(block('unsafe').textContent.includes('<img'), 'literal markup lost');
  });
  await run('retry a network failure without reloading the page', async () => {
    await until(() => block('retry')?.dataset.state === 'error', 'error state missing');
    assert(testAPI.retry().retried === 1, 'retry count incorrect');
    await until(() => block('retry')?.dataset.state === 'done', 'retry did not recover');
  });
  await run('translate dynamically inserted reply', async () => {
    const replies = document.createElement('ytd-comment-replies-renderer');
    document.querySelector('#comments').prepend(replies);
    make('reply', 'A dynamically loaded reply', replies);
    await until(() => block('reply')?.dataset.state === 'done', 'reply not detected');
  });
  await run('retranslate a reused comment node after its text changes', async () => {
    document.querySelector('#english #content-text').firstChild.data = 'An updated comment';
    await until(() => block('english')?.textContent.includes('An updated comment'), 'changed text not translated');
    assert(!block('english').textContent.includes('Thank you'), 'stale translation retained');
  });
  await run('restore translation if a page repaint removes its block', async () => {
    block('english').remove();
    await until(() => block('english')?.dataset.state === 'done', 'removed block was not restored');
  });
  await run('translation-only mode can reveal original and collapse translation', async () => {
    await testAPI.setPrefs({ display: 'translation' });
    await until(() => block('english')?.dataset.state === 'done', 'mode reset incomplete');
    const original = document.querySelector('#english #content-text');
    assert(original.classList.contains('ytcc-hide-original'), 'original still shown');
    Array.from(block('english').querySelectorAll('button')).find(b => b.textContent === '查看原文').click();
    assert(!original.classList.contains('ytcc-hide-original'), 'show original failed');
    Array.from(block('english').querySelectorAll('button')).find(b => b.textContent === '收起译文').click();
    assert(!block('english').querySelector('.ytcc-text'), 'translation did not collapse');
    assert(!original.classList.contains('ytcc-hide-original'), 'collapse hid both texts');
  });
  await run('disable translation restores originals and removes blocks', async () => {
    await testAPI.setPrefs({ enabled: false });
    assert(document.querySelectorAll('.ytcc-translation').length === 0, 'blocks not removed');
    assert(document.querySelectorAll('.ytcc-hide-original').length === 0, 'originals not restored');
  });
  await run('a pending response cannot restore translations after disabling', async () => {
    testAPI.delay = 400;
    await testAPI.setPrefs({ enabled: true });
    const item = make('race', 'Slow network race');
    await until(() => block('race')?.dataset.state === 'loading', 'request did not start');
    await testAPI.setPrefs({ enabled: false });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert(!block('race'), 'stale response restored a block'); item.remove();
    testAPI.delay = 60;
  });
  await run('AI replies receive the loaded parent and video title', async () => {
    await testAPI.setPrefs({ enabled: true, provider: 'ai', useContext: true, display: 'bilingual' });
    const thread = document.createElement('ytd-comment-thread-renderer');
    document.querySelector('#comments').prepend(thread);
    make('ai-parent', 'A wonderful guitar solo', thread);
    const replies = document.createElement('ytd-comment-replies-renderer');
    thread.append(replies);
    make('ai-reply', 'He really cooked', replies);
    await until(() => block('ai-reply')?.dataset.state === 'done', 'AI reply not translated');
    const request = testAPI.messages.find(message => message.text === 'He really cooked');
    assert(request.context.parent === 'A wonderful guitar solo', 'parent context missing');
    assert(request.context.title.length > 0, 'video title missing');
    assert(block('ai-reply').querySelector('.ytcc-label').textContent === 'AI 中文', 'AI label missing');
  });
  await run('AI regenerate bypasses the previous cache', async () => {
    const before = testAPI.messages.filter(message => message.text === 'He really cooked').length;
    Array.from(block('ai-reply').querySelectorAll('button')).find(button => button.textContent === '重新翻译').click();
    await until(() => testAPI.messages.filter(message => message.text === 'He really cooked').length > before && block('ai-reply')?.dataset.state === 'done', 'AI regenerate did not finish');
    const request = testAPI.messages.filter(message => message.text === 'He really cooked').at(-1);
    assert(request.force === true, 'regenerate did not force a fresh request');
  });
  await run('disabling AI context removes title and parent from messages', async () => {
    await testAPI.setPrefs({ useContext: false });
    make('no-context', 'Translate without context');
    await until(() => block('no-context')?.dataset.state === 'done', 'context-free comment not translated');
    const request = testAPI.messages.find(message => message.text === 'Translate without context');
    assert(!request.context.title && !request.context.parent, 'context still sent');
  });
  await run('free mode collects six visible comments before earlier requests finish', async () => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.querySelector('#comments').replaceChildren();
    await testAPI.setPrefs({ enabled: true, provider: 'ai', freeMode: true });
    testAPI.delay = 500;
    const before = testAPI.calls.length;
    for (let index = 0; index < 6; index++) make('free-' + index, 'Free batch comment ' + index);
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => testAPI.calls.length >= before + 6, 'six comments were not submitted together');
    const waiting = Array.from(document.querySelectorAll('.ytcc-translation[data-state="loading"]')).length;
    assert(waiting === 6, 'free mode retained the old two-comment bottleneck');
    await until(() => block('free-0')?.dataset.state === 'done' && block('free-5')?.dataset.state === 'done', 'free comments did not finish');
    testAPI.delay = 60;
  });
  await run('SPA navigation clears previous comment state and discovers new comments', async () => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.querySelector('#comments').replaceChildren();
    await testAPI.setPrefs({ enabled: true, display: 'bilingual' });
    make('nextvideo', 'A new video comment');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => block('nextvideo')?.dataset.state === 'done', 'new video not translated');
    assert(testAPI.status().translated === 1, 'old video stats retained');
  });
  await run('hung messages time out and release their concurrency slots', async () => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.querySelector('#comments').replaceChildren();
    await testAPI.setPrefs({ enabled: true, display: 'bilingual', provider: 'ai', freeMode: false });
    testAPI.watchdog = 400;
    testAPI.hang = true;
    const codesBefore = errorCodes.length;
    const watchdogsBefore = testAPI.watchdogCalls;
    const before = testAPI.calls.length;
    make('hang-a', 'Hung comment A');
    make('hang-b', 'Hung comment B');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => testAPI.calls.length >= before + 2, 'hung comments were not submitted');
    assert(testAPI.calls.length - before === 2, 'non-free mode started more than two requests');
    await until(() => block('hang-a')?.dataset.state === 'error' && block('hang-b')?.dataset.state === 'error', 'hung requests did not time out');
    assert(block('hang-a').textContent.includes(timeoutText), 'timeout error text missing');
    assert(errorCodes.slice(codesBefore).filter(code => code === 'OUTPUT_TIMEOUT').length === 2, 'timed-out requests reported ' + JSON.stringify(errorCodes.slice(codesBefore)));
    assert(testAPI.watchdogCalls - watchdogsBefore === 2, 'content.js did not arm one 100000ms watchdog per request');
    assert(testAPI.status().pending === 0 && testAPI.status().failed === 2, 'timed-out requests were not released');
    testAPI.hang = false;
    make('after-hang', 'A comment after hung requests');
    await until(() => block('after-hang')?.dataset.state === 'done', 'later comment could not start after timeouts');
    assert(block('after-hang').textContent.includes('中文译文：A comment after hung requests'), 'later comment was not translated');
  });
  await run('navigation frees slots so a new page never waits for stale requests', async () => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.querySelector('#comments').replaceChildren();
    await testAPI.setPrefs({ enabled: true, display: 'bilingual', provider: 'ai', freeMode: false });
    testAPI.watchdog = 5000;
    testAPI.hang = true;
    const before = testAPI.calls.length;
    make('stale-a', 'Stale video comment A');
    make('stale-b', 'Stale video comment B');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => testAPI.calls.length >= before + 2, 'stale requests were not submitted');
    // SPA navigation while both old requests are still hanging.
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.querySelector('#comments').replaceChildren();
    testAPI.hang = false;
    make('fresh', 'Fresh video comment');
    const started = Date.now();
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => block('fresh')?.dataset.state === 'done', 'new page waited for stale requests');
    assert(Date.now() - started < 2000, 'new page was blocked by stale requests');
    assert(!block('stale-a') && !block('stale-b'), 'stale blocks survived navigation');
    assert(testAPI.status().pending === 0 && testAPI.status().failed === 0, 'stale requests leaked into the new page state');
  });
  await run('a late response after the timeout is ignored', async () => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    document.querySelector('#comments').replaceChildren();
    await testAPI.setPrefs({ enabled: true, display: 'bilingual', provider: 'ai', freeMode: false });
    testAPI.watchdog = 100;
    testAPI.delay = 400;
    const codesBefore = errorCodes.length;
    make('late', 'Late response comment');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await until(() => block('late')?.dataset.state === 'error', 'late request did not time out');
    assert(errorCodes.slice(codesBefore).includes('OUTPUT_TIMEOUT'), 'late request did not time out with OUTPUT_TIMEOUT');
    const timedOut = block('late').textContent;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert(block('late')?.dataset.state === 'error', 'late response replaced the timeout state');
    assert(block('late').textContent === timedOut, 'late response rewrote the translation block');
    assert(!block('late').textContent.includes('中文译文'), 'late translation was inserted');
    assert(testAPI.status().pending === 0, 'timed-out request stayed pending');
    testAPI.delay = 60;
    testAPI.watchdog = 4000;
  });
  window.testResults = { passed: tests.filter(t => t.passed).length, failed: tests.filter(t => !t.passed).length, tests };
  document.querySelector('#results').textContent = JSON.stringify(window.testResults, null, 2);
  return window.testResults;
};
