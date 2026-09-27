#!/usr/bin/osascript -l JavaScript
// Google Search for Alfred: live suggestions, local search history, selected text. No dependencies.
// Usage: osascript -l JavaScript google.js <command> [arg]
//   search <query>      Script Filter (Alfred JSON on stdout)
//   act <url>           Run Script: open a search or link, forget a history entry, clear the history
//   selection <text>    Hotkey and Universal Action: search the selected text (or the clipboard)
// The only network request is to Google's suggest endpoint, and only while typing a query.
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("CoreFoundation");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
const FM = $.NSFileManager.defaultManager;
const PID = $.NSProcessInfo.processInfo.processIdentifier;
// Display strings: no control characters or bidi overrides (they can reorder what Alfred shows)
const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩‎‏؜]/g, " ").replace(/\s+/g, " ").trim();
const trimSlash = (s) => s.replace(/\/+$/, "");

// ---------- configuration ----------

// Test mode never reaches Google: the suggest URL the tests don't override points at a closed local port
const TESTING = env("GS_TEST", "") === "1";
const SUGGEST = env("GS_SUGGEST_URL", TESTING ? "http://127.0.0.1:9/complete/search" : "https://suggestqueries.google.com/complete/search");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DEFAULT_KEYWORD = "goo";
const MAX_SUGGEST_CHARS = 100; // longer queries make the suggest endpoint answer HTTP 400
const MAX_QUERY_CHARS = 2000; // Google ignores anything much longer (and URLs have limits)
const TTL = 3600; // fresh suggestions
const STALE = 86400; // kept for offline use, then pruned
const MAX_CACHE_FILES = 2000;
const HISTORY_MATCHES = 4; // history rows shown above the suggestions while typing
const HISTORY_SHOWN = 50; // rows shown for an empty query (typing finds older ones)
const DEBOUNCE = 0.15; // seconds between showing the typed query and asking Google (Alfred's rerun)
const MAX_RETRIES = 5;

// Search types: URL parameters, labels and icons. Map (not {}): keys can come from the query.
const TYPES = new Map([
  ["all", { label: "Google", params: [], icon: "search" }],
  ["web", { label: "Google Web", params: [["udm", "14"]], icon: "web", note: "no AI Overview" }],
  ["images", { label: "Google Images", params: [["udm", "2"]], icon: "images" }],
  ["news", { label: "Google News", params: [["tbm", "nws"]], icon: "news" }],
  ["videos", { label: "Google Videos", params: [["udm", "7"]], icon: "videos" }],
  ["shopping", { label: "Google Shopping", params: [["udm", "28"]], icon: "shopping" }],
  ["ai", { label: "Google AI Mode", params: [["udm", "50"]], icon: "ai" }],
]);
const TIMES = new Map([["h", "past hour"], ["d", "past 24 hours"], ["w", "past week"], ["m", "past month"], ["y", "past year"]]);
// Shortcuts typed anywhere in the query, as separate words
const BANGS = new Map([
  ["!i", ["type", "images"]], ["!img", ["type", "images"]], ["!images", ["type", "images"]],
  ["!n", ["type", "news"]], ["!news", ["type", "news"]],
  ["!v", ["type", "videos"]], ["!vid", ["type", "videos"]], ["!videos", ["type", "videos"]],
  ["!s", ["type", "shopping"]], ["!shop", ["type", "shopping"]], ["!shopping", ["type", "shopping"]],
  ["!w", ["type", "web"]], ["!web", ["type", "web"]],
  ["!ai", ["type", "ai"]],
  ["!all", ["type", "all"]],
  ["!h", ["time", "h"]], ["!hour", ["time", "h"]],
  ["!d", ["time", "d"]], ["!day", ["time", "d"]],
  ["!week", ["time", "w"]],
  ["!m", ["time", "m"]], ["!month", ["time", "m"]],
  ["!y", ["time", "y"]], ["!year", ["time", "y"]],
]);

// Browsers: name, and the argument that opens a private window (none: Safari, Arc and Orion can't be asked to)
const BROWSERS = [
  ["com.google.Chrome", "Google Chrome", "--incognito"],
  ["com.brave.Browser", "Brave", "--incognito"],
  ["com.microsoft.edgemac", "Microsoft Edge", "--inprivate"],
  ["com.vivaldi.Vivaldi", "Vivaldi", "--incognito"],
  ["org.chromium.Chromium", "Chromium", "--incognito"],
  ["com.operasoftware.Opera", "Opera", "--private"],
  ["org.mozilla.firefox", "Firefox", "--private-window"],
  ["org.mozilla.nightly", "Firefox Nightly", "--private-window"],
  ["app.zen-browser.zen", "Zen", "--private-window"],
  ["io.gitlab.librewolf-community", "LibreWolf", "--private-window"],
  ["net.waterfox.waterfox", "Waterfox", "--private-window"],
  ["com.apple.Safari", "Safari", ""],
  ["com.apple.SafariTechnologyPreview", "Safari Technology Preview", ""],
  ["company.thebrowser.Browser", "Arc", ""],
  ["com.kagi.kagimacOS", "Orion", ""],
];
function browserInfo(bundle) {
  // Channels share the prefix: com.google.Chrome.canary, com.brave.Browser.beta, com.microsoft.edgemac.Dev…
  const b = BROWSERS.find(([id]) => bundle === id || bundle.startsWith(id + "."));
  return b ? { name: b[1], flag: b[2] } : { name: bundle, flag: "" };
}

const choice = (v, allowed, d) => (allowed.includes(v) ? v : d);
function cfg() {
  const num = (v, d) => (/^\d+$/.test(String(v).trim()) ? parseInt(v, 10) : d);
  const domain = env("google_domain", "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const lang = env("language", "").trim();
  const region = env("region", "").trim();
  return {
    keyword: env("keyword_google", "").trim() || DEFAULT_KEYWORD,
    suggestions: env("suggestions", "1").trim() !== "0",
    type: choice(env("search_type", "all").trim(), [...TYPES.keys()], "all"),
    time: choice(env("time_range", "w").trim(), [...TIMES.keys()], "w"),
    // hl: "en", "pt-BR", "zh-TW"…; gl: a two-letter country code
    lang: /^[a-z]{2,3}([-_][a-z0-9]{2,4})?$/i.test(lang) ? lang.replace("_", "-") : "",
    region: /^[a-z]{2}$/i.test(region) ? region.toLowerCase() : "",
    domain: /^([a-z0-9-]+\.)*google(\.[a-z]{2,3}){1,2}$/.test(domain) ? domain : "www.google.com",
    safe: choice(env("safesearch", "").trim(), ["", "active", "off"], ""),
    browser: /^[A-Za-z0-9.-]+$/.test(env("browser", "").trim()) ? env("browser", "").trim() : "",
    privateDefault: env("private_window", "0").trim() === "1",
    historyLimit: Math.min(num(env("history_limit", "100"), 100), 5000),
    selectionMode: choice(env("selection_mode", "search").trim(), ["search", "alfred"], "search"),
    clipboardFallback: env("clipboard_fallback", "1").trim() !== "0",
    extra: extraParams(env("extra_params", "")),
  };
}

// "pws=0&lr=lang_en": only simple key=value pairs, never q (the query) or btnI
function extraParams(s) {
  const out = [];
  for (const part of String(s).trim().replace(/^[?&]+/, "").split("&")) {
    const m = /^([A-Za-z][A-Za-z0-9_.-]{0,30})=([A-Za-z0-9_.:%+,|-]{0,100})$/.exec(part.trim());
    if (m && !["q", "btnI", "udm", "tbm"].includes(m[1])) out.push([m[1], m[2]]);
  }
  return out;
}

// Language and country for suggestions: the configured ones, else the Mac's (Google defaults to US English)
function suggestLocale(c) {
  let hl = c.lang, gl = c.region;
  if (!hl) {
    const langs = $.NSLocale.preferredLanguages;
    const first = langs.count ? langs.objectAtIndex(0).js : "en";
    const m = /^([a-z]{2,3})(?:-(Hans|Hant))?(?:-([A-Z]{2}|\d{3}))?/.exec(first) || [];
    const base = m[1] || "en";
    // Google's Chinese codes are zh-CN / zh-TW
    hl = base === "zh" ? (m[2] === "Hant" || /^(TW|HK|MO)$/.test(m[3] || "") ? "zh-TW" : "zh-CN") : base;
  }
  if (!gl) {
    const cc = $.NSLocale.currentLocale.objectForKey($.NSLocaleCountryCode);
    gl = !cc.isNil() && /^[A-Z]{2}$/.test(cc.js) ? cc.js.toLowerCase() : "";
  }
  return { hl, gl };
}

// ---------- files ----------

function safeDir(dir) {
  dir = trimSlash(dir || "");
  // pruning deletes files under these folders: never accept "", "/" or a relative path
  return /^\/[^/]/.test(dir) && !/(^|\/)\.\.?(\/|$)/.test(dir) ? dir : "";
}
function cacheDir() {
  const dir = safeDir(env("alfred_workflow_cache", "")) || `${trimSlash($.NSTemporaryDirectory().js)}/alfred-google-search`;
  mkdirp(dir);
  return dir;
}
// The search history lives in the workflow's data folder (kept when the cache is cleared)
function dataDir() {
  const dir = safeDir(env("alfred_workflow_data", "")) || cacheDir();
  mkdirp(dir);
  return dir;
}
function mkdirp(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
}
function exists(p) {
  return FM.fileExistsAtPath(p);
}
function readText(p) {
  if (!exists(p)) return null;
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}
// Atomic (temporary file + rename): Alfred ends a Script Filter at any moment when the next key is typed
function writeText(p, text) {
  mkdirp(p.replace(/\/[^/]*$/, ""));
  return $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, $());
}
function readJSON(p) {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}
function remove(p) {
  FM.removeItemAtPathError(p, $());
}
// Seconds since the file was modified, or null when it doesn't exist
function fileAge(p) {
  const a = FM.attributesOfItemAtPathError(p, $());
  return a.isNil() ? null : -a.fileModificationDate.timeIntervalSinceNow;
}
function touch(p) {
  if (!exists(p)) writeText(p, "");
  else FM.setAttributesOfItemAtPathError($({ NSFileModificationDate: $.NSDate.date }), p, $());
}
function listDir(dir) {
  const arr = FM.contentsOfDirectoryAtPathError(dir, $());
  if (arr.isNil()) return [];
  const out = [];
  for (let i = 0; i < arr.count; i++) out.push(arr.objectAtIndex(i).js);
  return out;
}

// FNV-1a, 2 × 32 bit: a short, stable key for cache file names
function hash(s) {
  const one = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return one(2166136261) + one(84696351);
}

// ---------- processes ----------

// Run a command with argv (never through a shell string). Returns { status, out (NSData), err (string) }
function exec(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardOutput = outP;
  task.standardError = errP;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError($())) return { status: -1, out: $.NSData.data, err: "launch failed" };
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const e = $.NSString.alloc.initWithDataEncoding(err, $.NSUTF8StringEncoding);
  return { status: task.terminationStatus, out, err: e.isNil() ? "" : e.js };
}

// Decode a response in the charset it declares: Google answers in ISO-8859-1, Shift_JIS, EUC-KR… for some
// languages unless oe=utf-8 is honoured, so the declared charset wins and UTF-8 / Latin-1 are fallbacks.
function decode(data, contentType) {
  const m = /charset=["']?([A-Za-z0-9._:-]+)/i.exec(contentType || "");
  const encodings = [];
  if (m) {
    // Apple's Shift_JIS turns byte 0x5C into "¥", which breaks JSON escapes ("\u0027"): Windows-31J keeps "\"
    const name = /^(shift[_-]?jis|x-sjis|sjis|ms_kanji|csshiftjis)$/i.test(m[1]) ? "windows-31j" : m[1];
    const cf = $.CFStringConvertIANACharSetNameToEncoding($(name));
    if (cf !== 0xffffffff) encodings.push($.CFStringConvertEncodingToNSStringEncoding(cf));
  }
  encodings.push($.NSUTF8StringEncoding, $.NSISOLatin1StringEncoding);
  for (const enc of encodings) {
    const s = $.NSString.alloc.initWithDataEncoding(data, enc);
    if (!s.isNil()) return s.js;
  }
  return null;
}

// GET with curl. The body comes through a pipe (nothing is left behind when Alfred ends this process);
// status and content type are written to stderr after the body. Returns { status, text }; status 0 = unreachable.
function httpGet(url, timeout) {
  const r = exec("/usr/bin/curl", ["-sS", "--proto", "=https,http", "--max-redirs", "0", "--compressed",
    "--connect-timeout", "3", "--max-time", String(timeout), "--max-filesize", "1000000", "-A", UA,
    "-H", "Accept: application/json, text/javascript", "-w", "%{stderr}\n@@%{http_code}|%{content_type}", "--", url]);
  const m = /@@(\d{3})\|(.*)\s*$/.exec(r.err);
  const status = m ? parseInt(m[1], 10) : 0;
  return { status, text: status ? decode(r.out, m[2]) : null };
}

// ---------- suggestions ----------

// The chrome client answers [query, [texts], [descriptions], [], {"google:suggesttype": [...]}]:
// QUERY rows, NAVIGATION rows (the text is a URL, the description its page title) and CALCULATOR rows ("= 8").
// Stored as [{k:"q", t}, {k:"n", t: title, u: url}, {k:"c", t: result}]
function parseSuggestions(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(d) || !Array.isArray(d[1])) return null;
  const descs = Array.isArray(d[2]) ? d[2] : [];
  const meta = d[4] && typeof d[4] === "object" && !Array.isArray(d[4]) ? d[4] : {};
  const types = Array.isArray(meta["google:suggesttype"]) ? meta["google:suggesttype"] : [];
  const out = [];
  d[1].forEach((t, i) => {
    if (typeof t !== "string") return;
    const type = typeof types[i] === "string" ? types[i] : "QUERY";
    const desc = typeof descs[i] === "string" ? clean(descs[i]).slice(0, 300) : "";
    const s = clean(t).slice(0, 500);
    if (!s) return;
    if (type === "NAVIGATION") {
      if (isWebUrl(t.trim())) out.push({ k: "n", t: desc || s, u: t.trim() });
    } else if (type === "CALCULATOR") {
      const v = s.replace(/^=\s*/, "");
      if (v) out.push({ k: "c", t: v });
    } else out.push({ k: "q", t: s });
  });
  return out;
}
function validSuggestions(d) {
  return Array.isArray(d) && d.every((s) => s && typeof s.t === "string" && (s.k === "q" || s.k === "c" || (s.k === "n" && isWebUrl(s.u))));
}
function isWebUrl(u) {
  return typeof u === "string" && u.length < 2048 && /^https?:\/\/[^\s"<>\\^`{|}]+$/i.test(u);
}

function suggestUrl(query, loc) {
  const p = [["client", "chrome"], ["ie", "utf-8"], ["oe", "utf-8"], ["hl", loc.hl]];
  if (loc.gl) p.push(["gl", loc.gl]);
  p.push(["q", query]);
  return `${SUGGEST}?${p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
function cachePath(query, loc) {
  return `${cacheDir()}/suggest/${hash(`${loc.hl}|${loc.gl}|${query}`)}.json`;
}
function readCached(path) {
  const d = readJSON(path);
  return d && d.v === 1 && validSuggestions(d.s) ? d.s : null;
}

// Back off after HTTP 429 or Google's "unusual traffic" page (403/503): 5 minutes; after a network failure: 20 s.
// Returns 0 (go ahead), 429 or -1 (offline)
function backoff() {
  const d = cacheDir();
  const limited = fileAge(`${d}/ratelimited`);
  if (limited !== null && limited < 300) return 429;
  const offline = fileAge(`${d}/offline`);
  if (offline !== null && offline < 20) return -1;
  return 0;
}
// At most 15 requests per 10 seconds across processes (every keystroke is a process of its own).
// Counted with one empty file per request; typing is debounced first, so this only catches bursts.
function allowRequest() {
  if (env("GS_UNTHROTTLED", "") === "1") return true;
  const dir = `${cacheDir()}/requests`;
  mkdirp(dir);
  const now = Date.now();
  let recent = 0;
  for (const f of listDir(dir)) {
    const t = parseInt(f, 10);
    if (!(t > now - 10000) || t > now + 60000) remove(`${dir}/${f}`);
    else recent++;
  }
  if (recent >= 15) return false;
  writeText(`${dir}/${now}-${PID}`, "");
  return true;
}

// Suggestions for a query: { list } or { list (stale or null), error, retry }
function fetchSuggestions(query, loc) {
  const path = cachePath(query, loc);
  const age = fileAge(path);
  const cached = age === null ? null : readCached(path);
  if (cached && age < TTL) return { list: cached };
  const wait = backoff();
  if (wait === 429) return { list: cached, error: "limited" };
  if (wait === -1) return { list: cached, error: "offline" };
  if (!allowRequest()) return { list: cached, error: "busy", retry: true };
  const r = httpGet(suggestUrl(query, loc), 4);
  if (r.status === 200 && r.text !== null) {
    const list = parseSuggestions(r.text);
    if (list) {
      writeText(path, JSON.stringify({ v: 1, s: list }));
      prune();
      return { list };
    }
    return { list: cached, error: "unexpected" };
  }
  if (r.status === 0) touch(`${cacheDir()}/offline`);
  if (r.status === 429 || r.status === 403 || r.status === 503) touch(`${cacheDir()}/ratelimited`);
  if (r.status === 400) return { list: cached || [] }; // a query Google won't suggest for (too long, odd characters)
  const error = r.status === 0 ? "offline" : r.status === 429 || r.status === 403 || r.status === 503 ? "limited" : "http";
  return { list: cached, error, status: r.status };
}

// Hourly: suggestions older than a day go, and at most MAX_CACHE_FILES are kept
function prune(force) {
  const d = cacheDir();
  const marker = `${d}/pruned`;
  const age = fileAge(marker);
  if (!force && age !== null && age < 3600) return;
  touch(marker);
  const dir = `${d}/suggest`;
  const files = listDir(dir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)).map((f) => ({ f, age: fileAge(`${dir}/${f}`) }));
  files.sort((a, b) => a.age - b.age);
  files.forEach((x, i) => {
    if (x.age === null || x.age > STALE || i >= MAX_CACHE_FILES) remove(`${dir}/${x.f}`);
  });
}

// ---------- queries and URLs ----------

// Split the typed query into the search text and the ! shortcuts it contains
function parseQuery(raw) {
  const words = String(raw || "").replace(/[\u0000-\u001f\u007f]/g, " ").split(/\s+/).filter(Boolean);
  let type = "", time = "";
  const keep = [], bangs = [];
  for (const w of words) {
    const b = BANGS.get(w.toLowerCase());
    if (b) {
      if (b[0] === "type") type = b[1];
      else time = b[1];
      bangs.push(w);
    } else keep.push(w);
  }
  return { text: truncate(keep.join(" "), MAX_QUERY_CHARS), type, time, bangs };
}
// Cut at a code point boundary
function truncate(s, n) {
  if (s.length <= n) return s;
  let out = s.slice(0, n);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function searchUrl(text, o, c) {
  const p = [["q", text]];
  for (const kv of TYPES.get(o.type || "all").params) p.push(kv);
  if (o.time) p.push(["tbs", `qdr:${o.time}`]);
  if (c.lang) p.push(["hl", c.lang]);
  if (c.region) p.push(["gl", c.region]);
  if (c.safe) p.push(["safe", c.safe]);
  if (o.lucky) p.push(["btnI", "1"]);
  for (const kv of c.extra) if (!p.some(([k]) => k === kv[0])) p.push(kv);
  const enc = (v) => encodeURIComponent(v).replace(/%20/g, "+").replace(/%3A/g, ":");
  return `https://${c.domain}/search?${p.map(([k, v]) => `${k}=${enc(v)}`).join("&")}`;
}

// A typed address ("github.com/foo", "https://…", "localhost:3000") gets an "Open" row
function typedUrl(q) {
  if (/\s/.test(q) || q.length > 2000) return null;
  if (/^https?:\/\//i.test(q)) return isWebUrl(q) ? q : null;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?(\/\S*)?$/i.test(q)) return isWebUrl(`http://${q}`) ? `http://${q}` : null;
  const m = /^([a-z0-9-]+\.)+([a-z]{2,24}|xn--[a-z0-9-]+)(:\d{1,5})?([/?#]\S*)?$/i.exec(q);
  // "node.js", "index.html", "file.txt": common words that look like domains are only offered with a path or www.
  if (!m) return null;
  const tld = m[2].toLowerCase();
  const fileLike = /^(js|ts|py|rb|md|txt|html?|css|json|pdf|png|jpe?g|gif|svg|zip|exe|dmg|app|sh|mp[34]|mov|docx?|xlsx?|pptx?|csv|log|swift|java|cpp|php|go|rs|yml|yaml|xml)$/.test(tld);
  if (fileLike && !/^www\./i.test(q)) return null;
  const url = `https://${q}`;
  return isWebUrl(url) ? url : null;
}

// Case, accent and width insensitive form for matching and de-duplicating
function fold(s) {
  return String(s).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------- history ----------

function historyPath() {
  return `${dataDir()}/history.json`;
}
// [{ q: text as typed (with ! shortcuts), t: last used (ms), n: times, u: URL for links }]
function readHistory() {
  const d = readJSON(historyPath());
  if (!d || d.v !== 1 || !Array.isArray(d.items)) return [];
  return d.items.filter((h) => h && typeof h.q === "string" && h.q && typeof h.t === "number" && (h.u === undefined || isWebUrl(h.u)));
}
function writeHistory(items) {
  return writeText(historyPath(), JSON.stringify({ v: 1, items }));
}
const historyKey = (h) => (h.u ? `u|${urlKey(h.u)}` : `q|${fold(h.q)}`);
// The same page with or without "www.", a trailing slash or https
function urlKey(u) {
  return String(u).replace(/^https?:\/\/(www\.)?/i, "").replace(/^([^/?#]*)/, (h) => h.toLowerCase()).replace(/\/$/, "");
}
const shortUrl = (u) => clean(String(u).replace(/^https?:\/\//i, "").replace(/\/$/, ""));
function remember(entry, limit) {
  if (limit <= 0 || !entry.q) return;
  const key = historyKey(entry);
  const items = readHistory();
  const old = items.find((h) => historyKey(h) === key);
  const next = [Object.assign({ q: entry.q, t: Date.now(), n: (old && old.n ? old.n : 0) + 1 }, entry.u ? { u: entry.u } : {})];
  for (const h of items) if (historyKey(h) !== key && next.length < limit) next.push(h);
  writeHistory(next);
}
function forget(key) {
  const items = readHistory();
  const next = items.filter((h) => historyKey(h) !== key);
  if (next.length !== items.length) writeHistory(next);
  return items.length - next.length;
}

// History entries that match what's typed: every typed word starts a word of the entry (or the whole
// query appears in it). Prefix matches of the entire entry come first, then the most recent.
function matchHistory(items, q) {
  const fq = fold(q);
  if (!fq) return [];
  const words = fq.split(" ");
  const scored = [];
  for (const h of items) {
    const fh = fold(h.u ? `${h.q} ${h.u.replace(/^https?:\/\/(www\.)?/, "")}` : h.q);
    if (fh === fq) continue; // the typed row already is this search
    const hw = fh.split(/[\s./:_-]+/);
    const every = words.every((w) => hw.some((x) => x.startsWith(w)));
    if (!every && !fh.includes(fq)) continue;
    scored.push({ h, score: fh.startsWith(fq) ? 0 : 1 });
  }
  scored.sort((a, b) => a.score - b.score || b.h.t - a.h.t);
  return scored.map((x) => x.h);
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return plural(Math.floor(s / 60), "minute") + " ago";
  if (s < 86400) return plural(Math.floor(s / 3600), "hour") + " ago";
  const days = Math.floor(s / 86400);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const d = new Date(t);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `on ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
const plural = (n, w, many) => `${n} ${n === 1 ? w : many || w + "s"}`;

// ---------- Alfred rows ----------

const quote = (s) => `“${s}”`;
function info(title, subtitle, icon, extra) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon || "info"}.png` } }, extra || {});
}
// A modifier that does nothing on this row (otherwise Alfred runs the connection with the row's own arg)
const off = (subtitle) => ({ valid: false, arg: "", subtitle });
// Variables for the Conditional and `act` (absent ones default there: search, not private, not remembered)
const vars = (action, extra) => Object.assign({ gs_action: action }, extra || {});

// "Google Web (no AI Overview) · past week"; with a query: "Google Web for “x” (no AI Overview) · past week"
function describe(type, time, text) {
  const t = TYPES.get(type);
  const q = text === undefined ? "" : ` for ${quote(clean(text))}`;
  return `${t.label}${q}${t.note ? ` (${t.note})` : ""}${time ? ` · ${TIMES.get(time)}` : ""}`;
}

// Rows that search Google: the typed query, suggestions and history. `h` is the history entry, if any.
function searchRow(text, parsed, c, ctx, opts) {
  const o = opts || {};
  const type = parsed.type || c.type;
  const time = parsed.time;
  // The query as it is remembered and autocompleted: with the ! shortcuts that were typed
  const withBangs = [text, ...parsed.bangs].join(" ");
  const priv = c.privateDefault;
  const remember = (p) => (c.historyLimit > 0 && !p ? "1" : "0");
  const reopen = ctx.raw;
  const mk = (sub, t, tm, extra) => {
    const e = extra || {};
    const url = searchUrl(text, { type: t, time: tm, lucky: e.lucky }, c);
    const p = e.private === undefined ? priv : e.private;
    return {
      valid: true, arg: url, subtitle: sub,
      variables: vars(e.action || "open", { gs_query: withBangs, gs_private: p ? "1" : "0", gs_remember: remember(p) }),
    };
  };
  const main = mk("", type, time);
  const other = (t) => (t === type ? "all" : t);
  const typeOf = (t) => describe(t, time);
  const pastTime = time === c.time ? "" : c.time;
  const mods = {
    cmd: Object.assign(mk("Copy the search URL", type, time, { action: "copy" }), {}),
    alt: mk(`Search ${typeOf(other("images"))}`, other("images"), time),
    ctrl: mk("I’m Feeling Lucky: open the first result", "all", time, { lucky: true }),
    shift: mk(`Search ${typeOf(other("web"))}`, other("web"), time),
    fn: mk(pastTime ? `Search ${describe(type, pastTime)}` : `Search ${describe(type, "")} · any time`, type, pastTime),
    "cmd+shift": mk(priv ? `Search ${describe(type, time)} in a normal window` : `Search ${describe(type, time)} in a private window (not remembered)`, type, time, { private: !priv }),
  };
  mods.cmd.variables.gs_remember = "0";
  if (o.history) {
    mods["cmd+alt"] = { valid: true, arg: "forget", subtitle: "Remove from search history", variables: vars("forget", { gs_forget: historyKey(o.history), gs_reopen: reopen }) };
  } else mods["cmd+alt"] = off("Not in your search history");
  const display = clean(o.title || text);
  return {
    uid: `${o.uidKind || "q"}|${display}`,
    title: display,
    subtitle: o.subtitle || `Search ${describe(type, time, display)}`,
    arg: main.arg,
    autocomplete: withBangs,
    text: { copy: text, largetype: text },
    icon: { path: `icons/${o.icon || TYPES.get(type).icon}.png` },
    variables: main.variables,
    mods,
  };
}

function linkRow(title, url, c, ctx, opts) {
  const o = opts || {};
  const priv = c.privateDefault;
  const act = (p) => vars("open", { gs_kind: "link", gs_query: title, gs_private: p ? "1" : "0", gs_remember: c.historyLimit > 0 && !p && o.remember !== false ? "1" : "0" });
  const na = off("Not available for links");
  const display = clean(title);
  const shown = shortUrl(url);
  return {
    uid: `n|${urlKey(url)}`,
    title: display,
    subtitle: o.subtitle || `Open ${shown}`,
    arg: url,
    autocomplete: o.autocomplete || shown,
    text: { copy: url, largetype: url },
    icon: { path: `icons/${o.icon || "link"}.png` },
    variables: act(priv),
    mods: {
      cmd: { valid: true, arg: url, subtitle: "Copy the link", variables: vars("copy") },
      alt: na, ctrl: na, shift: na, fn: na,
      "cmd+shift": { valid: true, arg: url, subtitle: priv ? "Open in a normal window" : "Open in a private window (not remembered)", variables: act(!priv) },
      "cmd+alt": o.history ? { valid: true, arg: "forget", subtitle: "Remove from search history", variables: vars("forget", { gs_forget: historyKey(o.history), gs_reopen: ctx.raw }) }
        : off("Not in your search history"),
    },
  };
}

function calcRow(result, query) {
  const na = off("Not available for calculations");
  const r = clean(result);
  return {
    uid: `c|${r}`,
    title: r,
    subtitle: `${clean(query)} = ${r} · ↩ Copy`,
    arg: r,
    autocomplete: query,
    text: { copy: r, largetype: r },
    icon: { path: "icons/calc.png" },
    variables: vars("copy"),
    mods: {
      cmd: { valid: true, arg: r, subtitle: "Paste the result into the frontmost app", variables: vars("paste") },
      alt: na, ctrl: na, shift: na, fn: na, "cmd+shift": na, "cmd+alt": na,
    },
  };
}

function historyRow(h, c, ctx) {
  const when = `${h.u ? "Opened" : "Searched"} ${ago(h.t)}${h.n > 1 ? ` · ${h.n} times` : ""}`;
  if (h.u) return linkRow(h.q, h.u, c, ctx, { history: h, subtitle: `${when} · ${shortUrl(h.u)}`, icon: "history" });
  const parsed = parseQuery(h.q);
  if (!parsed.text) return null;
  return searchRow(parsed.text, parsed, c, ctx, { history: h, uidKind: "h", icon: "history", subtitle: `${when} · ${describe(parsed.type || c.type, parsed.time)}` });
}

function output(items, extra) {
  return JSON.stringify(Object.assign({ skipknowledge: true, items }, extra || {}));
}

// ---------- Script Filter ----------

function searchFilter(raw) {
  const c = cfg();
  const q = String(raw || "").trim();
  const ctx = { raw: q };
  if (!q) return emptyQuery(c);
  if (q === ":clear") return clearConfirm(c, ctx);
  const parsed = parseQuery(q);
  const history = c.historyLimit > 0 ? readHistory().slice(0, c.historyLimit) : [];
  if (!parsed.text) {
    const type = parsed.type || c.type;
    return output([info(`Type to search ${describe(type, parsed.time)}`, `${parsed.bangs.join(" ")} is set: type the words to search for`, TYPES.get(type).icon)]);
  }
  const loc = suggestLocale(c);
  const text = parsed.text;
  const canSuggest = c.suggestions && text.length <= MAX_SUGGEST_CHARS;
  const prevQuery = env("gs_prev", null);
  let list = null, status = null, rerun = null;
  const variables = { gs_prev: q };
  if (canSuggest) {
    const path = cachePath(text, loc);
    const age = fileAge(path);
    const cached = age === null ? null : readCached(path);
    if (cached && age < TTL) list = cached;
    else if (prevQuery !== q) {
      // A new keystroke: answer at once with the typed query (so ↩ never searches a half-typed one) and
      // the previous suggestions that still fit, then ask Google on the rerun if no key follows.
      const prevText = prevQuery ? parseQuery(prevQuery).text : "";
      const prev = prevText ? readCached(cachePath(prevText, loc)) || [] : [];
      const ft = fold(text);
      list = cached || prev.filter((s) => s.k !== "c" && (fold(s.t).startsWith(ft) || (s.u && fold(s.u.replace(/^https?:\/\/(www\.)?/, "")).startsWith(ft))));
      rerun = DEBOUNCE;
      variables.gs_retries = "0";
    } else {
      const r = fetchSuggestions(text, loc);
      list = r.list || [];
      if (r.error) status = r;
      const n = parseInt(env("gs_retries", "0"), 10) || 0;
      if (r.retry && n < MAX_RETRIES) {
        rerun = 1;
        variables.gs_retries = String(n + 1);
      }
    }
  }
  const fq = fold(q);
  const exact = history.find((h) => !h.u && fold(h.q) === fq);
  const items = [searchRow(text, parsed, c, ctx, { uidKind: "typed", history: exact })];
  const seen = new Set([`q|${fold(text)}`]);
  const add = (row, key) => {
    if (!row || seen.has(key)) return;
    seen.add(key);
    items.push(row);
  };
  for (const s of list || []) if (s.k === "c") add(calcRow(s.t, text), `c|${s.t}`);
  const url = typedUrl(text);
  if (url) add(linkRow(text, url, c, ctx, { autocomplete: text }), `u|${urlKey(url)}`);
  for (const h of matchHistory(history, q).slice(0, HISTORY_MATCHES)) add(historyRow(h, c, ctx), historyKey(h));
  for (const s of list || []) {
    if (s.k === "q") {
      // a suggestion keeps the ! shortcuts that were typed
      add(searchRow(s.t, Object.assign({}, parsed, { text: s.t }), c, ctx, { uidKind: "s" }), `q|${fold(s.t)}`);
    } else if (s.k === "n") {
      add(linkRow(s.t, s.u, c, ctx), `u|${urlKey(s.u)}`);
    }
  }
  if (status) items.push(statusRow(status, list && list.length, !!rerun));
  items.forEach((it) => {
    if (!it.uid) it.uid = `${it.title}`;
  });
  const extra = { variables };
  if (rerun) extra.rerun = rerun;
  return output(items, extra);
}

function statusRow(r, haveSaved, retrying) {
  const saved = haveSaved ? "showing saved suggestions" : "no suggestions for now";
  if (r.error === "offline") return info("Google can’t be reached", `Check your connection: ${saved}. ↩ still opens the search.`, "offline");
  if (r.error === "limited") return info("Google is limiting suggestions", `Suggestions are paused for a few minutes: ${saved}. Searching still works.`, "offline");
  if (r.error === "busy") return info("Slowing down", `Too many suggestion requests at once: ${retrying ? "trying again in a second" : "type again in a moment"}`, "offline");
  if (r.error === "unexpected") return info("Couldn’t read Google’s suggestions", `Unexpected response: ${saved}`, "error");
  return info("Couldn’t load suggestions", `Google answered HTTP ${r.status}: ${saved}`, "error");
}

function emptyQuery(c) {
  if (c.historyLimit <= 0) {
    const items = [info("Type to search Google", "Search history is off in the Workflow’s Configuration", "search")];
    if (exists(historyPath())) items.push(info("Clear Search History…", "Searches saved before history was turned off are still stored", "trash", { autocomplete: ":clear", uid: "clear" }));
    return output(items);
  }
  const ctx = { raw: "" };
  const hist = readHistory().slice(0, c.historyLimit);
  if (!hist.length) return output([info("Type to search Google", "Your recent searches will appear here", "search")]);
  const items = hist.slice(0, HISTORY_SHOWN).map((h) => historyRow(h, c, ctx)).filter(Boolean);
  items.push(info("Clear Search History…", `${plural(hist.length, "saved search", "saved searches")} · ↩ to choose, then confirm`, "trash", { autocomplete: ":clear", uid: "clear" }));
  return output(items);
}

function clearConfirm(c, ctx) {
  const n = readHistory().length;
  const items = [];
  if (n) {
    items.push({
      uid: "clear-confirm", title: `Clear All ${plural(n, "Saved Search", "Saved Searches")}`, subtitle: "↩ Delete your Google Search history from this Mac. This can’t be undone.",
      arg: "clear", valid: true, icon: { path: "icons/trash.png" }, variables: vars("clear"),
      mods: Object.fromEntries(["cmd", "alt", "ctrl", "shift", "fn", "cmd+shift", "cmd+alt"].map((m) => [m, off("Press ↩ without a modifier to clear the history")])),
    });
  } else items.push(info("Search history is empty", "Nothing to clear", "history", { uid: "clear-empty" }));
  // still searchable, in case ":clear" is what you meant
  items.push(searchRow(ctx.raw, parseQuery(ctx.raw), c, ctx, { uidKind: "typed" }));
  return output(items);
}

// ---------- actions ----------

function defaultBrowser() {
  const test = env("GS_DEFAULT_BROWSER", "");
  if (TESTING && test) return test;
  const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://www.google.com"));
  if (u.isNil()) return "";
  const b = $.NSBundle.bundleWithURL(u);
  return b.isNil() || b.bundleIdentifier.isNil() ? "" : b.bundleIdentifier.js;
}
function installed(bundle) {
  if (TESTING) return env("GS_MISSING_BROWSER", "") !== bundle;
  return !$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bundle).isNil();
}

// Tests record commands instead of running them
function runCmd(path, args) {
  const log = env("GS_LOG", "");
  if (TESTING) {
    if (log) {
      const prev = readText(log) || "";
      writeText(log, prev + JSON.stringify([path, ...args]) + "\n");
    }
    return 0;
  }
  return exec(path, args).status;
}
function alfredSearch(text) {
  if (TESTING) return runCmd("alfred-search", [text]);
  Application("com.runningwithcrayons.Alfred").search(text);
  return 0;
}

// Open a URL in the configured browser (a private window when asked). Returns an error message or "".
function openUrl(url, priv, c) {
  if (!isWebUrl(url)) return "Couldn’t open the search: invalid URL";
  const bundle = c.browser || (priv ? defaultBrowser() : "");
  if (bundle && !installed(bundle)) return `Couldn’t find ${browserInfo(bundle).name}: choose another browser in the Workflow’s Configuration`;
  let args;
  if (priv) {
    const b = browserInfo(bundle);
    if (!b.flag) return `Couldn’t open a private window: ${bundle ? b.name : "the default browser"} can’t be asked to. Choose Chrome, Firefox, Brave, Edge or Vivaldi in the Workflow’s Configuration.`;
    // -n passes the argument even when the browser is already running (it hands the URL to the open instance)
    args = ["-n", "-b", bundle, "--args", b.flag, url];
  } else args = bundle ? ["-b", bundle, url] : [url];
  return runCmd("/usr/bin/open", args) === 0 ? "" : `Couldn’t open ${bundle ? browserInfo(bundle).name : "the browser"}`;
}

function act(arg) {
  const c = cfg();
  const action = env("gs_action", "open");
  if (action === "clear") {
    const n = readHistory().length;
    remove(historyPath());
    return n ? `Cleared ${plural(n, "saved search", "saved searches")}` : "Search history is empty";
  }
  if (action === "forget") {
    forget(env("gs_forget", ""));
    // back to the list, one entry shorter
    const reopen = clean(env("gs_reopen", ""));
    alfredSearch(`${c.keyword} ${reopen}`);
    return undefined;
  }
  if (action !== "open") return undefined;
  const url = String(arg || "");
  const priv = env("gs_private", "0") === "1";
  const err = openUrl(url, priv, c);
  if (err) return err;
  const q = env("gs_query", "").trim();
  if (!priv && env("gs_remember", "0") === "1" && q) {
    remember(env("gs_kind", "search") === "link" ? { q: truncate(clean(q), 500), u: url } : { q: truncate(clean(q), MAX_QUERY_CHARS) }, c.historyLimit);
  }
  return undefined;
}

// ---------- selected text ----------

function clipboardText() {
  if (TESTING) return env("GS_CLIPBOARD", "");
  const pb = $.NSPasteboard.generalPasteboard;
  // Password managers mark what they copy (nspasteboard.org): never search for a password
  const types = pb.types;
  if (!types.isNil()) {
    for (let i = 0; i < types.count; i++) {
      if (/^org\.nspasteboard\.(Concealed|Transient|AutoGenerated)Type$/.test(types.objectAtIndex(i).js)) return "";
    }
  }
  const s = pb.stringForType($.NSPasteboardTypeString);
  return s.isNil() ? "" : s.js;
}

function selection(arg) {
  const c = cfg();
  let text = truncate(clean(arg || ""), MAX_QUERY_CHARS);
  if (!text && c.clipboardFallback) text = truncate(clean(clipboardText()), MAX_QUERY_CHARS);
  if (!text || c.selectionMode === "alfred") {
    // nothing to search: show the keyword (history and suggestions) instead
    alfredSearch(`${c.keyword} ${text}`);
    return undefined;
  }
  const parsed = parseQuery(text);
  if (!parsed.text) {
    alfredSearch(`${c.keyword} ${text}`);
    return undefined;
  }
  const url = searchUrl(parsed.text, { type: parsed.type || c.type, time: parsed.time }, c);
  const err = openUrl(url, c.privateDefault, c);
  if (err) return err;
  if (!c.privateDefault) remember({ q: text }, c.historyLimit);
  return undefined;
}

// ---------- entry point ----------

function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === "search") return searchFilter(arg);
  if (cmd === "act") return act(arg);
  if (cmd === "selection") return selection(arg);
  if (cmd === "test" && TESTING) return testHook(argv.slice(1));
  return undefined;
}

// Unit tests call pure functions directly
function testHook(args) {
  const [fn, ...rest] = args;
  const c = cfg();
  const f = new Map([
    ["parseSuggestions", (t) => parseSuggestions(t)],
    ["parseQuery", (q) => parseQuery(q)],
    ["searchUrl", (t, o) => searchUrl(t, JSON.parse(o || "{}"), c)],
    ["typedUrl", (q) => typedUrl(q)],
    ["fold", (s) => fold(s)],
    ["matchHistory", (items, q) => matchHistory(JSON.parse(items), q).map((h) => h.q)],
    ["suggestLocale", () => suggestLocale(c)],
    ["cfg", () => c],
    ["browserInfo", (b) => browserInfo(b)],
    ["prune", () => prune(true)],
    ["decode", (hex, ct) => decode($.NSData.alloc.initWithBase64EncodedStringOptions($(hex), 0), ct)],
  ]).get(fn);
  return f ? JSON.stringify(f(...rest)) : "";
}

function run(argv) {
  return main(argv);
}
