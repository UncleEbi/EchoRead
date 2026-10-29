/* EchoRead – service worker
 * Responsibilities:
 *  - Context menu ("Save Highlight to EchoRead")
 *  - Single writer for chrome.storage.local (serialised queue → no lost updates)
 *  - Relay popup → content-script messages, injecting the content script on demand
 *  - chrome.tts fallback voice when Chrome blocks page-level speechSynthesis
 *  - Resolve the top-level page URL/title for highlights made inside iframes
 */
'use strict';

const STORE_KEY = 'echoread_highlights';
const MENU_ID = 'echoread-save-highlight';
const DEFAULT_COLOR = '#fde68a';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Save Highlight to EchoRead',
      contexts: ['selection'],
    });
  });
});

/* ---------- Storage (serialised) ---------- */
let writeQueue = Promise.resolve();
function enqueue(task) {
  const run = writeQueue.then(task);
  writeQueue = run.catch(() => {});
  return run;
}

async function readAll() {
  const data = await chrome.storage.local.get(STORE_KEY);
  return data[STORE_KEY] || {};
}

async function addHighlight(h) {
  if (!h || typeof h.id !== 'string' || typeof h.url !== 'string' || typeof h.text !== 'string' || !h.text.trim()) {
    throw new Error('Invalid highlight payload');
  }
  const item = {
    id: h.id,
    url: h.url,
    pageTitle: String(h.pageTitle || h.url),
    text: h.text,
    timestamp: h.timestamp || new Date().toISOString(),
    color: h.color || DEFAULT_COLOR,
    // Surrounding text, used to re-find the right occurrence when a phrase appears more than once.
    prefix: String(h.prefix || '').slice(-60),
    suffix: String(h.suffix || '').slice(0, 60),
  };
  const all = await readAll();
  const group = all[item.url] || { url: item.url, pageTitle: item.pageTitle, items: [] };
  group.pageTitle = item.pageTitle;
  if (!group.items.some((i) => i.id === item.id)) group.items.push(item);
  all[item.url] = group;
  await chrome.storage.local.set({ [STORE_KEY]: all });
}

async function deleteHighlight(url, id) {
  const all = await readAll();
  const group = all[url];
  if (!group) return;
  group.items = group.items.filter((i) => i.id !== id);
  if (group.items.length === 0) delete all[url];
  await chrome.storage.local.set({ [STORE_KEY]: all });
}

/* ---------- Tab messaging ---------- */
// frameId 0 = top frame. Content scripts run in every frame, so always address one explicitly.
async function sendToTab(tabId, message, frameId = 0) {
  const opts = { frameId };
  try {
    return await chrome.tabs.sendMessage(tabId, message, opts);
  } catch (_) {
    // Content script missing (tab was open before install / extension reload). Inject and retry.
    try {
      await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ['scripts/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['scripts/content.js'] });
    } catch (injectErr) {
      throw new Error('EchoRead cannot run on this page.');
    }
    return chrome.tabs.sendMessage(tabId, message, opts);
  }
}

function flashBadge(tabId, text) {
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626', tabId });
  chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 2500);
}

/* ---------- Context menu ---------- */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  try {
    // info.frameId targets the iframe the selection is actually in.
    await sendToTab(tab.id, { type: 'SAVE_SELECTION', text: info.selectionText || '', color: DEFAULT_COLOR }, info.frameId || 0);
  } catch (err) {
    console.warn('[EchoRead]', err);
    flashBadge(tab.id, '!');
  }
});

/* ---------- chrome.tts fallback ---------- */
function ttsSpeak(tabId, msg, useVoice) {
  const opts = {
    rate: Math.min(10, Math.max(0.1, Number(msg.rate) || 1)),
    pitch: Math.min(2, Math.max(0, Number(msg.pitch) || 1)),
    onEvent: (ev) => {
      // Selected voice unknown to chrome.tts → retry once with the system default.
      if (ev.type === 'error' && useVoice && msg.voiceName) return ttsSpeak(tabId, msg, false);
      if (['end', 'error', 'interrupted', 'cancelled'].includes(ev.type)) {
        chrome.tabs
          .sendMessage(tabId, { type: 'BG_TTS_EVENT', gen: msg.gen, event: ev.type, error: ev.errorMessage }, { frameId: 0 })
          .catch(() => {});
      }
    },
  };
  if (useVoice && msg.voiceName) opts.voiceName = msg.voiceName;
  if (msg.lang) opts.lang = msg.lang;
  chrome.tts.speak(String(msg.text || '').slice(0, 3000), opts);
}

/* ---------- Runtime messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg && msg.type) {
    case 'SAVE_HIGHLIGHT':
      enqueue(() => addHighlight(msg.highlight))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case 'DELETE_HIGHLIGHT':
      enqueue(() => deleteHighlight(msg.url, msg.id))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case 'RELAY_TO_TAB':
      sendToTab(msg.tabId, msg.message, msg.frameId || 0)
        .then((response) => sendResponse({ ok: true, response }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case 'GET_TOP_URL': {
      // An iframe asks "what page am I on?" – answered by the top frame's content script.
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      chrome.tabs.sendMessage(tabId, { type: 'GET_URL' }, { frameId: 0 })
        .then((r) => sendResponse(r || { ok: false }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    case 'BG_SPEAK': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) ttsSpeak(tabId, msg, true);
      return false;
    }

    case 'BG_TTS_CONTROL':
      if (msg.action === 'pause') chrome.tts.pause();
      else if (msg.action === 'resume') chrome.tts.resume();
      else if (msg.action === 'stop') chrome.tts.stop();
      return false;

    default:
      return false; // not ours (e.g. TTS_STATE broadcasts meant for the popup)
  }
});
