#!/usr/bin/env python3
"""Tests for Google Search.

Unit tests call pure JXA functions through the `test` hook (GS_TEST=1). End-to-end tests run the Script Filter
and the actions the way Alfred does, against a local mock of Google's suggest endpoint (GS_SUGGEST_URL).
In test mode nothing is opened: `open` and Alfred calls are written to a log file (GS_LOG).
Set GS_LIVE=1 to also run a smoke test against the real suggest endpoint.
"""
import json, os, plistlib, re, shutil, signal, subprocess, tempfile, threading, time, unittest, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
MODS = ("cmd", "alt", "ctrl", "shift", "fn", "cmd+shift", "cmd+alt")


# ---------- mock suggest server ----------

def chrome_response(q, rows):
    """rows: [(text, type, description)] in the chrome client's shape"""
    # raw characters, and "'" escaped as \u0027 like Google does
    return json.dumps([q, [r[0] for r in rows], [r[2] if len(r) > 2 else "" for r in rows], [],
                       {"google:suggesttype": [r[1] for r in rows], "google:suggestrelevance": [600 - i for i in range(len(rows))]}],
                      ensure_ascii=False).replace("'", "\\u0027")


class Mock:
    def __init__(self):
        self.queries, self.mode = [], {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.handler())
        self.base = "http://127.0.0.1:%d" % self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reset(self):
        self.queries.clear()
        self.mode.clear()

    def handler(mock):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body, ctype="text/javascript; charset=UTF-8"):
                body = body.encode("utf-8") if isinstance(body, str) else body
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
                mock.queries.append(q)
                if mock.mode.get("delay"):
                    time.sleep(mock.mode["delay"])
                forced = mock.mode.get("status")
                if forced:
                    return self.send(forced, "<html>error</html>", "text/html")
                if mock.mode.get("garbage"):
                    return self.send(200, "<html>not json</html>", "text/html")
                if u.path != "/complete/search" or q.get("client") != "chrome" or q.get("oe") != "utf-8":
                    return self.send(404, "not found", "text/plain")
                query = q.get("q", "")
                if len(query) > 100:
                    return self.send(400, "<html>400</html>", "text/html")
                if query == "youtu":
                    return self.send(200, chrome_response(query, [("youtube", "QUERY"), ("https://www.youtube.com/", "NAVIGATION", "YouTube"),
                                                                  ("youtube tv", "QUERY"), ("youtube music", "QUERY")]))
                if query == "2+2*3":
                    return self.send(200, chrome_response(query, [("= 8", "CALCULATOR", "Calculator"), ("2+2*3 solution", "QUERY")]))
                if query == "café":
                    body = chrome_response(query, [("café frappé", "QUERY"), ("café liégeois", "QUERY"), ("café d'art", "QUERY")])
                    if mock.mode.get("latin1"):
                        return self.send(200, body.encode("latin-1"), "text/javascript; charset=ISO-8859-1")
                    return self.send(200, body)
                if query == "東京":
                    body = chrome_response(query, [("東京 天気", "QUERY"), ("東京タワー", "QUERY"), ("東京's", "QUERY")])
                    return self.send(200, body.encode("shift_jis"), "text/javascript; charset=Shift_JIS")
                if query == "evil":
                    return self.send(200, json.dumps([query, ["evil‮txt.exe", "javascript:alert(1)", 5, None, "evil ok", "ftp://x"],
                                                      ["", "", "", "", "", ""], [],
                                                      {"google:suggesttype": ["QUERY", "NAVIGATION", "QUERY", "QUERY", "QUERY", "NAVIGATION"]}]))
                if query == "shape":
                    return self.send(200, json.dumps({"not": "an array"}))
                if query == "github":
                    return self.send(200, chrome_response(query, [("github copilot", "QUERY"), ("https://github.com/", "NAVIGATION", "GitHub")]))
                return self.send(200, chrome_response(query, [(query + " one", "QUERY"), (query + " two", "QUERY")]))

        return H


MOCK = Mock()
CLOSED = "http://127.0.0.1:9/complete/search"  # nothing listens: behaves like being offline


# ---------- running the workflow ----------

CONFIG_VARS = ("keyword_google", "suggestions", "search_type", "time_range", "history_limit", "browser", "private_window",
               "safesearch", "language", "region", "google_domain", "selection_mode", "clipboard_fallback", "extra_params")


class Env:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="google-search-test ")  # a space, like Alfred's real folders
        self.cache = os.path.join(self.dir, "cache dir")
        self.data = os.path.join(self.dir, "data dir")
        self.log = os.path.join(self.dir, "log.txt")

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def vars(self, **extra):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("GS_", "gs_")) and k not in CONFIG_VARS}
        e.update(alfred_workflow_cache=self.cache, alfred_workflow_data=self.data, GS_TEST="1", GS_UNTHROTTLED="1",
                 GS_SUGGEST_URL=MOCK.base + "/complete/search", GS_LOG=self.log, language="en", region="us")
        e.update({k: str(v) for k, v in extra.items()})
        return {k: v for k, v in e.items() if v != "<unset>"}

    def run(self, *argv, **extra):
        return subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./google.js", *argv], cwd=SRC,
                              env=self.vars(**extra), capture_output=True, text=True, timeout=60)

    def sf(self, query="", **extra):
        out = self.run("search", query, **extra)
        assert out.returncode == 0, out.stderr
        data = json.loads(out.stdout)
        validate(data)
        return data

    def fetch(self, query, **extra):
        """The rerun after a keystroke: the query is unchanged, so suggestions are fetched"""
        return self.sf(query, gs_prev=query, **extra)

    def act(self, item, mod=None, **extra):
        """Press ↩ (or mod+↩) on a row: the conditional routes copy/paste to Alfred, the rest to `act`"""
        src = item["mods"][mod] if mod else item
        assert src.get("valid", True) is not False, src
        v = dict(item.get("variables", {}))
        v.update(src.get("variables", {}))
        if v.get("gs_action") in ("copy", "paste"):
            return ("clipboard", v["gs_action"], src["arg"])
        out = self.run("act", src["arg"], **v, **extra)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    def logged(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(l) for l in f if l.strip()]

    def history(self):
        p = os.path.join(self.data, "history.json")
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)["items"]

    def write_history(self, items):
        os.makedirs(self.data, exist_ok=True)
        with open(os.path.join(self.data, "history.json"), "w") as f:
            json.dump({"v": 1, "items": items}, f)

    def hook(self, *args, **extra):
        out = self.run("test", *args, **extra)
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout) if out.stdout.strip() else None


def validate(data):
    assert isinstance(data.get("items"), list) and data["items"], data
    uids = [it.get("uid") for it in data["items"] if it.get("uid")]
    assert len(uids) == len(set(uids)), uids
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert not re.search(r"[\u0000-\u001f‪-‮⁦-⁩]", it["title"] + it.get("subtitle", "")), it
        p = it["icon"]["path"]
        assert os.path.exists(os.path.join(SRC, p)), p
        if it.get("valid", True) is not False:
            assert "arg" in it and it["arg"], it
            assert set(it.get("mods", {})) == set(MODS), it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m
    json.dumps(data)


def titles(data):
    return [i["title"] for i in data["items"]]


def by_title(data, title):
    return next(i for i in data["items"] if i["title"] == title)


class Base(unittest.TestCase):
    def setUp(self):
        MOCK.reset()
        self.env = Env()

    def tearDown(self):
        self.env.cleanup()


# ---------- unit tests ----------

class UnitTests(Base):
    def test_parse_suggestions(self):
        body = chrome_response("youtu", [("youtube", "QUERY"), ("https://www.youtube.com/", "NAVIGATION", "YouTube"), ("= 8", "CALCULATOR", "Calculator")])
        self.assertEqual(self.env.hook("parseSuggestions", body),
                         [{"k": "q", "t": "youtube"}, {"k": "n", "t": "YouTube", "u": "https://www.youtube.com/"}, {"k": "c", "t": "8"}])
        # firefox-like shape (no types), junk, and non-URLs in NAVIGATION rows
        self.assertEqual(self.env.hook("parseSuggestions", '["a",["a b","a c"]]'), [{"k": "q", "t": "a b"}, {"k": "q", "t": "a c"}])
        self.assertIsNone(self.env.hook("parseSuggestions", "<html>"))
        self.assertIsNone(self.env.hook("parseSuggestions", '{"a":1}'))
        self.assertEqual(self.env.hook("parseSuggestions", '["x",[1,null,"javascript:alert(1)"],[],[],{"google:suggesttype":["QUERY","QUERY","NAVIGATION"]}]'), [])
        # a navigation row without a title shows the URL
        self.assertEqual(self.env.hook("parseSuggestions", '["x",["https://x.org/"],[""],[],{"google:suggesttype":["NAVIGATION"]}]'),
                         [{"k": "n", "t": "https://x.org/", "u": "https://x.org/"}])

    def test_parse_query_shortcuts(self):
        p = self.env.hook("parseQuery", "cats !i  !WEEK in hats")
        self.assertEqual((p["text"], p["type"], p["time"], p["bangs"]), ("cats in hats", "images", "w", ["!i", "!WEEK"]))
        p = self.env.hook("parseQuery", "!important css !unknown")
        self.assertEqual((p["text"], p["type"], p["time"]), ("!important css !unknown", "", ""))
        p = self.env.hook("parseQuery", "a\nb\tc")
        self.assertEqual(p["text"], "a b c")
        p = self.env.hook("parseQuery", "constructor __proto__ !toString")
        self.assertEqual((p["text"], p["type"]), ("constructor __proto__ !toString", ""))

    def test_search_urls(self):
        u = lambda text, o="{}", **kw: self.env.hook("searchUrl", text, o, **kw)
        self.assertEqual(u("a b&c=d#e", language="", region=""), "https://www.google.com/search?q=a+b%26c%3Dd%23e")
        self.assertEqual(u("x", '{"type":"images","time":"w"}', language="", region=""), "https://www.google.com/search?q=x&udm=2&tbs=qdr:w")
        self.assertEqual(u("x", '{"type":"web"}', language="", region=""), "https://www.google.com/search?q=x&udm=14")
        self.assertEqual(u("x", '{"type":"news"}', language="", region=""), "https://www.google.com/search?q=x&tbm=nws")
        self.assertEqual(u("x", '{"type":"videos"}', language="", region=""), "https://www.google.com/search?q=x&udm=7")
        self.assertEqual(u("x", '{"type":"shopping"}', language="", region=""), "https://www.google.com/search?q=x&udm=28")
        self.assertEqual(u("x", '{"type":"ai"}', language="", region=""), "https://www.google.com/search?q=x&udm=50")
        self.assertEqual(u("x", '{"lucky":true}', language="", region=""), "https://www.google.com/search?q=x&btnI=1")
        self.assertEqual(u("x", language="pt-BR", region="BR", safesearch="active", google_domain="https://www.google.com.br/"),
                         "https://www.google.com.br/search?q=x&hl=pt-BR&gl=br&safe=active")
        # invalid settings fall back; extra parameters can't replace the query or the type
        self.assertEqual(u("x", language="en;rm", region="usa", safesearch="bad", google_domain="evil.com/google.com"),
                         "https://www.google.com/search?q=x")
        self.assertEqual(u("x", language="", region="", extra_params="pws=0&lr=lang_en&q=hijack&udm=1&bad key=1&tbs=li:1"),
                         "https://www.google.com/search?q=x&pws=0&lr=lang_en&tbs=li:1")
        self.assertEqual(u("東京 😀", language="", region=""), "https://www.google.com/search?q=%E6%9D%B1%E4%BA%AC+%F0%9F%98%80")

    def test_typed_urls(self):
        t = lambda q: self.env.hook("typedUrl", q)
        self.assertEqual(t("github.com"), "https://github.com")
        self.assertEqual(t("example.co.uk/path?x=1"), "https://example.co.uk/path?x=1")
        self.assertEqual(t("https://x.org/a"), "https://x.org/a")
        self.assertEqual(t("localhost:3000/api"), "http://localhost:3000/api")
        self.assertEqual(t("www.index.html"), "https://www.index.html")
        for q in ("node.js", "index.html", "hello world.com", "javascript:alert(1)", "file:///etc/passwd", "a.b", "1.5", "3.14.15"):
            self.assertIsNone(t(q), q)

    def test_fold_and_history_matching(self):
        self.assertEqual(self.env.hook("fold", "Café  ÉCOLE ｆｕｌｌ"), "cafe ecole full")
        items = json.dumps([{"q": "rust lifetimes", "t": 3}, {"q": "Crème brûlée recipe", "t": 2}, {"q": "the rust book", "t": 5},
                            {"q": "GitHub", "t": 1, "u": "https://github.com/"}, {"q": "rust", "t": 9}])
        m = lambda q: self.env.hook("matchHistory", items, q)
        self.assertEqual(m("rust"), ["rust lifetimes", "the rust book"])  # the exact entry is the typed row itself
        self.assertEqual(m("creme bru"), ["Crème brûlée recipe"])
        self.assertEqual(m("github.c"), ["GitHub"])
        self.assertEqual(m("book rust"), ["the rust book"])
        self.assertEqual(m("zzz"), [])

    def test_locale(self):
        self.assertEqual(self.env.hook("suggestLocale", language="de", region="AT"), {"hl": "de", "gl": "at"})
        auto = self.env.hook("suggestLocale", language="", region="")
        self.assertRegex(auto["hl"], r"^[a-z]{2,3}(-[A-Z]{2})?$")
        self.assertRegex(auto["gl"], r"^([a-z]{2})?$")

    def test_decode(self):
        import base64
        d = lambda raw, ct: self.env.hook("decode", base64.b64encode(raw).decode(), ct)
        self.assertEqual(d("東京".encode("shift_jis"), "text/javascript; charset=Shift_JIS"), "東京")
        self.assertEqual(d("café".encode("latin-1"), "text/javascript; charset=ISO-8859-1"), "café")
        self.assertEqual(d("café".encode("utf-8"), "text/javascript; charset=bogus-charset"), "café")
        self.assertEqual(d("café".encode("latin-1"), ""), "café")  # not UTF-8: Latin-1 fallback

    def test_config_defaults_and_validation(self):
        c = self.env.hook("cfg", **{k: "<unset>" for k in CONFIG_VARS})
        self.assertEqual((c["keyword"], c["type"], c["time"], c["historyLimit"], c["domain"], c["suggestions"], c["clipboardFallback"]),
                         ("goo", "all", "w", 100, "www.google.com", True, True))
        c = self.env.hook("cfg", keyword_google="  ", search_type="constructor", time_range="__proto__", history_limit="-5", browser="a b;c")
        self.assertEqual((c["keyword"], c["type"], c["time"], c["historyLimit"], c["browser"]), ("goo", "all", "w", 100, ""))

    def test_browsers(self):
        self.assertEqual(self.env.hook("browserInfo", "com.google.Chrome.canary"), {"name": "Google Chrome", "flag": "--incognito"})
        self.assertEqual(self.env.hook("browserInfo", "org.mozilla.firefox"), {"name": "Firefox", "flag": "--private-window"})
        self.assertEqual(self.env.hook("browserInfo", "com.apple.Safari")["flag"], "")
        self.assertEqual(self.env.hook("browserInfo", "com.example.Unknown"), {"name": "com.example.Unknown", "flag": ""})


# ---------- Script Filter ----------

class ScriptFilterTests(Base):
    def test_empty_query_without_history(self):
        d = self.env.sf("")
        self.assertEqual(titles(d), ["Type to search Google"])
        self.assertEqual(MOCK.queries, [])
        d = self.env.sf("", history_limit="0")
        self.assertIn("off", d["items"][0]["subtitle"])

    def test_keystroke_answers_at_once_then_fetches(self):
        d = self.env.sf("youtu")
        self.assertEqual(titles(d), ["youtu"])  # nothing cached yet: only the typed query
        self.assertEqual(d["rerun"], 0.15)
        self.assertEqual(d["variables"]["gs_prev"], "youtu")
        self.assertEqual(MOCK.queries, [])
        d = self.env.fetch("youtu")
        self.assertNotIn("rerun", d)
        self.assertEqual(titles(d), ["youtu", "youtube", "YouTube", "youtube tv", "youtube music"])
        q = MOCK.queries[-1]
        self.assertEqual((q["q"], q["hl"], q["gl"], q["ie"], q["oe"]), ("youtu", "en", "us", "utf-8", "utf-8"))
        typed, sugg, nav = d["items"][0], d["items"][1], d["items"][2]
        self.assertEqual(typed["arg"], "https://www.google.com/search?q=youtu&hl=en&gl=us")
        self.assertEqual(typed["autocomplete"], "youtu")
        self.assertEqual(sugg["autocomplete"], "youtube")
        self.assertEqual(sugg["arg"], "https://www.google.com/search?q=youtube&hl=en&gl=us")
        self.assertEqual(nav["arg"], "https://www.youtube.com/")
        self.assertEqual(nav["subtitle"], "Open www.youtube.com")
        self.assertEqual(nav["icon"]["path"], "icons/link.png")
        # the next run with the same query is answered from the cache, without asking Google
        n = len(MOCK.queries)
        d2 = self.env.sf("youtu")
        self.assertEqual(titles(d2), titles(d))
        self.assertNotIn("rerun", d2)
        self.assertEqual(len(MOCK.queries), n)

    def test_previous_suggestions_that_still_fit(self):
        self.env.fetch("youtu")
        d = self.env.sf("youtube t", gs_prev="youtu")
        self.assertEqual(titles(d), ["youtube t", "youtube tv"])
        self.assertEqual(d["rerun"], 0.15)

    def test_stale_cache_shown_at_once(self):
        self.env.fetch("youtu")
        folder = os.path.join(self.env.cache, "suggest")
        for f in os.listdir(folder):
            old = time.time() - 7200
            os.utime(os.path.join(folder, f), (old, old))
        d = self.env.sf("youtu", gs_prev="you")
        self.assertEqual(titles(d), ["youtu", "youtube", "YouTube", "youtube tv", "youtube music"])
        self.assertEqual(d["rerun"], 0.15)
        n = len(MOCK.queries)
        self.env.fetch("youtu")
        self.assertEqual(len(MOCK.queries), n + 1)  # refreshed on the rerun

    def test_modifiers(self):
        d = self.env.fetch("youtu", language="", region="")
        m = d["items"][1]["mods"]
        self.assertEqual(m["cmd"]["arg"], "https://www.google.com/search?q=youtube")
        self.assertEqual(m["cmd"]["variables"]["gs_action"], "copy")
        self.assertEqual(m["alt"]["arg"], "https://www.google.com/search?q=youtube&udm=2")
        self.assertEqual(m["ctrl"]["arg"], "https://www.google.com/search?q=youtube&btnI=1")
        self.assertEqual(m["shift"]["arg"], "https://www.google.com/search?q=youtube&udm=14")
        self.assertEqual(m["fn"]["arg"], "https://www.google.com/search?q=youtube&tbs=qdr:w")
        self.assertEqual(m["cmd+shift"]["variables"]["gs_private"], "1")
        self.assertEqual(m["cmd+shift"]["variables"]["gs_remember"], "0")
        self.assertIs(m["cmd+alt"]["valid"], False)  # not in the history
        # a link row: search-only modifiers do nothing
        nav = d["items"][2]["mods"]
        self.assertEqual(nav["cmd"]["arg"], "https://www.youtube.com/")
        for k in ("alt", "ctrl", "shift", "fn"):
            self.assertIs(nav[k]["valid"], False)
        # with Images as the default, ⌥ searches all results; with a month range, fn uses it
        d = self.env.fetch("youtu", search_type="images", time_range="m", language="", region="")
        self.assertEqual(d["items"][0]["arg"], "https://www.google.com/search?q=youtu&udm=2")
        self.assertEqual(d["items"][0]["mods"]["alt"]["arg"], "https://www.google.com/search?q=youtu")
        self.assertEqual(d["items"][0]["mods"]["fn"]["arg"], "https://www.google.com/search?q=youtu&udm=2&tbs=qdr:m")
        self.assertEqual(d["items"][0]["icon"]["path"], "icons/images.png")

    def test_shortcuts_in_query(self):
        d = self.env.fetch("cats !n !week", language="", region="")
        self.assertEqual(MOCK.queries[-1]["q"], "cats")  # suggestions for the words only
        typed = d["items"][0]
        self.assertEqual(typed["title"], "cats")
        self.assertEqual(typed["arg"], "https://www.google.com/search?q=cats&tbm=nws&tbs=qdr:w")
        self.assertEqual(typed["subtitle"], "Search Google News for “cats” · past week")
        s = by_title(d, "cats one")
        self.assertEqual(s["autocomplete"], "cats one !n !week")  # ⇥ keeps the shortcuts
        self.assertEqual(s["arg"], "https://www.google.com/search?q=cats+one&tbm=nws&tbs=qdr:w")
        # fn with the same range as typed: any time
        self.assertEqual(typed["mods"]["fn"]["arg"], "https://www.google.com/search?q=cats&tbm=nws")
        d = self.env.sf("!i")
        self.assertEqual(titles(d), ["Type to search Google Images"])

    def test_calculator(self):
        d = self.env.fetch("2+2*3")
        self.assertEqual(titles(d)[:2], ["2+2*3", "8"])
        calc = d["items"][1]
        self.assertEqual(self.env.act(calc), ("clipboard", "copy", "8"))
        self.assertEqual(self.env.act(calc, "cmd"), ("clipboard", "paste", "8"))
        self.assertIs(calc["mods"]["alt"]["valid"], False)

    def test_typed_address(self):
        d = self.env.fetch("github.com")
        self.assertEqual(titles(d)[:2], ["github.com", "github.com"])
        self.assertEqual(d["items"][1]["arg"], "https://github.com")
        self.assertEqual(d["items"][1]["subtitle"], "Open github.com")
        d = self.env.fetch("github")
        # a navigation suggestion for the same site as a typed address isn't shown twice
        d = self.env.sf("github", gs_prev="xx")
        self.assertEqual(len([i for i in d["items"] if i.get("arg", "").startswith("https://github.com")]), 1)

    def test_unicode_and_encodings(self):
        d = self.env.fetch("café")
        self.assertEqual(titles(d), ["café", "café frappé", "café liégeois", "café d'art"])
        shutil.rmtree(self.env.cache)
        MOCK.mode["latin1"] = True
        d = self.env.fetch("café")
        self.assertEqual(titles(d), ["café", "café frappé", "café liégeois", "café d'art"])
        d = self.env.fetch("東京")
        self.assertEqual(titles(d), ["東京", "東京 天気", "東京タワー", "東京's"])

    def test_hostile_suggestions(self):
        d = self.env.fetch("evil")
        self.assertEqual(titles(d), ["evil", "evil txt.exe", "evil ok"])
        self.assertTrue(all(i["arg"].startswith("https://www.google.com/search?") for i in d["items"]))

    def test_injection_and_quotes(self):
        q = "\"; rm -rf ~; $(touch /tmp/pwned) `id` 'x' \\"
        d = self.env.fetch(q)
        self.assertEqual(d["items"][0]["title"], q)
        self.assertEqual(MOCK.queries[-1]["q"], q)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlparse(d["items"][0]["arg"]).query)["q"], [q])
        d = self.env.sf("line one\nline\ttwo‮")
        self.assertEqual(d["items"][0]["title"], "line one line two")

    def test_offline(self):
        d = self.env.fetch("youtu", GS_SUGGEST_URL=CLOSED)
        self.assertEqual(titles(d), ["youtu", "Google can’t be reached"])
        self.assertTrue(d["items"][0]["arg"].startswith("https://www.google.com/search?q=youtu"))
        # backing off: the next keystroke doesn't wait for the network again
        t = time.time()
        d = self.env.fetch("youtub", GS_SUGGEST_URL=CLOSED)
        self.assertLess(time.time() - t, 2)
        self.assertEqual(titles(d)[-1], "Google can’t be reached")

    def test_offline_shows_saved_suggestions(self):
        self.env.fetch("youtu")
        # make the cache stale
        folder = os.path.join(self.env.cache, "suggest")
        for f in os.listdir(folder):
            old = time.time() - 7200
            os.utime(os.path.join(folder, f), (old, old))
        d = self.env.fetch("youtu", GS_SUGGEST_URL=CLOSED)
        self.assertEqual(titles(d), ["youtu", "youtube", "YouTube", "youtube tv", "youtube music", "Google can’t be reached"])
        self.assertIn("saved suggestions", d["items"][-1]["subtitle"])

    def test_rate_limited(self):
        for status in (429, 503):
            self.env.cleanup()
            self.env = Env()
            MOCK.reset()
            MOCK.mode["status"] = status
            d = self.env.fetch("youtu")
            self.assertEqual(titles(d), ["youtu", "Google is limiting suggestions"])
            MOCK.mode.clear()
            n = len(MOCK.queries)
            d = self.env.fetch("youtube")  # backing off for a few minutes
            self.assertEqual(len(MOCK.queries), n)
            self.assertEqual(titles(d)[-1], "Google is limiting suggestions")

    def test_bad_responses(self):
        MOCK.mode["garbage"] = True
        d = self.env.fetch("youtu")
        self.assertEqual(titles(d), ["youtu", "Couldn’t read Google’s suggestions"])
        MOCK.mode.clear()
        d = self.env.fetch("shape")
        self.assertEqual(titles(d), ["shape", "Couldn’t read Google’s suggestions"])
        MOCK.mode["status"] = 500
        d = self.env.fetch("other")
        self.assertEqual(titles(d), ["other", "Couldn’t load suggestions"])

    def test_long_queries_and_suggestions_off(self):
        long = "word " * 30
        d = self.env.fetch(long)
        self.assertEqual(len(d["items"]), 1)
        self.assertNotIn("rerun", d)
        self.assertEqual(MOCK.queries, [])
        d = self.env.sf("youtu", suggestions="0")
        self.assertEqual(titles(d), ["youtu"])
        self.assertNotIn("rerun", d)
        d = self.env.fetch("youtu", suggestions="0")
        self.assertEqual(MOCK.queries, [])

    def test_request_limit_across_processes(self):
        for i in range(15):
            self.env.fetch("q%d" % i, GS_UNTHROTTLED="0")
        d = self.env.fetch("q15", GS_UNTHROTTLED="0")
        self.assertEqual(len(MOCK.queries), 15)
        self.assertEqual(titles(d)[-1], "Slowing down")
        self.assertEqual(d["rerun"], 1)
        self.assertEqual(d["variables"]["gs_retries"], "1")
        d = self.env.fetch("q15", GS_UNTHROTTLED="0", gs_retries="5")
        self.assertNotIn("rerun", d)

    def test_killed_mid_request(self):
        MOCK.mode["delay"] = 3
        p = subprocess.Popen(["/usr/bin/osascript", "-l", "JavaScript", "./google.js", "search", "youtu"], cwd=SRC,
                             env=self.env.vars(gs_prev="youtu"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        p.send_signal(signal.SIGTERM)  # Alfred's queue mode 2 on the next keystroke
        p.wait(timeout=10)
        MOCK.mode.clear()
        d = self.env.fetch("youtu")
        self.assertEqual(titles(d)[1], "youtube")
        leftovers = [f for _, _, fs in os.walk(self.env.cache) for f in fs if not re.fullmatch(r"[0-9a-f]{16}\.json|pruned|\d+-\d+|offline|ratelimited", f)]
        self.assertEqual(leftovers, [])

    def test_prune(self):
        folder = os.path.join(self.env.cache, "suggest")
        os.makedirs(folder)
        for i in range(2010):
            with open(os.path.join(folder, "%016x.json" % i), "w") as f:
                f.write("{}")
        old = time.time() - 2 * 86400
        os.utime(os.path.join(folder, "%016x.json" % 0), (old, old))
        self.env.hook("prune")
        left = os.listdir(folder)
        self.assertEqual(len(left), 2000)
        self.assertNotIn("%016x.json" % 0, left)

    def test_stable_uids(self):
        d1 = self.env.fetch("youtu")
        d2 = self.env.sf("youtu")
        self.assertEqual([i["uid"] for i in d1["items"]], [i["uid"] for i in d2["items"]])
        self.assertTrue(d1["skipknowledge"])


# ---------- history ----------

class HistoryTests(Base):
    def test_search_is_remembered_and_listed(self):
        d = self.env.fetch("youtu")
        self.assertIsNone(self.env.act(d["items"][1]) or None)
        self.assertEqual(self.env.logged(), [["/usr/bin/open", "https://www.google.com/search?q=youtube&hl=en&gl=us"]])
        h = self.env.history()
        self.assertEqual([(x["q"], x["n"]) for x in h], [("youtube", 1)])
        # searching it again moves it up and counts it
        self.env.act(self.env.fetch("abc")["items"][0])
        self.env.act(self.env.sf("YouTube")["items"][0])
        h = self.env.history()
        self.assertEqual([(x["q"], x["n"]) for x in h], [("YouTube", 2), ("abc", 1)])
        d = self.env.sf("")
        self.assertEqual(titles(d), ["YouTube", "abc", "Clear Search History…"])
        self.assertRegex(d["items"][0]["subtitle"], r"^Searched just now · 2 times · Google$")
        self.assertEqual(d["items"][0]["icon"]["path"], "icons/history.png")
        self.assertEqual(d["items"][-1]["autocomplete"], ":clear")

    def test_links_are_remembered(self):
        d = self.env.fetch("youtu")
        self.env.act(by_title(d, "YouTube"))
        self.assertEqual(self.env.history(), [dict(self.env.history()[0], q="YouTube", u="https://www.youtube.com/")])
        d = self.env.sf("")
        self.assertEqual(d["items"][0]["arg"], "https://www.youtube.com/")
        self.assertIn("Opened just now", d["items"][0]["subtitle"])
        # while typing, the remembered link is shown once
        d = self.env.fetch("youtu")
        self.assertEqual(titles(d), ["youtu", "YouTube", "youtube", "youtube tv", "youtube music"])
        self.assertEqual(d["items"][1]["icon"]["path"], "icons/history.png")

    def test_history_merged_while_typing(self):
        now = int(time.time() * 1000)
        self.env.write_history([{"q": "youtube premium price", "t": now - 5000, "n": 1}, {"q": "unrelated", "t": now, "n": 1},
                                {"q": "youtube tv", "t": now - 1000, "n": 3}])
        d = self.env.fetch("youtu")
        self.assertEqual(titles(d), ["youtu", "youtube tv", "youtube premium price", "youtube", "YouTube", "youtube music"])
        self.assertIn("3 times", d["items"][1]["subtitle"])
        self.assertIs(d["items"][1]["mods"]["cmd+alt"]["valid"], True)

    def test_forget_one(self):
        now = int(time.time() * 1000)
        self.env.write_history([{"q": "one", "t": now, "n": 1}, {"q": "two", "t": now - 1, "n": 1}])
        d = self.env.sf("")
        self.env.act(d["items"][0], "cmd+alt", keyword_google="gsx")
        self.assertEqual([h["q"] for h in self.env.history()], ["two"])
        self.assertEqual(self.env.logged(), [["alfred-search", "gsx "]])  # back to the list
        # from a typed query: back to the same query
        d = self.env.fetch("tw")
        self.env.act(by_title(d, "two"), "cmd+alt")
        self.assertEqual(self.env.history(), [])
        self.assertEqual(self.env.logged()[-1], ["alfred-search", "goo tw"])

    def test_typed_query_in_history_can_be_removed(self):
        self.env.write_history([{"q": "Cats !i", "t": int(time.time() * 1000), "n": 1}])
        d = self.env.sf("cats !i")
        self.assertIs(d["items"][0]["mods"]["cmd+alt"]["valid"], True)
        self.assertEqual(d["items"][0]["arg"], "https://www.google.com/search?q=cats&udm=2&hl=en&gl=us")
        self.env.act(d["items"][0], "cmd+alt")
        self.assertEqual(self.env.history(), [])
        self.assertEqual(self.env.logged(), [["alfred-search", "goo cats !i"]])

    def test_google_links_are_remembered_as_links(self):
        d = self.env.fetch("youtu")
        row = by_title(d, "YouTube")
        row = dict(row, arg="https://www.google.com/search?q=maps")
        self.env.act(row)
        self.assertEqual(self.env.history()[0]["u"], "https://www.google.com/search?q=maps")

    def test_clear_all(self):
        now = int(time.time() * 1000)
        self.env.write_history([{"q": "one", "t": now, "n": 1}, {"q": "two", "t": now - 1, "n": 1}])
        d = self.env.sf(":clear")
        self.assertEqual(titles(d), ["Clear All 2 Saved Searches", ":clear"])
        self.assertEqual(self.env.act(d["items"][0]), "Cleared 2 saved searches")
        self.assertIsNone(self.env.history())
        d = self.env.sf(":clear")
        self.assertEqual(titles(d), ["Search history is empty", ":clear"])

    def test_limit_and_off(self):
        self.env.write_history([{"q": "q%d" % i, "t": 1000 - i, "n": 1} for i in range(60)])
        self.env.act(self.env.sf("new")["items"][0], history_limit="50")
        h = self.env.history()
        self.assertEqual(len(h), 50)
        self.assertEqual(h[0]["q"], "new")
        self.assertEqual(len(self.env.sf("", history_limit="10")["items"]), 11)
        self.assertEqual(len(self.env.sf("")["items"]), 51)  # 50 rows at most: typing finds older ones
        # turned off: nothing is shown or stored
        d = self.env.sf("new", history_limit="0")
        self.assertEqual(d["items"][0]["variables"]["gs_remember"], "0")
        self.env.act(self.env.sf("other", history_limit="0")["items"][0], history_limit="0")
        self.assertEqual(self.env.history()[0]["q"], "new")
        d = self.env.sf("", history_limit="0")
        self.assertEqual(titles(d), ["Type to search Google", "Clear Search History…"])

    def test_damaged_history(self):
        os.makedirs(self.env.data)
        with open(os.path.join(self.env.data, "history.json"), "w") as f:
            f.write("{broken")
        self.assertEqual(titles(self.env.sf("")), ["Type to search Google"])
        self.env.write_history([{"q": 5}, None, {"q": "ok", "t": 1, "n": 1}, {"q": "bad link", "t": 1, "u": "javascript:x"}])
        self.assertEqual(titles(self.env.sf("")), ["ok", "Clear Search History…"])
        self.env.act(self.env.sf("new")["items"][0])
        self.assertEqual([h["q"] for h in self.env.history()], ["new", "ok"])

    def test_private_not_remembered(self):
        d = self.env.fetch("youtu", browser="com.google.Chrome")
        self.env.act(d["items"][1], "cmd+shift", browser="com.google.Chrome")
        self.assertEqual(self.env.logged(), [["/usr/bin/open", "-n", "-b", "com.google.Chrome", "--args", "--incognito",
                                              "https://www.google.com/search?q=youtube&hl=en&gl=us"]])
        self.assertIsNone(self.env.history())

    def test_private_by_default(self):
        d = self.env.sf("x", private_window="1")
        self.assertEqual(d["items"][0]["variables"]["gs_private"], "1")
        self.assertEqual(d["items"][0]["mods"]["cmd+shift"]["variables"]["gs_private"], "0")
        self.env.act(d["items"][0], private_window="1", GS_DEFAULT_BROWSER="org.mozilla.firefox")
        self.assertEqual(self.env.logged()[-1][:6], ["/usr/bin/open", "-n", "-b", "org.mozilla.firefox", "--args", "--private-window"])

    def test_private_unsupported_and_missing_browser(self):
        d = self.env.sf("x")
        msg = self.env.act(d["items"][0], "cmd+shift", GS_DEFAULT_BROWSER="com.apple.Safari")
        self.assertTrue(msg.startswith("Couldn’t open a private window: Safari"), msg)
        self.assertEqual(self.env.logged(), [])
        msg = self.env.act(d["items"][0], browser="org.mozilla.firefox", GS_MISSING_BROWSER="org.mozilla.firefox")
        self.assertEqual(msg, "Couldn’t find Firefox: choose another browser in the Workflow’s Configuration")
        self.assertIsNone(self.env.history())
        self.env.act(d["items"][0], browser="com.apple.Safari")
        self.assertEqual(self.env.logged(), [["/usr/bin/open", "-b", "com.apple.Safari", "https://www.google.com/search?q=x&hl=en&gl=us"]])

    def test_copy_url_not_remembered(self):
        d = self.env.sf("x")
        self.assertEqual(self.env.act(d["items"][0], "cmd"), ("clipboard", "copy", "https://www.google.com/search?q=x&hl=en&gl=us"))
        self.assertIsNone(self.env.history())


# ---------- selected text ----------

class SelectionTests(Base):
    def sel(self, text, **extra):
        out = self.env.run("selection", text, **extra)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.strip()

    def test_searches_selection(self):
        self.assertEqual(self.sel("  hello\n  world  ", language="", region=""), "")
        self.assertEqual(self.env.logged(), [["/usr/bin/open", "https://www.google.com/search?q=hello+world"]])
        self.assertEqual(self.env.history()[0]["q"], "hello world")

    def test_clipboard_fallback(self):
        self.sel("", GS_CLIPBOARD="from clipboard", language="", region="")
        self.assertEqual(self.env.logged(), [["/usr/bin/open", "https://www.google.com/search?q=from+clipboard"]])
        self.sel("", GS_CLIPBOARD="ignored", clipboard_fallback="0")
        self.assertEqual(self.env.logged()[-1], ["alfred-search", "goo "])
        self.sel("", GS_CLIPBOARD="")
        self.assertEqual(self.env.logged()[-1], ["alfred-search", "goo "])

    def test_show_in_alfred(self):
        self.sel("some text", selection_mode="alfred", keyword_google="gsx")
        self.assertEqual(self.env.logged(), [["alfred-search", "gsx some text"]])
        self.assertIsNone(self.env.history())

    def test_shortcuts_and_long_text(self):
        self.sel("cats !i", language="", region="")
        self.assertEqual(self.env.logged()[-1], ["/usr/bin/open", "https://www.google.com/search?q=cats&udm=2"])
        self.sel("x" * 5000, language="", region="")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.env.logged()[-1][-1]).query)["q"][0]
        self.assertEqual(len(q), 2000)


# ---------- Alfred's runtime and the build ----------

class RuntimeTests(Base):
    def test_minimal_environment(self):
        """As Alfred runs it: no LANG, no Homebrew PATH; and a fresh install without workflow folders"""
        base = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "GS_TEST": "1",
                "GS_SUGGEST_URL": MOCK.base + "/complete/search", "GS_UNTHROTTLED": "1", "GS_LOG": self.env.log,
                "alfred_workflow_cache": os.path.join(self.env.dir, "new", "cache"), "alfred_workflow_data": os.path.join(self.env.dir, "new", "data")}
        run = lambda *a, **e: subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./google.js", *a], cwd=SRC,
                                             env=dict(base, **e), capture_output=True, text=True, timeout=60)
        out = run("search", "café", gs_prev="café")
        self.assertEqual(out.returncode, 0, out.stderr)
        d = json.loads(out.stdout)
        validate(d)
        self.assertEqual(titles(d)[:2], ["café", "café frappé"])
        out = run("act", d["items"][0]["arg"], **d["items"][0]["variables"])
        self.assertEqual((out.returncode, out.stdout), (0, ""))
        out = run("search", "")
        self.assertEqual(json.loads(out.stdout)["items"][0]["title"], "café")

    def test_info_plist(self):
        subprocess.run(["/usr/bin/python3", os.path.join(ROOT, "tools", "build.py")], check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        self.assertEqual(p["bundleid"], "io.github.x-o-r-r-o.google-search")
        self.assertEqual(p["category"], "Internet")
        objs = {o["uid"]: o for o in p["objects"]}
        sf = next(o for o in p["objects"] if o["type"] == "alfred.workflow.input.scriptfilter")
        self.assertEqual(sf["config"]["queuemode"], 2)
        self.assertEqual(sf["config"]["keyword"], "{var:keyword_google}")
        # every modifier the rows define is connected
        mods = sorted(c["modifiers"] for c in p["connections"][sf["uid"]])
        self.assertEqual(mods, sorted([0, 1048576, 524288, 262144, 131072, 8388608, 1179648, 1572864]))
        hot = next(o for o in p["objects"] if o["type"] == "alfred.workflow.trigger.hotkey")
        self.assertEqual(hot["config"]["argument"], 1)
        cond = next(o for o in p["objects"] if o["type"] == "alfred.workflow.utility.conditional")
        outs = {c.get("sourceoutputuid"): objs[c["destinationuid"]] for c in p["connections"][cond["uid"]]}
        self.assertEqual(len(outs), 3)
        self.assertIn("## Usage", p["readme"])
        self.assertNotIn("images/", p["readme"])
        for c in p["userconfigurationconfig"]:
            if c["variable"].startswith("keyword_"):
                self.assertGreaterEqual(len(c["config"]["default"]), 3)

    def test_icons_exist(self):
        with open(os.path.join(ROOT, "tools", "icons.json")) as f:
            names = [n for n in json.load(f) if n != "icon"]
        with open(os.path.join(SRC, "google.js")) as f:
            js = f.read()
        used = set(re.findall(r'icon: "([a-z]+)"', js)) | set(re.findall(r'"icons/([a-z]+)\.png"', js))
        used |= set(re.findall(r'info\([^)]*?, "([a-z]+)"', js))
        for n in used:
            self.assertIn(n, names)
            self.assertTrue(os.path.exists(os.path.join(SRC, "icons", n + ".png")), n)


@unittest.skipUnless(os.environ.get("GS_LIVE") == "1", "set GS_LIVE=1 to query the real suggest endpoint")
class LiveTests(Base):
    def test_real_suggestions(self):
        d = self.env.fetch("github", GS_SUGGEST_URL="https://suggestqueries.google.com/complete/search", GS_TEST="0")
        self.assertEqual(d["items"][0]["title"], "github")
        self.assertGreater(len(d["items"]), 3)
        self.assertTrue(any(i["arg"].startswith("https://github.com") for i in d["items"]))


if __name__ == "__main__":
    unittest.main()
