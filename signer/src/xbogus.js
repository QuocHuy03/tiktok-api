'use strict';
/**
 * X-Bogus - legacy TikTok/Douyin web signature.
 *
 * Pure-JS reimplementation. Fast (no browser) but this is the OLD algorithm:
 * TikTok web has largely moved to X-Gnarly. Keep it as the cheap fast path and
 * fall back to the browser signer (src/browserSigner.js) when TikTok rejects it.
 */
const crypto = require('crypto');

const CHARSET =
  'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=';

// hex char -> nibble
function nib(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 87; // a-f
  if (c >= 65 && c <= 70) return c - 55; // A-F
  return 0;
}

/** hex string (<=32 chars) -> byte array; anything longer is treated as raw chars */
function md5StrToArray(str) {
  if (str.length > 32) {
    const out = new Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  const out = [];
  for (let i = 0; i + 1 < str.length; i += 2) {
    out.push((nib(str[i]) << 4) | nib(str[i + 1]));
  }
  return out;
}

function md5(input) {
  const arr = typeof input === 'string' ? md5StrToArray(input) : input;
  return crypto.createHash('md5').update(Buffer.from(arr)).digest('hex');
}

/** double-md5 then back to bytes - what the JS bundle does to the query string */
function md5Encrypt(urlParams) {
  return md5StrToArray(md5(md5StrToArray(md5(urlParams))));
}

/** RC4 over latin1 code points, returns a latin1 string */
function rc4(key, data) {
  const S = new Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key.charCodeAt(i % key.length)) & 0xff;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
  }
  let i = 0;
  j = 0;
  let out = '';
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
    out += String.fromCharCode(data.charCodeAt(k) ^ S[(S[i] + S[j]) & 0xff]);
  }
  return out;
}

// the bundle interleaves the 19 bytes in this fixed order before the final RC4
function shuffle19(a) {
  const y = [
    a[0], a[10], a[1], a[11], a[2], a[12], a[3], a[13], a[4], a[14],
    a[5], a[15], a[6], a[16], a[7], a[17], a[8], a[18], a[9],
  ];
  return y.map((n) => String.fromCharCode(n & 0xff)).join('');
}

// 3 bytes -> 4 charset chars (custom base64 alphabet)
function b64Triple(a1, a2, a3) {
  const n = ((a1 & 255) << 16) | ((a2 & 255) << 8) | (a3 & 255);
  return (
    CHARSET[(n & 0xfc0000) >> 18] +
    CHARSET[(n & 0x03f000) >> 12] +
    CHARSET[(n & 0x000fc0) >> 6] +
    CHARSET[n & 0x3f]
  );
}

const UA_RC4_KEY = String.fromCharCode(0, 1, 14);
const FINAL_RC4_KEY = String.fromCharCode(255);

/**
 * @param {string} urlParams query string WITHOUT the leading "?"
 * @param {string} userAgent
 * @param {number} [timestamp] unix seconds
 * @returns {{xbogus: string, params: string, timestamp: number}}
 */
function sign(urlParams, userAgent, timestamp) {
  const ts = timestamp || Math.floor(Date.now() / 1000);

  // md5 of an empty POST body
  const bodyArr = md5StrToArray(
    md5(md5StrToArray('d41d8cd98f00b204e9800998ecf8427e'))
  );

  // UA -> RC4 -> base64 -> double md5
  const uaRc4 = rc4(UA_RC4_KEY, userAgent);
  const uaB64 = Buffer.from(uaRc4, 'latin1').toString('base64');
  const uaArr = md5StrToArray(md5(md5StrToArray(uaB64)));

  const qArr = md5Encrypt(urlParams);

  const CT = 536919696; // env constant baked into the bundle

  const raw = [
    64,
    0, // 0.00390625, truncated to int
    1,
    12,
    qArr[14], qArr[15],
    uaArr[14], uaArr[15],
    bodyArr[14], bodyArr[15],
    (ts >> 24) & 255, (ts >> 16) & 255, (ts >> 8) & 255, ts & 255,
    (CT >> 24) & 255, (CT >> 16) & 255, (CT >> 8) & 255, CT & 255,
  ];

  let xor = raw[0];
  for (let i = 1; i < raw.length; i++) xor ^= raw[i];
  raw.push(xor & 0xff);

  const even = [];
  const odd = [];
  for (let i = 0; i < raw.length; i++) (i % 2 === 0 ? even : odd).push(raw[i]);
  const merged = even.concat(odd);

  const garbled =
    String.fromCharCode(2) +
    String.fromCharCode(255) +
    rc4(FINAL_RC4_KEY, shuffle19(merged));

  let xb = '';
  for (let i = 0; i < garbled.length; i += 3) {
    xb += b64Triple(
      garbled.charCodeAt(i),
      garbled.charCodeAt(i + 1) || 0,
      garbled.charCodeAt(i + 2) || 0
    );
  }

  return { xbogus: xb, params: `${urlParams}&X-Bogus=${xb}`, timestamp: ts };
}

module.exports = { sign, md5, md5Encrypt, rc4 };
