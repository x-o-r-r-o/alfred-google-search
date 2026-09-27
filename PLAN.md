# Google Search — Plan

**Bundle ID:** `io.github.x-o-r-r-o.google-search` · **Category:** Internet · **Keyword:** `goo` · **Also:** Hotkey, Universal Action “Google Search”, Fallback Search

## Why build it
- Raycast: [Google Search](https://www.raycast.com/mblode/google-search) by mblode (autosuggestions, local search history, “search selected text” with an optional clipboard fallback) is one of the most installed web search extensions.
- Alfred today: the Gallery’s [Google Suggest](https://github.com/alfredapp/google-suggest-workflow) shows suggestions (keyword `g`, ↩ and ⇥ only). No history, no modifiers, no region/language, no selected text, and its issue about “I’m Feeling Lucky” was closed as not possible.

## What makes it better
| | Raycast Google Search | Alfred Google Suggest | This workflow |
|---|---|---|---|
| Typed query always first, even while suggestions load | ✓ | ✓ | ✓ (answers at once, asks Google 0.15 s after the last key) |
| Suggestions in any language | ✗ decodes every reply as ISO-8859-1, `hl=en-us` hard coded | UTF-8 only, no `hl`/`gl` | UTF-8 requested, declared charset honoured (Shift_JIS, EUC-KR…), Mac’s language/region or configured |
| Website suggestions open directly | ✓ | ✗ (searched as text) | ✓ plus typed addresses (`github.com/foo`) |
| Calculator answers | ✗ (dropped) | shown as a search for “= 8” | result row: ↩ copy, ⌘↩ paste |
| History | unlimited, never re-ordered | ✗ | limit or off, moves to top, counts, merged while typing, remove one (⌘⌥↩) or all (`:clear`) |
| Images / Web without AI Overview / News / time range / Lucky | ✗ | ✗ | ⌥ ⇧ fn ⌃ modifiers, `!i !n !v !s !w !ai !week…` shortcuts |
| Browser, private window, SafeSearch, Google domain | ✗ | ✗ | ✓ (private searches are never remembered) |
| Selected text + clipboard fallback | ✓ | ✗ | ✓ (skips password-manager clipboard entries), or show it in Alfred |
| Offline / rate limiting | toast | silent failure | cached suggestions, back-off, clear rows; search still works |

## Features (v1.0)
- [x] `goo` Script Filter: typed query first; history matches; Google’s suggestions (QUERY, NAVIGATION, CALCULATOR); ⇥ autocompletes (with the typed `!` shortcuts)
- [x] Debounce the google-suggest way: a new keystroke answers at once (typed query + previous suggestions that still fit) with `rerun` 0.15 s; the rerun with the same query fetches. `queuemode` 2
- [x] Suggestion cache (1 h fresh, 1 day for offline use, ≤ 2000 files, pruned hourly); cross-process request limit (15 per 10 s); back-off after 429/403/503 (5 min) and when offline (20 s); queries over 100 characters aren’t sent (the endpoint answers 400)
- [x] Modifiers: ⌘ copy URL, ⌥ Images, ⌃ I’m Feeling Lucky, ⇧ Web (`udm=14`), fn time range, ⌘⇧ private window, ⌘⌥ remove from history; ⌘Y Quick Look; ⌘C copies the query
- [x] Shortcuts: `!i/!img/!images`, `!n/!news`, `!v/!vid/!videos`, `!s/!shop/!shopping`, `!w/!web`, `!ai`, `!all`, `!h/!hour`, `!d/!day`, `!week`, `!m/!month`, `!y/!year`
- [x] History in `$alfred_workflow_data/history.json`: the 50 most recent for an empty query, up to 4 matches while typing; limit 50–1000 or off, dedupe (case/accent-insensitive), counts, links remembered with their title; `:clear` with confirmation
- [x] Hotkey (selection) and Universal Action: search at once or show in Alfred; clipboard fallback (configurable, ignores `org.nspasteboard.ConcealedType`/`TransientType`)
- [x] Fallback Search trigger
- [x] Configuration: keyword, suggestions on/off, default search type (All, Web, Images, News, Videos, Shopping, AI Mode), fn time range, history size, browser, private by default, SafeSearch, language, region, Google domain, selected-text mode, clipboard fallback, extra URL parameters

## Tech
- **Stack:** JXA (`osascript -l JavaScript`) with the ObjC bridge; `/usr/bin/curl` (argv only) for the suggest endpoint; `/usr/bin/open` to launch the browser.
- **Network:** only `https://suggestqueries.google.com/complete/search?client=chrome&ie=utf-8&oe=utf-8&hl=..&gl=..&q=..`, only while typing, and never when suggestions are turned off. No cookies are stored.
- **Encoding:** the reply is decoded in the charset it declares (Shift_JIS is read as Windows-31J so `'` escapes survive), then UTF-8, then Latin-1.
- **Files:** every write is atomic (Alfred ends the previous run on each keystroke); curl’s output goes through a pipe, so a killed run leaves nothing behind.
- **Row size:** a history row with its 7 modifiers is about 2 KB, so the empty query lists at most 50 (≈ 100 KB); modifier variables carry no copy of the URL (it is the `arg`), and Quick Look uses the `arg`.
- **Routing:** rows carry `gs_*` variables; a Conditional sends `copy` / `paste` to Copy to Clipboard objects and everything else to `google.js act`.
- `tools/build.py` is the DevToolbox copy plus the `conditional` builder (from alfred-icon-finder) and a `fallback` builder (config as in alfredapp/google-suggest-workflow).

## Known limitations
- **I’m Feeling Lucky:** Google sends `btnI` searches that don’t come from its home page through a “Redirect Notice” page for many users (alfredapp/google-suggest-workflow#1). The row says what ⌃↩ does; the notice is Google’s.
- **Private windows** can’t be requested from Safari, Arc or Orion (no command-line option); the workflow says so instead of opening a normal window.
- Suggestions follow the Mac’s first preferred language and region unless configured; Google’s search page keeps your account or browser language unless a Language is set.
- The chrome client’s suggestions are what Chrome’s address bar gets; rich entity descriptions (Google’s own search box, `gws-wiz`) aren’t used because that format is undocumented and changes often.
- A query is passed to the Script Filter as an argument (as Alfred does for every Script Filter), so it’s briefly visible to `ps` for the current user.

## Verify in real Alfred
- [ ] Typing fast then ↩ always searches exactly what’s typed (the typed row is first before and after the rerun).
- [ ] ⇥ on a suggestion completes it and shows fresh suggestions; the selection moves back to the top row.
- [ ] While suggestions load, the selected row stays put across the 0.15 s rerun (uids are `kind|text`).
- [ ] Every modifier subtitle shows, and each goes through the Conditional: ⌘↩ copies the URL, ⌘↩ on a calculation pastes, ⌘⌥↩ removes a history row and Alfred reopens with the same query.
- [ ] `:clear` from the “Clear Search History…” row (↩ on an invalid row with `autocomplete`), then confirm; the notification says how many were cleared.
- [ ] Hotkey with text selected in Safari, Notes and a terminal; with nothing selected (clipboard fallback on and off); a password copied from 1Password isn’t searched.
- [ ] Universal Action “Google Search” on selected text; “Show it in Alfred” mode opens `goo <text>`.
- [ ] Fallback Search added in Features → Default Results shows suggestions.
- [ ] Private windows: Chrome, Brave, Edge and Firefox with the browser already running and not running (`open -n -b … --args --incognito URL`); Firefox doesn’t show a “profile in use” error.
- [ ] Browser setting: Safari, Chrome, Firefox, Arc; “Default browser” follows the system default.
- [ ] Workflow Configuration: keyword, search type, time range, history size and off, SafeSearch, language/region (e.g. `ja` / `jp`), Google domain (`www.google.de`), extra parameters.
- [ ] Screenshots for every `images/*.png` referenced in the README.

## Release checklist (Alfred forum + Gallery)
- [x] README starts with `## Usage`; paragraphs end “via the `goo` keyword” / “via the Universal Action” / “configure the Hotkey”
- [ ] A clean screenshot after each paragraph in `images/` (placeholders are in place)
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`
- [x] No `## Setup` section (the Fallback Search is optional and mentioned in Usage)
- [x] Keyword ≥ 3 characters and configurable via `{var:keyword_google}` (`google` is taken by Alfred’s default web search)
- [x] Settings in Workflow Configuration; the About readme is generated from README.md
- [x] Main icon ≥ 256×256 px (SF Symbol, no Google logo)
- [x] No self-updater; never downloads or installs software; only Google’s suggest endpoint is contacted
- [x] No compiled binaries; quarantine untouched
- [x] No hard-coded paths; `prefs.plist` is git-ignored; no secrets
- [x] AI assistance disclosed in the README
- [x] Version 1.0.0; `python3 tools/build.py --package` builds `dist/alfred-google-search-1.0.0.alfredworkflow`
- [ ] GitHub release with the `.alfredworkflow` attached (by the author)
- [ ] Forum post in “Share your Workflows” (by the author)

## Ideas for v1.1
1. Per-shortcut keywords (e.g. `gimg`) for people who prefer keywords to `!i`.
2. Search other Google properties from a row: Maps, Scholar (it has its own suggest endpoint), YouTube.
3. Show the history entry’s search type (⌥ Images, fn week…) and repeat it, instead of only the typed shortcuts.
4. Rich entity rows (“Eiffel Tower · Historical landmark”) if Google’s `gws-wiz` format proves stable.
