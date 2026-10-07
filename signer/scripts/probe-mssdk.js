// Dumps window._mssdk on a live page - it owns _enablePathList, which is what
// decides whether a request gets signed.
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const target = process.argv[2] || 'https://www.tiktok.com/@tiktok';
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);

  const out = await page.evaluate(() => {
    const describe = (o, depth = 0) => {
      if (o === null || o === undefined) return String(o);
      const t = typeof o;
      if (t === 'function') return `function(${o.length})`;
      if (t !== 'object') return t === 'string' && o.length > 80 ? o.slice(0, 80) + '...' : o;
      if (Array.isArray(o)) return depth > 1 ? `array[${o.length}]` : o.slice(0, 40).map((x) => describe(x, depth + 1));
      if (depth > 1) return `object{${Object.keys(o).length}}`;
      const r = {};
      for (const k of Object.keys(o).slice(0, 40)) {
        try { r[k] = describe(o[k], depth + 1); } catch (e) { r[k] = 'throws'; }
      }
      return r;
    };

    const res = { has_mssdk: typeof window._mssdk };
    if (window._mssdk) {
      res.mssdk_keys = Object.keys(window._mssdk);
      res.mssdk = describe(window._mssdk);
      // the interesting bits, in full
      res.enablePathList = window._mssdk._enablePathList;
      res.enablePathListRegex = (window._mssdk._enablePathListRegex || []).map(String);
    }
    res.MSSDK_INITIALIZED = window.MSSDK_INITIALIZED;
    res.xex = window._xex ? Object.keys(window._xex) : null;
    res.secsdk = window.secsdk ? Object.keys(window.secsdk) : null;

    // Is fetch patched, and by whom?
    res.fetch_is_native = /\[native code\]/.test(String(window.fetch));
    res.fetch_src = String(window.fetch).slice(0, 300);
    res.xhr_send_native = /\[native code\]/.test(String(XMLHttpRequest.prototype.send));
    res.xhr_send_src = String(XMLHttpRequest.prototype.send).slice(0, 300);
    res.xhr_open_native = /\[native code\]/.test(String(XMLHttpRequest.prototype.open));
    return res;
  });

  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
