'use strict';
/**
 * Browserless signing, backed by a pool of warm SdkHost instances.
 *
 * Loading the three bundles into a fresh node:vm costs a couple of seconds, so
 * hosts are kept and reused. They are retired by age and use count for the same
 * reason browser sessions are: the SDK accumulates state, and a host that has
 * signed thousands of requests is a worse fingerprint than a fresh one.
 *
 * Cost per signature once warm is milliseconds, against seconds for a page
 * render - and no Chromium process at all.
 */
const { SdkHost, DEFAULT_UA } = require('./sdkHost');

class NativeSigner {
  constructor(opts = {}) {
    this.size = opts.size || 2;
    this.maxUses = opts.maxUses || 500;
    this.maxAgeMs = opts.maxAgeMs || 30 * 60 * 1000;
    this.userAgent = opts.userAgent || DEFAULT_UA;
    this.hosts = [];
    this.cursor = 0;
    this.built = 0;
  }

  _spawn(cookie, href) {
    const host = new SdkHost({ userAgent: this.userAgent, cookie, href });
    host.load();
    try {
      host.init();
    } catch (_) {
      // init is best-effort - signing works without it
    }
    const entry = { host, uses: 0, createdAt: Date.now(), cookie, href };
    this.hosts.push(entry);
    this.built++;
    return entry;
  }

  /**
   * A host bakes in document.cookie and location at construction, and the SDK
   * reads both while signing - so a host is only reusable for the same pair.
   */
  _acquire(cookie, href) {
    const now = Date.now();
    this.hosts = this.hosts.filter(
      (e) => e.uses < this.maxUses && now - e.createdAt < this.maxAgeMs
    );
    const match = this.hosts.filter((e) => e.cookie === cookie && e.href === href);
    if (match.length) return match[this.cursor++ % match.length];
    while (this.hosts.length >= this.size) this.hosts.shift();
    return this._spawn(cookie, href);
  }

  /**
   * @returns {Promise<{url:string, signatures:object, headers:object}>}
   */
  async sign(url, { cookie = '', referer = 'https://www.tiktok.com/' } = {}) {
    const cookieMap = Object.fromEntries(
      cookie
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf('=');
          return [c.slice(0, i), c.slice(i + 1)];
        })
    );

    // msToken is part of the signed query string, so it has to go in first.
    const u = new URL(url);
    if (!u.searchParams.get('msToken') && cookieMap.msToken) {
      u.searchParams.set('msToken', cookieMap.msToken);
    }

    const entry = this._acquire(cookie, referer);
    const call = await entry.host.signViaFetch(u.toString());
    entry.uses++;

    const signed = new URL(call.url);
    const signatures = {};
    for (const k of ['X-Gnarly', 'X-Bogus', 'X-Dynosaur']) {
      const v = signed.searchParams.get(k);
      if (v !== null) signatures[k] = v;
    }
    if (!signatures['X-Gnarly']) {
      throw new Error(
        `path not in the SDK allowlist: ${signed.pathname} ` +
          '(re-run scripts/probe-mssdk.js to refresh vendor/mssdk-paths.json)'
      );
    }

    return {
      url: call.url,
      signatures,
      headers: call.headers || {},
      userAgent: this.userAgent,
      hostUses: entry.uses,
    };
  }

  stats() {
    return {
      hosts: this.hosts.length,
      built: this.built,
      detail: this.hosts.map((e) => ({
        uses: e.uses,
        ageSec: Math.round((Date.now() - e.createdAt) / 1000),
      })),
    };
  }
}

module.exports = { NativeSigner };
