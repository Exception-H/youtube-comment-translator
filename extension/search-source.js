/* Public, same-origin YouTube search client for the search panel.
 *
 * It reads the public INNERTUBE_CONTEXT.client block that the current page
 * already exposes in a <script>, then POSTs to /youtubei/v1/search on the
 * page's own origin and parses the rendered video results. It never reads
 * cookies, localStorage, login state, visitor data, API keys or Authorization
 * headers, and it never evaluates page code. Continuation tokens stay in
 * memory: they are not logged, persisted or exposed through hidden tabs.
 */
(function (root) {
  'use strict';

  const ALLOWED_ORIGINS = Object.freeze(['https://www.youtube.com', 'https://m.youtube.com']);
  const SEARCH_PATH = '/youtubei/v1/search?prettyPrint=false';
  const START_GAP = 600;
  const REQUEST_TIMEOUT = 20000;
  const MAX_QUERY = 300;
  const MAX_PARAMS = 512;
  const MAX_TOKEN = 16000;
  const MAX_ITEMS = 100;
  const MAX_LIST = 1000;
  const MAX_NODES = 20000;
  const MAX_DEPTH = 40;
  const MAX_SCRIPT = 8 * 1024 * 1024;
  const MAX_SCRIPTS = 200;

  const CLIENT_KEYS = Object.freeze(['clientName', 'clientVersion', 'hl', 'gl']);
  const SKIP_RENDERERS = new Set([
    'adSlotRenderer',
    'promotedSparklesTextSearchRenderer',
    'promotedSparklesWebRenderer',
    'displayAdRenderer',
    'searchPyvRenderer',
    'playlistRenderer',
    'gridPlaylistRenderer',
    'courseRenderer',
    'channelRenderer',
    'radioRenderer'
  ]);

  function fail(name) {
    const error = new Error(name);
    error.code = name;
    return error;
  }

  function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
  }

  /* ---------------------------- client context ---------------------------- */

  function validVersion(value) {
    return typeof value === 'string' && /^[0-9][0-9A-Za-z._-]{0,63}$/.test(value);
  }

  function validLanguage(value) {
    return typeof value === 'string' && value.length <= 16 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(value);
  }

  function validRegion(value) {
    return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
  }

  /* Walk forward from an opening brace, ignoring braces inside JSON strings
   * (including escaped quotes). Returns the balanced object text or null. */
  function balancedObject(text, start) {
    if (text[start] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const ch = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return null;
  }

  /* Collect JSON object slices that may carry the public client config. Only
   * text is scanned; nothing is evaluated. */
  function jsonObjects(text) {
    const found = [];
    const marker = '"INNERTUBE_CONTEXT"';
    let index = 0;
    while ((index = text.indexOf(marker, index)) !== -1) {
      let cursor = index + marker.length;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      if (text[cursor] === ':') {
        cursor++;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
        if (text[cursor] === '{') {
          const slice = balancedObject(text, cursor);
          if (slice) found.push(slice);
        }
      }
      index += marker.length;
    }
    const call = 'ytcfg.set(';
    let position = 0;
    while ((position = text.indexOf(call, position)) !== -1) {
      let cursor = position + call.length;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      if (text[cursor] === '{') {
        const slice = balancedObject(text, cursor);
        if (slice) found.push(slice);
      }
      position += call.length;
    }
    return found;
  }

  function contextOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const nested = value.INNERTUBE_CONTEXT;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
    if (value.client && typeof value.client === 'object' && !Array.isArray(value.client)) return value;
    return null;
  }

  /* Parse one <script> text. Returns only whitelisted client fields that are
   * individually valid, or null. Never returns visitorData, user, API key or
   * any other context field. */
  function parseClientConfig(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_SCRIPT) return null;
    for (const slice of jsonObjects(text)) {
      let parsed;
      try { parsed = JSON.parse(slice); } catch { continue; }
      const context = contextOf(parsed);
      if (!context) continue;
      const client = context.client;
      if (!client || typeof client !== 'object' || Array.isArray(client)) continue;
      const result = {};
      if (client.clientName === 'WEB' || client.clientName === 'MWEB') result.clientName = client.clientName;
      if (validVersion(client.clientVersion)) result.clientVersion = client.clientVersion;
      if (validLanguage(client.hl)) result.hl = client.hl;
      if (validRegion(client.gl)) result.gl = client.gl;
      if (Object.keys(result).length) return result;
    }
    return null;
  }

  function scriptTexts(doc) {
    if (!doc) return [];
    let nodes = [];
    try {
      if (doc.scripts && typeof doc.scripts.length === 'number') nodes = Array.from(doc.scripts);
      else if (typeof doc.querySelectorAll === 'function') nodes = Array.from(doc.querySelectorAll('script'));
    } catch { nodes = []; }
    const texts = [];
    for (const node of nodes.slice(0, MAX_SCRIPTS)) {
      const text = node && typeof node.textContent === 'string' ? node.textContent : '';
      if (text && text.length <= MAX_SCRIPT) texts.push(text);
    }
    return texts;
  }

  function readClientContext(doc) {
    const merged = {};
    for (const text of scriptTexts(doc)) {
      const config = parseClientConfig(text);
      if (!config) continue;
      for (const key of CLIENT_KEYS) {
        if (!merged[key] && config[key]) merged[key] = config[key];
      }
      if (CLIENT_KEYS.every(key => merged[key])) {
        return {
          clientName: merged.clientName,
          clientVersion: merged.clientVersion,
          hl: merged.hl,
          gl: merged.gl
        };
      }
    }
    throw fail('SEARCH_CONTEXT');
  }

  /* ------------------------------ results --------------------------------- */

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : '';
  }

  function textOf(value) {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) {
      let out = '';
      for (const run of value.runs) {
        if (run && typeof run.text === 'string') out += run.text;
        if (out.length > 4000) break;
      }
      return out;
    }
    return '';
  }

  function cleanText(value, max) {
    if (typeof value !== 'string' || !value) return '';
    return value
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function safeThumbUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) return '';
    let url;
    try { url = new URL(value); } catch { return ''; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    const host = url.hostname.toLowerCase();
    const allowed = host === 'ytimg.com' || host.endsWith('.ytimg.com')
      || host === 'ggpht.com' || host.endsWith('.ggpht.com');
    if (!allowed) return '';
    url.hash = '';
    return url.href;
  }

  function pickThumb(thumbnail) {
    const list = thumbnail && Array.isArray(thumbnail.thumbnails) ? thumbnail.thumbnails : [];
    for (let index = list.length - 1; index >= 0; index--) {
      const url = safeThumbUrl(list[index] && list[index].url);
      if (url) return url;
    }
    return '';
  }

  function isLive(video) {
    if (Array.isArray(video.badges)) {
      for (const badge of video.badges) {
        const renderer = badge && badge.metadataBadgeRenderer;
        if (!renderer) continue;
        if (renderer.style === 'BADGE_STYLE_TYPE_LIVE_NOW') return true;
        if (typeof renderer.label === 'string' && renderer.label.trim().toUpperCase() === 'LIVE') return true;
      }
    }
    if (Array.isArray(video.thumbnailOverlays)) {
      for (const overlay of video.thumbnailOverlays) {
        const renderer = overlay && overlay.thumbnailOverlayTimeStatusRenderer;
        if (!renderer) continue;
        if (renderer.style === 'LIVE') return true;
        if (textOf(renderer.text).trim().toUpperCase() === 'LIVE') return true;
      }
    }
    return false;
  }

  function buildModel(id, fields) {
    return {
      id,
      title: cleanText(fields.title, 300),
      channel: cleanText(fields.channel, 120),
      views: cleanText(fields.views, 60),
      published: cleanText(fields.published, 60),
      duration: cleanText(fields.duration, 30),
      description: cleanText(fields.description, 500),
      thumbnail: safeThumbUrl(fields.thumbnail),
      url: 'https://www.youtube.com/watch?v=' + id
    };
  }

  function videoModel(video) {
    if (!video || typeof video !== 'object') return null;
    const id = validId(video.videoId);
    if (!id) return null;
    const live = isLive(video);
    return buildModel(id, {
      title: textOf(video.title) || textOf(video.headline),
      channel: textOf(video.ownerText) || textOf(video.longBylineText) || textOf(video.shortBylineText),
      views: textOf(video.viewCountText),
      published: textOf(video.publishedTimeText),
      duration: textOf(video.lengthText) || (live ? '直播' : ''),
      description: textOf(video.detailedMetadataSnippets && video.detailedMetadataSnippets[0] && video.detailedMetadataSnippets[0].snippetText)
        || textOf(video.descriptionSnippet),
      thumbnail: pickThumb(video.thumbnail)
    });
  }

  function reelModel(reel) {
    if (!reel || typeof reel !== 'object') return null;
    const id = validId(reel.videoId);
    if (!id) return null;
    return buildModel(id, {
      title: textOf(reel.headline),
      channel: '',
      views: textOf(reel.viewCountText),
      published: '',
      duration: '',
      description: '',
      thumbnail: pickThumb(reel.thumbnail)
    });
  }

  /* Shorts lockups only contribute when the id can be read without guessing. */
  function shortsModel(lockup) {
    if (!lockup || typeof lockup !== 'object') return null;
    const tap = lockup.onTap && lockup.onTap.innertubeCommand;
    let id = validId(tap && tap.reelWatchEndpoint && tap.reelWatchEndpoint.videoId);
    if (!id && typeof lockup.entityId === 'string') {
      const match = /^shorts-shelf-item-([A-Za-z0-9_-]{11})$/.exec(lockup.entityId);
      if (match) id = match[1];
    }
    if (!id) return null;
    return buildModel(id, {
      title: textOf(lockup.overlayMetadata && lockup.overlayMetadata.primaryText),
      channel: '',
      views: textOf(lockup.overlayMetadata && lockup.overlayMetadata.secondaryText),
      published: '',
      duration: '',
      description: '',
      thumbnail: ''
    });
  }

  function pushModel(model, items, seen) {
    if (!model || seen.has(model.id) || items.length >= MAX_ITEMS) return;
    seen.add(model.id);
    items.push(model);
  }

  function collect(node, items, seen, state, depth) {
    if (++state.nodes > MAX_NODES) throw fail('SEARCH_RESPONSE');
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length > MAX_LIST) throw fail('SEARCH_RESPONSE');
      for (const entry of node) collect(entry, items, seen, state, depth + 1);
      return;
    }
    if (depth > MAX_DEPTH) throw fail('SEARCH_RESPONSE');
    for (const key of Object.keys(node)) {
      if (SKIP_RENDERERS.has(key)) continue;
      const value = node[key];
      if (!value || typeof value !== 'object') continue;
      if (key === 'videoRenderer') { pushModel(videoModel(value), items, seen); continue; }
      if (key === 'reelItemRenderer') { pushModel(reelModel(value), items, seen); continue; }
      if (key === 'shortsLockupViewModel') { pushModel(shortsModel(value), items, seen); continue; }
      if (key === 'continuationItemRenderer') continue;
      collect(value, items, seen, state, depth + 1);
    }
  }

  /* The main list's own trailing continuation item is the only token we take.
   * Shorts shelves nest their tokens deeper, so they are never selected. */
  function continuationOf(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const tail = list[list.length - 1];
    const token = tail && tail.continuationItemRenderer
      && tail.continuationItemRenderer.continuationEndpoint
      && tail.continuationItemRenderer.continuationEndpoint.continuationCommand
      && tail.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return '';
    return /^[A-Za-z0-9_\-=.%]+$/.test(token) ? token : '';
  }

  function parseResults(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('SEARCH_RESPONSE');
    const contents = data.contents && data.contents.twoColumnSearchResultsRenderer
      && data.contents.twoColumnSearchResultsRenderer.primaryContents
      && data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer
      ? data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents
      : data.contents && data.contents.sectionListRenderer
        ? data.contents.sectionListRenderer.contents
        : undefined;
    const lists = [];
    let recognized = Array.isArray(contents);
    if (Array.isArray(contents)) lists.push(contents);
    for (const key of ['onResponseReceivedCommands', 'onResponseReceivedActions']) {
      const commands = data[key];
      if (!Array.isArray(commands)) continue;
      for (const command of commands) {
        const items = command && command.appendContinuationItemsAction
          && command.appendContinuationItemsAction.continuationItems;
        if (Array.isArray(items)) {
          recognized = true;
          lists.push(items);
        }
      }
    }
    if (!recognized) throw fail('SEARCH_RESPONSE');
    for (const list of lists) {
      if (list.length > MAX_LIST) throw fail('SEARCH_RESPONSE');
    }
    const items = [];
    const seen = new Set();
    const state = { nodes: 0 };
    for (const list of lists) {
      for (const entry of list) collect(entry, items, seen, state, 0);
    }
    return { items, continuation: continuationOf(lists[lists.length - 1]) };
  }

  /* ------------------------------ requests -------------------------------- */

  function normalizeOrigin(value) {
    if (typeof value !== 'string') return '';
    const origin = value.trim().replace(/\/+$/, '');
    return ALLOWED_ORIGINS.includes(origin) ? origin : '';
  }

  function normalizeSearch(query, options) {
    if (typeof query !== 'string') throw fail('SEARCH_INPUT');
    const cleaned = query.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (!cleaned || Array.from(cleaned).length > MAX_QUERY) throw fail('SEARCH_INPUT');
    let params = options ? options.params : '';
    if (params === undefined || params === null) params = '';
    if (typeof params !== 'string') throw fail('SEARCH_INPUT');
    if (params && (params.length > MAX_PARAMS || !/^[A-Za-z0-9_-]+$/.test(params))) throw fail('SEARCH_INPUT');
    return { query: cleaned, params };
  }

  function normalizeToken(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) throw fail('SEARCH_INPUT');
    if (!/^[A-Za-z0-9_\-=.%]+$/.test(token)) throw fail('SEARCH_INPUT');
    return token;
  }

  class SearchSource {
    constructor(options) {
      const source = options && typeof options === 'object' ? options : {};
      const rawOrigin = source.origin === undefined
        ? (typeof location !== 'undefined' && location ? location.origin : '')
        : source.origin;
      const origin = normalizeOrigin(rawOrigin);
      if (!origin) throw fail('SEARCH_ORIGIN');
      this.origin = origin;
      this.document = source.document || null;
      this.fetch = typeof source.fetch === 'function'
        ? source.fetch
        : (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
      this.now = typeof source.now === 'function' ? source.now : Date.now;
      this.sleep = typeof source.sleep === 'function'
        ? source.sleep
        : ms => new Promise(resolve => setTimeout(resolve, ms));
      const timeout = Number(source.timeout);
      this.timeout = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, REQUEST_TIMEOUT) : REQUEST_TIMEOUT;
      this.client = null;
      this.chain = Promise.resolve();
      this.lastStart = -Infinity;
    }

    /* Read lazily: ytcfg exists by the time the panel issues its first query. */
    clientContext() {
      if (!this.client) {
        if (!this.document) throw fail('SEARCH_CONTEXT');
        this.client = readClientContext(this.document);
      }
      return this.client;
    }

    clientBody() {
      const client = this.clientContext();
      return {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: client.hl,
        gl: client.gl
      };
    }

    /* One serial chain per instance; concurrent calls queue instead of racing. */
    enqueue(signal, task) {
      const run = this.chain.then(() => {
        if (signal && signal.aborted) throw abortError();
        return task();
      });
      this.chain = run.then(() => undefined, () => undefined);
      return run;
    }

    search(query, options) {
      const opts = options && typeof options === 'object' ? options : {};
      let input;
      try { input = normalizeSearch(query, opts); } catch (error) { return Promise.reject(error); }
      const signal = opts.signal;
      return this.enqueue(signal, () => {
        const body = { context: { client: this.clientBody() }, query: input.query };
        if (input.params) body.params = input.params;
        return this.request(body, signal);
      });
    }

    next(token, options) {
      const opts = options && typeof options === 'object' ? options : {};
      let continuation;
      try { continuation = normalizeToken(token); } catch (error) { return Promise.reject(error); }
      const signal = opts.signal;
      return this.enqueue(signal, () => this.request({ context: { client: this.clientBody() }, continuation }, signal));
    }

    async request(body, signal) {
      if (typeof this.fetch !== 'function') throw fail('SEARCH_NETWORK');
      if (signal && signal.aborted) throw abortError();
      const wait = this.lastStart + START_GAP - this.now();
      if (wait > 0) await this.sleep(wait);
      if (signal && signal.aborted) throw abortError();
      this.lastStart = this.now();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch { /* already aborted */ }
      }, this.timeout);
      const forward = () => {
        try { controller.abort(); } catch { /* already aborted */ }
      };
      if (signal) signal.addEventListener('abort', forward, { once: true });
      let response;
      try {
        response = await this.fetch(this.origin + SEARCH_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          redirect: 'error',
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch {
        if (timedOut) throw fail('SEARCH_TIMEOUT');
        if (signal && signal.aborted) throw abortError();
        throw fail('SEARCH_NETWORK');
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', forward);
      }
      const status = Number(response && response.status);
      const ok = Boolean(response && (response.ok === true
        || (response.ok === undefined && status >= 200 && status < 300)));
      if (!ok) {
        if (status === 400) throw fail('SEARCH_EXPIRED');
        if (status === 429) throw fail('RATE_LIMIT');
        if (status === 401 || status === 403) throw fail('SEARCH_ACCESS');
        throw fail('SEARCH_RESPONSE');
      }
      let data;
      try { data = await response.json(); } catch { throw fail('SEARCH_RESPONSE'); }
      return parseResults(data);
    }
  }

  const api = { readClientContext, parseClientConfig, parseResults, SearchSource };
  root.YTCSearchSource = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
