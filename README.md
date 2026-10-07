# TikTok API — one file, no browser

`tiktok.py` is the whole client. A Node service signs requests; nothing ever
launches Chromium.

```bash
python tiktok.py user tiktok
python tiktok.py video https://www.tiktok.com/@user/video/76xxxxxxxxx
python tiktok.py explore --count 10
python tiktok.py foryou --count 10
python tiktok.py categories
python tiktok.py sound 7385161230984316945
python tiktok.py keywords "nau an"
python tiktok.py users "nau an"
python tiktok.py music 7385161230984316945
python tiktok.py tag fyp
python tiktok.py trending
python tiktok.py tags --pages 4 --hops 3
python tiktok.py download <url> [<url> ...] --out downloads
```

Add `--json` for raw output, `--login "<cookie header>"` to act as an account,
`-v` to see what it is doing.

## Setup

```bash
pip install curl_cffi
cd signer && npm install          # Node only; Chromium is never started
node server.js                    # :8081
```

`user`, `video` and `download` work without the signer. The rest need it,
because they need `X-Gnarly`.

## Tags and keywords

Videos under a hashtag (`/api/challenge/item_list/`) are gated, so tags cannot be
*searched*. They can be **mined**: every video carries its own hashtags, so
sampling the feed and aggregating gives frequency and the reach behind each tag.

```
$ python tiktok.py tags --pages 3 --top 6
  tag                          videos    total plays          avg
  #xuhuong                         14     18,679,700    1,334,264
  #fyp                              9     20,819,100    2,313,233
  #xh                               6      8,798,300    1,466,383
  #viral                            5      5,576,500    1,115,300
  #dance                            4      9,762,800    2,440,700
  #vibes                            3      9,100,000    3,033,333
```

`--hops N` widens the sample through the sound edge — the only expanding link
still open. Three hops roughly doubled the sample here (#xuhuong 14 → 25 videos)
for about 7 s.

`trending` uses `/api/trending/searchwords/`, which answers **only** with
`from_page=search` and a search referer; anything else returns statusCode
100002, which reads like a block but is a parameter error. `tag <name>` still
gives a single hashtag's view and video counts.

## What actually blocks you (measured, not assumed)

**1. `X-Bogus` is dead.** `byted_acrawler.frontierSign` still returns one, but
the real client now sends `X-Bogus=1` — the literal string — alongside
**`X-Gnarly`** and **`X-Dynosaur`**. `signer/src/xbogus.js` implements the
legacy 28-char algorithm and is kept only for Douyin; it is not on the path.

**2. `X-Gnarly` can't be called, but the SDK runs outside a browser.** Nothing
exports it — it is stamped on by a fetch monkey-patch. The three bundles load
and sign happily in `node:vm` against a stubbed browser
(`signer/src/sdkHost.js`). Two non-obvious requirements:

* **`secsdk-lastest.umd.js` installs the interceptor**, not `webmssdk.js`. All
  three bundles must load, in page order.
* **`_mssdk._enablePathList` decides what gets signed** — 209 route prefixes
  that the *TikTok app*, not the SDK, fills in. Outside the app the list is
  empty, everything loads correctly, and nothing is signed. Captured into
  `signer/vendor/mssdk-paths.json`; refresh with `scripts/probe-mssdk.js`.

**3. The WAF is a SHA-256 proof of work.** A cold request gets a 1.4 KB Slardar
challenge page. Its script has no canvas, no WebGL, no fingerprinting — it reads
a challenge out of `class` attributes and brute-forces an integer. `solve_waf()`
in `tiktok.py` does the same, in well under a second. Three details cost time:

* the base64 has **no padding** (`atob` tolerates it, Python does not);
* the solved cookies live **10 seconds** — a door key, not a session, so what the
  server sets *on the way through* has to be harvested;
* the token is **scoped to the route family** — a jar from a profile page gets
  403 on video pages, which is why there is one `curl_cffi.Session` per kind.

**4. The data moved into the page.** `/api/user/detail/` and
`/api/post/item_list/` answer **200 with a zero-length body** — for a real
browser too. Profile and video data ships in the SSR blob
`__UNIVERSAL_DATA_FOR_REHYDRATION__`. Reading the page *is* the API.

**5. The counters live in `statsV2`.** TikTok left the old `stats` block reading
**0** for anything past JavaScript's safe integer range. `#fyp` reports
`stats.videoCount: 0` against 127 trillion views; `statsV2` says 9.2 billion.
`statsV2` is also exact where `stats` is rounded (21,482 vs 21,500).

**6. Search is gated; its autocomplete neighbours are not.**
`/api/search/*/full/` returns nothing to a guest. Three others do answer:
`search/general/preview` (related terms), `search/suggest/guide/` (trending,
**needs no signature at all**), and `comment/search/sug/user/` — which is
`search/user/full/` by another name, minus the follower counts.

**7. The CDN wants three headers together.** `Referer` + `Range` + `Cookie`.
Drop any one and it answers 403 with a 504-byte HTML body.

## What does not work

**A channel's uploads — including just its latest video.** Confirmed three
independent ways:

* **API** — every list route is gated or errors: `post/item_list`,
  `post/item_list/v1`, `creator/item_list`, `favorite/item_list`,
  `repost/item_list`, `user/playlist`, `user/music_list`, `story/item_list`,
  `story/user_list`, plus the whole `reflow` family.
* **SSR blob** — `webapp.user-detail` carries `userInfo` and nothing else.
* **SEO** — the full 387 KB profile page contains **zero** video ids, no
  `ld+json`, no `og:` video meta. TikTok strips it server-side for guests; the
  grid is fetched client-side from the gated route.

Chaining other edges does not reach it either. It is tempting to assume a
video's "original sound" belongs to its author, so `music` would return that
author's other videos — it does not. The sound is credited to whoever first
uploaded it. On one test, 1 of 28 results was by the seed author, and that one
*was* the seed video.

| Edge | Works |
|---|---|
| `explore` / `foryou` → videos | yes |
| video → sound → `music` | yes (the only expanding edge) |
| video → its own hashtags | yes (what `tags` mines) |
| keyword → accounts / related terms | yes |
| trending search terms | yes |
| hashtag → videos | no |
| video → related | no |
| account → uploads | no |

Also dead, checked one by one: `challenge/related`, `discover/challenge`,
`topic/item_list` (all 10201), `search/challengesug` and `discover/search`
(non-JSON), `trending/topics/info` (statusCode 1).

The `reflow` family returns `statusCode=5`, a *parameter* error rather than a
gate, so it may still be reachable. Working that out needs a captured request
from a `vt.tiktok.com` share link, since that flow is built for logged-out
traffic.

## Layout

```
tiktok.py                      the client and CLI
signer/
  server.js                    /sign (native), /page, /api, /cookies, /health
  src/sdkHost.js               stubbed browser + bundle loader (node:vm)
  src/nativeSigner.js          pool of warm SDK hosts
  src/sessionPool.js           Chromium pool - lazy, for the fallback only
  src/xbogus.js                legacy X-Bogus (off the path)
  vendor/                      pinned bundles + the 209-path allowlist
  scripts/probe.js             what the live bundle exposes today
  scripts/probe-mssdk.js       refresh vendor/mssdk-paths.json
  scripts/capture-full.js      dump a complete request, headers included
  scripts/survey.js            which /api/* endpoints still return data
  scripts/sdk-host-test.js     does the node:vm signer still work
docs/xgnarly-assessment.md     how the signing was solved, and why not a port
```

## When it breaks

1. **Empty 200s** → gating, not signing. Compare against a real browser with
   `node scripts/survey.js <url>`.
2. **`path not in the SDK allowlist`** → `node scripts/probe-mssdk.js <url>`,
   then refresh `vendor/mssdk-paths.json`.
3. **The bundle throws on load** → TikTok shipped a new version. Re-download all
   three (URLs appear in `scripts/probe.js` output), re-pin, then run
   `node scripts/sdk-host-test.js`.
4. **A shell page instead of the real one** → TikTok's edge serves a ~43 KB stub
   intermittently, roughly 1 in 3 on video URLs, and always fast (~120 ms against
   ~2.5 s). Retrying is nearly free; `HTTP_ATTEMPTS` in `tiktok.py` is that.

Reads public data only. Respect rate limits and TikTok's ToS.
