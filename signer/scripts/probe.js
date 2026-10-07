// Opens tiktok.com and reports which signer entry points the live bundle exposes.
// Run this whenever signing starts failing - TikTok renames these regularly.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.goto('https://www.tiktok.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(8000);

  const report = await page.evaluate(() => {
    const out = { globals: {}, acrawler: null, sdkScripts: [], suspects: [] };
    const names = [
      'byted_acrawler',
      'webmssdk',
      'bytedAcrawler',
      '__TIKTOK_SIGN__',
      'generateBogus',
      'generateSignature',
      'SIGI_STATE',
    ];
    for (const n of names) out.globals[n] = typeof window[n];
    if (window.byted_acrawler) {
      out.acrawler = Object.keys(window.byted_acrawler).map(
        (k) => k + ':' + typeof window.byted_acrawler[k]
      );
    }
    out.sdkScripts = performance
      .getEntriesByType('resource')
      .map((r) => r.name)
      .filter((u) => /webmssdk|acrawler|secsdk/i.test(u))
      .slice(0, 12);
    out.suspects = Object.keys(window).filter((k) =>
      /sign|bogus|gnarly|crawler|mssdk/i.test(k)
    );
    return out;
  });

  const cookies = await ctx.cookies('https://www.tiktok.com');
  report.cookies = cookies.map((c) => c.name);

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
