// Does /api/post/item_list/ ever return data, and what exactly does the browser
// send when it asks?
//
// Two things the earlier capture got wrong: it discarded requests whose response
// was empty (losing the params, which is the part we need), and it never
// scrolled - the video grid loads lazily.
//
//   COOKIE_FILE=... node scripts/probe-posts.js @handle
const fs = require('fs');
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const handle = (process.argv[2] || '1chutdethunw').replace(/^@/, '');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (process.env.COOKIE_FILE) {
    const raw = fs.readFileSync(process.env.COOKIE_FILE, 'utf8').trim();
    const cookies = raw
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return { name: c.slice(0, i), value: c.slice(i + 1), domain: '.tiktok.com', path: '/' };
      })
      .filter((c) => c.name && c.value);
    await ctx.addCookies(cookies);
    console.error(`(injected ${cookies.length} cookies)`);
  }

  const page = await ctx.newPage();
  const hits = [];
  const pending = [];

  page.on('response', (resp) => {
    if (!resp.url().includes('/api/post/item_list')) return;
    pending.push(
      (async () => {
        const req = resp.request();
        let headers = {};
        try {
          headers = await req.allHeaders();
        } catch (_) {
          headers = req.headers();
        }
        let body = '';
        try {
          body = (await resp.body()).toString('utf8');
        } catch (_) {}
        // Keep it whether or not there was a body - the params are the point.
        hits.push({ url: resp.url(), status: resp.status(), headers, body });
      })()
    );
  });

  await page.goto(`https://www.tiktok.com/@${handle}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(6000);

  // The grid is lazy - scroll it into view and keep going.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(2000);
  }
  await Promise.allSettled(pending);

  const loggedIn = await page.evaluate(() => document.cookie.includes('sessionid'));
  const gridLinks = await page.evaluate(
    () => document.querySelectorAll('a[href*="/video/"]').length
  );
  console.error(`session cookie present in page: ${loggedIn}`);
  console.error(`video links rendered in the grid: ${gridLinks}`);
  console.error(`post/item_list requests seen: ${hits.length}`);

  for (const h of hits) {
    const u = new URL(h.url);
    console.error(`\n  HTTP ${h.status}  body ${h.body.length} bytes`);
    const keys = [...u.searchParams.keys()].sort();
    console.error(`  params (${keys.length}):`);
    for (const k of keys) {
      const v = u.searchParams.get(k);
      console.error(`    ${k} = ${v.length > 56 ? v.slice(0, 56) + '...' : v}`);
    }
    if (h.body) console.error(`  body head: ${h.body.slice(0, 160)}`);
  }

  if (process.argv[3]) {
    fs.writeFileSync(process.argv[3], JSON.stringify(hits, null, 1));
    console.error(`\nwrote ${process.argv[3]}`);
  }
  await browser.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
