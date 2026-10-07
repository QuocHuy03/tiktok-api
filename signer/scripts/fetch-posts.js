// A profile's uploads, read from a real Chrome window.
//
// Why it has to be this way: the browser's own request works (430 KB, 16
// videos), but it is single-use. Replaying it byte-for-byte - same URL, same
// cookies, same headers, seconds later - returns an empty body, so the
// `msToken` in the query is consumed per request. Capture-and-replay cannot
// work; the request has to originate in a session that can mint its own token.
//
// Headless Chromium is not enough either: it never renders the profile grid, so
// the request is never made. Hence `channel: chrome` and a visible window.
//
//   node scripts/fetch-posts.js @handle [--count 30] [--pages 2]
// Prints JSON on stdout; progress on stderr.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const handle = (args[0] || '').replace(/^@/, '');
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const wantPages = flag('pages', 1);
const USER_DIR = path.join(__dirname, '..', '.chrome-profile');

if (!handle) {
  console.error('usage: fetch-posts.js @handle [--pages N]');
  process.exit(2);
}

(async () => {
  const launch = {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(USER_DIR, launch);
  } catch (e) {
    console.error(`real Chrome unavailable (${e.message.split('\n')[0]}); using Chromium`);
    delete launch.channel;
    ctx = await chromium.launchPersistentContext(USER_DIR, launch);
  }
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (process.env.COOKIE_FILE && fs.existsSync(process.env.COOKIE_FILE)) {
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
  }

  const page = ctx.pages()[0] || (await ctx.newPage());
  const pages = [];
  const pending = [];

  page.on('response', (resp) => {
    if (!resp.url().includes('/api/post/item_list')) return;
    pending.push(
      (async () => {
        try {
          const body = (await resp.body()).toString('utf8');
          if (body) pages.push(JSON.parse(body));
        } catch (_) {
          /* the page will retry on its own */
        }
      })()
    );
  });

  console.error(`opening @${handle} ...`);
  await page.goto(`https://www.tiktok.com/@${handle}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForTimeout(7000);

  // Scroll until we have the pages asked for, or the grid stops growing.
  let stale = 0;
  for (let i = 0; i < 25 && pages.length < wantPages; i++) {
    const before = pages.length;
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(1600);
    await Promise.allSettled(pending);
    if (pages.length === before) {
      if (++stale >= 6) break;
    } else {
      stale = 0;
      console.error(`  page ${pages.length}`);
    }
  }
  await Promise.allSettled(pending);

  const items = [];
  const seen = new Set();
  let hasMore = false;
  let cursor = null;
  for (const p of pages) {
    hasMore = Boolean(p.hasMore);
    cursor = p.cursor ?? cursor;
    for (const it of p.itemList || []) {
      if (it.id && !seen.has(it.id)) {
        seen.add(it.id);
        items.push(it);
      }
    }
  }
  console.error(`got ${items.length} videos across ${pages.length} page(s)`);
  process.stdout.write(JSON.stringify({ itemList: items, hasMore, cursor }));
  await ctx.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
