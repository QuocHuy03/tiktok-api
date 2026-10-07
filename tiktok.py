#!/usr/bin/env python3
"""TikTok web API client - single file, CLI included.

    python tiktok.py user tiktok
    python tiktok.py posts tiktok --count 16
    python tiktok.py video https://www.tiktok.com/@user/video/76xxxxxxxxx
    python tiktok.py explore --count 10
    python tiktok.py foryou --count 10
    python tiktok.py search "nau an" --pages 2
    python tiktok.py keywords "nau an"
    python tiktok.py users "nau an"
    python tiktok.py music 7385161230984316945
    python tiktok.py comments <video url> --pages 2
    python tiktok.py tag fyp
    python tiktok.py trending
    python tiktok.py tags --pages 4 --hops 3
    python tiktok.py download <url> [<url> ...] --out downloads

No browser is used. Two things make that possible:

1. **The WAF is a SHA-256 proof of work.** A cold request gets a 1.4 KB Slardar
   challenge page whose script has no canvas, no WebGL, no fingerprinting - it
   just brute-forces an integer. `solve_waf` below does the same in Python.

2. **X-Gnarly comes from TikTok's own SDK run in node:vm.** No export returns
   it; it is stamped on by a fetch monkey-patch. The `signer/` service loads the
   three bundles outside a browser and signs there. Commands that need a
   signature say so if it is not running; `user`, `video` and `download` do not
   need it.

Requires: curl_cffi (`pip install curl_cffi`). TLS fingerprint matters - plain
requests/httpx get dropped before TikTok looks at anything else.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import pathlib
import random
import re
import sys
import time
from urllib.parse import quote, urlencode

from curl_cffi import requests as cffi

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "https://www.tiktok.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
IMPERSONATE = "chrome131"
SIGNER = "http://127.0.0.1:8081"
TIMEOUT = 25
HTTP_ATTEMPTS = 6

SSR_RE = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>',
    re.S,
)
ITEM_ID_RE = re.compile(r"/video/(\d{17,20})")
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_DEVICE_ID = str(random.randint(7250000000000000000, 7390000000000000000))


class TikTokError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# WAF: a SHA-256 proof of work, not a fingerprint check
# --------------------------------------------------------------------------- #

_CLASS_RE = {
    k: (
        re.compile(rf'id="{k}"[^>]*class="([^"]*)"', re.I),
        re.compile(rf'class="([^"]*)"[^>]*id="{k}"', re.I),
    )
    for k in ("wci", "cs", "rci", "rs", "rs_id")
}


def _b64(data: str) -> bytes:
    """Decode base64 the way `atob` does - padding optional."""
    return base64.b64decode(data + "=" * (-len(data) % 4))


def is_challenge(html: str) -> bool:
    return "SlardarWAF" in html or 'id="cs"' in html


def _field(html: str, key: str) -> str | None:
    for pattern in _CLASS_RE[key]:
        m = pattern.search(html)
        if m:
            return m.group(1)
    return None


def solve_waf(html: str, max_iterations: int = 2_000_000) -> dict[str, str]:
    """Return the cookies the challenge script would have set.

    The page carries its inputs in `class` attributes; the answer is the first
    integer whose sha256(prefix + str(i)) matches the expected digest.
    """
    cs, wci = _field(html, "cs"), _field(html, "wci")
    if not cs or not wci:
        raise TikTokError("not a WAF challenge page")
    try:
        challenge = json.loads(_b64(cs))
        prefix = _b64(challenge["v"]["a"])
        expect = _b64(challenge["v"]["c"]).hex()
    except Exception as e:
        raise TikTokError(f"malformed challenge: {e}")

    for i in range(max_iterations):
        if hashlib.sha256(prefix + str(i).encode()).hexdigest() == expect:
            challenge["d"] = base64.b64encode(str(i).encode()).decode()
            cookies = {
                wci: base64.b64encode(
                    json.dumps(challenge, separators=(",", ":")).encode()
                ).decode()
            }
            rci, rs = _field(html, "rci"), _field(html, "rs")
            if rci and rs:
                cookies[rci] = rs
            rs_id = _field(html, "rs_id")
            if rs_id:
                cookies["waforigin_id"] = rs_id
            return cookies
    raise TikTokError(f"no solution below {max_iterations} iterations")


# --------------------------------------------------------------------------- #
# request building
# --------------------------------------------------------------------------- #


def base_params(referer: str = "", login_cookie: str = "", **overrides) -> dict:
    """The query string TikTok's web client sends on every /api/* call.

    The params have to agree with the cookies: user_is_login=false alongside a
    live sessionid is rejected, and the failure looks exactly like gating.
    """
    logged_in = "sessionid=" in (login_cookie or "")
    m = re.search(r"multi_sids=(\d+)", login_cookie or "")
    odin_id = m.group(1) if m else ""
    m = re.search(r"store-country-code=([a-zA-Z]{2})", login_cookie or "")
    region = m.group(1).upper() if m else "US"

    now = int(time.time())
    params = {
        "WebIdLastTime": str(now - random.randint(3600, 86400)),
        "aid": "1988",
        "app_language": "en",
        "app_name": "tiktok_web",
        "browser_language": "en-US",
        "browser_name": "Mozilla",
        "browser_online": "true",
        "browser_platform": "Win32",
        "browser_version": UA.replace("Mozilla/", ""),
        "channel": "tiktok_web",
        "cookie_enabled": "true",
        "coverFormat": "2",
        "data_collection_enabled": "true",
        "device_id": _DEVICE_ID,
        "device_platform": "web_pc",
        "focus_state": "true",
        "from_page": "video",
        "history_len": str(random.randint(3, 9)),
        "is_fullscreen": "false",
        "is_page_visible": "true",
        "language": "en",
        "os": "windows",
        "priority_region": region if logged_in else "",
        "referer": referer,
        "root_referer": referer,
        "region": region,
        "screen_height": "800",
        "screen_width": "1280",
        # TikTok's own JS emits the Asia/Saigon alias, not Asia/Ho_Chi_Minh.
        "tz_name": "Asia/Saigon",
        "user_is_login": "true" if logged_in else "false",
        "webcast_language": "en",
    }
    if odin_id:
        params["odinId"] = odin_id
    params.update({k: v for k, v in overrides.items() if v is not None})
    return params


def page_headers(cookie: str = "") -> dict:
    h = {
        "User-Agent": UA,
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,*/*;q=0.8"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    }
    if cookie:
        h["Cookie"] = cookie
    return h


def api_headers(cookie: str, referer: str) -> dict:
    """Copied from a captured browser request - an exact replay of which TikTok
    accepted. The browser sends no Origin here, and does send the client hints."""
    return {
        "Cookie": cookie,
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US",
        "Referer": referer,
        "priority": "u=1, i",
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }


def merge_cookies(*jars: str) -> str:
    merged: dict[str, str] = {}
    for jar in jars:
        for part in (jar or "").split(";"):
            part = part.strip()
            if "=" in part:
                name, _, value = part.partition("=")
                merged[name.strip()] = value
    return "; ".join(f"{k}={v}" for k, v in merged.items())


# --------------------------------------------------------------------------- #
# client
# --------------------------------------------------------------------------- #


class TikTok:
    def __init__(self, login_cookie: str = "", signer: str = SIGNER, verbose: bool = False):
        self.login = login_cookie
        self.signer = signer.rstrip("/")
        self.verbose = verbose
        # One session per route family. A WAF token minted on a profile page
        # gets a 403 on a video page, and a shared session carries the wrong
        # one across without saying so.
        self._sessions: dict[str, cffi.Session] = {}
        self._jars: dict[str, str] = {}

    def log(self, *a):
        if self.verbose:
            print("   ", *a, file=sys.stderr)

    def _session(self, kind: str) -> cffi.Session:
        if kind not in self._sessions:
            self._sessions[kind] = cffi.Session()
        return self._sessions[kind]

    @staticmethod
    def _kind(url: str) -> str:
        return "video" if "/video/" in url else "profile"

    def jar(self, kind: str) -> str:
        return merge_cookies(self._jars.get(kind, ""), self.login)

    def verify_fp(self, kind: str = "profile") -> str:
        """`verifyFp` is the session's own `s_v_web_id` cookie under another
        name. Requests that omit it come back empty, which is what made the
        uploads route look gated for so long."""
        m = re.search(r"s_v_web_id=(verify_[\w-]+)", self.jar(kind))
        return m.group(1) if m else ""

    # -- page fetch -------------------------------------------------------- #

    def page(self, url: str) -> dict:
        """Fetch a TikTok page and return its SSR rehydration scope."""
        kind = self._kind(url)
        last = ""
        for attempt in range(HTTP_ATTEMPTS):
            sess = self._session(kind)
            r = sess.get(
                url, headers=page_headers(self.jar(kind)),
                impersonate=IMPERSONATE, timeout=TIMEOUT, allow_redirects=True,
            )
            html = r.text or ""

            if r.status_code == 200 and is_challenge(html):
                solved = solve_waf(html)
                self._jars[kind] = merge_cookies(self._jars.get(kind, ""), "; ".join(
                    f"{k}={v}" for k, v in solved.items()))
                self.log(f"solved WAF ({len(solved)} cookies)")
                r = sess.get(
                    url, headers=page_headers(self.jar(kind)),
                    impersonate=IMPERSONATE, timeout=TIMEOUT, allow_redirects=True,
                )
                html = r.text or ""

            if r.status_code == 403 or is_challenge(html):
                last = f"blocked (HTTP {r.status_code})"
                self._jars.pop(kind, None)
                continue

            m = SSR_RE.search(html)
            if not m:
                # TikTok's edge intermittently serves a ~43 KB shell instead of
                # the full page. It comes back fast, so retrying is cheap.
                last = f"shell page ({len(html) // 1024} KB)"
                self.log(f"attempt {attempt + 1}: {last}")
                time.sleep(0.25)
                continue

            # Harvest on every success: the WAF only challenges sometimes, and
            # the video CDN answers 403 without these cookies.
            issued = {k: v for k, v in sess.cookies.items() if v}
            if issued:
                self._jars[kind] = merge_cookies(
                    self._jars.get(kind, ""),
                    "; ".join(f"{k}={v}" for k, v in issued.items()),
                )
            return json.loads(m.group(1)).get("__DEFAULT_SCOPE__") or {}

        raise TikTokError(f"{url}: {last}")

    # -- signed / unsigned api --------------------------------------------- #

    def _sign(self, url: str, cookie: str, referer: str) -> dict:
        try:
            r = cffi.post(
                f"{self.signer}/sign",
                json={"url": url, "backend": "native", "cookie": cookie, "referer": referer},
                timeout=120,
            )
        except Exception as e:
            raise TikTokError(
                f"signer not reachable at {self.signer} ({e}). "
                "Start it:  cd signer && node server.js"
            )
        if r.status_code != 200:
            raise TikTokError(f"signing failed: {r.text[:160]}")
        return r.json()

    def api(self, path: str, params: dict, referer: str, signed: bool = True) -> dict:
        kind = self._kind(referer)
        if not self._jars.get(kind):
            # Cheap way to get a jar: touch a page of the right kind.
            try:
                self.page(referer if referer.startswith(HOST) else HOST + "/@tiktok")
            except TikTokError:
                pass
        cookie = self.jar(kind)
        params = {**params, "referer": referer, "root_referer": referer}
        url = f"{HOST}{path}?{urlencode(params)}"

        if signed:
            signed_out = self._sign(url, cookie, referer)
            url = signed_out["url"]

        r = self._session(kind).get(
            url, headers=api_headers(cookie, referer),
            impersonate=IMPERSONATE, timeout=TIMEOUT,
        )
        body = r.text or ""
        if not body.strip():
            raise TikTokError(
                f"{path}: empty body - gated to logged-in sessions "
                "(a real browser gets nothing here as a guest either)"
            )
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise TikTokError(f"{path}: non-JSON response")
        code = data.get("statusCode", data.get("status_code", 0))
        if code not in (0, None):
            raise TikTokError(f"{path}: tiktok statusCode={code}")
        return data

    # -- endpoints ---------------------------------------------------------- #

    def user(self, handle: str) -> dict:
        handle = handle.lstrip("@")
        scope = self.page(f"{HOST}/@{handle}")
        detail = scope.get("webapp.user-detail") or {}
        if not (detail.get("userInfo") or {}).get("user"):
            raise TikTokError(f"@{handle}: not found")
        return norm_user(detail)

    def video(self, target: str) -> dict:
        url = target if target.startswith("http") else f"{HOST}/@tiktok/video/{target}"
        scope = self.page(url)
        struct = (scope.get("webapp.video-detail") or {}).get("itemInfo", {}).get("itemStruct")
        if not struct:
            raise TikTokError(f"{target}: not found or unavailable")
        return norm_video(struct)

    def explore(self, count: int = 16, cursor: int = 0, category: int = 119) -> list[dict]:
        data = self.api(
            "/api/explore/item_list/",
            base_params(login_cookie=self.login, count=str(count), cursor=str(cursor),
                        categoryType=str(category), from_page="explore"),
            f"{HOST}/explore",
        )
        return [norm_video(i) for i in (data.get("itemList") or [])]

    def foryou(self, count: int = 10) -> list[dict]:
        """The For You feed - a second video source alongside `explore`, and the
        one that reflects what TikTok is actually pushing right now."""
        data = self.api(
            "/api/recommend/item_list/",
            base_params(login_cookie=self.login, count=str(count), from_page="fyp"),
            HOST + "/",
        )
        return [norm_video(i) for i in (data.get("itemList") or [])]

    def categories(self) -> list[dict]:
        """Real explore category ids, instead of guessing the numbers."""
        data = self.api(
            "/api/explore/category_list/",
            base_params(login_cookie=self.login, count="20", from_page="explore"),
            f"{HOST}/explore",
        )
        return [
            {"type": c.get("type"), "name": c.get("name")}
            for c in (data.get("categoryList") or [])
        ]

    def sound(self, music_id: str) -> dict:
        """Sound metadata. Note the param is `musicId` here and `musicID` on the
        item list - the casing differs between the two routes."""
        data = self.api(
            "/api/music/detail/",
            base_params(login_cookie=self.login, musicId=str(music_id), from_page="music"),
            HOST + "/",
        )
        info = (data.get("musicInfo") or {}).get("music") or {}
        stats = (data.get("musicInfo") or {}).get("stats") or {}
        return {
            "id": info.get("id"),
            "title": info.get("title"),
            "author": info.get("authorName"),
            "duration": info.get("duration"),
            "original": info.get("original"),
            "play_url": info.get("playUrl"),
            "videos": stats.get("videoCount"),
        }

    def music_posts(self, music_id: str, count: int = 30, cursor: int = 0) -> list[dict]:
        data = self.api(
            "/api/music/item_list/",
            base_params(login_cookie=self.login, musicID=str(music_id),
                        count=str(count), cursor=str(cursor), from_page="music"),
            HOST + "/",
        )
        return [norm_video(i) for i in (data.get("itemList") or [])]

    def tag(self, name: str) -> dict:
        name = name.lstrip("#")
        data = self.api(
            "/api/challenge/detail/",
            base_params(login_cookie=self.login, challengeName=name, from_page="hashtag"),
            f"{HOST}/tag/{name}",
        )
        ci = data.get("challengeInfo") or {}
        info, stats, v2 = ci.get("challenge") or {}, ci.get("stats") or {}, ci.get("statsV2") or {}
        return {
            "id": info.get("id"),
            "title": info.get("title"),
            "desc": info.get("desc"),
            "views": count_of(stats, v2, "viewCount"),
            "videos": count_of(stats, v2, "videoCount"),
        }

    def keywords(self, keyword: str = "", count: int = 10) -> dict:
        """Search itself is gated; its autocomplete neighbours are not."""
        referer = f"{HOST}/search?q={quote(keyword)}" if keyword else HOST + "/"
        out: dict = {"keyword": keyword or None, "suggestions": [], "trending": []}
        p = base_params(login_cookie=self.login, keyword=keyword, count=str(count),
                        cursor="0", from_page="search")
        if keyword:
            try:
                d = self.api("/api/search/general/preview/", p, referer)
                out["suggestions"] = [
                    s["content"] for s in (d.get("sug_list") or []) if s.get("content")
                ]
            except TikTokError as e:
                out["suggestions_error"] = str(e)[:100]
        try:
            out["trending"] = [t["word"] for t in self.trending(count)]
        except TikTokError:
            # Fall back to the unsigned guide route, which needs no signature.
            try:
                d = self.api("/api/search/suggest/guide/", p, referer, signed=False)
                out["trending"] = [w["word"] for w in (d.get("data") or []) if w.get("word")]
            except TikTokError as e:
                out["trending_error"] = str(e)[:100]
        return out

    def trending(self, count: int = 20) -> list[dict]:
        """Trending search terms.

        `/api/trending/searchwords/` answers only with `from_page=search` and a
        search referer - with anything else it returns statusCode 100002, which
        reads like a block but is a parameter error.
        """
        data = self.api(
            "/api/trending/searchwords/",
            base_params(login_cookie=self.login, count=str(count), from_page="search"),
            f"{HOST}/search",
        )
        return [
            {"word": w.get("trendingSearchWord"), "type": w.get("trendingSearchWordType")}
            for w in (data.get("trending_search_words") or [])
            if w.get("trendingSearchWord")
        ]

    def tags(self, pages: int = 3, count: int = 30, music_hops: int = 0) -> list[dict]:
        """Which hashtags are actually moving, mined from the feed.

        `/api/challenge/item_list/` (videos under a tag) is gated, so tags cannot
        be searched directly. They can be *mined*: every video carries its own
        hashtags, so sampling the feed and aggregating gives frequency and the
        reach behind each tag. `music_hops` widens the sample through the sound
        edge, the only expanding link that still works.
        """
        seen: dict[str, dict] = {}
        sounds: list[str] = []

        def absorb(videos: list[dict]):
            for v in videos:
                plays = v["stats"]["plays"] or 0
                mid = (v.get("music") or {}).get("id")
                if mid and mid not in sounds:
                    sounds.append(mid)
                for tag in v["hashtags"]:
                    row = seen.setdefault(tag, {"tag": tag, "videos": 0, "plays": 0, "top": 0})
                    row["videos"] += 1
                    row["plays"] += plays
                    row["top"] = max(row["top"], plays)

        for i in range(pages):
            absorb(self.explore(count, cursor=i * count))
        for mid in sounds[:music_hops]:
            try:
                absorb(self.music_posts(mid, count))
            except TikTokError:
                continue

        rows = sorted(seen.values(), key=lambda r: (r["videos"], r["plays"]), reverse=True)
        for r in rows:
            r["avg_plays"] = r["plays"] // r["videos"] if r["videos"] else 0
        return rows

    def posts(self, handle: str, count: int = 16, cursor: int = 0,
              pages: int = 1) -> dict:
        """A profile's uploads.

        This looked gated for a long time - every attempt returned 200 with an
        empty body. It was not: the request was missing `verifyFp` (the
        `s_v_web_id` cookie) and four flags the app always sends. Captured from
        a real Chrome window with `signer/scripts/capture-posts-real.js`, which
        is also how to re-derive it if TikTok changes the shape again.
        """
        handle = handle.lstrip("@")
        profile = f"{HOST}/@{handle}"
        user = self.user(handle)          # also warms the jar for this profile
        sec_uid = user["sec_uid"]

        p = base_params(
            login_cookie=self.login,
            secUid=sec_uid,
            count=str(count),
            cursor=str(cursor),
            from_page="user",
            post_item_list_request_type="0",
            needPinnedItemIds="true",
            enable_cache="false",
            video_encoding="dash",
            coverFormat="2",
            verifyFp=self.verify_fp("profile"),
        )
        try:
            data = self.api("/api/post/item_list/", p, profile)
            items = data.get("itemList") or []
        except TikTokError:
            items = []
            data = {}

        if not items:
            # Expected: this route is single-use. The browser's own request
            # works, but replaying it byte-for-byte seconds later returns an
            # empty body - the msToken in the query is consumed per request. So
            # the request has to originate in a session that mints its own, and
            # headless Chromium will not do: it never renders the grid, so the
            # request is never made at all.
            self.log("HTTP path empty (expected) - reading it from a real browser")
            data = self._posts_via_browser(handle, pages)
            items = data.get("itemList") or []

        return {
            "user": user,
            "videos": [norm_video(i) for i in items],
            "cursor": data.get("cursor"),
            "has_more": bool(data.get("hasMore")),
        }

    def _posts_via_browser(self, handle: str, pages: int = 1) -> dict:
        return self._via_browser("fetch-posts.js", [handle, "--pages", str(pages)])

    def _via_browser(self, script_name: str, argv: list[str]) -> dict:
        """Run one of the signer's browser scripts and read its JSON.

        These open a real Chrome window. That is not stubbornness: the routes
        they cover answer only to a session that mints its own single-use token,
        and headless Chromium never renders the UI that triggers the request.
        """
        import subprocess

        script = pathlib.Path(__file__).parent / "signer" / "scripts" / script_name
        if not script.exists():
            raise TikTokError(f"{script} is missing")
        env = None
        if self.login:
            import os
            import tempfile

            fh = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt",
                                             encoding="utf-8")
            fh.write(self.login)
            fh.close()
            env = {**os.environ, "COOKIE_FILE": fh.name}
        proc = subprocess.run(
            ["node", str(script), *argv],
            capture_output=True,
            text=True,
            # Descriptions are Vietnamese; Windows would otherwise decode the
            # pipe as cp1252 and throw.
            encoding="utf-8",
            errors="replace",
            timeout=300,
            env=env,
            cwd=str(script.parent.parent),
        )
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            tail = (proc.stderr or "").strip().splitlines()[-1:] or ["no output"]
            raise TikTokError(f"browser fetch failed: {tail[0][:120]}")
        return json.loads(proc.stdout)

    def comments(self, target: str, count: int = 50, pages: int = 1,
                 replies: bool = False) -> dict:
        """A video's comments.

        This one wants the *opposite* of every other route here: four params,
        no signature. Sending the full browser param set returns an empty body,
        which is what made it look gated for so long - the signature was never
        the problem. Isolated:

            minimal params, unsigned -> 19 comments
            full params,    unsigned ->  0
            full params,    signed   ->  0
            minimal params, signed   -> 18 comments

        So the rule is per-endpoint, not global: `music/item_list` is the mirror
        image and returns nothing *without* the full set.
        """
        v = self.video(target)
        out: list[dict] = []
        seen: set[str] = set()
        cursor, has_more, total = 0, True, None

        for _ in range(max(1, pages)):
            if not has_more:
                break
            data = self._plain(
                "/api/comment/list/",
                {"aweme_id": v["id"], "aid": 1988, "count": count, "cursor": cursor},
            )
            batch = data.get("comments") or []
            total = data.get("total", total)
            for c in batch:
                cid = c.get("cid")
                if not cid or cid in seen:
                    continue  # TikTok repeats entries across pages
                seen.add(cid)
                out.append(norm_comment(c))
            has_more = bool(data.get("has_more"))
            cursor = data.get("cursor") or cursor + count

        if replies:
            for c in out:
                if not c["replies"]:
                    continue
                c["reply_list"] = self.comment_replies(v["id"], c["id"])

        return {
            "video": {"id": v["id"], "url": v["url"], "desc": v["desc"],
                      "author": v["author"]["unique_id"]},
            "comments": out,
            "total": total,
            "has_more": has_more,
            "cursor": cursor,
        }

    def comment_replies(self, item_id: str, comment_id: str,
                        count: int = 50, pages: int = 1) -> list[dict]:
        """Replies under one comment - same minimal, unsigned shape."""
        out, seen, cursor, has_more = [], set(), 0, True
        for _ in range(max(1, pages)):
            if not has_more:
                break
            data = self._plain(
                "/api/comment/list/reply/",
                {"item_id": item_id, "comment_id": comment_id,
                 "aid": 1988, "count": count, "cursor": cursor},
            )
            for c in data.get("comments") or []:
                cid = c.get("cid")
                if cid and cid not in seen:
                    seen.add(cid)
                    out.append(norm_comment(c))
            has_more = bool(data.get("has_more"))
            cursor = data.get("cursor") or cursor + count
        return out

    def _plain(self, path: str, params: dict) -> dict:
        """Unsigned GET with only the params given - no base_params, no jar."""
        sess = self._session("plain")
        last = ""
        for attempt in range(3):
            r = sess.get(
                HOST + path,
                params=params,
                headers={"User-Agent": UA, "Referer": HOST + "/"},
                impersonate=IMPERSONATE,
                timeout=TIMEOUT,
            )
            body = r.text or ""
            if body.strip():
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    last = "non-JSON"
            else:
                last = f"empty body (HTTP {r.status_code})"
            time.sleep(0.5 * (attempt + 1))
        raise TikTokError(f"{path}: {last}")

    def users(self, keyword: str, count: int = 10) -> list[dict]:
        """/api/search/user/full/ is gated; this suggestion route is not."""
        data = self.api(
            "/api/comment/search/sug/user/",
            base_params(login_cookie=self.login, keyword=keyword,
                        count=str(count), cursor="0", from_page="search"),
            f"{HOST}/search?q={quote(keyword)}",
        )
        out = []
        for entry in data.get("userList") or []:
            u = entry.get("user") or entry
            out.append({
                "unique_id": u.get("uniqueId"),
                "nickname": u.get("nickname"),
                "verified": bool(u.get("verified")),
                "url": f"{HOST}/@{u.get('uniqueId')}",
            })
        return out

    # -- download ----------------------------------------------------------- #

    def download(self, target: str, out_dir: pathlib.Path) -> dict:
        """The CDN needs Referer + Range + Cookie together; drop one and it 403s."""
        v = self.video(target)
        author = v["author"]["unique_id"] or "unknown"
        name = f"{v['id']}_{safe_name(v['desc'] or '')}.mp4"
        dest = out_dir / author / name
        if dest.exists():
            return {"path": str(dest), "bytes": dest.stat().st_size, "cached": True}

        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.with_suffix(".mp4.part")
        cookie = self.jar("video")
        headers = {
            "User-Agent": UA,
            "Referer": HOST + "/",
            "Range": "bytes=0-",
            "Cookie": cookie,
            "Accept": "*/*",
        }
        last = ""
        for url in (v["download_url"], v["play_url"]):
            if not url:
                continue
            started = time.perf_counter()
            try:
                r = self._session("video").get(
                    url, headers=headers, impersonate=IMPERSONATE,
                    timeout=TIMEOUT, stream=True,
                )
                if r.status_code not in (200, 206):
                    last = f"HTTP {r.status_code}"
                    r.close()
                    continue
                written = 0
                with partial.open("wb") as fh:
                    for chunk in r.iter_content(256 * 1024):
                        if chunk:
                            fh.write(chunk)
                            written += len(chunk)
                r.close()
                if not written:
                    last = "empty response"
                    continue
                partial.replace(dest)
                return {
                    "path": str(dest), "bytes": written, "cached": False,
                    "seconds": round(time.perf_counter() - started, 2), "video": v,
                }
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
            finally:
                partial.unlink(missing_ok=True)
        raise TikTokError(f"download failed: {last}")


# --------------------------------------------------------------------------- #
# normalising
# --------------------------------------------------------------------------- #


def count_of(stats: dict, stats_v2: dict, key: str):
    """Prefer statsV2.

    TikTok left the old `stats` block reading 0 for anything past JavaScript's
    safe integer range and moved the real values into `statsV2` as strings.
    #fyp reports 0 videos against 127 trillion views in one and 9.2 billion in
    the other; statsV2 is also exact where stats is rounded.
    """
    raw = (stats_v2 or {}).get(key)
    if raw is None:
        raw = (stats or {}).get(key)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return raw


def norm_video(item: dict) -> dict:
    v, a = item.get("video") or {}, item.get("author") or {}
    s, s2, m = item.get("stats") or {}, item.get("statsV2") or {}, item.get("music") or {}
    return {
        "id": item.get("id"),
        "url": f"{HOST}/@{a.get('uniqueId')}/video/{item.get('id')}",
        "desc": item.get("desc"),
        "created_at": item.get("createTime"),
        "duration": v.get("duration"),
        "cover": v.get("cover"),
        "play_url": v.get("playAddr") or None,
        "download_url": v.get("downloadAddr") or None,
        "author": {
            "id": a.get("id"), "unique_id": a.get("uniqueId"),
            "nickname": a.get("nickname"), "sec_uid": a.get("secUid"),
            "verified": a.get("verified", False),
        },
        "music": {
            "id": m.get("id"), "title": m.get("title"),
            "author": m.get("authorName"), "original": m.get("original", False),
        },
        "stats": {
            "plays": count_of(s, s2, "playCount"),
            "likes": count_of(s, s2, "diggCount"),
            "comments": count_of(s, s2, "commentCount"),
            "shares": count_of(s, s2, "shareCount"),
            "collects": count_of(s, s2, "collectCount"),
        },
        "hashtags": [t["hashtagName"] for t in (item.get("textExtra") or []) if t.get("hashtagName")],
    }


def norm_user(payload: dict) -> dict:
    info = payload.get("userInfo") or {}
    u, s, s2 = info.get("user") or {}, info.get("stats") or {}, info.get("statsV2") or {}
    # `region` is gone from the payload; `language` is what is left of it.
    return {
        "id": u.get("id"),
        "unique_id": u.get("uniqueId"),
        "nickname": u.get("nickname"),
        "sec_uid": u.get("secUid"),
        "avatar": u.get("avatarLarger"),
        "signature": u.get("signature"),
        "language": u.get("language"),
        "created_at": u.get("createTime"),
        "verified": u.get("verified", False),
        "private": bool(u.get("privateAccount") or u.get("secret")),
        "stats": {
            "followers": count_of(s, s2, "followerCount"),
            "following": count_of(s, s2, "followingCount"),
            "likes": count_of(s, s2, "heartCount"),
            "videos": count_of(s, s2, "videoCount"),
        },
    }


def norm_comment(c: dict) -> dict:
    u = c.get("user") or {}
    return {
        "id": c.get("cid"),
        "text": c.get("text"),
        "created_at": c.get("create_time"),
        "likes": c.get("digg_count"),
        "replies": c.get("reply_comment_total") or 0,
        "author": {
            "unique_id": u.get("unique_id"),
            "nickname": u.get("nickname"),
            "id": u.get("uid"),
        },
    }


def safe_name(text: str, limit: int = 70) -> str:
    cleaned = re.sub(r"\s+", " ", _UNSAFE.sub("", text or "")).strip().rstrip(".")
    return cleaned[:limit].strip() or "video"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def show(obj, as_json: bool):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
        return
    if isinstance(obj, list):
        for row in obj:
            show(row, False)
            print()
        return
    if not isinstance(obj, dict):
        print(obj)
        return
    for k, v in obj.items():
        if isinstance(v, dict):
            inner = "  ".join(f"{ik}={iv}" for ik, iv in v.items() if iv not in (None, "", False))
            print(f"  {k:12} {inner}")
        elif isinstance(v, list):
            print(f"  {k:12} {', '.join(map(str, v)) if v else '-'}")
        elif v not in (None, ""):
            text = str(v)
            print(f"  {k:12} {text[:110] + '...' if len(text) > 110 else text}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="TikTok web API client (no browser)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("No browser")[0],
    )
    # Shared flags live in a parent parser so they work on either side of the
    # subcommand - `tiktok.py users foo --json` is what people actually type.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="raw JSON output")
    common.add_argument("--login", default="", help="account cookie header")
    common.add_argument("--signer", default=SIGNER)
    common.add_argument("-v", "--verbose", action="store_true")
    for a in common._actions:
        ap._add_action(a)
    sub = ap.add_subparsers(dest="cmd", required=True, parser_class=lambda **kw: argparse.ArgumentParser(parents=[common], **kw))

    p = sub.add_parser("user", help="profile by @handle");           p.add_argument("handle")
    p = sub.add_parser("video", help="video by url or id");          p.add_argument("target")
    p = sub.add_parser("explore", help="public feed")
    p.add_argument("--count", type=int, default=12)
    p.add_argument("--cursor", type=int, default=0)
    p = sub.add_parser("keywords", help="related + trending terms")
    p.add_argument("keyword", nargs="?", default="")
    p.add_argument("--count", type=int, default=10)
    p = sub.add_parser("search", help="videos by keyword")
    p.add_argument("keyword")
    p.add_argument("--count", type=int, default=12)
    p.add_argument("--pages", type=int, default=1)
    p.add_argument("--kind", default="general", choices=["general", "photo", "video"])
    p = sub.add_parser("users", help="accounts by keyword");         p.add_argument("keyword")
    p.add_argument("--count", type=int, default=10)
    p = sub.add_parser("music", help="videos using a sound");        p.add_argument("music_id")
    p.add_argument("--count", type=int, default=20)
    p = sub.add_parser("tag", help="hashtag stats");                 p.add_argument("name")
    p = sub.add_parser("posts", help="a profile's uploads")
    p.add_argument("handle")
    p.add_argument("--count", type=int, default=16)
    p.add_argument("--cursor", type=int, default=0)
    p.add_argument("--pages", type=int, default=1, help="how many pages to scroll")
    p = sub.add_parser("comments", help="a video's comments")
    p.add_argument("target")
    p.add_argument("--count", type=int, default=50)
    p.add_argument("--pages", type=int, default=1)
    p.add_argument("--replies", action="store_true", help="also fetch replies")
    p = sub.add_parser("foryou", help="the For You feed")
    p.add_argument("--count", type=int, default=10)
    sub.add_parser("categories", help="explore category ids")
    p = sub.add_parser("sound", help="sound metadata");              p.add_argument("music_id")
    p = sub.add_parser("trending", help="trending search terms")
    p.add_argument("--count", type=int, default=20)
    p = sub.add_parser("tags", help="hashtags mined from the feed, ranked")
    p.add_argument("--pages", type=int, default=3)
    p.add_argument("--count", type=int, default=30)
    p.add_argument("--hops", type=int, default=0, help="widen through sounds")
    p.add_argument("--top", type=int, default=20)
    p = sub.add_parser("download", help="download videos");          p.add_argument("targets", nargs="+")
    p.add_argument("--out", default="downloads")

    args = ap.parse_args()
    tt = TikTok(login_cookie=args.login, signer=args.signer, verbose=args.verbose)

    try:
        if args.cmd == "user":
            show(tt.user(args.handle), args.json)
        elif args.cmd == "video":
            show(tt.video(args.target), args.json)
        elif args.cmd == "explore":
            show(tt.explore(args.count, args.cursor), args.json)
        elif args.cmd == "keywords":
            show(tt.keywords(args.keyword, args.count), args.json)
        elif args.cmd == "search":
            out = tt.search(args.keyword, args.count, args.pages, args.kind)
            if args.json:
                show(out, True)
            else:
                print(f"  {args.keyword!r}: {len(out['videos'])} videos  "
                      f"has_more={out['has_more']}")
                for v in out["videos"]:
                    print(f"    {v['stats']['plays']:>11,}  @{(v['author']['unique_id'] or '')[:20]:22} "
                          f"{(v['desc'] or '')[:40]}")
        elif args.cmd == "users":
            show(tt.users(args.keyword, args.count), args.json)
        elif args.cmd == "music":
            show(tt.music_posts(args.music_id, args.count), args.json)
        elif args.cmd == "tag":
            show(tt.tag(args.name), args.json)
        elif args.cmd == "posts":
            out = tt.posts(args.handle, args.count, args.cursor, args.pages)
            if args.json:
                show(out, True)
            else:
                u = out["user"]
                print(f"  @{u['unique_id']}  {u['stats']['videos']} videos, "
                      f"{u['stats']['followers']:,} followers")
                for v in out["videos"]:
                    print(f"    {v['stats']['plays']:>11,}  {v['id']}  {(v['desc'] or '')[:44]}")
                print(f"  has_more={out['has_more']} cursor={out['cursor']}")
        elif args.cmd == "comments":
            out = tt.comments(args.target, args.count, args.pages, args.replies)
            if args.json:
                show(out, True)
            else:
                v = out["video"]
                print(f"  @{v['author']}  {v['id']}  total={out['total']}")
                for c in out["comments"]:
                    print(f"    {c['likes'] or 0:>6} likes  @{(c['author']['unique_id'] or '?')[:18]:20} "
                          f"{(c['text'] or '')[:52]}")
                print(f"  {len(out['comments'])} comments  has_more={out['has_more']}")
        elif args.cmd == "foryou":
            show(tt.foryou(args.count), args.json)
        elif args.cmd == "categories":
            rows = tt.categories()
            if args.json:
                show(rows, True)
            else:
                for c in rows:
                    print(f"  {c['type']:>4}  {c['name']}")
        elif args.cmd == "sound":
            show(tt.sound(args.music_id), args.json)
        elif args.cmd == "trending":
            rows = tt.trending(args.count)
            if args.json:
                show(rows, True)
            else:
                for i, t in enumerate(rows, 1):
                    print(f"  {i:>2}. {t['word']}")
        elif args.cmd == "tags":
            rows = tt.tags(args.pages, args.count, args.hops)[: args.top]
            if args.json:
                show(rows, True)
            else:
                print(f"  {'tag':28} {'videos':>6} {'total plays':>14} {'avg':>12}")
                for r in rows:
                    print(
                        f"  #{r['tag'][:26]:27} {r['videos']:>6} "
                        f"{r['plays']:>14,} {r['avg_plays']:>12,}"
                    )
        elif args.cmd == "download":
            out = pathlib.Path(args.out)
            ok = 0
            for n, t in enumerate(args.targets, 1):
                try:
                    res = tt.download(t, out)
                except TikTokError as e:
                    print(f"[{n}/{len(args.targets)}] {e}")
                    continue
                mb = res["bytes"] / 1024 / 1024
                note = "cached" if res.get("cached") else f"{res['seconds']}s"
                print(f"[{n}/{len(args.targets)}] {mb:.1f}MB in {note}  {res['path']}")
                ok += 1
            print(f"\n{ok}/{len(args.targets)} downloaded")
    except TikTokError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
