'use strict';
/**
 * Runs TikTok's webmssdk.js inside node:vm against a stubbed browser, with no
 * Chromium involved.
 *
 * The SDK signs by monkey-patching fetch/XHR, so we hand it our own fetch, let
 * it wrap that, then call it and read back the URL it produced - which carries
 * X-Gnarly / X-Dynosaur. Nothing about the algorithm needs to be understood for
 * this to work, and it keeps working when TikTok ships a new bundle: re-download
 * the file and pin the new version.
 *
 * It also doubles as the oracle for a native port: whatever a reimplementation
 * computes has to match what this produces for the same inputs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VENDOR = path.join(__dirname, '..', 'vendor');

// Load order matters and mirrors what the real page does: webmssdk registers
// byted_acrawler, secsdk installs the fetch/XHR interceptors that actually stamp
// X-Gnarly, and webmssdk_ex extends both.
const DEFAULT_BUNDLES = [
  path.join(VENDOR, 'webmssdk-1.0.0.388.js'),
  path.join(VENDOR, 'secsdk-lastest.umd.js'),
  path.join(VENDOR, 'webmssdk_ex-1.0.0.2404.js'),
];
const DEFAULT_BUNDLE = DEFAULT_BUNDLES[0];

/** Minimal EventTarget - the SDK registers listeners it never needs fired. */
function makeEventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign(
    {
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const a = listeners.get(type) || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
      dispatchEvent() {
        return true;
      },
      _fire(type, ev = {}) {
        for (const fn of listeners.get(type) || []) {
          try {
            fn(ev);
          } catch (_) {
            /* listener errors are the SDK's problem, not ours */
          }
        }
      },
    },
    extra
  );
}

function makeCanvas() {
  // Fingerprinting reads pixels back; stable dummy values are fine as long as
  // they are stable - a changing fingerprint looks worse than a boring one.
  const ctx2d = {
    canvas: null,
    fillRect() {}, clearRect() {}, fillText() {}, strokeText() {},
    beginPath() {}, arc() {}, closePath() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, rect() {}, save() {}, restore() {}, translate() {},
    rotate() {}, scale() {}, drawImage() {}, putImageData() {}, measureText: () => ({ width: 42 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
    isPointInPath: () => false,
    set fillStyle(_) {}, get fillStyle() { return '#000'; },
    set strokeStyle(_) {}, get strokeStyle() { return '#000'; },
    set font(_) {}, get font() { return '10px sans-serif'; },
    set globalCompositeOperation(_) {}, get globalCompositeOperation() { return 'source-over'; },
  };

  const GL_STRINGS = {
    7936: 'WebKit', // VENDOR
    7937: 'WebKit WebGL', // RENDERER
    7938: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)', // VERSION
    35724: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    37445: 'Google Inc. (NVIDIA)', // UNMASKED_VENDOR_WEBGL
    37446: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  };
  const glctx = {
    canvas: null,
    getParameter: (p) => (p in GL_STRINGS ? GL_STRINGS[p] : 0),
    getExtension: (name) =>
      name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 }
        : null,
    getSupportedExtensions: () => ['WEBGL_debug_renderer_info', 'OES_texture_float'],
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    createProgram: () => ({}), createShader: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
    useProgram() {}, getAttribLocation: () => 0, enableVertexAttribArray() {},
    vertexAttribPointer() {}, drawArrays() {}, viewport() {}, clearColor() {}, clear() {},
  };

  const canvas = {
    width: 300,
    height: 150,
    style: {},
    getContext(kind) {
      if (kind === '2d') return ctx2d;
      if (String(kind).startsWith('webgl') || kind === 'experimental-webgl') return glctx;
      return null;
    },
    toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    toBlob(cb) { cb && cb({ size: 0, type: 'image/png' }); },
  };
  ctx2d.canvas = canvas;
  glctx.canvas = canvas;
  return canvas;
}

class SdkHost {
  /**
   * @param {object} opts
   * @param {string} [opts.bundlePath]
   * @param {string} [opts.userAgent]
   * @param {string} [opts.cookie]    document.cookie contents (ttwid, msToken, ...)
   * @param {string} [opts.href]      the page the SDK believes it is on
   */
  constructor(opts = {}) {
    this.bundles = opts.bundles || (opts.bundlePath ? [opts.bundlePath] : DEFAULT_BUNDLES);
    this.userAgent = opts.userAgent || DEFAULT_UA;
    this.cookie = opts.cookie || '';
    this.href = opts.href || 'https://www.tiktok.com/';
    this.loaded = false;
    this.calls = []; // every request the patched fetch/XHR produced
  }

  _buildEnv() {
    const self = this;
    const url = new URL(this.href);

    const location = {
      href: this.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: '',
      replace() {},
      assign() {},
      reload() {},
      toString: () => this.href,
    };

    const storage = () => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
        key: (i) => [...m.keys()][i] ?? null,
        get length() { return m.size; },
      };
    };

    const makeElement = (tag) => {
      if (tag === 'canvas') return makeCanvas();
      return makeEventTarget({
        tagName: String(tag).toUpperCase(),
        style: {},
        setAttribute() {}, getAttribute: () => null, removeAttribute() {},
        appendChild: (c) => c, removeChild: (c) => c, insertBefore: (c) => c,
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        children: [], childNodes: [], parentNode: null,
        innerHTML: '', textContent: '', src: '', href: '',
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
      });
    };

    const head = makeElement('head');
    const body = makeElement('body');

    const document = makeEventTarget({
      readyState: 'complete',
      visibilityState: 'visible',
      hidden: false,
      referrer: '',
      title: 'TikTok',
      URL: this.href,
      documentURI: this.href,
      domain: url.hostname,
      characterSet: 'UTF-8',
      compatMode: 'CSS1Compat',
      head,
      body,
      documentElement: makeElement('html'),
      cookie: this.cookie,
      createElement: makeElement,
      createElementNS: (_ns, tag) => makeElement(tag),
      createTextNode: (t) => ({ textContent: t }),
      createEvent: () => ({ initEvent() {} }),
      getElementById: () => null,
      getElementsByTagName: (t) => (t === 'head' ? [head] : t === 'body' ? [body] : []),
      getElementsByClassName: () => [],
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      removeChild: (c) => c,
      currentScript: null,
      location,
    });

    const navigator = {
      userAgent: this.userAgent,
      appVersion: this.userAgent.replace('Mozilla/', ''),
      appName: 'Netscape',
      appCodeName: 'Mozilla',
      platform: 'Win32',
      product: 'Gecko',
      productSub: '20030107',
      vendor: 'Google Inc.',
      vendorSub: '',
      language: 'en-US',
      languages: ['en-US', 'en'],
      onLine: true,
      cookieEnabled: true,
      doNotTrack: null,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      webdriver: undefined,
      plugins: { length: 5, item: () => null, namedItem: () => null },
      mimeTypes: { length: 2, item: () => null },
      javaEnabled: () => false,
      sendBeacon: () => true,
      permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
      connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false },
      userAgentData: {
        brands: [
          { brand: 'Not_A Brand', version: '8' },
          { brand: 'Chromium', version: '131' },
          { brand: 'Google Chrome', version: '131' },
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: () => Promise.resolve({ platformVersion: '15.0.0' }),
      },
    };

    const screen = {
      width: 1920, height: 1080, availWidth: 1920, availHeight: 1040,
      colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0 },
    };

    // The request sink. The SDK wraps this; we read back what it produced.
    const baseFetch = (input, init = {}) => {
      const u = typeof input === 'string' ? input : input && input.url;
      self.calls.push({ via: 'fetch', url: String(u), headers: (init && init.headers) || {} });
      const res = {
        ok: true, status: 200, statusText: 'OK', url: String(u), redirected: false, type: 'basic',
        headers: { get: () => null, has: () => false, forEach() {} },
        text: async () => '',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => ({ size: 0 }),
        clone() { return res; },
      };
      return Promise.resolve(res);
    };

    class XMLHttpRequest {
      constructor() {
        this.readyState = 0; this.status = 0; this.responseText = ''; this.response = '';
        this._headers = {};
        this.onreadystatechange = null; this.onload = null; this.onerror = null;
      }
      open(method, url) { this._method = method; this._url = url; this.readyState = 1; }
      setRequestHeader(k, v) { this._headers[k] = v; }
      getAllResponseHeaders() { return ''; }
      getResponseHeader() { return null; }
      addEventListener(t, fn) { this['on' + t] = fn; }
      removeEventListener() {}
      send() {
        self.calls.push({ via: 'xhr', url: String(this._url), headers: this._headers });
        this.readyState = 4; this.status = 200;
        if (this.onreadystatechange) this.onreadystatechange();
        if (this.onload) this.onload();
      }
      abort() {}
    }

    const perfStart = Date.now();
    const performance = {
      now: () => Date.now() - perfStart,
      timeOrigin: perfStart,
      timing: { navigationStart: perfStart, loadEventEnd: perfStart + 800 },
      getEntriesByType: () => [],
      getEntriesByName: () => [],
      mark() {}, measure() {},
      memory: { usedJSHeapSize: 12345678, totalJSHeapSize: 23456789, jsHeapSizeLimit: 2172649472 },
    };

    const env = {
      console,
      Math, Date, JSON, Object, Array, String, Number, Boolean, Function, Symbol,
      Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
      RegExp, Promise, Map, Set, WeakMap, WeakSet, Proxy, Reflect, BigInt,
      Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
      TextEncoder, TextDecoder, URL, URLSearchParams, AbortController,
      parseInt, parseFloat, isNaN, isFinite, escape, unescape,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      setTimeout, clearTimeout, setInterval, clearInterval,
      queueMicrotask, structuredClone,
      requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
      cancelAnimationFrame: clearTimeout,
      requestIdleCallback: (fn) => setTimeout(() => fn({ timeRemaining: () => 50 }), 1),
      cancelIdleCallback: clearTimeout,

      document, navigator, location, screen, performance,
      history: { length: 3, state: null, pushState() {}, replaceState() {}, go() {}, back() {}, forward() {} },
      localStorage: storage(),
      sessionStorage: storage(),
      crypto: {
        getRandomValues: (arr) => {
          crypto.randomFillSync(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
          return arr;
        },
        randomUUID: () => crypto.randomUUID(),
        subtle: undefined,
      },
      fetch: baseFetch,
      XMLHttpRequest,
      Headers: class Headers {
        constructor(init) { this._m = new Map(Object.entries(init || {})); }
        get(k) { return this._m.get(k) ?? null; }
        set(k, v) { this._m.set(k, v); }
        has(k) { return this._m.has(k); }
        append(k, v) { this._m.set(k, v); }
        forEach(fn) { this._m.forEach(fn); }
      },
      Request: class Request { constructor(url, init) { this.url = url; Object.assign(this, init); } },
      Response: class Response { constructor(body, init) { this.body = body; Object.assign(this, init); } },
      Event: class Event { constructor(type) { this.type = type; } },
      CustomEvent: class CustomEvent { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
      MutationObserver: class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } },
      IntersectionObserver: class IntersectionObserver { observe() {} disconnect() {} unobserve() {} },
      PerformanceObserver: class PerformanceObserver { observe() {} disconnect() {} },
      WebSocket: class WebSocket { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} },
      Worker: class Worker { postMessage() {} terminate() {} addEventListener() {} },
      Image: class Image { constructor() { this.src = ''; } addEventListener() {} },
      innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 900,
      devicePixelRatio: 1, screenX: 0, screenY: 0, scrollX: 0, scrollY: 0,
      name: '', closed: false, isSecureContext: true, origin: url.origin,
      Intl,
      // deliberately absent: `process`, so the SDK does not take a Node branch
    };

    const target = makeEventTarget(env);
    target.window = target;
    target.self = target;
    target.top = target;
    target.parent = target;
    target.globalThis = target;
    target.frames = target;
    target.document.defaultView = target;

    this.env = target;
    return target;
  }

  load() {
    if (this.loaded) return this;
    const env = this._buildEnv();
    const context = vm.createContext(env);

    this.loadReport = [];
    for (const bundle of this.bundles) {
      const name = path.basename(bundle);
      if (!fs.existsSync(bundle)) {
        this.loadReport.push({ bundle: name, ok: false, error: 'not found' });
        continue;
      }
      const fetchBefore = env.fetch;
      const xhrSendBefore = env.XMLHttpRequest.prototype.send;
      try {
        vm.runInContext(fs.readFileSync(bundle, 'utf8'), context, {
          filename: name,
          timeout: 30000,
        });
        this.loadReport.push({
          bundle: name,
          ok: true,
          patchedFetch: env.fetch !== fetchBefore,
          patchedXhrSend: env.XMLHttpRequest.prototype.send !== xhrSendBefore,
        });
      } catch (e) {
        // One bundle failing should not hide whether the others installed their
        // hooks - record and keep going.
        this.loadReport.push({ bundle: name, ok: false, error: e.message });
      }
    }

    this._configureMssdk(env);

    this.loaded = true;
    this.acrawler = env.byted_acrawler;
    return this;
  }

  /**
   * Tell _mssdk which paths to sign.
   *
   * On a real page the TikTok app fills `_enablePathList` — 209 route prefixes,
   * everything from /api/item/detail/ to /api/comment/list/. The SDK signs a
   * request only if its path matches, so out of the app this list is empty and
   * nothing gets signed however correctly the bundles loaded. The list is
   * captured from a live page by `scripts/probe-mssdk.js` into
   * vendor/mssdk-paths.json; re-run it if a new endpoint stops being signed.
   */
  _configureMssdk(env) {
    const mssdk = env._mssdk;
    if (!mssdk) {
      this.mssdkConfigured = false;
      return;
    }
    const file = path.join(VENDOR, 'mssdk-paths.json');
    if (!fs.existsSync(file)) {
      this.mssdkConfigured = false;
      return;
    }
    const { enablePathList = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
    mssdk._enablePathList = enablePathList.slice();
    // Rebuild the regexes in the sandbox's own RegExp, not ours.
    mssdk._enablePathListRegex = enablePathList.map(
      (p) => new env.RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    env.MSSDK_INITIALIZED = true;
    this.mssdkConfigured = true;
    this.signedPaths = enablePathList.length;
  }

  /** byted_acrawler.init(...) is what the real page calls before signing. */
  init(opts = {}) {
    if (!this.acrawler || typeof this.acrawler.init !== 'function') {
      throw new Error('byted_acrawler.init missing after load');
    }
    this.acrawler.init({
      aid: 1988,
      dfp: true,
      boe: false,
      region: 'va',
      initialize: true,
      ...opts,
    });
    return this;
  }

  /**
   * Push a URL through the (now patched) fetch and return what actually went
   * out. If the SDK wrapped fetch, the returned URL carries X-Gnarly.
   */
  async signViaFetch(url) {
    const before = this.calls.length;
    await this.env.fetch(url, { method: 'GET', headers: {} });
    const produced = this.calls.slice(before);
    if (!produced.length) throw new Error('patched fetch produced no request');
    return produced[produced.length - 1];
  }

  /** The legacy call, kept because it is a cheap liveness check. */
  frontierSign(url) {
    if (!this.acrawler || typeof this.acrawler.frontierSign !== 'function') {
      throw new Error('byted_acrawler.frontierSign missing');
    }
    return this.acrawler.frontierSign({ url });
  }
}

module.exports = { SdkHost, DEFAULT_UA, DEFAULT_BUNDLE };
