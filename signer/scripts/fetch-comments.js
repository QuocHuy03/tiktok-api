// A video's comments, read from a real Chrome window.
//
// Same shape as fetch-posts.js, and for the same reason: `/api/comment/list/`
// returns an empty body to a plain HTTP request, and headless Chromium never
// renders the comment panel - so the request is never made at all. A real
// window renders it, and the page mints its own single-use token.
//
//   node scripts/fetch-comments.js <video url> [--pages 3]
// Prints JSON on stdout; progress on stderr.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const target = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const wantPages = flag('pages', 1);
const USER_DIR = path.join(__dirname, '..', '.chrome-profile');

if (!target) {
  console.error('usage: fetch-comments.js <video url> [--pages N]');
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

  const requests = []; // kept so the exact call can be diffed/replayed later
  page.on('response', (resp) => {
    if (!/\/api\/comment\/list\//.test(resp.url())) return;
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
        requests.push({ url: resp.url(), status: resp.status(), headers, bytes: body.length });
        if (body) {
          try {
            pages.push(JSON.parse(body));
          } catch (_) {
            /* the page retries on its own */
          }
        }
      })()
    );
  });

  console.error('opening video ...');
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);

  // The panel is lazy and lives in its own scroll container, so wheeling the
  // window is not enough - move the pointer over the list first.
  const box = await page
    .locator('[data-e2e="comment-list"], [class*="CommentListContainer"]')
    .first()
    .boundingBox()
    .catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }

  let stale = 0;
  for (let i = 0; i < 30 && pages.length < wantPages; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1400);
    await Promise.allSettled(pending);
    if (pages.length > stale) {
      console.error(`  page ${pages.length}`);
      stale = pages.length;
      i = Math.max(0, i - 2); // progress buys a little more patience
    }
  }
  await Promise.allSettled(pending);

  const comments = [];
  const seen = new Set();
  let hasMore = false;
  let cursor = 0;
  let total = null;
  for (const p of pages) {
    hasMore = Boolean(p.has_more);
    cursor = p.cursor ?? cursor;
    total = p.total ?? total;
    for (const c of p.comments || []) {
      if (c.cid && !seen.has(c.cid)) {
        seen.add(c.cid);
        comments.push(c);
      }
    }
  }
  console.error(`got ${comments.length} comments across ${pages.length} page(s)`);
  process.stdout.write(JSON.stringify({ comments, has_more: hasMore, cursor, total, requests }));
  await ctx.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
