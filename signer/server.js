'use strict';
/**
 * Signature microservice.
 *
 * POST /sign  { url, backend? }  ->  { url, headers, cookie, userAgent, backend }
 *
 * The Python API never talks to TikTok's signer directly; it asks this service
 * for a signed URL plus the cookie jar of the session that signed it. Those two
 * must travel together - a signature made in session A is not valid with
 * session B's msToken.
 */
const express = require('express');
const { SessionPool, DEFAULT_UA } = require('./src/sessionPool');
const { NativeSigner } = require('./src/nativeSigner');
const xbogus = require('./src/xbogus');

const PORT = Number(process.env.SIGNER_PORT || 8081);
const POOL_SIZE = Number(process.env.SIGNER_POOL_SIZE || 2);
const HEADLESS = process.env.SIGNER_HEADLESS !== 'false';
const PROXIES = (process.env.PROXIES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// A rejected promise inside a route used to kill the process, taking every warm
// session with it. Log and keep serving instead.
process.on('unhandledRejection', (err) => {
  console.error('[signer] unhandled rejection:', (err && err.message) || err);
});
process.on('uncaughtException', (err) => {
  console.error('[signer] uncaught exception:', (err && err.stack) || err);
});

const app = express();
app.use(express.json({ limit: '256kb' }));

const pool = new SessionPool({
  size: POOL_SIZE,
  headless: HEADLESS,
  proxies: PROXIES,
  userAgent: DEFAULT_UA,
  // Distinct from the API's TIKTOK_COOKIE, which is a WAF jar for the
  // browserless path. This one is an account login, for the gated endpoints.
  loginCookie: process.env.TIKTOK_LOGIN_COOKIE || '',
});

// Browserless signing. Runs TikTok's own bundles in node:vm, so it produces the
// real X-Gnarly / X-Dynosaur without a Chromium anywhere.
const nativeSigner = new NativeSigner({
  size: Number(process.env.NATIVE_POOL_SIZE || 2),
  userAgent: DEFAULT_UA,
});

/** Put msToken from the session's cookie jar into the query string before signing. */
function withMsToken(rawUrl, cookies) {
  const u = new URL(rawUrl);
  if (!u.searchParams.get('msToken') && cookies.msToken) {
    u.searchParams.set('msToken', cookies.msToken);
  }
  return u;
}

app.post('/sign', async (req, res) => {
  const { url, backend = 'browser' } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    if (backend === 'native') {
      // Preferred path: no browser, milliseconds per signature.
      const { cookie = '', referer } = req.body || {};
      const out = await nativeSigner.sign(url, { cookie, referer });
      return res.json({ ...out, cookie, backend: 'native' });
    }

    if (backend === 'xbogus') {
      // Legacy path: no browser, no cookies, 28-char X-Bogus. The live bundle
      // now emits a 16-char one, so expect TikTok to reject this. Kept for
      // Douyin and for offline testing.
      const u = new URL(url);
      const qs = u.searchParams.toString();
      const { xbogus: xb } = xbogus.sign(qs, DEFAULT_UA);
      u.searchParams.set('X-Bogus', xb);
      return res.json({
        url: u.toString(),
        headers: { 'X-Bogus': xb },
        cookie: '',
        userAgent: DEFAULT_UA,
        backend: 'xbogus',
      });
    }

    // A crashed renderer takes its session with it; try the next one rather
    // than failing the caller's request.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      let session;
      try {
        session = await pool.acquire();
        const cookies = await session.cookies();
        const u = withMsToken(url, cookies);

        const signed = await session.sign(u.toString());
        session.uses++;

        // frontierSign returns headers; the query string wants X-Bogus too.
        const headers = {};
        for (const [k, v] of Object.entries(signed || {})) {
          if (typeof v === 'string') headers[k] = v;
        }
        if (headers['X-Bogus']) u.searchParams.set('X-Bogus', headers['X-Bogus']);

        return res.json({
          url: u.toString(),
          headers,
          cookie: Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
          userAgent: DEFAULT_UA,
          backend: 'browser',
          sessionUses: session.uses,
        });
      } catch (e) {
        lastErr = e;
        console.warn(`[sign] attempt ${attempt + 1} failed: ${e.message}`);
        if (session && session.dead) pool._replace(session);
      }
    }
    throw lastErr;
  } catch (e) {
    console.error('[sign]', e.message);
    return res.status(502).json({ error: e.message });
  }
});

/**
 * POST /page { url, keys? } -> { status, scope }
 *
 * Renders a TikTok page in a warm session and returns its SSR blob. This is the
 * only way to read guest profile and video data now: the corresponding /api/*
 * endpoints answer 200 with an empty body, and cold HTTP requests get the WAF
 * challenge page instead of HTML.
 */
app.post('/page', async (req, res) => {
  const { url, keys } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!/^https:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url)) {
    return res.status(400).json({ error: 'only tiktok.com URLs are allowed' });
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let session;
    try {
      session = await pool.acquire();
      const out = await session.fetchSsr(url);
      session.uses++;
      if (!out.scope) {
        lastErr = new Error(out.waf ? 'WAF challenge page' : 'no SSR blob');
        continue;
      }
      // Trim to the scopes the caller asked for - the full blob is ~250KB.
      let scope = out.scope;
      if (Array.isArray(keys) && keys.length) {
        scope = {};
        for (const k of keys) if (out.scope[k] !== undefined) scope[k] = out.scope[k];
      }
      return res.json({ status: out.status, scope, sessionUses: session.uses });
    } catch (e) {
      lastErr = e;
      console.warn(`[page] attempt ${attempt + 1} failed: ${e.message}`);
      if (session && session.dead) pool._replace(session);
    }
  }
  console.error('[page]', lastErr && lastErr.message);
  return res.status(502).json({ error: lastErr ? lastErr.message : 'page fetch failed' });
});

/**
 * POST /api { url, referer } -> { status, body }
 *
 * Runs a /api/* call from inside a warm page so the SDK signs it with X-Gnarly.
 * Slower than replaying a signature from Python, but it is the only thing that
 * still works for the endpoints TikTok gates.
 */
app.post('/api', async (req, res) => {
  const { url, referer } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!/^https:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url)) {
    return res.status(400).json({ error: 'only tiktok.com URLs are allowed' });
  }
  const refererPage = referer || 'https://www.tiktok.com/';

  // One attempt by default: this path is the fallback for gated endpoints, and
  // when TikTok is not going to serve the data, retrying just multiplies a page
  // load into a 90-second failure.
  const attempts = Number(process.env.INPAGE_ATTEMPTS || 1);
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let session;
    try {
      session = await pool.acquire();
      const out = await session.fetchApi(url, refererPage);
      session.uses++;
      if (!out.len) {
        lastErr = new Error(`empty body (HTTP ${out.status})`);
        continue;
      }
      return res.json({ status: out.status, body: out.body, sessionUses: session.uses });
    } catch (e) {
      lastErr = e;
      console.warn(`[api] attempt ${attempt + 1} failed: ${e.message}`);
      if (session && session.dead) pool._replace(session);
    }
  }
  console.error('[api]', lastErr && lastErr.message);
  return res.status(502).json({ error: lastErr ? lastErr.message : 'api fetch failed' });
});

/**
 * POST /cookies { url? } -> { cookie, userAgent }
 *
 * Mints a WAF-cleared cookie jar. Navigating a real page makes Slardar issue
 * _waftokenid / waforigin_id, and a plain HTTP client can then fetch TikTok
 * pages directly with those cookies - no browser on the hot path.
 *
 * Call this rarely: one jar serves many thousands of HTTP fetches.
 */
app.post('/cookies', async (req, res) => {
  const url = (req.body && req.body.url) || 'https://www.tiktok.com/@tiktok';
  if (!/^https:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url)) {
    return res.status(400).json({ error: 'only tiktok.com URLs are allowed' });
  }

  // The WAF only challenges some of the time (IP reputation, page, A/B), so a
  // jar without _waftokenid is common and may still work. Report the flag and
  // let the caller decide by actually trying a fetch.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await pool.mintCookies(url);
      const wafCleared = out.names.includes('_waftokenid');
      console.log(
        `[cookies] minted (${out.names.length} cookies, waf_token=${wafCleared}, ` +
          `proxy=${out.proxy || 'none'})`
      );
      return res.json({ ...out, wafCleared, userAgent: DEFAULT_UA });
    } catch (e) {
      lastErr = e;
      console.warn(`[cookies] attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  console.error('[cookies]', lastErr && lastErr.message);
  return res.status(502).json({ error: lastErr ? lastErr.message : 'mint failed' });
});

app.get('/health', async (_req, res) => {
  res.json({
    // Native signing needs no browser, so the service is healthy without one.
    ok: true,
    browser: pool.browser ? 'started' : 'not started',
    pool: pool.stats(),
    native: nativeSigner.stats(),
  });
});

const server = app.listen(PORT, async () => {
  console.log(
    `[signer] listening on :${PORT} (pool=${POOL_SIZE}, proxies=${PROXIES.length}, ` +
      `login=${process.env.TIKTOK_LOGIN_COOKIE ? 'yes' : 'guest'})`
  );
  // The browser pool starts lazily. Native signing and the API's in-process
  // WAF solver cover the whole hot path, so a Chromium launched at boot would
  // just sit there costing memory - and it is the one thing standing between
  // this setup and "no browser anywhere". It spins up only if /page, /api or
  // /cookies is actually called.
  console.log('[signer] browser pool is lazy - no Chromium until one is needed');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[signer] ${sig}, shutting down`);
    server.close();
    await pool.close().catch(() => {});
    process.exit(0);
  });
}
