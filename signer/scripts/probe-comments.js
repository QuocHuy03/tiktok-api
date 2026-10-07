// Why doesn't /api/comment/list/ fire on a video page?
//
// Reports every /api/* call the page makes, what the comment area actually
// contains, and whether a login wall is in the way - so the answer is measured
// rather than guessed.
//
//   [COOKIE_FILE=...] node scripts/probe-comments.js <video url>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const target =
  process.argv[2] || 'https://www.tiktok.com/@ductuan2019/video/7678586838159805703';
const USER_DIR = path.join(__dirname, '..', '.chrome-profile');

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
    console.error(`(injected ${cookies.length} cookies)`);
  }

  const page = ctx.pages()[0] || (await ctx.newPage());
  const calls = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!u.includes('/api/')) return;
    let len = null;
    try {
      len = (await resp.body()).length;
    } catch (_) {}
    calls.push({ path: new URL(u).pathname, status: resp.status(), len });
  });

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1500);
  }

  const dom = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    const pick = (sel) => document.querySelectorAll(sel).length;
    return {
      loggedIn: document.cookie.includes('sessionid'),
      htmlLen: document.documentElement.outerHTML.length,
      commentList: pick('[data-e2e="comment-list"]'),
      commentItems: pick('[data-e2e="comment-level-1"]'),
      commentLike: pick('[class*="DivCommentListContainer"], [class*="CommentListContainer"]'),
      loginWall:
        /log in to see|log in to comment|đăng nhập/i.test(txt) ||
        pick('[data-e2e="login-modal"], [id*="loginContainer"]') > 0,
      title: document.title.slice(0, 70),
      bodyHead: txt.replace(/\s+/g, ' ').slice(0, 220),
    };
  });

  console.error('\nDOM:');
  for (const [k, v] of Object.entries(dom)) console.error(`  ${k.padEnd(13)} ${v}`);

  console.error('\n/api/* calls:');
  const seen = new Set();
  for (const c of calls) {
    const key = `${c.path}|${c.len}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  ${String(c.status).padEnd(4)} ${String(c.len).padStart(8)} B  ${c.path}`);
  }
  await ctx.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
