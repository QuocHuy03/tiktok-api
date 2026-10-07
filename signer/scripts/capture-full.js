// Captures a COMPLETE outgoing request - every header the browser actually
// sends, Cookie included - and the response it got.
//
// request.headers() hides headers the browser adds itself (Cookie, sec-*,
// accept-encoding). allHeaders() does not, and that gap is exactly where a
// "same request" that behaves differently tends to hide.
//
//   COOKIE_FILE=... node scripts/capture-full.js <page> <match> <out.json>
const fs = require('fs');
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const pageUrl = process.argv[2] || 'https://www.tiktok.com/@tiktok';
const match = process.argv[3] || '/api/';
const outPath = process.argv[4];

(async () => {
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
  const captured = [];
  const pending = [];
  let totalResponses = 0;

  page.on('response', (resp) => {
    totalResponses++;
    const url = resp.url();
    if (!url.includes(match)) return;
    pending.push(record(resp));
  });

  async function record(resp) {
    const url = resp.url();
    const req = resp.request();
    let headers = {};
    try {
      headers = await req.allHeaders(); // includes Cookie and browser-added headers
    } catch (_) {
      headers = req.headers();
    }
    let bodyLen = null;
    let bodyHead = null;
    try {
      const buf = await resp.body();
      bodyLen = buf.length;
      bodyHead = buf.subarray(0, 200).toString('utf8');
    } catch (_) {}
    captured.push({
      url,
      method: req.method(),
      headers,
      status: resp.status(),
      bodyLen,
      bodyHead,
      responseHeaders: await resp.allHeaders().catch(() => ({})),
    });
  }

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(14000);
  // The response handler is async; let the in-flight records finish.
  await Promise.allSettled(pending);
  console.error(`total responses seen: ${totalResponses}`);

  // Keep the ones that actually returned data - those are the interesting ones.
  const useful = captured.filter((c) => c.bodyLen > 0).sort((a, b) => b.bodyLen - a.bodyLen);
  console.error(`captured ${captured.length} matching requests, ${useful.length} with a body`);
  for (const c of useful.slice(0, 8)) {
    console.error(`  ${String(c.status).padEnd(4)} ${String(c.bodyLen).padStart(8)} B  ${new URL(c.url).pathname}`);
  }

  const payload = JSON.stringify(useful, null, 1);
  if (outPath) {
    fs.writeFileSync(outPath, payload);
    console.error(`\nwrote ${outPath}`);
  } else {
    process.stdout.write(payload);
  }
  await browser.close();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
