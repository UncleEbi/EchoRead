# EchoRead

Read any article aloud and save highlights from any webpage. Manifest V3, vanilla JS, zero dependencies.

## Load it
1. Unzip this folder.
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin EchoRead from the puzzle-piece menu.
5. Tabs that were already open still work: the background worker injects the content script on demand.
6. Optional, for local `file://` pages: open EchoRead's Details and turn on **Allow access to file URLs**.

## Test it
- **Reader**: open a news/blog article, open the popup, press Play. Try Pause/Resume/Stop, speed, pitch, voice.
  If Chrome blocks page-level speech (no interaction with the page yet), EchoRead automatically speaks through `chrome.tts` instead.
- **Highlighter**: select text, click "Highlight / Save" (or a colour dot). Reload: the highlight is restored,
  using saved surrounding text to pick the right occurrence if the phrase appears more than once.
- **Iframes**: highlighting works inside embedded frames and is saved under the top-level page.
- **Context menu**: select text, right-click, "Save Highlight to EchoRead".
- **Saved Highlights tab**: toggle "This page" / "All saved clips"; Copy, Delete, Go to page; export .md / .json.
- **Debug**: `chrome://extensions` > EchoRead > "service worker" for background logs; right-click popup > Inspect.

## Limitations
- Cannot run on `chrome://` pages or the Chrome Web Store (a browser restriction).
- The reader extracts article text from the top page only, not from inside iframes.
- Highlights are re-found by text; if a page's wording changes, an old highlight may not re-appear (it stays in your saved list).
