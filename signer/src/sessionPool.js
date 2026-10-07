'use strict';
/**
 * A pool of warm TikTok browser sessions.
 *
 * Each session is a real Chromium context that has loaded tiktok.com, so it owns
 * a genuine cookie set (ttwid / msToken / tt_csrf_token) and a live
 * window.byted_acrawler we can call to sign URLs. Sessions are rotated by age
 * and by use count because msToken has a TTL and per-session request volume is
 * what TikTok rate-limits on.
 */
const { chromium } = require('playwright');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STEALTH = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(p);
};

class Session {
  constructor(ctx, page, proxy) {
    this.ctx = ctx;
    this.page = page;
    this.proxy = proxy || null;
    this.createdAt = Date.now();
    this.uses = 0;
    this.dead = false;
  }

  age() {
    return Date.now() - this.createdAt;
  }

  async cookies() {
    const list = await this.ctx.cookies('https://www.tiktok.com');
    const map = {};
    for (const c of list) map[c.name] = c.value;
    return map;
  }

  async cookieHeader() {
    const map = await this.cookies();
    return Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** Call the page's own signer. Returns e.g. { "X-Bogus": "..." } */
  async sign(url) {
    try {
      return await this.page.evaluate((u) => {
        if (!window.byted_acrawler || !window.byted_acrawler.frontierSign) {
          throw new Error('byted_acrawler.frontierSign missing - run npm run probe');
        }
        return window.byted_acrawler.frontierSign({ url: u });
      }, url);
    } catch (e) {
      // "Target crashed" / "Target closed" means this context is gone for good.
      if (/Target (crashed|closed)|Execution context was destroyed|browser has been closed/i.test(e.message)) {
        this.dead = true;
      }
      throw e;
    }
  }

  /**
   * Navigate to a TikTok page in this session and return its SSR rehydration
   * blob.
   *
   * TikTok now serves guest profile/video data in
   * __UNIVERSAL_DATA_FOR_REHYDRATION__ and returns an empty body from the
   * matching /api/* endpoints - so for those, reading the page IS the API.
   * A plain HTTP client can't do this: cold requests get the Slardar WAF
   * challenge page, which only a JS engine clears.
   *
   * Uses a scratch tab so the signer page keeps its state.
   */
  async fetchSsr(url, { timeout = 45000 } = {}) {
    const tab = await this.ctx.newPage();
    const hasBlob = () =>
      tab
        .waitForFunction(
          () => !!document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__'),
          { timeout: 12000 }
        )
        .then(() => true)
        .catch(() => false);

    try {
      let resp = await tab.goto(url, { waitUntil: 'domcontentloaded', timeout });

      // The WAF sometimes serves its challenge page first and swaps in the real
      // one after its JS runs; a reload picks up the cleared state.
      if (!(await hasBlob())) {
        resp = await tab.reload({ waitUntil: 'domcontentloaded', timeout });
        await hasBlob();
      }

      const out = await tab.evaluate(() => {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!el) {
          return {
            scope: null,
            waf: document.documentElement.outerHTML.includes('SlardarWAF'),
            htmlLen: document.documentElement.outerHTML.length,
          };
        }
        const parsed = JSON.parse(el.textContent);
        return { scope: parsed.__DEFAULT_SCOPE__ || {}, waf: false };
      });

      return { status: resp ? resp.status() : null, ...out };
    } finally {
      await tab.close().catch(() => {});
    }
  }

  /**
   * Call a TikTok /api/* endpoint from inside the page.
   *
   * The SDK monkey-patches fetch/XHR and stamps X-Gnarly + X-Dynosaur onto
   * outgoing requests. Those are the signatures TikTok actually validates now -
   * byted_acrawler.frontierSign only still emits the legacy X-Bogus, which the
   * app now sends as the literal string "1". So the signature cannot be
   * extracted and replayed from an HTTP client; the request has to originate in
   * the page.
   *
   * @param {string} apiUrl   full https://www.tiktok.com/api/... URL
   * @param {string} refererPage page to sit on, so referer/root_referer match
   */
  async fetchApi(apiUrl, refererPage, { timeout = 45000 } = {}) {
    const tab = await this.ctx.newPage();
    try {
      await tab.goto(refererPage, { waitUntil: 'domcontentloaded', timeout });
      await tab
        .waitForFunction(() => !!window.byted_acrawler, { timeout: 25000 })
        .catch(() => {});
      await tab.waitForTimeout(2500);

      return await tab.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        const text = await r.text();
        return { status: r.status, len: text.length, body: text };
      }, apiUrl);
    } finally {
      await tab.close().catch(() => {});
    }
  }

  async close() {
    this.dead = true;
    try {
      await this.ctx.close();
    } catch (_) {
      /* already gone */
    }
  }
}

class SessionPool {
  /**
   * @param {object} opts
   * @param {number} opts.size            how many warm sessions to keep
   * @param {number} opts.maxUses         retire a session after this many signs
   * @param {number} opts.maxAgeMs        retire a session after this long
   * @param {string[]} opts.proxies       optional proxy URLs, round-robined
   * @param {boolean} opts.headless
   * @param {string} opts.userAgent
   * @param {string} opts.loginCookie     "sessionid=...; sid_tt=..." from a logged-in
   *                                      account; required for comments and post lists,
   *                                      which TikTok no longer serves to guests
   */
  constructor(opts = {}) {
    this.size = opts.size || 2;
    this.maxUses = opts.maxUses || 150;
    this.maxAgeMs = opts.maxAgeMs || 12 * 60 * 1000; // msToken goes stale well before this
    this.proxies = opts.proxies || [];
    this.headless = opts.headless !== false;
    this.userAgent = opts.userAgent || DEFAULT_UA;
    this.loginCookie = opts.loginCookie || '';

    this.browser = null;
    this.sessions = [];
    this.cursor = 0;
    this.proxyCursor = 0;
    this.starting = null;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.browser = await chromium.launch({
        headless: this.headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
        ],
      });
      await Promise.all(
        Array.from({ length: this.size }, () => this._spawn().catch(() => null))
      );
      const live = this.sessions.filter(Boolean).length;
      if (!live) throw new Error('session pool failed to warm any session');
      return this;
    })();
    return this.starting;
  }

  _nextProxy() {
    if (!this.proxies.length) return null;
    const p = this.proxies[this.proxyCursor % this.proxies.length];
    this.proxyCursor++;
    return p;
  }

  async _spawn() {
    // Concurrent acquires used to each spawn their own session, so the pool
    // grew well past `size` under load - more Chromium contexts than intended,
    // each one more memory and one more fingerprint.
    if (this.sessions.filter((s) => !s.dead).length >= this.size) {
      const live = this.sessions.filter((s) => !s.dead);
      return live[this.cursor++ % live.length];
    }

    const proxyUrl = this._nextProxy();
    const ctxOpts = {
      userAgent: this.userAgent,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Asia/Ho_Chi_Minh',
    };
    if (proxyUrl) {
      const u = new URL(proxyUrl);
      ctxOpts.proxy = {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username) || undefined,
        password: decodeURIComponent(u.password) || undefined,
      };
    }

    const ctx = await this.browser.newContext(ctxOpts);
    await ctx.addInitScript(STEALTH);

    // Guest sessions can read profiles and videos but not comments or post
    // lists - TikTok returns 200/empty for those. Supplying an account's
    // cookies is what unlocks them.
    if (this.loginCookie) {
      const cookies = this.loginCookie
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf('=');
          return {
            name: c.slice(0, i),
            value: c.slice(i + 1),
            domain: '.tiktok.com',
            path: '/',
          };
        })
        .filter((c) => c.name && c.value);
      if (cookies.length) await ctx.addCookies(cookies);
    }

    // Images/fonts/media are pure cost here - we only need the JS to run.
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'media') return route.abort();
      return route.continue();
    });

    const page = await ctx.newPage();
    const session = new Session(ctx, page, proxyUrl);
    page.on('crash', () => {
      console.error('[pool] page crashed, marking session dead');
      session.dead = true;
    });

    await page.goto('https://www.tiktok.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForFunction(
      () => !!(window.byted_acrawler && window.byted_acrawler.frontierSign),
      { timeout: 45000 }
    );

    // msToken is written by the SDK a beat after the page settles
    await page.waitForTimeout(3000);

    this.sessions.push(session);
    return session;
  }

  /**
   * Mint a WAF-cleared cookie jar in a throwaway context.
   *
   * It has to be a fresh context: the WAF only issues _waftokenid when it
   * actually challenges, and a warm pooled session has already been waved
   * through, so its jar carries no token and is useless to an HTTP client.
   * Going in cold, straight to a content page, is what triggers the handshake.
   */
  async mintCookies(url = 'https://www.tiktok.com/@tiktok') {
    if (!this.browser) await this.start();

    const proxyUrl = this._nextProxy();
    const ctxOpts = {
      userAgent: this.userAgent,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Asia/Ho_Chi_Minh',
    };
    if (proxyUrl) {
      const u = new URL(proxyUrl);
      ctxOpts.proxy = {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username) || undefined,
        password: decodeURIComponent(u.password) || undefined,
      };
    }

    const ctx = await this.browser.newContext(ctxOpts);
    try {
      await ctx.addInitScript(STEALTH);

      // Minting only needs the WAF handshake, not a rendered page. Blocking
      // assets is most of why this used to take ~35s.
      await ctx.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') {
          return route.abort();
        }
        return route.continue();
      });

      // Seed the account before navigating, so the jar that comes back is a
      // logged-in one - and, crucially, carries a *fresh* msToken. A msToken
      // copied out of a browser hours ago is expired, and a signed request
      // carrying a stale one comes back 200/empty, which reads exactly like
      // guest gating.
      if (this.loginCookie) {
        const seed = this.loginCookie
          .split(';')
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => {
            const i = c.indexOf('=');
            return {
              name: c.slice(0, i),
              value: c.slice(i + 1),
              domain: '.tiktok.com',
              path: '/',
            };
          })
          .filter((c) => c.name && c.value);
        if (seed.length) await ctx.addCookies(seed);
      }

      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for the WAF cookies themselves rather than for the page to
      // finish rendering. The jar needs waforigin_id / waforiginalreid as well
      // as _waftokenid - one without the others gets rejected by the HTTP path
      // - but polling for exactly those is seconds, where waiting on the SSR
      // blob was tens of seconds.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const names = new Set((await ctx.cookies()).map((c) => c.name));
        if (names.has('_waftokenid') && names.has('waforigin_id')) break;
        await page.waitForTimeout(400);
      }

      // No domain filter - WAF cookies can be scoped differently to app cookies.
      const cookies = await ctx.cookies();
      return {
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        names: cookies.map((c) => c.name),
        proxy: proxyUrl ? new URL(proxyUrl).host : null,
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async _replace(session) {
    this.sessions = this.sessions.filter((s) => s !== session);
    session.close().catch(() => {});
    try {
      await this._spawn();
    } catch (e) {
      console.error('[pool] respawn failed:', e.message);
    }
  }

  /** Round-robin a healthy session, retiring stale ones as it goes. */
  async acquire() {
    if (!this.browser) await this.start();

    for (let attempt = 0; attempt < this.sessions.length + 2; attempt++) {
      const live = this.sessions.filter((s) => !s.dead);
      if (!live.length) {
        await this._spawn();
        continue;
      }
      const s = live[this.cursor++ % live.length];
      if (s.uses >= this.maxUses || s.age() >= this.maxAgeMs) {
        // If this is the last one standing, wait for its replacement rather
        // than looping until the attempts run out - sessions all age out at
        // roughly the same moment, so that path is easy to hit.
        if (live.length === 1) {
          await this._replace(s);
        } else {
          this._replace(s);
        }
        continue;
      }
      return s;
    }
    throw new Error('no healthy session available');
  }

  stats() {
    return {
      size: this.size,
      live: this.sessions.filter((s) => !s.dead).length,
      sessions: this.sessions.map((s) => ({
        uses: s.uses,
        ageSec: Math.round(s.age() / 1000),
        proxy: s.proxy ? new URL(s.proxy).host : null,
      })),
    };
  }

  async close() {
    await Promise.all(this.sessions.map((s) => s.close()));
    if (this.browser) await this.browser.close();
  }
}

module.exports = { SessionPool, Session, DEFAULT_UA };
