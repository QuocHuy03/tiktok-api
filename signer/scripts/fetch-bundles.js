// Download the three TikTok SDK bundles the signer runs in node:vm.
//
// They are TikTok's own files, so they are not kept in this repo - fetch them
// once after cloning:
//
//   node scripts/fetch-bundles.js
//
// If TikTok ships new versions, `node scripts/probe.js` prints the URLs the
// live page is loading; update the list below and re-run.
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE =
  'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static';

const BUNDLES = [
  ['webmssdk-1.0.0.388.js', `${BASE}/webmssdk/1.0.0.388/webmssdk.js`],
  ['secsdk-lastest.umd.js', `${BASE}/secsdk/secsdk-lastest.umd.js`],
  ['webmssdk_ex-1.0.0.2404.js', `${BASE}/ttweb_webmssdk_ex/1.0.0.2404/webmssdk_ex.js`],
];

const VENDOR = path.join(__dirname, '..', 'vendor');

const get = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });

(async () => {
  fs.mkdirSync(VENDOR, { recursive: true });
  let failed = 0;
  for (const [name, url] of BUNDLES) {
    const dest = path.join(VENDOR, name);
    if (fs.existsSync(dest)) {
      console.log(`  have    ${name} (${Math.round(fs.statSync(dest).size / 1024)} KB)`);
      continue;
    }
    try {
      const buf = await get(url);
      fs.writeFileSync(dest, buf);
      console.log(`  fetched ${name} (${Math.round(buf.length / 1024)} KB)`);
    } catch (e) {
      console.error(`  FAILED  ${name}: ${e.message}`);
      failed++;
    }
  }
  if (failed) {
    console.error('\nSome bundles are missing - run scripts/probe.js to see the URLs');
    console.error('the live page loads today, then update the list in this file.');
    process.exit(1);
  }
  console.log('\nbundles ready - the signer can start.');
})();
