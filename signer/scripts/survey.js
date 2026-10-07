// Scrolls a page and reports every /api/* call with its response size, so we
// can see which endpoints actually return data for a guest session.
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const target = process.argv[2] || 'https://www.tiktok.com/@1chutdethunw';
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // Set COOKIE_FILE to survey the page as a logged-in user - several endpoints
  // behave differently, and this is how you tell gating from a bad request.
  if (process.env.COOKIE_FILE) {
    const raw = require('fs').readFileSync(process.env.COOKIE_FILE, 'utf8').trim();
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
    console.log(`(injected ${cookies.length} cookies)`);
  }

  const page = await ctx.newPage();

  const rows = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!u.includes('/api/')) return;
    let len = null;
    try {
      len = (await resp.body()).length;
    } catch (_) {}
    rows.push({ path: new URL(u).pathname, status: resp.status(), len });
  });

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(2500);
  }

  // Does the SSR blob carry the profile data instead?
  const ssr = await page.evaluate(() => {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el) return null;
    try {
      const j = JSON.parse(el.textContent);
      const scope = j.__DEFAULT_SCOPE__ || {};
      return { keys: Object.keys(scope), bytes: el.textContent.length };
    } catch (e) {
      return { error: String(e) };
    }
  });

  console.log('API CALLS');
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.path}|${r.status}|${r.len}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${String(r.status).padEnd(4)} ${String(r.len).padStart(8)} B  ${r.path}`);
  }
  console.log('\nSSR BLOB:', JSON.stringify(ssr, null, 2));

  await browser.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
