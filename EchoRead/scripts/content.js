/* EchoRead – content script
 * 1. Article extraction + speechSynthesis reader (with paragraph sync)
 * 2. Floating "Highlight / Save" pill, DOM highlighting, restore on load
 */
(() => {
  'use strict';
  if (window.__echoreadLoaded) return; // guard against double injection
  window.__echoreadLoaded = true;

  const STORE_KEY = 'echoread_highlights';
  const MARK_CLASS = 'echoread-highlight';
  const SPEAKING_CLASS = 'echoread-speaking';
  const DEFAULT_COLOR = '#fde68a';
  const SWATCHES = [['Amber', '#fde68a'], ['Mint', '#bbf7d0'], ['Sky', '#bfdbfe'], ['Rose', '#fbcfe8']];
  const MAX_SELECTION = 5000;

  const IS_TOP = window === window.top;
  const localKey = () => location.href.split('#')[0];
  let topInfo = null; // iframes: { url, title } of the top-level page, resolved through the background worker
  const pageKey = () => (IS_TOP || !topInfo ? localKey() : topInfo.url);
  const pageTitle = () => (IS_TOP || !topInfo ? document.title || location.hostname : topInfo.title);
  const sendToBG = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      return p && typeof p.then === 'function' ? p.catch(() => null) : Promise.resolve(null);
    } catch (_) { return Promise.resolve(null); } // extension context invalidated
  };
  const safeSend = (msg) => { sendToBG(msg); };

  /* =====================================================================
   * ARTICLE EXTRACTION
   * ===================================================================== */
  const NOISE_TAGS = new Set(['NAV', 'ASIDE', 'FOOTER', 'FORM', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'BUTTON', 'SELECT', 'TEXTAREA', 'DIALOG']);
  const NOISE_ROLES = new Set(['navigation', 'complementary', 'contentinfo', 'search', 'dialog', 'alert']);
  const NOISE_TOKEN = /^(ad|ads|adv|advert\w*|banner|breadcrumbs?|comments?|comment-\w+|cookie\w*|consent|footer\w*|masthead|menu|modal|navbar|nav|newsletter\w*|outbrain|popup|promo\w*|recirc\w*|related\w*|share\w*|sharing|sidebar\w*|social\w*|sponsor\w*|subscribe\w*|taboola|toolbar|widget\w*)(-|_|$)/i;

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function isNoise(el, stopAt) {
    for (let n = el; n && n !== stopAt && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (NOISE_TAGS.has(n.tagName.toUpperCase())) return true;
      const role = n.getAttribute('role');
      if (role && NOISE_ROLES.has(role)) return true;
      if (n.getAttribute('aria-hidden') === 'true') return true;
      const cls = (n.getAttribute('class') || '') + ' ' + (n.id || '');
      if (cls.trim() && cls.split(/\s+/).some((t) => t && NOISE_TOKEN.test(t))) return true;
    }
    return false;
  }

  function findContainer() {
    const scores = new Map();
    document.querySelectorAll('p').forEach((p) => {
      if (isNoise(p, document.body) || !p.getClientRects().length) return;
      const text = p.textContent || '';
      const len = text.trim().length;
      if (len < 40) return;
      const score = Math.min(len, 600) + (text.match(/[,;.]/g) || []).length * 10;
      const parent = p.parentElement;
      if (!parent) return;
      scores.set(parent, (scores.get(parent) || 0) + score);
      const gp = parent.parentElement;
      if (gp) scores.set(gp, (scores.get(gp) || 0) + score / 2);
    });
    let best = null, bestScore = 0;
    scores.forEach((s, el) => { if (s > bestScore) { best = el; bestScore = s; } });
    if (!best) return document.querySelector('article, main, [role="main"]') || document.body;
    const art = best.closest('article, [itemprop="articleBody"]');
    return art && !isNoise(art, document.body) ? art : best;
  }

  const cleanText = (t) => (t || '').replace(/\[\d{1,3}\]/g, '').replace(/\s+/g, ' ').trim();

  function collectBlocks() {
    const container = findContainer();
    const sel = 'h1,h2,h3,h4,p,li,blockquote';
    const blocks = [];
    container.querySelectorAll(sel).forEach((el) => {
      if (el.querySelector(sel)) return; // read leaf blocks only (avoid duplicates)
      if (isNoise(el, container) || !isVisible(el)) return;
      const text = cleanText(el.innerText);
      const min = /^H\d$/.test(el.tagName) ? 3 : el.tagName === 'P' ? 15 : 20;
      if (text.length < min) return;
      blocks.push({ el, text });
    });
    // The page headline is often outside the article body – read it first.
    const h1 = document.querySelector('h1');
    if (h1 && !container.contains(h1) && isVisible(h1) && !isNoise(h1, document.body)) {
      const t = cleanText(h1.innerText);
      if (t.length >= 3) blocks.unshift({ el: h1, text: t });
    }
    return blocks;
  }

  // Chrome stops long utterances after ~15 s, so speak in sentence-sized chunks.
  function chunkText(text, max = 220) {
    const sentences = text.split(/(?<=[.!?…]["'”’)\]]*)\s+/);
    const chunks = [];
    let cur = '';
    const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
    for (let s of sentences) {
      while (s.length > max) {
        let idx = s.lastIndexOf(' ', max);
        if (idx < max * 0.5) idx = max;
        if (cur) flush();
        chunks.push(s.slice(0, idx).trim());
        s = s.slice(idx).trim();
      }
      if ((cur + ' ' + s).trim().length > max) flush();
      cur = (cur + ' ' + s).trim();
    }
    flush();
    return chunks;
  }

  /* =====================================================================
   * TEXT-TO-SPEECH ENGINE
   * ===================================================================== */
  const tts = {
    status: 'idle', // idle | playing | paused
    blocks: [],
    chunks: [],
    index: 0,
    gen: 0, // invalidates stale utterance callbacks
    activeBlock: -1,
    useBg: false, // true → speaking through chrome.tts in the background worker
    resumeNeedsSpeak: false,
    finished: false,
    error: null,
    settings: { rate: 1, pitch: 1, voiceURI: '' },
  };

  const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, +n)) : d);

  function ttsState() {
    const chunk = tts.chunks[tts.index];
    return {
      status: tts.status,
      index: tts.index,
      total: tts.chunks.length,
      preview: chunk ? chunk.text : '',
      finished: tts.finished,
      error: tts.error,
    };
  }
  const report = () => safeSend({ type: 'TTS_STATE', state: ttsState() });

  function applySettings(s) {
    if (!s) return;
    tts.settings.rate = clamp(s.rate, 0.75, 2, tts.settings.rate);
    tts.settings.pitch = clamp(s.pitch, 0.5, 2, tts.settings.pitch);
    if (typeof s.voiceURI === 'string') tts.settings.voiceURI = s.voiceURI;
  }

  function setActiveBlock(i) {
    if (i === tts.activeBlock) return;
    clearActiveBlock();
    tts.activeBlock = i;
    const b = tts.blocks[i];
    if (!b) return;
    b.el.classList.add(SPEAKING_CLASS);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    b.el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }
  function clearActiveBlock() {
    document.querySelectorAll('.' + SPEAKING_CLASS).forEach((e) => e.classList.remove(SPEAKING_CLASS));
    tts.activeBlock = -1;
  }

  function cancelSpeech() {
    try { speechSynthesis.cancel(); } catch (_) {}
    if (tts.useBg) safeSend({ type: 'BG_TTS_CONTROL', action: 'stop' });
  }

  function onChunkEnd(myGen) {
    if (myGen !== tts.gen || tts.status === 'idle') return;
    tts.index++;
    if (tts.status === 'paused') { tts.resumeNeedsSpeak = true; return; }
    speakCurrent();
  }

  function failSpeech(myGen, code) {
    if (myGen !== tts.gen) return;
    stopReading(`Speech failed (${code || 'unknown error'}). Try another voice.`);
  }

  // Chrome fills its voice list asynchronously, and getVoices() is often still
  // empty the first time this script runs – without a cache the voice picked in
  // the popup silently resolves to nothing and the default voice is used.
  let voicesCache = [];
  const loadVoices = () => { voicesCache = speechSynthesis.getVoices(); };
  loadVoices();
  // addEventListener so a page's own onvoiceschanged handler is left alone.
  if (typeof speechSynthesis.addEventListener === 'function') speechSynthesis.addEventListener('voiceschanged', loadVoices);
  else speechSynthesis.onvoiceschanged = loadVoices;
  function resolveVoice() {
    if (!tts.settings.voiceURI) return null;
    const live = speechSynthesis.getVoices();
    return (live.length ? live : voicesCache).find((v) => v.voiceURI === tts.settings.voiceURI) || null;
  }

  // Chrome refuses page-level speech until the user has interacted with the page.
  // chrome.tts (in the background worker) has no such restriction, so fall back to it.
  function speakViaBackground(chunk, myGen) {
    tts.useBg = true;
    const voice = resolveVoice();
    safeSend({
      type: 'BG_SPEAK', gen: myGen, text: chunk.text,
      rate: tts.settings.rate, pitch: tts.settings.pitch,
      voiceName: voice ? voice.name : '', lang: voice ? voice.lang : (document.documentElement.lang || ''),
    });
  }

  function speakCurrent() {
    const chunk = tts.chunks[tts.index];
    if (!chunk) return finish();
    const myGen = ++tts.gen;
    setActiveBlock(chunk.block);
    report();
    if (tts.useBg) return speakViaBackground(chunk, myGen);
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(chunk.text);
    u.rate = tts.settings.rate;
    u.pitch = tts.settings.pitch;
    const voice = resolveVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.onend = () => onChunkEnd(myGen);
    u.onerror = (e) => {
      if (myGen !== tts.gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') return speakViaBackground(chunk, myGen);
      failSpeech(myGen, e.error);
    };
    speechSynthesis.speak(u);
  }

  function startReading(settings) {
    stopReading(null, true);
    tts.useBg = false; // try native speech first on every Play
    applySettings(settings);
    tts.blocks = collectBlocks();
    tts.chunks = [];
    tts.blocks.forEach((b, i) => chunkText(b.text).forEach((t) => tts.chunks.push({ block: i, text: t })));
    tts.index = 0;
    tts.finished = false;
    tts.error = null;
    if (!tts.chunks.length) {
      tts.error = 'No readable article text was found on this page.';
      return report();
    }
    tts.status = 'playing';
    speakCurrent();
  }

  function pauseReading() {
    if (tts.status !== 'playing') return;
    if (tts.useBg) safeSend({ type: 'BG_TTS_CONTROL', action: 'pause' });
    else speechSynthesis.pause();
    tts.status = 'paused';
    report();
  }

  function resumeReading() {
    if (tts.status !== 'paused') return;
    tts.status = 'playing';
    if (tts.resumeNeedsSpeak) { tts.resumeNeedsSpeak = false; speakCurrent(); return; }
    if (tts.useBg) safeSend({ type: 'BG_TTS_CONTROL', action: 'resume' });
    else speechSynthesis.resume();
    report();
  }

  function stopReading(error = null, silent = false) {
    tts.gen++;
    cancelSpeech();
    clearActiveBlock();
    tts.status = 'idle';
    tts.index = 0;
    tts.resumeNeedsSpeak = false;
    tts.error = error;
    if (!silent) report();
  }

  function finish() {
    clearActiveBlock();
    tts.status = 'idle';
    tts.index = 0;
    tts.finished = true;
    report();
  }

  function updateSettingsLive(settings) {
    applySettings(settings);
    if (tts.status === 'playing') speakCurrent(); // restart current sentence with new voice/rate/pitch
    else if (tts.status === 'paused') { tts.gen++; cancelSpeech(); tts.resumeNeedsSpeak = true; }
  }

  window.addEventListener('pagehide', () => { if (tts.status !== 'idle') cancelSpeech(); });

  /* =====================================================================
   * HIGHLIGHT ENGINE
   * ===================================================================== */
  const SKIP_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT']);
  const isSkippableText = (n) => !n.parentElement || SKIP_PARENTS.has(n.parentElement.tagName);
  const genId = () => `er_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const findMarks = (id) => document.querySelectorAll(`mark.${MARK_CLASS}[data-echoread-id="${id}"]`);

  function collectSegments(range) {
    const segs = [];
    const consider = (node) => {
      if (isSkippableText(node)) return;
      const len = node.nodeValue.length;
      const s = node === range.startContainer ? range.startOffset : 0;
      const e = node === range.endContainer ? range.endOffset : len;
      if (s >= e) return;
      const piece = node.nodeValue.slice(s, e);
      if (!piece.trim() && piece.includes('\n')) return; // layout whitespace
      segs.push({ node, s, e });
    };
    const c = range.commonAncestorContainer;
    if (c.nodeType === Node.TEXT_NODE) { consider(c); return segs; }
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (range.intersectsNode(n)) consider(n);
    return segs;
  }

  function wrapRange(range, id, color) {
    const segs = collectSegments(range); // computed up-front: splitting mutates live ranges
    // Bail out instead of throwing if the page re-rendered under us (SPA route
    // change) and the captured range no longer sits in the document.
    if (!segs.length || segs.some(({ node }) => !node.parentNode)) return false;
    for (const { node, s, e } of segs) {
      let target = node;
      if (e < node.nodeValue.length) node.splitText(e);
      if (s > 0) target = node.splitText(s);
      const mark = document.createElement('mark');
      mark.className = MARK_CLASS;
      mark.dataset.echoreadId = id;
      mark.style.setProperty('background-color', color || DEFAULT_COLOR, 'important');
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }
    return true;
  }

  function unwrapMark(mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  // Locate `text` in the page (whitespace-insensitive) and return a Range, or null.
  function findTextRange(text, prefix = '', suffix = '') {
    const target = text.replace(/\s+/g, ' ').trim();
    if (!target) return null;
    const blockCache = new Map();
    const blockOf = (node) => {
      let el = node.parentElement;
      const trail = [];
      while (el && el !== document.body) {
        if (blockCache.has(el)) { const b = blockCache.get(el); trail.forEach((t) => blockCache.set(t, b)); return b; }
        trail.push(el);
        const d = getComputedStyle(el).display;
        if (!d.startsWith('inline') && d !== 'contents') { trail.forEach((t) => blockCache.set(t, el)); return el; }
        el = el.parentElement;
      }
      return document.body;
    };

    const build = (compact) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (isSkippableText(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let norm = '';
      const map = [];
      let lastSpace = true, prevBlock = null, n;
      while ((n = walker.nextNode())) {
        if (!compact) {
          const b = blockOf(n);
          if (prevBlock && b !== prevBlock && !lastSpace) { norm += ' '; map.push({ node: n, offset: 0 }); lastSpace = true; }
          prevBlock = b;
        }
        const s = n.nodeValue;
        for (let i = 0; i < s.length; i++) {
          const code = s.charCodeAt(i);
          const isSpace = code === 32 || (code >= 9 && code <= 13) || code === 160;
          if (isSpace) {
            if (!compact && !lastSpace) { norm += ' '; map.push({ node: n, offset: i }); lastSpace = true; }
          } else { norm += s[i]; map.push({ node: n, offset: i }); lastSpace = false; }
        }
      }
      return { norm, map };
    };

    const tail = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; };
    const head = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

    for (const compact of [false, true]) {
      const needle = compact ? target.replace(/\s+/g, '') : target;
      const pre = compact ? prefix.replace(/\s+/g, '') : prefix;
      const suf = compact ? suffix.replace(/\s+/g, '') : suffix;
      const { norm, map } = build(compact);
      // If the phrase occurs several times, pick the occurrence whose surrounding text matches best.
      let best = -1, bestScore = -1, idx = norm.indexOf(needle), guard = 0;
      while (idx >= 0 && guard++ < 500) {
        const score =
          tail(pre, norm.slice(Math.max(0, idx - pre.length), idx)) +
          head(suf, norm.slice(idx + needle.length, idx + needle.length + suf.length));
        if (score > bestScore) { best = idx; bestScore = score; }
        if (!pre && !suf) break; // no context stored: first match wins
        idx = norm.indexOf(needle, idx + 1);
      }
      if (best < 0) continue;
      const a = map[best], b = map[best + needle.length - 1];
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset + 1);
      return range;
    }
    return null;
  }

  function applyHighlight(h) {
    if (findMarks(h.id).length) return true;
    const range = findTextRange(h.text, h.prefix || '', h.suffix || '');
    return range ? wrapRange(range, h.id, h.color) : false;
  }

  // Iframes are filed under the top-level page, whose URL only the top frame
  // knows; ask it, retrying while that frame's content script is still loading.
  async function ensureTopInfo(tries = 4, delay = 1500) {
    for (let i = 0; i < tries && !topInfo; i++) {
      const r = await sendToBG({ type: 'GET_TOP_URL' });
      if (r && r.ok && r.url) { topInfo = { url: r.url, title: r.title || r.url }; break; }
      if (i < tries - 1) await new Promise((res) => setTimeout(res, delay));
    }
    return topInfo;
  }

  async function restoreHighlights() {
    if (!IS_TOP && !topInfo && !(await ensureTopInfo())) return;
    try {
      const data = await chrome.storage.local.get(STORE_KEY);
      const group = data[STORE_KEY] && data[STORE_KEY][pageKey()];
      if (!group) return;
      const failed = group.items.filter((h) => !applyHighlight(h));
      if (failed.length) setTimeout(() => failed.forEach(applyHighlight), 2500); // late-rendering pages
    } catch (_) {}
  }

  // Keep the DOM in sync with storage (deletes from popup, saves from other tabs).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORE_KEY]) return;
    if (!IS_TOP && !topInfo) return; // iframe hasn't learned its page key yet
    const all = changes[STORE_KEY].newValue || {};
    const items = (all[pageKey()] && all[pageKey()].items) || [];
    const ids = new Set(items.map((i) => i.id));
    const seen = new Set();
    document.querySelectorAll(`mark.${MARK_CLASS}[data-echoread-id]`).forEach((m) => {
      const id = m.dataset.echoreadId;
      if (!ids.has(id)) unwrapMark(m); else seen.add(id);
    });
    items.forEach((h) => { if (!seen.has(h.id)) applyHighlight(h); });
  });

  async function saveRange(range, color) {
    const raw = range.toString();
    const text = raw.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return;
    const ctx = (() => {
      try {
        const before = document.createRange();
        before.selectNodeContents(document.body);
        before.setEnd(range.startContainer, range.startOffset);
        const after = document.createRange();
        after.selectNodeContents(document.body);
        after.setStart(range.endContainer, range.endOffset);
        return {
          prefix: before.toString().replace(/\s+/g, ' ').slice(-40),
          suffix: after.toString().replace(/\s+/g, ' ').slice(0, 40),
        };
      } catch (_) { return { prefix: '', suffix: '' }; }
    })();
    const id = genId();
    if (!wrapRange(range, id, color)) { showToast("Couldn't highlight that selection."); return; }
    const sel = getSelection();
    if (sel) sel.removeAllRanges();
    hidePill();
    // A highlight made inside an iframe belongs to the top-level page – resolve it
    // before writing, otherwise it lands under the frame's URL and never shows up
    // under "This page" in the popup.
    if (!IS_TOP) await ensureTopInfo(2, 700);
    const res = await sendToBG({
      type: 'SAVE_HIGHLIGHT',
      highlight: {
        id, url: pageKey(), pageTitle: pageTitle(),
        text, timestamp: new Date().toISOString(), color,
        prefix: ctx.prefix, suffix: ctx.suffix,
      },
    });
    if (res && res.ok) { showToast('Saved to EchoRead'); return; }
    findMarks(id).forEach(unwrapMark); // storage refused it – don't leave a phantom mark
    showToast(res && res.error ? `Couldn't save: ${res.error}` : "Couldn't save that highlight.");
  }

  async function handleContextSave(msg) {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && sel.toString().trim()) {
      return saveRange(sel.getRangeAt(0), msg.color || DEFAULT_COLOR);
    }
    const range = msg.text ? findTextRange(msg.text) : null; // selection already cleared / inside iframe
    if (range) return saveRange(range, msg.color || DEFAULT_COLOR);
    showToast("Couldn't locate that selection on the page.");
  }

  /* =====================================================================
   * FLOATING PILL + TOAST (closed shadow DOM → immune to page CSS)
   * ===================================================================== */
  const UI_CSS = `
    :host{all:initial}
    [hidden]{display:none!important}
    .pill{position:fixed;display:flex;align-items:center;gap:6px;padding:5px 6px;background:#1f2937;color:#f9fafb;
      border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.3);font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      animation:pop .12s ease-out;user-select:none}
    button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-block}
    .save{padding:7px 12px;border-radius:999px;background:#6366f1;color:#fff}
    .save:hover{background:#4f46e5}
    .sep{width:1px;height:16px;background:rgba(255,255,255,.25)}
    .dot{width:18px;height:18px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
    .dot:hover{transform:scale(1.15)}
    button:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 16px;
      border-radius:10px;font:500 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}
    @keyframes pop{from{opacity:0;transform:translateY(4px) scale(.96)}to{opacity:1;transform:none}}
    @media (prefers-reduced-motion:reduce){.pill{animation:none}}`;

  let ui = null, pendingRange = null, toastTimer = null;

  function getUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${UI_CSS}</style>
      <div class="pill" role="toolbar" aria-label="EchoRead highlight tools" hidden>
        <button type="button" class="save">✎ Highlight / Save</button>
        <span class="sep" aria-hidden="true"></span>
        ${SWATCHES.map(([n, c]) => `<button type="button" class="dot" data-color="${c}" style="background:${c}" aria-label="Highlight in ${n}" title="${n}"></button>`).join('')}
      </div>
      <div class="toast" role="status" aria-live="polite" hidden></div>`;
    const pill = root.querySelector('.pill');
    pill.addEventListener('mousedown', (e) => e.preventDefault()); // keep the page selection alive
    pill.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && pendingRange) {
        saveRange(pendingRange, btn.dataset.color || DEFAULT_COLOR)
          .catch(() => showToast("Couldn't highlight that selection."));
      }
    });
    document.documentElement.appendChild(host);
    ui = { host, pill, toast: root.querySelector('.toast') };
    return ui;
  }

  function showToast(msg) {
    const { toast } = getUI();
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
  }

  function showPill(range) {
    const { pill } = getUI();
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    pill.hidden = false;
    const w = pill.offsetWidth, h = pill.offsetHeight;
    let top = r.bottom + 10;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 10);
    const left = Math.min(Math.max(8, r.right - w / 2), innerWidth - w - 8);
    pill.style.top = `${top}px`;
    pill.style.left = `${left}px`;
  }

  function hidePill() {
    if (ui) ui.pill.hidden = true;
    pendingRange = null;
  }

  const isEditable = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest('input,textarea,[contenteditable=""],[contenteditable="true"]'));
  };

  function evaluateSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hidePill();
    const len = sel.toString().trim().length;
    if (len < 2 || len > MAX_SELECTION) return hidePill();
    const range = sel.getRangeAt(0);
    if (isEditable(range.commonAncestorContainer)) return hidePill();
    pendingRange = range.cloneRange();
    showPill(pendingRange);
  }

  const fromUI = (e) => ui && e.composedPath().includes(ui.host);
  document.addEventListener('mouseup', (e) => { if (!fromUI(e)) setTimeout(evaluateSelection, 10); }, true);
  document.addEventListener('mousedown', (e) => { if (!fromUI(e)) hidePill(); }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') hidePill();
    else if (e.shiftKey || e.key === 'Shift') evaluateSelection();
  }, true);
  document.addEventListener('scroll', () => { if (pendingRange) hidePill(); }, { capture: true, passive: true });

  /* =====================================================================
   * MESSAGES (popup → background relay → here, and background → here)
   * ===================================================================== */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'PING': sendResponse({ ok: true }); break;
      case 'GET_URL': if (IS_TOP) sendResponse({ ok: true, url: localKey(), title: document.title || location.hostname }); break;
      case 'BG_TTS_EVENT':
        if (msg.gen === tts.gen) {
          if (msg.event === 'end') onChunkEnd(msg.gen);
          else if (msg.event === 'error') failSpeech(msg.gen, msg.error);
        }
        break;
      case 'TTS_PLAY': startReading(msg.settings); sendResponse({ ok: true, state: ttsState() }); break;
      case 'TTS_PAUSE': pauseReading(); sendResponse({ ok: true, state: ttsState() }); break;
      case 'TTS_RESUME': resumeReading(); sendResponse({ ok: true, state: ttsState() }); break;
      case 'TTS_STOP': stopReading(); sendResponse({ ok: true, state: ttsState() }); break;
      case 'TTS_SETTINGS': updateSettingsLive(msg.settings); sendResponse({ ok: true, state: ttsState() }); break;
      case 'TTS_GET_STATE': sendResponse({ ok: true, state: ttsState() }); break;
      case 'BG_TTS_STOPPED':
        if (msg.gen === tts.gen) stopReading(); // another tab took over the voice
        break;
      case 'SAVE_SELECTION':
        handleContextSave(msg).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
        return true; // async: the save only reports success once storage confirms it
      default: break;
    }
    return false;
  });

  restoreHighlights();
})();
