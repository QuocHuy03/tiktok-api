# X-Gnarly without a browser — how it was done

**Outcome: solved, and without porting the algorithm.** TikTok's own signing
bundles run fine inside `node:vm` against a stubbed browser. They produce real
`X-Gnarly` / `X-Dynosaur`, TikTok accepts them, and no Chromium is involved.

Measured end to end: `/api/explore/item_list/` returns 368 KB of real JSON
(`itemList`, `cursor`, `statusCode: 0`) from a Node-signed request, and through
the API the same call costs **~670-770 ms** uncached with the browser pool
sitting at **zero uses**.

## Why this beats porting the algorithm

The original plan was to reimplement X-Gnarly natively — LZW, a ChaCha-style
block function, a seeded PRNG, custom base64 — the way public reference
implementations do. Running the real bundle is better on every axis that matters:

* **It cannot drift from the algorithm**, because it *is* the algorithm.
* **It survives TikTok's updates**: re-download the bundle, bump the pinned
  filename. A port has to be re-derived every time they change the scheme.
* **It took hours, not days.** The bundle is VM/bytecode-obfuscated —
  `t.u[1080].v.prototype.frontierSign = V`, dispatch through
  `L(91177, t, this, arguments, 0, 40)`, strings assembled at runtime — so
  static deobfuscation was never the cheap route.

A native port is still the only way to drop Node itself. If that becomes the
goal, this host is the oracle to verify it against.

## The four things that had to be right

**1. Three bundles, in page order.** `webmssdk.js` alone is not enough:

| bundle | role |
|---|---|
| `webmssdk-1.0.0.388.js` | registers `byted_acrawler` and `_mssdk` |
| `secsdk-lastest.umd.js` | **patches `fetch`, `XHR.open`, `XHR.send`** |
| `webmssdk_ex-1.0.0.2404.js` | extends both (`_xex`) |

**2. A browser stub, not jsdom.** `src/sdkHost.js` hand-builds `document`,
`navigator`, `location`, `screen`, `performance`, storage, and canvas/WebGL
contexts that return stable fingerprint values. The bundle reaches for very
little beyond that — the env probe found it needed only typed arrays, `document`
and `process`-absence to take its browser branch.

**3. `_mssdk._enablePathList` — the part that is easy to miss.** The SDK signs a
request only if its path matches an allowlist, and on a real page the *TikTok
app*, not the SDK, fills that list with 209 route prefixes. Outside the app the
list is empty, so everything loads correctly and nothing gets signed. The list is
captured from a live page into `vendor/mssdk-paths.json`.

**4. Sign through the patched `fetch`, not `frontierSign`.**
`byted_acrawler.frontierSign` still exists and still returns a 16-char `X-Bogus`
— which the real app now sends as the literal string `"1"`. The signature that
counts is stamped on by the interceptor, so the way to get it is to call the
patched `fetch` and read the URL that comes out.

## Layout

```
signer/
  vendor/webmssdk-1.0.0.388.js       pinned bundles
  vendor/secsdk-lastest.umd.js
  vendor/webmssdk_ex-1.0.0.2404.js
  vendor/mssdk-paths.json            the 209-path signing allowlist
  src/sdkHost.js                     stubbed browser + bundle loader
  src/nativeSigner.js                pool of warm hosts
  scripts/sdk-env-probe.js           what globals the bundle wants
  scripts/sdk-globals-diff.js        which bundle defines what
  scripts/probe-mssdk.js             refresh vendor/mssdk-paths.json
  scripts/sign-cli.js                sign one URL from the shell
scripts/test_native_sign.py          sign in Node, fetch with curl_cffi
```

## What it does not fix

* **Guest gating is unchanged.** `/api/user/detail/` and `/api/post/item_list/`
  still answer 200/empty for guests, correct signature or not — a real browser
  gets the same. Comments and post lists need `TIKTOK_LOGIN_COOKIE`.
* **The WAF is separate.** Page fetches still need the `_waftokenid` jar, which
  only a browser can mint. Signed `/api/*` calls mostly do not.
* **Profiles and videos still come from the SSR blob**, because their `/api/*`
  endpoints are dead, not because signing was the blocker.

## When it breaks

1. `path not in the SDK allowlist` → run `node scripts/probe-mssdk.js <url>` and
   refresh `vendor/mssdk-paths.json`.
2. Signatures accepted but data empty → gating, not signing. Check against a
   real browser with `node scripts/survey.js <url>`.
3. The bundle throws on load → TikTok shipped a new version. Re-download all
   three from the URLs in `scripts/probe.js` output, re-pin, re-run
   `scripts/sdk-host-test.js`.
