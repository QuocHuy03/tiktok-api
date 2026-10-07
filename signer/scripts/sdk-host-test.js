// Can webmssdk.js sign inside node:vm, with no browser at all?
//
// Progress goes to stderr: the bundle installs timers, so the process can stay
// alive after the test finishes and a buffered stdout would never flush.
const { SdkHost } = require('../src/sdkHost');

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const WATCHDOG_MS = Number(process.env.WATCHDOG_MS || 45000);
const watchdog = setTimeout(() => {
  log(`\nWATCHDOG: still running after ${WATCHDOG_MS}ms - the bundle is hung`);
  process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();

const TARGET =
  'https://www.tiktok.com/api/user/detail/?aid=1988&app_language=en&app_name=tiktok_web' +
  '&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=Win32' +
  '&channel=tiktok_web&cookie_enabled=true&device_platform=web_pc&focus_state=true' +
  '&from_page=user&history_len=3&is_fullscreen=false&is_page_visible=true&os=windows' +
  '&priority_region=&region=VN&screen_height=1080&screen_width=1920&tz_name=Asia%2FSaigon' +
  '&uniqueId=tiktok&webcast_language=en';

(async () => {
  const host = new SdkHost({
    href: 'https://www.tiktok.com/@tiktok',
    cookie: 'tt_csrf_token=abc; ttwid=1%7Ctest; msToken=testtoken',
  });

  log('load bundles ...');
  host.load();
  for (const r of host.loadReport) {
    log(
      '  ' + r.bundle.padEnd(30),
      r.ok
        ? `ok  patchedFetch=${r.patchedFetch} patchedXhrSend=${r.patchedXhrSend}`
        : 'FAILED: ' + r.error
    );
  }
  log('  byted_acrawler:', typeof host.acrawler);
  log('  _mssdk configured:', host.mssdkConfigured, '| signed paths:', host.signedPaths);
  log('  _xex members:', host.env._xex ? Object.keys(host.env._xex).join(',') : '(none)');
  log('  fetch patched:', !/\[native code\]/.test(String(host.env.fetch)));
  if (host.acrawler) log('  members:', Object.keys(host.acrawler).join(', '));

  log('init ...');
  try {
    host.init();
    log('ok');
  } catch (e) {
    log('FAILED:', e.message);
  }

  log('frontierSign ...');
  try {
    log(JSON.stringify(host.frontierSign(TARGET)));
  } catch (e) {
    log('FAILED:', e.message);
  }

  log('signViaFetch ...');
  try {
    const call = await host.signViaFetch(TARGET);
    const u = new URL(call.url);
    const sig = {};
    for (const k of ['X-Gnarly', 'X-Bogus', 'X-Dynosaur', 'msToken']) {
      const v = u.searchParams.get(k);
      if (v !== null) sig[k] = v.length > 30 ? v.slice(0, 30) + '...' : v;
    }
    log('ok');
    log('  via     :', call.via);
    log('  sig     :', JSON.stringify(sig));
    log('  headers :', JSON.stringify(call.headers));
    log(
      Object.keys(sig).some((k) => k.startsWith('X-G') || k.startsWith('X-D'))
        ? '\nSIGNED IN NODE - no browser needed'
        : '\nfetch was NOT patched: the SDK signs somewhere else'
    );
  } catch (e) {
    log('FAILED:', e.message);
  }
  clearTimeout(watchdog);
  process.exit(0);
})().catch((e) => {
  log('fatal:', e.stack || e.message);
  process.exit(1);
});
