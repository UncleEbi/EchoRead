/* EchoRead – popup logic
 * Talks to content scripts via the background worker (RELAY_TO_TAB) and listens
 * for TTS_STATE broadcasts. Reads highlights straight from chrome.storage.local;
 * deletes go through the background worker (single writer).
 */
'use strict';

const STORE_KEY = 'echoread_highlights';
const SETTINGS_KEY = 'echoread_settings';
const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  supported: false,
  tts: { status: 'idle', index: 0, total: 0, preview: '', finished: false, error: null },
  scope: 'page',
  groups: {},
  settings: { rate: 1, pitch: 1, voiceURI: '' },
};

const pageKey = (url) => (url || '').split('#')[0];

/* ---------------- helpers ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  children.flat().forEach((c) => c && node.append(c));
  return node;
}
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

async function relay(type, extra = {}) {
  if (!state.tab || state.tab.id == null) return { ok: false, error: 'No active tab.' };
  try {
    return await chrome.runtime.sendMessage({ type: 'RELAY_TO_TAB', tabId: state.tab.id, message: { type, ...extra } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------- tabs ---------------- */
const tabs = [$('tab-reader'), $('tab-highlights')];
function selectTab(tab, focus = false) {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
  if (focus) tab.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      selectTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length], true);
    }
  });
});

/* ---------------- reader UI ---------------- */
function renderTTS() {
  const s = state.tts;
  const idle = s.status === 'idle';
  $('btnPlay').disabled = !state.supported || !idle;
  $('btnPause').disabled = s.status !== 'playing';
  $('btnResume').disabled = s.status !== 'paused';
  $('btnStop').disabled = idle;

  const status = $('status');
  status.classList.toggle('error', !!s.error);
  const pct = s.total ? Math.round((s.index / s.total) * 100) : 0;
  if (s.error) status.textContent = s.error;
  else if (s.status === 'playing') status.textContent = `Reading… ${pct}% (sentence ${Math.min(s.index + 1, s.total)} of ${s.total})`;
  else if (s.status === 'paused') status.textContent = `Paused at ${pct}%`;
  else if (s.finished) status.textContent = 'Finished reading ✓';
  else status.textContent = 'Ready. Press Play to read this page aloud.';

  $('progress').value = idle ? (s.finished ? 100 : 0) : pct;
  $('preview').textContent = idle ? '' : s.preview;
}

function applyRelayResult(res) {
  if (!res || !res.ok) {
    state.tts = { status: 'idle', index: 0, total: 0, preview: '', finished: false, error: "Couldn't reach this page. Try reloading the tab." };
  } else if (res.response && res.response.state) {
    state.tts = res.response.state;
  }
  renderTTS();
}

async function saveSettings() {
  try { await chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }); } catch (_) {}
}
let liveTimer;
function settingsChanged() {
  saveSettings();
  if (state.tts.status === 'idle') return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => applyRelayResult(await relay('TTS_SETTINGS', { settings: state.settings })), 250);
}

$('btnPlay').addEventListener('click', async () => applyRelayResult(await relay('TTS_PLAY', { settings: state.settings })));
$('btnPause').addEventListener('click', async () => applyRelayResult(await relay('TTS_PAUSE')));
$('btnResume').addEventListener('click', async () => applyRelayResult(await relay('TTS_RESUME')));
$('btnStop').addEventListener('click', async () => applyRelayResult(await relay('TTS_STOP')));

$('rate').addEventListener('input', (e) => {
  state.settings.rate = parseFloat(e.target.value);
  $('rateOut').textContent = `${state.settings.rate.toFixed(2)}×`;
  settingsChanged();
});
$('pitch').addEventListener('input', (e) => {
  state.settings.pitch = parseFloat(e.target.value);
  $('pitchOut').textContent = state.settings.pitch.toFixed(1);
  settingsChanged();
});
$('voice').addEventListener('change', (e) => {
  state.settings.voiceURI = e.target.value;
  settingsChanged();
});

function langName(code) {
  try { return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) || code; } catch (_) { return code; }
}
function populateVoices() {
  const voices = speechSynthesis.getVoices();
  const sel = $('voice');
  if (!voices.length) { $('voiceHint').textContent = 'Loading voices…'; return; }
  $('voiceHint').textContent = '';
  const byLang = new Map();
  voices.forEach((v) => {
    const key = (v.lang || 'und').split(/[-_]/)[0].toLowerCase();
    if (!byLang.has(key)) byLang.set(key, []);
    byLang.get(key).push(v);
  });
  const mine = (navigator.language || 'en').split('-')[0].toLowerCase();
  const keys = [...byLang.keys()].sort((a, b) => (a === mine ? -1 : b === mine ? 1 : langName(a).localeCompare(langName(b))));
  sel.replaceChildren(new Option('System default', ''));
  keys.forEach((k) => {
    const group = document.createElement('optgroup');
    group.label = langName(k);
    byLang.get(k).sort((a, b) => a.name.localeCompare(b.name)).forEach((v) => {
      group.appendChild(new Option(`${v.name} (${v.lang})${v.localService ? '' : ' · online'}`, v.voiceURI));
    });
    sel.appendChild(group);
  });
  const wanted = state.settings.voiceURI || '';
  sel.value = wanted;
  if (sel.value !== wanted) { // saved voice no longer exists on this system
    sel.value = '';
    state.settings.voiceURI = '';
  }
}

/* ---------------- highlights UI ---------------- */
const allItems = () => Object.values(state.groups).flatMap((g) => g.items || []);
const latest = (g) => Math.max(0, ...(g.items || []).map((i) => Date.parse(i.timestamp) || 0));
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return iso; } };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard');
}

function clipNode(item) {
  const text = h('p', { class: 'clip-text', text: item.text, title: 'Click to expand', tabindex: '0', role: 'button', 'aria-expanded': 'false' });
  const toggle = () => { const on = text.classList.toggle('expanded'); text.setAttribute('aria-expanded', String(on)); };
  text.addEventListener('click', toggle);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

  const li = h('li', { class: 'clip' },
    text,
    h('p', { class: 'clip-meta', text: fmtDate(item.timestamp) }),
    h('div', { class: 'clip-actions' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy highlight to clipboard', onclick: () => copyText(item.text) }, icon('i-copy'), 'Copy'),
      h('button', {
        class: 'icon-btn danger', type: 'button', 'aria-label': 'Delete highlight',
        onclick: async () => {
          const res = await chrome.runtime.sendMessage({ type: 'DELETE_HIGHLIGHT', url: item.url, id: item.id });
          toast(res && res.ok ? 'Deleted' : 'Could not delete');
        },
      }, icon('i-trash'), 'Delete'),
      h('a', { class: 'icon-btn', href: item.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Go to page: ${item.pageTitle}` }, icon('i-open'), 'Go to page'),
    ),
  );
  li.style.setProperty('--clip-color', item.color && /^#|^rgb|^hsl/.test(item.color) ? item.color : '#fde68a');
  return li;
}

function renderHighlights() {
  const current = pageKey(state.tab && state.tab.url);
  const here = state.groups[current] ? state.groups[current].items.length : 0;
  $('countBadge').textContent = String(here);

  const list = $('clipList');
  list.replaceChildren();
  let groups = Object.values(state.groups);
  if (state.scope === 'page') groups = groups.filter((g) => g.url === current);
  else groups.sort((a, b) => latest(b) - latest(a));

  groups.forEach((g) => {
    if (state.scope === 'all') {
      list.appendChild(h('li', {}, h('a', { class: 'group-title', href: g.url, target: '_blank', rel: 'noopener noreferrer', title: g.url, text: g.pageTitle || g.url })));
    }
    [...g.items].sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)).forEach((item) => list.appendChild(clipNode(item)));
  });

  const empty = $('emptyState');
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  empty.hidden = count > 0;
  if (!count) {
    empty.textContent = state.scope === 'page'
      ? 'No highlights on this page yet. Select some text and choose "Highlight / Save", or right-click → "Save Highlight to EchoRead".'
      : 'Nothing saved yet.';
  }
  const total = allItems().length;
  $('exportMd').disabled = !total;
  $('exportJson').disabled = !total;
}

function setScope(scope) {
  state.scope = scope;
  $('scopePage').setAttribute('aria-pressed', String(scope === 'page'));
  $('scopeAll').setAttribute('aria-pressed', String(scope === 'all'));
  renderHighlights();
}
$('scopePage').addEventListener('click', () => setScope('page'));
$('scopeAll').addEventListener('click', () => setScope('all'));

/* ---------------- export ---------------- */
function download(filename, mime, content) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const stamp = () => new Date().toISOString().slice(0, 10);

function toMarkdown() {
  const groups = Object.values(state.groups).sort((a, b) => latest(b) - latest(a));
  const total = allItems().length;
  const esc = (s) => String(s).replace(/([\[\]\\])/g, '\\$1');
  const out = ['# EchoRead Highlights', '', `_Exported ${new Date().toISOString()} · ${total} clip${total === 1 ? '' : 's'} from ${groups.length} page${groups.length === 1 ? '' : 's'}_`, ''];
  groups.forEach((g) => {
    out.push(`## [${esc(g.pageTitle || g.url)}](${g.url})`, '');
    [...g.items].sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0)).forEach((i) => {
      out.push(i.text.split('\n').map((l) => `> ${l}`).join('\n'), '', `<sub>Saved ${i.timestamp}</sub>`, '');
    });
  });
  return out.join('\n');
}
function toJSON() {
  const highlights = Object.values(state.groups).flatMap((g) => g.items);
  return JSON.stringify({ app: 'EchoRead', version: 1, exportedAt: new Date().toISOString(), total: highlights.length, highlights }, null, 2);
}
$('exportMd').addEventListener('click', () => { download(`echoread-highlights-${stamp()}.md`, 'text/markdown', toMarkdown()); toast('Exported Markdown'); });
$('exportJson').addEventListener('click', () => { download(`echoread-highlights-${stamp()}.json`, 'application/json', toJSON()); toast('Exported JSON'); });

/* ---------------- live updates ---------------- */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'TTS_STATE' && sender.tab && state.tab && sender.tab.id === state.tab.id) {
    state.tts = msg.state;
    renderTTS();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORE_KEY]) {
    state.groups = changes[STORE_KEY].newValue || {};
    renderHighlights();
  }
});

/* ---------------- init ---------------- */
async function init() {
  const stored = await chrome.storage.local.get([STORE_KEY, SETTINGS_KEY]);
  state.groups = stored[STORE_KEY] || {};
  Object.assign(state.settings, stored[SETTINGS_KEY] || {});
  $('rate').value = state.settings.rate;
  $('pitch').value = state.settings.pitch;
  $('rateOut').textContent = `${Number(state.settings.rate).toFixed(2)}×`;
  $('pitchOut').textContent = Number(state.settings.pitch).toFixed(1);

  populateVoices();
  speechSynthesis.addEventListener('voiceschanged', populateVoices);
  setTimeout(() => { if (!speechSynthesis.getVoices().length) $('voiceHint').textContent = 'No speech voices were found on this system.'; }, 2000);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  state.supported = !!(tab && /^(https?|file):/i.test(tab.url || ''));
  $('pageTitle').textContent = (tab && tab.title) || '';
  $('pageTitle').title = (tab && tab.url) || '';
  $('unsupported').hidden = state.supported;

  setScope('page');
  if (state.supported) applyRelayResult(await relay('TTS_GET_STATE'));
  else renderTTS();
}
init();
