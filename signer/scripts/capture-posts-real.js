// Capture /api/post/item_list/ from a REAL Chrome window.
//
// Headless Chromium never rendered the profile grid - 0 video links, 0 requests
// - so the route was never even asked for. This uses the installed Chrome
// (`channel: chrome`, not the bundled Chromium) with a visible window and a
// persistent profile directory, which is what a normal session looks like.
//
// It is a sampling tool, not part of the runtime: run it once, keep the params.
//
//   COOKIE_FILE=... node scripts/capture-posts-real.js @handle out.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const handle = (process.argv[2] || '1chutdethunw').replace(/^@/, '');
const outPath = process.argv[3];
const USER_DIR = path.join(__dirname, '..', '.chrome-profile');

(async () => {
  const launch = {
    headless: false,
    channel: 'chrome', // the real install, so sec-ch-ua says "Google Chrome"
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  };

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(USER_DIR, launch);
  } catch (e) {
    console.error(`real Chrome unavailable (${e.message.split('\n')[0]}), falling back to Chromium`);
    delete launch.channel;
    ctx = await chromium.launchPersistentContext(USER_DIR, launch);
  }

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

  const page = ctx.pages()[0] || (await ctx.newPage());
  const hits = [];
  const pending = [];

  page.on('response', (resp) => {
    if (!/\/api\/(post|user)\/item_list/.test(resp.url())) return;
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
        hits.push({ url: resp.url(), status: resp.status(), headers, body });
      })()
    );
  });

  console.error(`opening @${handle} ...`);
  await page.goto(`https://www.tiktok.com/@${handle}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForTimeout(8000);

  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1800);
    const n = await page.evaluate(
      () => document.querySelectorAll('a[href*="/video/"]').length
    );
    if (i === 0 || n) console.error(`  scroll ${i + 1}: ${n} video links`);
    if (hits.length) break;
  }
  await Promise.allSettled(pending);

  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/video/"]')].map((a) => a.href).slice(0, 5)
  );
  console.error(`\nvideo links rendered : ${links.length}`);
  links.forEach((l) => console.error(`   ${l}`));
  console.error(`item_list requests   : ${hits.length}`);

  for (const h of hits) {
    const u = new URL(h.url);
    console.error(`\n  ${u.pathname}  HTTP ${h.status}  body ${h.body.length} bytes`);
    const keys = [...u.searchParams.keys()].sort();
    console.error(`  params (${keys.length}):`);
    for (const k of keys) {
      const v = u.searchParams.get(k);
      console.error(`    ${k} = ${v.length > 54 ? v.slice(0, 54) + '...' : v}`);
    }
    if (h.body) {
      try {
        const d = JSON.parse(h.body);
        console.error(`  itemList: ${(d.itemList || []).length}  hasMore: ${d.hasMore}`);
      } catch (_) {
        console.error(`  body head: ${h.body.slice(0, 120)}`);
      }
    }
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(hits, null, 1));
    console.error(`\nwrote ${outPath}`);
  }
  await ctx.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
