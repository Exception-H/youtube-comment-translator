/* Browser-only integration checks for extension/search.js. No network, no debug hooks in production code. */
(() => {
  'use strict';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed');
  }

  async function until(check, timeout = 6000, label = 'condition') {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeout) {
      try {
        if (check()) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(20);
    }
    throw new Error('timeout waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
  }

  function byId(id) { return document.getElementById(id); }
  function host() { return byId('ytcc-search-host'); }
  function pane(key) { return byId('ytcc-search-pane-' + key); }
  function scrollBody(key) { return byId('ytcc-search-scroll-' + key); }
  function list(key) { return byId('ytcc-search-list-' + key); }
  function cards(key) { return Array.from(document.querySelectorAll('#ytcc-search-list-' + key + ' .ytcc-search-card')); }
  function cardIds(key) { return cards(key).map(card => card.dataset.ytccSearchId); }
  function stateBox(key) { return byId('ytcc-search-state-' + key); }
  function moreButton(key) { return byId('ytcc-search-more-' + key); }

  function navigate(query, sp = '') {
    const params = new URLSearchParams();
    if (query !== null && query !== undefined) params.set('search_query', query);
    if (sp) params.set('sp', sp);
    history.replaceState(null, '', 'results' + (params.toString() ? '?' + params.toString() : ''));
    window.dispatchEvent(new PopStateEvent('popstate'));
    return sleep(30);
  }

  function navigatePath(path) {
    history.replaceState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return sleep(120);
  }

  function page(prefix, query, count, continuation) {
    return {
      items: Array.from({ length: count }, (_, index) => testAPI.item(
        prefix + '00' + (index + 1),
        (prefix === 'zh' ? '中文结果 ' : 'English result ') + query + ' #' + (index + 1),
        { duration: '0' + (index + 1) + ':00' }
      )),
      continuation: continuation || ''
    };
  }

  async function begin(query, options = {}) {
    testAPI.resetScenarios();
    testAPI.resetQueryTranslations();
    testAPI.resetTitleTranslation();
    testAPI.clearMessages();
    testAPI.resetSourceCalls();
    if (options.scenarios) {
      for (const [key, value] of Object.entries(options.scenarios)) testAPI.scenario(key, value);
    }
    if (options.queryTranslation) {
      for (const [key, value] of Object.entries(options.queryTranslation)) testAPI.setQueryTranslation(key, value);
    }
    if (options.titleTranslation) testAPI.setTitleTranslation(options.titleTranslation);
    await testAPI.setSettings({ dualSearch: true });
    await navigate('__ytcc_fixture_reset__');
    await navigate(query, options.sp || '');
    await until(() => {
      const node = host();
      return node && node.dataset.ytccSearchQuery === query;
    }, 6000, 'host for ' + query);
    if (options.waitZh !== false) {
      await until(() => cards('zh').length > 0, 6000, 'Chinese cards');
    }
    if (options.waitEn) {
      await until(() => cards('en').length > 0, 6000, 'English cards');
    }
  }

  async function runChecks() {
    const tests = [];
    let passed = 0;
    let failed = 0;

    async function run(name, fn) {
      try {
        await fn();
        passed++;
        tests.push({ name, ok: true });
      } catch (error) {
        failed++;
        tests.push({ name, ok: false, error: error && error.message ? error.message : String(error) });
        console.error('[search-check] ' + name, error);
      }
    }

    if (!/\/results$/.test(location.pathname)) {
      const result = {
        passed: 0,
        failed: 1,
        tests: [{ name: 'fixture URL', ok: false, error: 'Open this fixture over HTTP at /results?search_query=... (for example via a local test host).' }]
      };
      window.__searchChecks = result;
      return result;
    }

    await run('Chinese query renders two panes, hides native results and starts a session', async () => {
      const query = 'Windows 11 卡顿怎么解决';
      await begin(query, { waitEn: true });
      const node = host();
      assert(node, 'host missing');
      assert(getComputedStyle(node).display !== 'none', 'host is hidden');
      assert(document.querySelectorAll('#ytcc-search-pane-zh').length === 1, 'Chinese pane missing');
      assert(document.querySelectorAll('#ytcc-search-pane-en').length === 1, 'English pane missing');
      assert(getComputedStyle(byId('native-results')).display === 'none', 'native results were not hidden');
      assert(getComputedStyle(byId('native-header')).display !== 'none', 'native search header should stay visible');
      assert(cards('zh').length === 6, 'expected six Chinese cards, got ' + cards('zh').length);
      assert(cards('en').length === 6, 'expected six English cards, got ' + cards('en').length);
      assert(cards('zh')[0].textContent.includes(query), 'Chinese card title missing query');
      assert(cards('en')[0].textContent.includes('English result'), 'English card title missing');
      const starts = testAPI.messages.filter(message => message.type === 'SEARCH_START');
      assert(starts.length >= 1, 'SEARCH_START was not sent');
      const session = starts[starts.length - 1].session;
      assert(/^[a-z0-9_-]{1,80}$/.test(session), 'bad session id: ' + session);
      const queryMessage = testAPI.messages.filter(message => message.type === 'SEARCH_TRANSLATE' && message.purpose === 'query').pop();
      assert(queryMessage, 'query translation was not requested');
      assert(queryMessage.text === query && queryMessage.query === query, 'query translation payload mismatch');
      assert(queryMessage.session === session, 'query translation used the wrong session');
      const startIndex = testAPI.messages.findIndex(message => message.type === 'SEARCH_START');
      const translateIndex = testAPI.messages.findIndex(message => message.type === 'SEARCH_TRANSLATE' && message.purpose === 'query');
      assert(startIndex >= 0 && startIndex < translateIndex, 'SEARCH_START must precede translation');
      const searches = testAPI.sourceCalls.search;
      assert(searches.some(call => call.query === query), 'Chinese source search missing');
      assert(searches.some(call => call.query === 'english ' + query), 'English source search missing');
      assert(searches.every(call => call.origin === location.origin), 'source origin mismatch');
    });

    await run('the two desktop panes scroll independently and share the same top edge', async () => {
      await begin('Windows 11 独立滚动', { waitEn: true });
      const masthead = document.querySelector('ytd-masthead');
      const oldHeight = masthead.style.height;
      masthead.style.height = '140px';
      window.dispatchEvent(new Event('resize'));
      await sleep(80);
      const zh = scrollBody('zh');
      const en = scrollBody('en');
      assert(zh && en, 'scroll bodies missing');
      assert(zh.clientHeight > 120, 'Chinese scroll body too short: ' + zh.clientHeight);
      assert(zh.scrollHeight > zh.clientHeight, 'Chinese content is not scrollable');
      assert(en.scrollHeight > en.clientHeight, 'English content is not scrollable');
      zh.scrollTop = 80;
      en.scrollTop = 30;
      await sleep(30);
      assert(zh.scrollTop > 0, 'Chinese scrollTop did not stick');
      assert(en.scrollTop > 0, 'English scrollTop did not stick');
      assert(Math.abs(zh.scrollTop - en.scrollTop) > 1, 'scroll positions should be independent');
      const zhTop = pane('zh').getBoundingClientRect().top;
      const enTop = pane('en').getBoundingClientRect().top;
      assert(Math.abs(zhTop - enTop) < 2, 'right pane was pushed down');
      assert(Math.abs(zh.getBoundingClientRect().bottom - en.getBoundingClientRect().bottom) < 2, 'pane bottoms differ');
      masthead.style.height = oldHeight;
      window.dispatchEvent(new Event('resize'));
      await sleep(40);
    });

    await run('load more advances each pane independently and keeps ordering', async () => {
      await begin('Windows 11 分页独立', { waitEn: true });
      assert(cards('zh').length === 6 && cards('en').length === 6, 'initial page counts wrong');
      const zhMore = moreButton('zh');
      assert(zhMore && !zhMore.hidden, 'Chinese load-more button is not visible');
      zhMore.click();
      await until(() => cards('zh').length === 9, 6000, 'Chinese second page');
      assert(cards('en').length === 6, 'English pane advanced with Chinese pane');
      const enMore = moreButton('en');
      assert(enMore && !enMore.hidden, 'English load-more button is not visible');
      enMore.click();
      await until(() => cards('en').length === 9, 6000, 'English second page');
      const tokens = testAPI.sourceCalls.next.map(call => call.token);
      assert(tokens.includes('zh-p2'), 'Chinese next token missing');
      assert(tokens.includes('en-p2'), 'English next token missing');
      assert(cardIds('zh').slice(0, 3).join(',') === 'zh001,zh002,zh003', 'Chinese ordering changed');
      assert(moreButton('zh').hidden && moreButton('en').hidden, 'load-more should hide after the last page');
    });

    await run('same video in both panes keeps each order and gets the cross badge', async () => {
      const query = 'Windows 11 跨组去重';
      const english = 'english ' + query;
      await begin(query, {
        waitEn: true,
        scenarios: {
          [english]: {
            pages: [{
              items: [
                testAPI.item('en101', 'English cross result'),
                testAPI.item('zh003', 'Cross duplicate result')
              ],
              continuation: ''
            }],
            searchDelay: 8
          }
        }
      });
      await until(() => {
        const zhBadge = document.querySelector('#ytcc-search-list-zh [data-ytcc-search-id="zh003"] .ytcc-search-badge-cross');
        const enBadge = document.querySelector('#ytcc-search-list-en [data-ytcc-search-id="zh003"] .ytcc-search-badge-cross');
        return zhBadge && enBadge && !zhBadge.hidden && !enBadge.hidden;
      }, 6000, 'cross badges');
      assert(cardIds('zh').join(',') === 'zh001,zh002,zh003,zh004,zh005,zh006', 'Chinese order changed');
      assert(cardIds('en').join(',') === 'en101,zh003', 'English order changed');
      const zhBadge = document.querySelector('#ytcc-search-list-zh [data-ytcc-search-id="zh003"] .ytcc-search-badge-cross');
      const enBadge = document.querySelector('#ytcc-search-list-en [data-ytcc-search-id="zh003"] .ytcc-search-badge-cross');
      assert(getComputedStyle(zhBadge).display !== 'none' && getComputedStyle(enBadge).display !== 'none', 'cross badge hidden');
    });

    await run('only visible English cards queue title translations, one at a time', async () => {
      const masthead = document.querySelector('ytd-masthead');
      const oldHeight = masthead.style.height;
      masthead.style.height = '420px';
      window.dispatchEvent(new Event('resize'));
      await sleep(60);
      await begin('Windows 11 译名队列', { waitEn: true });
      await until(() => cards('en').length === 6, 6000, 'English cards');
      await until(() => {
        const first = cards('en')[0];
        const title = first && first.querySelector('.ytcc-search-title');
        return title && title.textContent.startsWith('译名：');
      }, 6000, 'first translated title (calls=' + testAPI.titleTranslation.calls + ', max=' + testAPI.titleTranslation.maxActive + ', first=' + (cards('en')[0] ? cards('en')[0].querySelector('.ytcc-search-title').textContent.slice(0, 40) : 'none') + ')');
      assert(testAPI.titleTranslation.maxActive === 1, 'more than one title translation was in flight: ' + testAPI.titleTranslation.maxActive);
      assert(testAPI.titleTranslation.calls <= 4, 'offscreen titles were translated: ' + testAPI.titleTranslation.calls);
      const titleMessages = testAPI.messages.filter(message => message.type === 'SEARCH_TRANSLATE' && message.purpose === 'title');
      assert(titleMessages.length >= 1, 'title translation message missing');
      assert(titleMessages[0].text.startsWith('English result'), 'title message text is not the original title');
      assert(titleMessages[0].query === 'Windows 11 译名队列', 'title message query mismatch');
      const startMessage = testAPI.messages.filter(message => message.type === 'SEARCH_START').pop();
      assert(titleMessages[0].session === startMessage.session, 'title message session mismatch');
      const first = cards('en')[0];
      const title = first.querySelector('.ytcc-search-title');
      const badge = first.querySelector('.ytcc-search-badge-translated');
      const toggle = first.querySelector('.ytcc-search-title-toggle');
      const original = first.querySelector('.ytcc-search-original-title');
      assert(title.textContent.startsWith('译名：'), 'translated title not shown');
      assert(!badge.hidden && getComputedStyle(badge).display !== 'none', '中文译名 badge missing');
      assert(!toggle.hidden && original.hidden, 'original title should start collapsed');
      toggle.click();
      assert(!original.hidden, 'original title did not expand');
      assert(original.textContent.includes('English result'), 'original title text missing');
      assert(toggle.textContent.includes('收起'), 'toggle label did not change');
      toggle.click();
      assert(original.hidden, 'original title did not collapse');
      const last = cards('en')[cards('en').length - 1];
      assert(last.querySelector('.ytcc-search-title').textContent.startsWith('English result'), 'offscreen title was translated');
      masthead.style.height = oldHeight;
      window.dispatchEvent(new Event('resize'));
      await sleep(60);
    });

    await run('a failed title translation keeps English and retries without pretending to be Chinese', async () => {
      await begin('Windows 11 译名失败', {
        waitEn: true,
        titleTranslation: { error: 'TITLE_FAILED', delay: 5 }
      });
      const first = cards('en')[0];
      const title = first.querySelector('.ytcc-search-title');
      const badge = first.querySelector('.ytcc-search-badge-translated');
      const retry = first.querySelector('.ytcc-search-title-retry');
      await until(() => retry && !retry.hidden, 6000, 'title retry button (calls=' + testAPI.titleTranslation.calls + ', error=' + testAPI.titleTranslation.error + ', title=' + title.textContent.slice(0, 30) + ', hidden=' + (retry ? retry.hidden : 'none') + ')');
      assert(title.textContent.startsWith('English result'), 'failed title changed to Chinese');
      assert(badge.hidden, 'failed title showed 中文译名');
      testAPI.setTitleTranslation({ error: null });
      retry.click();
      await until(() => title.textContent.startsWith('译名：'), 6000, 'title retry success');
      assert(!badge.hidden, 'badge missing after retry');
    });

    await run('a late result from the previous query cannot pollute the new view', async () => {
      testAPI.resetScenarios();
      testAPI.resetQueryTranslations();
      testAPI.resetTitleTranslation();
      testAPI.clearMessages();
      testAPI.resetSourceCalls();
      await testAPI.setSettings({ dualSearch: true });
      const firstQuery = 'Windows 11 旧查询迟到';
      const secondQuery = 'Windows 11 新查询干净';
      testAPI.scenario(firstQuery, {
        pages: [page('zh', firstQuery, 4, '')],
        searchDelay: 420
      });
      await navigate(firstQuery);
      await until(() => host() && host().dataset.ytccSearchQuery === firstQuery, 6000, 'old host');
      await sleep(30);
      await navigate(secondQuery);
      await until(() => host() && host().dataset.ytccSearchQuery === secondQuery, 6000, 'new host');
      await until(() => cards('zh').length > 0, 6000, 'new Chinese cards');
      await sleep(520);
      assert(!document.body.textContent.includes(firstQuery), 'late old query result was inserted');
      assert(cards('zh')[0].textContent.includes(secondQuery), 'new view did not keep its own results');
      const starts = testAPI.messages.filter(message => message.type === 'SEARCH_START');
      const ends = testAPI.messages.filter(message => message.type === 'SEARCH_END');
      assert(starts.length >= 2, 'new query did not send SEARCH_START');
      assert(starts[starts.length - 1].session !== starts[starts.length - 2].session, 'session did not change');
      assert(ends.some(message => message.session === starts[starts.length - 2].session), 'old session was not ended');
    });

    await run('turning the switch off restores native DOM and inline styles while keeping the entry point', async () => {
      const query = 'Windows 11 关闭恢复';
      const native = byId('native-results');
      await testAPI.setSettings({ dualSearch: false });
      await until(() => !host(), 6000, 'host removal before off test');
      const originalStyle = native.getAttribute('style');
      assert(originalStyle === 'min-height:420px', 'fixture style changed before test: ' + originalStyle);
      await begin(query, { waitEn: true });
      assert(native.getAttribute('style') !== originalStyle, 'native results were not hidden by the view');
      assert(getComputedStyle(native).display === 'none', 'native results should be hidden before off');
      const toggle = byId('ytcc-search-toggle');
      assert(toggle, 'toggle missing');
      toggle.click();
      await until(() => !host(), 6000, 'host removal');
      assert(native.getAttribute('style') === originalStyle, 'inline style was not restored');
      assert(getComputedStyle(native).display !== 'none', 'native results stayed hidden');
      assert(byId('ytcc-search-toggle'), 'toggle disappeared while off');
      assert(document.body.style.overflow === '', 'body overflow was modified');
      assert(testAPI.settings.dualSearch === false, 'dualSearch was not persisted');
      assert(testAPI.settings.provider === 'google' && testAPI.settings.enabled === true, 'unrelated settings were changed');
      const ends = testAPI.messages.filter(message => message.type === 'SEARCH_END');
      assert(ends.length >= 1, 'SEARCH_END was not sent when off');
      byId('ytcc-search-toggle').click();
      await until(() => host() && host().dataset.ytccSearchQuery === query, 6000, 'host after on');
      await until(() => cards('zh').length > 0, 6000, 'cards after on');
    });

    await run('without translation permission the English pane shows an auth prompt while Chinese works', async () => {
      const query = 'Windows 11 授权提示';
      const before = testAPI.optionsOpened;
      await begin(query, {
        waitEn: false,
        queryTranslation: { [query]: { error: 'BILIBILI_PERMISSION', delay: 3 } }
      });
      await until(() => cards('zh').length === 6, 6000, 'Chinese cards');
      await until(() => stateBox('en').dataset.ytccSearchKind === 'auth', 6000, 'auth state');
      assert(cards('en').length === 0, 'English pane fabricated cards without permission');
      const auth = stateBox('en');
      assert(auth.textContent.includes('授权'), 'auth prompt missing');
      const settings = auth.querySelector('.ytcc-search-action');
      assert(settings && settings.textContent.includes('设置'), 'open settings button missing');
      settings.click();
      await until(() => testAPI.optionsOpened === before + 1, 3000, 'open settings message');
      assert(testAPI.optionsOpened === before + 1, 'openOptionsPage was not called');
      assert(cards('zh').length === 6, 'Chinese pane stopped working');
    });

    await run('an English source error stays inside its pane and retry recovers', async () => {
      const query = 'Windows 11 英文源错误';
      const english = 'english ' + query;
      await begin(query, {
        waitEn: false,
        scenarios: {
          [english]: { pages: [{ items: [testAPI.item('en901', 'English recovered result')], continuation: '' }], searchError: 'SEARCH_FAIL', searchDelay: 5 }
        }
      });
      await until(() => stateBox('en').dataset.ytccSearchKind === 'error', 6000, 'English source error');
      assert(cards('zh').length === 6, 'Chinese pane was affected by the English source error');
      assert(cards('en').length === 0, 'English pane fabricated a card on source error');
      assert(stateBox('en').textContent.includes('搜索请求失败'), 'source error text missing');
      testAPI.scenario(english, { pages: [{ items: [testAPI.item('en901', 'English recovered result')], continuation: '' }], searchDelay: 5 });
      const retry = stateBox('en').querySelector('.ytcc-search-retry');
      assert(retry, 'English source error has no retry button');
      retry.click();
      await until(() => cards('en').length === 1, 6000, 'English source retry');
      assert(cards('en')[0].textContent.includes('English recovered result'), 'retry result missing');
      assert(cards('zh').length === 6, 'Chinese pane changed during English retry');
    });

    await run('narrow tabs switch panes without re-querying and preserve each scrollTop', async () => {
      const search = byId('search');
      const masthead = document.querySelector('ytd-masthead');
      const oldWidth = search.style.width;
      const oldHeight = masthead.style.height;
      search.style.width = '900px';
      masthead.style.height = '200px';
      window.dispatchEvent(new Event('resize'));
      await sleep(60);
      await begin('Windows 11 窄屏标签', { waitEn: true });
      await until(() => host().classList.contains('ytcc-search-narrow'), 6000, 'narrow class');
      assert(getComputedStyle(byId('ytcc-search-tabs')).display === 'flex', 'tabs not visible');
      assert(getComputedStyle(pane('en')).display === 'none', 'English pane should be hidden');
      const searchCallsBefore = testAPI.sourceCalls.search.length;
      const zh = scrollBody('zh');
      zh.scrollTop = 40;
      await sleep(30);
      assert(zh.scrollTop > 0, 'Chinese scrollTop did not stick in narrow mode');
      byId('ytcc-search-tab-en').click();
      await sleep(40);
      assert(getComputedStyle(pane('en')).display !== 'none', 'English pane did not activate');
      const en = scrollBody('en');
      en.scrollTop = 24;
      await sleep(30);
      assert(en.scrollTop > 0, 'English scrollTop did not stick in narrow mode');
      byId('ytcc-search-tab-zh').click();
      await sleep(40);
      assert(Math.abs(scrollBody('zh').scrollTop - 40) <= 2, 'Chinese scrollTop was not restored: ' + scrollBody('zh').scrollTop);
      byId('ytcc-search-tab-en').click();
      await sleep(40);
      assert(Math.abs(scrollBody('en').scrollTop - 24) <= 2, 'English scrollTop was not restored: ' + scrollBody('en').scrollTop);
      assert(testAPI.sourceCalls.search.length === searchCallsBefore, 'tab switching re-ran the search');
      search.style.width = oldWidth;
      masthead.style.height = oldHeight;
      window.dispatchEvent(new Event('resize'));
      await sleep(80);
      assert(!host().classList.contains('ytcc-search-narrow'), 'desktop class was not restored');
      assert(getComputedStyle(pane('en')).display !== 'none', 'English pane stayed hidden on desktop');
    });

    await run('API HTML and javascript URLs are rendered as text, never as markup or a navigable script URL', async () => {
      const query = 'Windows 11 安全测试';
      const malicious = testAPI.item('xss001', '<img src=x onerror="window.pwned=true">', {
        channel: '<b>bad channel</b>',
        description: '<script>window.pwned=true</script>',
        thumbnail: 'https://evil.example/x.png',
        url: 'javascript:alert(1)'
      });
      await begin(query, {
        waitEn: false,
        scenarios: { [query]: { pages: [{ items: [malicious], continuation: '' }], searchDelay: 5 } }
      });
      await until(() => cards('zh').length === 1, 6000, 'XSS card');
      const card = cards('zh')[0];
      const title = card.querySelector('.ytcc-search-title');
      const thumb = card.querySelector('.ytcc-search-thumb');
      assert(title.textContent === malicious.title, 'title was not rendered as literal text');
      assert(!title.querySelector('img') && !title.querySelector('script'), 'title executed markup');
      assert(!thumb.querySelector('img'), 'untrusted thumbnail was rendered');
      assert(title.getAttribute('href') === '/watch?v=xss001', 'video URL was not rebuilt from the safe id');
      assert(!title.hasAttribute('target'), 'link should stay in the same tab');
      assert(card.querySelectorAll('script').length === 0, 'script element was created');
      assert(card.querySelector('.ytcc-search-description').textContent.includes('<script>'), 'description was not literal text');
      assert(typeof window.pwned === 'undefined', 'XSS handler executed');
    });

    await run('non-search pages and English-only queries keep the native page', async () => {
      await navigatePath('watch?v=abc123');
      await until(() => !host(), 6000, 'host removal on watch');
      assert(getComputedStyle(byId('native-results')).display !== 'none', 'native results stayed hidden on watch');
      assert(!byId('ytcc-search-toggle'), 'toggle leaked onto a watch page');
      await navigate('hello world');
      await sleep(160);
      assert(!host(), 'host appeared for an English query');
      assert(getComputedStyle(byId('native-results')).display !== 'none', 'native results hidden for an English query');
      assert(!byId('ytcc-search-toggle'), 'toggle appeared for an English query');
      await begin('Windows 11 恢复双搜', { waitEn: false });
    });

    await run('a missing source module shows an explicit error and retry never fabricates results', async () => {
      testAPI.resetScenarios();
      testAPI.resetQueryTranslations();
      testAPI.resetTitleTranslation();
      testAPI.clearMessages();
      testAPI.resetSourceCalls();
      await testAPI.setSettings({ dualSearch: true });
      const saved = window.YTCSearchSource;
      window.YTCSearchSource = undefined;
      const query = 'Windows 11 模块缺失';
      try {
        await navigate(query);
        await until(() => host() && host().dataset.ytccSearchQuery === query, 6000, 'host without source');
        await until(() => stateBox('zh').dataset.ytccSearchKind === 'error', 6000, 'source error state');
        assert(cards('zh').length === 0, 'source-less pane fabricated cards');
        assert(stateBox('zh').textContent.includes('搜索数据模块'), 'explicit source error text missing');
        window.YTCSearchSource = saved;
        const retry = stateBox('zh').querySelector('.ytcc-search-retry');
        assert(retry, 'source error has no retry button');
        retry.click();
        await until(() => cards('zh').length === 6, 6000, 'retry after source restored');
        const enRetry = stateBox('en').querySelector('.ytcc-search-retry');
        if (enRetry) {
          enRetry.click();
          await until(() => cards('en').length === 6, 6000, 'English retry after source restored');
        }
      } finally {
        window.YTCSearchSource = saved;
      }
    });

    await run('a repeated continuation token stops with an error instead of looping', async () => {
      const query = 'Windows 11 重复分页';
      const first = {
        items: [testAPI.item('dup001', 'Duplicate token one'), testAPI.item('dup002', 'Duplicate token two')],
        continuation: 'dup-token'
      };
      const second = {
        items: [testAPI.item('dup003', 'Duplicate token three')],
        continuation: 'dup-token'
      };
      await begin(query, {
        waitEn: false,
        scenarios: { [query]: { pages: [first], nextMap: { 'dup-token': second }, searchDelay: 5, nextDelay: 5 } }
      });
      await until(() => cards('zh').length === 2, 6000, 'first duplicate page');
      moreButton('zh').click();
      await until(() => stateBox('zh').dataset.ytccSearchKind === 'error', 6000, 'duplicate token error');
      assert(stateBox('zh').textContent.includes('分页标记重复'), 'duplicate token error text missing');
      assert(moreButton('zh').hidden, 'load-more stayed enabled after duplicate token');
      assert(testAPI.sourceCalls.next.length === 1, 'duplicate token caused another request');
    });

    await run('zero new videos with a fresh token still allows the next page', async () => {
      const query = 'Windows 11 零新增分页';
      const first = {
        items: [testAPI.item('zero001', 'Zero new one'), testAPI.item('zero002', 'Zero new two')],
        continuation: 'z1'
      };
      const same = {
        items: [testAPI.item('zero001', 'Zero new one'), testAPI.item('zero002', 'Zero new two')],
        continuation: 'z2'
      };
      const last = {
        items: [testAPI.item('zero003', 'Zero new three')],
        continuation: ''
      };
      await begin(query, {
        waitEn: false,
        scenarios: { [query]: { pages: [first], nextMap: { z1: same, z2: last }, searchDelay: 5, nextDelay: 5 } }
      });
      await until(() => cards('zh').length === 2, 6000, 'zero page one');
      moreButton('zh').click();
      await until(() => testAPI.sourceCalls.next.length === 1, 6000, 'zero first next');
      await sleep(60);
      assert(cards('zh').length === 2, 'duplicate items were inserted');
      assert(!moreButton('zh').hidden, 'fresh token was not offered');
      moreButton('zh').click();
      await until(() => cards('zh').length === 3, 6000, 'zero third item');
      assert(moreButton('zh').hidden, 'load-more should hide at the end');
      assert(testAPI.sourceCalls.next.map(call => call.token).join(',') === 'z1,z2', 'token sequence wrong');
    });

    await run('sp is inherited and query changes end the old session with a fresh id', async () => {
      const query = 'Windows 11 参数继承';
      const sp = 'EgIQAQ%3D%3D';
      const expectedSp = 'EgIQAQ';
      await begin(query, { sp, waitEn: true });
      const searches = testAPI.sourceCalls.search;
      assert(searches.length >= 2, 'expected Chinese and English searches');
      assert(searches.every(call => call.sp === expectedSp), 'sp was not inherited: ' + searches.map(call => call.sp).join(','));
      const starts = testAPI.messages.filter(message => message.type === 'SEARCH_START');
      const firstSession = starts[starts.length - 1].session;
      assert(/^[a-z0-9_-]{1,80}$/.test(firstSession), 'bad session id');
      const nextQuery = 'Windows 11 参数继承二';
      await navigate(nextQuery);
      await until(() => host() && host().dataset.ytccSearchQuery === nextQuery, 6000, 'next query host');
      await until(() => cards('zh').length > 0, 6000, 'next query cards');
      const allStarts = testAPI.messages.filter(message => message.type === 'SEARCH_START');
      const secondSession = allStarts[allStarts.length - 1].session;
      assert(secondSession !== firstSession, 'session id was reused');
      assert(/^[a-z0-9_-]{1,80}$/.test(secondSession), 'bad next session id');
      const ends = testAPI.messages.filter(message => message.type === 'SEARCH_END');
      assert(ends.some(message => message.session === firstSession), 'old session was not ended');
    });

    await run('wide panes keep independent scroll through a narrow-tab trip and a return to wide', async () => {
      const search = byId('search');
      const masthead = document.querySelector('ytd-masthead');
      const oldWidth = search.style.width;
      const oldHeight = masthead.style.height;
      // Wide fixture viewport: give both panes room and enough scroll range to hold 100/220.
      search.style.width = '1400px';
      masthead.style.height = '320px';
      window.dispatchEvent(new Event('resize'));
      await sleep(80);
      try {
        await begin('Windows 11 宽窄滚动恢复', { waitEn: true });
        await until(() => !host().classList.contains('ytcc-search-narrow'), 6000, 'desktop layout before narrow trip');
        const zh = scrollBody('zh');
        const en = scrollBody('en');
        assert(zh.scrollHeight > zh.clientHeight && en.scrollHeight > en.clientHeight, 'panes are not scrollable in wide layout');
        zh.scrollTop = 100;
        en.scrollTop = 220;
        await sleep(50);
        const zhWide = zh.scrollTop;
        const enWide = en.scrollTop;
        assert(zhWide > 60, 'Chinese wide scrollTop did not stick: ' + zhWide);
        assert(enWide > 160, 'English wide scrollTop did not stick: ' + enWide);
        assert(Math.abs(zhWide - enWide) > 60, 'the two wide panes should keep different scroll offsets');
        const searchesBefore = testAPI.sourceCalls.search.length;

        // Narrow uses the fixture's own viewport simulation (shrink ytd-search), like the older test.
        search.style.width = '900px';
        window.dispatchEvent(new Event('resize'));
        await until(() => host().classList.contains('ytcc-search-narrow'), 6000, 'narrow layout');
        assert(getComputedStyle(pane('en')).display === 'none', 'English pane should be hidden in narrow layout');
        byId('ytcc-search-tab-en').click();
        await sleep(50);
        assert(getComputedStyle(pane('en')).display !== 'none', 'English pane did not activate in narrow layout');
        const enNarrow = scrollBody('en').scrollTop;
        assert(enNarrow > 0, 'English narrow scrollTop was lost: ' + enNarrow);
        byId('ytcc-search-tab-zh').click();
        await sleep(50);
        assert(scrollBody('zh').scrollTop > 0, 'Chinese narrow scrollTop was lost');

        // Return to the wide fixture viewport. Whichever pane is hidden right now reports scrollTop 0;
        // that transient zero must not be mistaken for a lost position.
        search.style.width = oldWidth;
        masthead.style.height = oldHeight;
        window.dispatchEvent(new Event('resize'));
        await sleep(140);
        assert(!host().classList.contains('ytcc-search-narrow'), 'desktop layout was not restored');
        const zhAfter = scrollBody('zh').scrollTop;
        const enAfter = scrollBody('en').scrollTop;
        assert(Math.abs(zhAfter - zhWide) <= 40, 'Chinese scrollTop was not restored after returning wide: ' + zhAfter + ' (was ' + zhWide + ')');
        assert(Math.abs(enAfter - enWide) <= 40, 'English scrollTop was not restored after returning wide: ' + enAfter + ' (was ' + enWide + ')');
        assert(testAPI.sourceCalls.search.length === searchesBefore, 'layout or tab changes re-ran source.search');
      } finally {
        search.style.width = oldWidth;
        masthead.style.height = oldHeight;
        window.dispatchEvent(new Event('resize'));
        await sleep(60);
      }
    });

    await run('an expired load-more token retries with a fresh source and a first-page search', async () => {
      const query = 'Windows 11 分页过期重试';
      const firstPage = {
        items: [0, 1, 2, 3, 4, 5].map(index => testAPI.item('exp00' + (index + 1), 'Expired page result #' + (index + 1))),
        continuation: 'p1'
      };
      await begin(query, {
        waitEn: true,
        scenarios: { [query]: { pages: [firstPage], nextError: 'SEARCH_EXPIRED', searchDelay: 5, nextDelay: 5 } }
      });
      assert(cards('zh').length === 6 && cards('en').length === 6, 'initial page counts wrong');
      const en = scrollBody('en');
      en.scrollTop = 60;
      await sleep(40);
      const enScroll = en.scrollTop;
      const more = moreButton('zh');
      assert(more && !more.hidden, 'Chinese load-more button should be available');
      more.click();
      await until(() => stateBox('zh').dataset.ytccSearchKind === 'error', 6000, 'expired load-more error');
      assert(cards('zh').length === 6, 'the failed next page should keep the existing items');
      assert(stateBox('zh').textContent.includes('过期'), 'expired-token message missing');
      assert(testAPI.sourceCalls.next.length === 1, 'the next token should have been requested exactly once');
      assert(testAPI.sourceCalls.next[0].token === 'p1', 'load-more used the wrong token');

      // Clear nextError and adjust the first page: retry must re-search, not replay the stale token.
      testAPI.scenario(query, { pages: [{ items: [testAPI.item('retry001', 'Retry fresh result')], continuation: '' }], searchDelay: 5 });
      const searchBefore = testAPI.sourceCalls.search.length;
      const nextBefore = testAPI.sourceCalls.next.length;
      const constructedBefore = testAPI.sourceCalls.constructed.length;
      const retry = stateBox('zh').querySelector('.ytcc-search-retry');
      assert(retry, 'expired-token error has no retry button');
      retry.click();
      await until(() => cards('zh').length === 1 && cardIds('zh')[0] === 'retry001', 6000, 'fresh first-page retry result');
      const searchCalls = testAPI.sourceCalls.search;
      assert(searchCalls.length === searchBefore + 1, 'retry should run exactly one new source.search');
      assert(searchCalls[searchCalls.length - 1].query === query, 'retry searched the wrong query: ' + searchCalls[searchCalls.length - 1].query);
      assert(testAPI.sourceCalls.next.length === nextBefore, 'retry replayed the stale next token');
      assert(testAPI.sourceCalls.next.map(call => call.token).join(',') === 'p1', 'stale token was requested more than once');
      assert(testAPI.sourceCalls.constructed.length === constructedBefore + 1, 'retry did not build a fresh SearchSource');
      assert(cardIds('zh').join(',') === 'retry001', 'retry did not replace the pane with the fresh first page');
      assert(cards('en').length === 6, 'the other pane lost its items during retry');
      assert(Math.abs(scrollBody('en').scrollTop - enScroll) <= 2, 'the other pane lost its scroll position during retry');
    });

    const result = { passed, failed, tests };
    window.__searchChecks = result;
    return result;
  }

  function render(result) {
    const output = document.getElementById('results');
    if (!output) return;
    output.textContent = JSON.stringify(result, null, 2);
  }

  let running;
  window.runSearchChecks = function () {
    if (!running) running = runChecks();
    return running.then(result => {
      render(result);
      return result;
    });
  };

  window.addEventListener('load', () => {
    window.runSearchChecks().then(result => {
      window.__searchChecks = result;
      render(result);
    }).catch(error => {
      const result = { passed: 0, failed: 1, tests: [{ name: 'runner', ok: false, error: error && error.message ? error.message : String(error) }] };
      window.__searchChecks = result;
      render(result);
    });
  });
})();
