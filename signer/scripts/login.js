// Log in once, in the persistent Chrome profile the browser-backed commands use.
//
// Better than pasting a cookie header: the session lives in the profile
// directory, survives restarts, refreshes itself, and never travels through a
// chat log or a temp file. `posts` and `comments` pick it up automatically.
//
//   node scripts/login.js            log in and wait
//   node scripts/login.js --check    just report whether a session is there
const path = require('path');
const { chromium } = require('playwright');

const USER_DIR = path.join(__dirname, '..', '.chrome-profile');
const checkOnly = process.argv.includes('--check');

(async () => {
  const launch = {
    headless: checkOnly,
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

  const has = async () =>
    (await ctx.cookies('https://www.tiktok.com')).some(
      (c) => c.name === 'sessionid' && c.value
    );

  if (checkOnly) {
    const ok = await has();
    console.log(JSON.stringify({ logged_in: ok, profile: USER_DIR }));
    await ctx.close();
    process.exit(ok ? 0 : 1);
  }

  const page = ctx.pages()[0] || (await ctx.newPage());
  if (await has()) {
    console.error('already logged in - close the window when you are done');
  } else {
    console.error('log in in the window that opened (QR is quickest); waiting ...');
    await page.goto('https://www.tiktok.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await has()) {
      console.error('\nsession saved to the Chrome profile.');
      console.error('posts and comments will use it from now on.');
      await page.waitForTimeout(1500);
      await ctx.close();
      return;
    }
    await page.waitForTimeout(2000);
  }
  console.error('timed out after 5 minutes without a session');
  await ctx.close();
  process.exit(1);
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
