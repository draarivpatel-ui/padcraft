/*
 * PadCraft DFM and Matrix Scaling Lab (pad-lab.js)
 * ----------------------------------------------------------------------
 * A pure, deterministic audit layer on top of cad.js. It has no runtime
 * dependencies and runs in two places unchanged:
 *   1. Node, as a library:  const lab = require('./pad-lab.js')
 *   2. A browser, as a script tag: it installs globalThis.PadCraftLab
 *
 * Everything the lab reports is recomputed from the real generator and the
 * real verification engine (generateAll, verifyBundle, auditDesign,
 * inspectBoard). Nothing is fabricated: benchmark rows call the same code
 * paths the exports use.
 *
 * Pure helpers (SHA-256, canonical JSON, CSV escaping, the #pclab= hash
 * codec, CRC32 and the ZIP reader) work standalone. The DOM mount is
 * optional: if PadCraftLab or a full DOM is absent the workstation keeps
 * working and the static fallback note stays visible.
 */

(function () {
  'use strict';

  /* =================================================================== *
   * 1. FIPS 180-4 SHA-256 (pure JS, deterministic in Node and browser)
   * =================================================================== */

  function utf8(text) {
    const s = String(text), out = [];
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i);
      if (cp > 0xFFFF) i++;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return Uint8Array.from(out);
  }

  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Hex(input) {
    const bytes = typeof input === 'string' ? utf8(input) : Uint8Array.from(input);
    const padded = new Uint8Array((Math.floor((bytes.length + 8) / 64) + 1) * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = bytes.length * 8;
    view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
    view.setUint32(padded.length - 4, bitLength >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let block = 0; block < padded.length; block += 64) {
      for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4);
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      const v = h.slice();
      for (let t = 0; t < 64; t++) {
        const s1 = rotr(v[4], 6) ^ rotr(v[4], 11) ^ rotr(v[4], 25);
        const ch = (v[4] & v[5]) ^ (~v[4] & v[6]);
        const t1 = (v[7] + s1 + ch + SHA256_K[t] + w[t]) | 0;
        const s0 = rotr(v[0], 2) ^ rotr(v[0], 13) ^ rotr(v[0], 22);
        const maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
        const t2 = (s0 + maj) | 0;
        v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = (v[3] + t1) | 0;
        v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = (t1 + t2) | 0;
      }
      for (let i = 0; i < 8; i++) h[i] = (h[i] + v[i]) | 0;
    }
    return [...h].map(word => (word >>> 0).toString(16).padStart(8, '0')).join('');
  }

  /* =================================================================== *
   * 2. CRC32 (ZIP integrity) and a strict local-header ZIP reader
   * =================================================================== */

  const CRC_TABLE = (function () {
    const t = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    const bytes = typeof data === 'string' ? utf8(data) : data;
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* Parses the local file headers of a store/deflate ZIP and verifies every
   * stored CRC32 against the entry payload it carries. Throws on truncated
   * or hostile records instead of trusting them. */
  function zipEntries(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const entries = [];
    let off = 0;
    while (off + 4 <= data.length && view.getUint32(off, true) === 0x04034b50) {
      if (off + 30 > data.length) throw new Error('Truncated ZIP local header');
      const method = view.getUint16(off + 8, true);
      const crc = view.getUint32(off + 14, true);
      const size = view.getUint32(off + 22, true);
      const nameLen = view.getUint16(off + 26, true);
      const extraLen = view.getUint16(off + 28, true);
      const nameBytes = data.slice(off + 30, off + 30 + nameLen);
      const start = off + 30 + nameLen + extraLen;
      if (start + size > data.length) throw new Error('Truncated ZIP entry payload');
      const payload = data.slice(start, start + size);
      let name = '';
      for (const b of nameBytes) name += String.fromCharCode(b);
      entries.push({ name, method, crc, size, verified: method === 0 ? crc32(payload) === crc : null });
      off = start + size;
    }
    return entries;
  }

  /* =================================================================== *
   * 3. Canonical JSON: cycle safe, depth bounded, key ordered
   * =================================================================== */

  const CANON_MAX_DEPTH = 64;

  function canonicalJSON(value) {
    const stack = new Set();
    const enc = (v, depth) => {
      if (v === null) return 'null';
      const t = typeof v;
      if (t === 'boolean') return v ? 'true' : 'false';
      if (t === 'number') {
        if (!Number.isFinite(v)) throw new TypeError('canonicalJSON: non-finite number');
        return v === 0 ? '0' : String(v);
      }
      if (t === 'string') return JSON.stringify(v);
      if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
      if (t === 'bigint') throw new TypeError('canonicalJSON: bigint is unsupported');
      if (depth > CANON_MAX_DEPTH) throw new TypeError('canonicalJSON: depth bound exceeded');
      if (stack.has(v)) throw new TypeError('canonicalJSON: cyclic value');
      stack.add(v);
      try {
        if (Array.isArray(v)) {
          const parts = [];
          for (let i = 0; i < v.length; i++) {
            const piece = enc(v[i], depth + 1);
            parts.push(piece === undefined ? 'null' : piece);
          }
          return '[' + parts.join(',') + ']';
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== null && proto !== Object.prototype) {
          throw new TypeError('canonicalJSON: only plain objects and arrays are supported');
        }
        const parts = [];
        for (const key of Object.keys(v).sort()) {
          const piece = enc(v[key], depth + 1);
          if (piece !== undefined) parts.push(JSON.stringify(key) + ':' + piece);
        }
        return '{' + parts.join(',') + '}';
      } finally {
        stack.delete(v);
      }
    };
    return enc(value, 0);
  }

  /* =================================================================== *
   * 4. Formula-injection-safe CSV fields
   * =================================================================== */

  function csvField(value) {
    let s = value === undefined || value === null ? '' : String(value);
    if (/^[\s\u0085\u180E\u200B\u200C\u200D\u2060\uFEFF]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csvRow(fields) {
    return fields.map(csvField).join(',');
  }

  /* =================================================================== *
   * 5. Deterministic measurement on top of the real engine
   * =================================================================== */

  function round3(value) {
    return Math.round(value * 1000) / 1000;
  }

  /* The four shipped showcases plus four extra stress and edge matrices.
   * Showcase configs are cloned so the lab can never mutate the presets. */
  function benchmarkSpecs(pc) {
    const clone = id => JSON.parse(JSON.stringify(pc.SHOWCASES[id].config));
    return [
      { id: 'studio', label: 'Studio control', tag: 'showcase', config: clone('studio') },
      { id: 'sensor', label: 'Sensor console', tag: 'showcase', config: clone('sensor') },
      { id: 'compact', label: 'Pocket instrument', tag: 'showcase', config: clone('compact') },
      { id: 'sweep', label: '48-key stress test', tag: 'showcase', config: clone('sweep') },
      { id: 'edge-2x2', label: '2x2 Choc compact', tag: 'custom',
        config: { name: 'Lab 2x2 Choc', rows: 2, cols: 2, switchType: 'Choc', keySpacing: 18, encoder: false, sensor: false } },
      { id: 'edge-3x4e', label: '3x4 MX plus encoder', tag: 'custom',
        config: { name: 'Lab 3x4 MX ENC', rows: 3, cols: 4, switchType: 'MX', keySpacing: 19.05, encoder: true, sensor: false } },
      { id: 'edge-4x4s', label: '4x4 MX plus 3 ADC', tag: 'custom',
        config: { name: 'Lab 4x4 MX ADC', rows: 4, cols: 4, switchType: 'MX', keySpacing: 19.05, encoder: false, sensor: true, sensorCount: 3 } },
      { id: 'edge-6x7', label: '6x7 MX full peripheral', tag: 'custom',
        config: { name: 'Lab 6x7 MX Full', rows: 6, cols: 7, switchType: 'MX', keySpacing: 19.05, encoder: true, sensor: true, sensorCount: 3 } },
    ];
  }

  /* A showcase id when the normalized config equals a shipped preset. */
  function showcaseIdFor(pc, config) {
    let target = null;
    try { target = canonicalJSON(pc.clampConfig(config)); } catch (_) { return null; }
    for (const id of Object.keys(pc.SHOWCASES)) {
      try {
        if (canonicalJSON(pc.clampConfig(pc.SHOWCASES[id].config)) === target) return id;
      } catch (_) { /* keep scanning */ }
    }
    return null;
  }

  /* Runs the real generator, verifier, audit and geometry screen on one
   * configuration and reports only measured values. */
  function benchmarkConfig(pc, config) {
    const c = pc.clampConfig(config);
    const files = pc.generateAll(c);
    const verification = pc.verifyBundle(c, files);
    const audit = pc.auditDesign(c);
    const board = pc.buildBoard(c);
    const pins = board.netlist.pins;
    const drills = board.drillPoints;
    return {
      name: c.name, rows: c.rows, cols: c.cols, switchType: c.switchType,
      keys: board.stats.keys,
      widthMm: round3(board.layout.width), heightMm: round3(board.layout.height),
      areaCm2: round3(board.layout.width * board.layout.height / 100),
      gpioUsed: pins.needed, gpioPool: pins.pool.length,
      gpioPct: round3(pins.needed / pins.pool.length),
      adcUsed: pins.sensor.length,
      stlTriangles: verification.mesh.triangles,
      stlVolumeCm3: round3(verification.mesh.volume / 1000),
      stlBadEdges: verification.mesh.badEdges,
      pthHits: drills.filter(d => d.plated).length,
      npthHits: drills.filter(d => !d.plated).length,
      copperIssues: verification.geometry.issues.length,
      remainingRoutes: verification.geometry.remainingRoutes,
      airwires: verification.geometry.airwires.length,
      artifactCount: Object.keys(files).length,
      verified: !!verification.valid,
      geometryValid: !!verification.geometry.geometryValid,
      drcErrors: audit.errors, drcWarnings: audit.warnings,
      auditFingerprint: audit.fingerprint,
    };
  }

  /* The matrix ladder the scaling frontier charts: 1x2 up to 6x8. */
  const MATRIX_LADDER = [
    [1, 2], [1, 4], [2, 2], [2, 3], [2, 4], [3, 4], [3, 5], [3, 6],
    [4, 4], [4, 5], [4, 6], [5, 6], [5, 8], [6, 7], [6, 8],
  ];

  /* Area and RP2040 GPIO utilization for every ladder size, per switch
   * footprint. MX keeps its 19.05 mm pitch, Choc the compact 18 mm pitch. */
  function matrixFrontier(pc) {
    const series = [];
    for (const switchType of ['MX', 'Choc']) {
      const points = [];
      for (const [rows, cols] of MATRIX_LADDER) {
        const cfg = { rows, cols, switchType, keySpacing: switchType === 'Choc' ? 18 : 19.05, encoder: false, sensor: false };
        const layout = pc.computeLayout(cfg);
        const pins = pc.buildPinAssignment(cfg);
        points.push({
          rows, cols, switchType, keys: rows * cols,
          widthMm: round3(layout.width), heightMm: round3(layout.height),
          areaCm2: round3(layout.width * layout.height / 100),
          gpioUsed: pins.needed, gpioPool: pins.pool.length,
          gpioPct: round3(pins.needed / pins.pool.length),
        });
      }
      series.push({ switchType, points });
    }
    return series;
  }

  /* =================================================================== *
   * 6. Audited DFM proof brief: one cached canonical SHA-256 per design
   * =================================================================== */

  const LAB_SCHEMA = 'padcraft.lab/1';
  const briefCache = new Map();
  const BRIEF_CACHE_MAX = 24;

  /* Deterministic state key: the normalized configuration, canonically
   * serialized. Identical designs share one digest-stamped payload. */
  function briefStateKey(pc, config) {
    return canonicalJSON(pc.clampConfig(config));
  }

  function buildBriefPayload(pc, config) {
    const c = pc.clampConfig(config);
    const files = pc.generateAll(c);
    const verification = pc.verifyBundle(c, files);
    const audit = pc.auditDesign(c);
    const proof = pc.buildLayoutProof(c, files);
    const metrics = benchmarkConfig(pc, c);
    return {
      schema: LAB_SCHEMA,
      design: {
        name: c.name, program: c.program,
        rows: c.rows, cols: c.cols, switchType: c.switchType,
        keySpacingMm: c.keySpacing, encoder: c.encoder,
        sensor: c.sensor, sensorCount: c.sensor ? c.sensorCount : 0,
      },
      metrics,
      checks: {
        verified: metrics.verified, geometryValid: metrics.geometryValid,
        drcErrors: metrics.drcErrors, drcWarnings: metrics.drcWarnings,
        auditFingerprint: audit.fingerprint,
        bundleFingerprint: proof.fingerprint,
      },
      files: proof.files.map(entry => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })),
    };
  }

  /* Returns the cached digest-stamped brief for this exact design state.
   * The on-page fingerprint, JSON, CSV and Markdown exports all reuse this
   * one object, so every surface stamps the identical SHA-256. */
  function getBrief(pc, config) {
    const key = briefStateKey(pc, config);
    if (briefCache.has(key)) return briefCache.get(key);
    const payload = buildBriefPayload(pc, config);
    const stamped = { ...payload, sha256: sha256Hex(canonicalJSON(payload)) };
    if (briefCache.size >= BRIEF_CACHE_MAX) briefCache.delete(briefCache.keys().next().value);
    briefCache.set(key, stamped);
    return stamped;
  }

  function briefDigest(stamped) {
    const { sha256, ...payload } = stamped;
    return sha256Hex(canonicalJSON(payload));
  }

  function verifyBriefDigest(stamped) {
    if (!stamped || typeof stamped !== 'object' || typeof stamped.sha256 !== 'string') {
      return { valid: false, expected: null, actual: null };
    }
    const actual = briefDigest(stamped);
    return { valid: actual === stamped.sha256, expected: stamped.sha256, actual };
  }

  /* One-unit tamper demo: mutates a single measured count and proves the
   * digest no longer verifies against the stamped value. */
  function briefTamperDemo(stamped) {
    const { sha256, ...payload } = JSON.parse(JSON.stringify(stamped));
    payload.metrics.keys = (payload.metrics.keys || 0) + 1;
    const forged = { ...payload, sha256 };
    const replayed = { ...payload, sha256: briefDigest(payload) };
    return {
      mutatedField: 'metrics.keys', from: stamped.metrics.keys, to: payload.metrics.keys,
      stampedDigest: sha256,
      replayedDigest: replayed.sha256,
      forgeryRejected: !verifyBriefDigest(forged).valid,
      changed: replayed.sha256 !== sha256,
    };
  }

  function briefToJson(stamped) {
    return JSON.stringify(stamped, null, 2) + '\n';
  }

  function briefToCsv(stamped) {
    const m = stamped.metrics, d = stamped.design;
    const lines = [
      '# ' + LAB_SCHEMA + ' | design ' + d.name + ' | sha256 ' + stamped.sha256,
      csvRow(['section', 'key', 'value']),
      csvRow(['design', 'name', d.name]),
      csvRow(['design', 'program', d.program]),
      csvRow(['design', 'matrix', d.rows + 'x' + d.cols + ' ' + d.switchType]),
      csvRow(['design', 'key_spacing_mm', d.keySpacingMm]),
      csvRow(['metrics', 'board_mm', m.widthMm + 'x' + m.heightMm]),
      csvRow(['metrics', 'area_cm2', m.areaCm2]),
      csvRow(['metrics', 'keys', m.keys]),
      csvRow(['metrics', 'gpio_used_of_pool', m.gpioUsed + '/' + m.gpioPool]),
      csvRow(['metrics', 'gpio_utilization', m.gpioPct]),
      csvRow(['metrics', 'adc_channels', m.adcUsed]),
      csvRow(['metrics', 'stl_triangles', m.stlTriangles]),
      csvRow(['metrics', 'stl_volume_cm3', m.stlVolumeCm3]),
      csvRow(['metrics', 'stl_bad_edges', m.stlBadEdges]),
      csvRow(['metrics', 'pth_hits', m.pthHits]),
      csvRow(['metrics', 'npth_hits', m.npthHits]),
      csvRow(['metrics', 'copper_findings', m.copperIssues]),
      csvRow(['metrics', 'remaining_routes', m.remainingRoutes]),
      csvRow(['metrics', 'airwire_groups', m.airwires]),
      csvRow(['metrics', 'bundle_artifacts', m.artifactCount]),
      csvRow(['checks', 'verified', m.verified]),
      csvRow(['checks', 'geometry_valid', m.geometryValid]),
      csvRow(['checks', 'audit_errors', m.drcErrors]),
      csvRow(['checks', 'audit_warnings', m.drcWarnings]),
      csvRow(['digest', 'sha256', stamped.sha256]),
    ];
    return lines.join('\n') + '\n';
  }

  function briefToMarkdown(stamped) {
    const m = stamped.metrics, d = stamped.design;
    return [
      '# PadCraft DFM proof brief',
      '',
      'Design: ' + d.name + ' (' + d.program + ')',
      'Matrix: ' + d.rows + 'x' + d.cols + ' ' + d.switchType + ' at ' + d.keySpacingMm + ' mm pitch',
      'Board: ' + m.widthMm + ' x ' + m.heightMm + ' mm (' + m.areaCm2 + ' cm^2)',
      'GPIO: ' + m.gpioUsed + ' of ' + m.gpioPool + ' digital (GP0-GP22), ' + m.adcUsed + ' ADC (GP26-GP28)',
      'Plate STL: ' + m.stlTriangles + ' triangles, ' + m.stlVolumeCm3 + ' cm^3, ' + m.stlBadEdges + ' open edges',
      'Drills: ' + m.pthHits + ' plated, ' + m.npthHits + ' non-plated',
      'Copper findings: ' + m.copperIssues + ' | Remaining routes: ' + m.remainingRoutes + ' | Airwire groups: ' + m.airwires,
      'Bundle artifacts: ' + m.artifactCount,
      'Verification: ' + (m.verified ? 'PASS' : 'FAIL') + ' | Geometry: ' + (m.geometryValid ? 'PASS' : 'FAIL') +
        ' | Audit: ' + m.drcErrors + ' errors, ' + m.drcWarnings + ' warnings',
      'Audit fingerprint: ' + stamped.checks.auditFingerprint,
      'Bundle fingerprint: ' + stamped.checks.bundleFingerprint,
      '',
      'SHA-256: ' + stamped.sha256,
      '',
    ].join('\n');
  }

  /* =================================================================== *
   * 7. Fail-closed #pclab= URL hash codec
   * =================================================================== */

  const HASH_KEYS = { v: 1, sel: 1, r: 1, c: 1, sw: 1, e: 1, s: 1 };

  function clampInt(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function intField(v) {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^-?\d{1,6}$/.test(v)) return parseInt(v, 10);
    return null;
  }

  /* encode({ sel: 'studio' }) or encode({ r: 3, c: 4, sw: 'mx', e: 1, s: 0 }).
   * Emits canonical clamped integers so decode(encode(x)) is stable. */
  function encodeHash(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const parts = ['v=1'];
    if (state.sel !== undefined && state.sel !== null) {
      if (typeof state.sel !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(state.sel)) return null;
      parts.push('sel=' + state.sel);
      return 'pclab=' + parts.join('&');
    }
    const r = intField(state.r), c = intField(state.c);
    if (r === null || c === null) return null;
    parts.push('r=' + clampInt(r, 1, 6));
    parts.push('c=' + clampInt(c, 1, 8));
    parts.push('sw=' + (state.sw === 'choc' ? 'choc' : 'mx'));
    const e = intField(state.e === undefined ? 0 : state.e);
    const s = intField(state.s === undefined ? 0 : state.s);
    if (e === null || s === null) return null;
    parts.push('e=' + (e > 0 ? 1 : 0));
    parts.push('s=' + clampInt(s, 0, 3));
    return 'pclab=' + parts.join('&');
  }

  function decodeHash(input) {
    let s = input === undefined || input === null ? '' : String(input);
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s.indexOf('pclab=') !== 0) return null;
    const body = s.slice(6);
    if (!body.length || body.length > 160) return null;
    const pairs = body.split('&');
    if (pairs.length > 8) return null;
    const seen = new Map();
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0 || eq !== pair.lastIndexOf('=')) return null;
      const key = pair.slice(0, eq), value = pair.slice(eq + 1);
      /* hasOwnProperty guard: unknown, inherited and magic keys such as
       * __proto__ or constructor reject the whole hash, fail closed. */
      if (!Object.prototype.hasOwnProperty.call(HASH_KEYS, key)) return null;
      if (seen.has(key)) return null;
      if (!value.length || value.length > 48 || /[^a-zA-Z0-9_-]/.test(value)) return null;
      seen.set(key, value);
    }
    if (seen.get('v') !== '1') return null;
    if (seen.has('sel')) {
      if (seen.size !== 2) return null;
      const sel = seen.get('sel');
      return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(sel) ? { v: 1, sel } : null;
    }
    if (!seen.has('r') || !seen.has('c')) return null;
    const intVal = key => {
      const v = seen.get(key);
      return v !== undefined && /^-?\d{1,4}$/.test(v) ? parseInt(v, 10) : null;
    };
    const r = intVal('r'), c = intVal('c');
    if (r === null || c === null || !Number.isFinite(r) || !Number.isFinite(c)) return null;
    let sw = 'mx';
    if (seen.has('sw')) {
      sw = seen.get('sw');
      if (sw !== 'mx' && sw !== 'choc') return null;
    }
    let enc = 0, sen = 0;
    if (seen.has('e')) { enc = intVal('e'); if (enc === null) return null; }
    if (seen.has('s')) { sen = intVal('s'); if (sen === null) return null; }
    return {
      v: 1,
      matrix: {
        rows: clampInt(r, 1, 6), cols: clampInt(c, 1, 8),
        switchType: sw === 'choc' ? 'Choc' : 'MX',
        encoder: enc > 0, sensor: sen > 0, sensorCount: clampInt(sen, 0, 3),
      },
    };
  }

  /* =================================================================== *
   * 8. In-page deterministic self-tests (>= 18 checks)
   * =================================================================== */

  function selfTests(pc, deps) {
    deps = deps || {};
    const checks = [];
    const run = (id, label, fn) => {
      let pass = false, detail = '';
      try {
        const out = fn();
        pass = out === true || (out && !!out.pass);
        detail = out && out.detail !== undefined ? String(out.detail) : '';
      } catch (error) {
        pass = false;
        detail = 'threw: ' + (error && error.message);
      }
      checks.push({ id, label, pass: !!pass, detail });
    };
    const need = (what) => {
      if (!pc) throw new Error('PadCraft engine unavailable for ' + what);
    };

    run('sha256.kat.empty', 'SHA-256 known answer: empty string', () =>
      sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    run('sha256.kat.abc', 'SHA-256 known answer: abc', () =>
      sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    run('sha256.kat.padding', 'SHA-256 known answers at padding boundaries', () =>
      sha256Hex('a'.repeat(56)) === 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a' &&
      sha256Hex('a'.repeat(64)) === 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb' &&
      sha256Hex('a'.repeat(119)) === '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb' &&
      sha256Hex('a'.repeat(128)) === '6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e');
    run('sha256.kat.long', 'SHA-256 known answer: one million a bytes', () =>
      sha256Hex('a'.repeat(1000000)) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    run('canon.keyorder', 'Canonical JSON orders keys recursively', () =>
      canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 4 } }) === '{"a":{"c":4,"d":[3,{"y":2,"z":1}]},"b":1}');
    run('canon.cycle', 'Canonical JSON rejects cycles', () => {
      const o = { a: 1 }; o.self = o;
      try { canonicalJSON(o); return false; } catch (e) { return /cyclic/.test(e.message); }
    });
    run('canon.depth', 'Canonical JSON enforces the depth bound', () => {
      let o = {}, cur = o;
      for (let i = 0; i < 80; i++) { cur.next = {}; cur = cur.next; }
      try { canonicalJSON(o); return false; } catch (e) { return /depth bound/.test(e.message); }
    });
    run('canon.finite', 'Canonical JSON rejects non-finite numbers', () => {
      for (const bad of [NaN, Infinity, -Infinity]) {
        try { canonicalJSON({ v: bad }); return false; } catch (e) { if (!/non-finite/.test(e.message)) return false; }
      }
      return true;
    });
    run('csv.formula', 'CSV fields escape spreadsheet formula injection', () =>
      csvField('=1+1') === "'=1+1" && csvField('+cmd') === "'+cmd" && csvField('-9') === "'-9" &&
      csvField('@x') === "'@x" && csvField('\tx') === "'\tx" && csvField('\rx') === '"\'\rx"');
    run('csv.quote', 'CSV fields quote commas, quotes and newlines', () =>
      csvField('a,b') === '"a,b"' && csvField('say "hi"') === '"say ""hi"""' &&
      csvField('two\nlines') === '"two\nlines"' && csvField('plain') === 'plain');
    run('stl.watertight', 'Generated plate STL is closed and positive volume', () => {
      need('stl');
      const cfg = { rows: 3, cols: 4, encoder: true, sensor: true };
      const mesh = pc.validateSTL(pc.generateSTL(cfg));
      return { pass: mesh.valid && mesh.badEdges === 0 && mesh.volume > 0, detail: mesh.triangles + ' triangles, ' + mesh.badEdges + ' open edges' };
    });
    run('gerber.fslax', 'Front copper Gerber carries the RS-274X FSLAX36Y36 header', () => {
      need('gerber');
      const g = pc.generateGerberFCu({ rows: 2, cols: 3, encoder: false, sensor: false });
      return g.indexOf('%FSLAX36Y36*%') !== -1 && g.indexOf('%MOMM*%') !== -1 && /M02\*\s*$/.test(g);
    });
    run('excellon.m48', 'Excellon drills carry the M48/METRIC/M30 structure', () => {
      need('excellon');
      const pth = pc.generateExcellon({ rows: 2, cols: 3, encoder: false, sensor: false }, true);
      const npth = pc.generateExcellon({ rows: 2, cols: 3, encoder: false, sensor: false }, false);
      return /^M48\n/.test(pth) && pth.indexOf('METRIC,TZ') !== -1 && /M30\s*$/.test(pth) &&
        /^M48\n/.test(npth) && /M30\s*$/.test(npth) && pc.validateExcellon(pth).hits.length > 0;
    });
    run('gpio.disjoint', 'RP2040 digital and ADC pools never overlap', () => {
      need('gpio');
      const digital = new Set(pc.RP2040_GPIO_POOL.map(n => 'GP' + n));
      const overlap = pc.RP2040_ADC_POOL.filter(p => digital.has(p));
      const pins = pc.buildPinAssignment({ rows: 6, cols: 8, encoder: true, sensor: true, sensorCount: 3, pinOffset: 6 });
      const unique = new Set(pins.usage.map(u => u.pin)).size === pins.usage.length;
      return { pass: overlap.length === 0 && unique, detail: pins.needed + ' digital GPIOs unique, ' + pins.sensor.length + ' ADC' };
    });
    run('zip.crc32', 'ZIP CRC32 verified against the standard vector and writer', () => {
      if (crc32('123456789') !== 0xCBF43926) return false;
      const zip = deps.zip;
      if (!zip || typeof zip.buildZip !== 'function') return { pass: true, detail: 'vector only' };
      const entries = zipEntries(zip.buildZip([
        { name: 'a.txt', data: 'hello zip' },
        { name: 'dir/b.json', data: '{"k":1}' },
      ]));
      return { pass: entries.length === 2 && entries.every(e => e.verified === true), detail: entries.length + ' entries verified' };
    });
    run('digest.parity', 'One SHA-256 stamps the page, JSON, CSV and Markdown surfaces', () => {
      need('brief');
      const stamped = getBrief(pc, { rows: 3, cols: 4, encoder: true, sensor: false, name: 'Lab Digest Check' });
      const surfaces = [stamped.sha256, briefToJson(stamped), briefToCsv(stamped), briefToMarkdown(stamped)];
      return surfaces.every(text => String(text).indexOf(stamped.sha256) !== -1);
    });
    run('digest.verify', 'Verify Digest recomputes and accepts the stamped brief', () => {
      need('brief');
      const stamped = getBrief(pc, { rows: 2, cols: 2, encoder: false, sensor: false, name: 'Lab Verify Check' });
      const res = verifyBriefDigest(stamped);
      return { pass: res.valid, detail: res.expected ? res.expected.slice(0, 16) : '' };
    });
    run('digest.tamper', 'A one-unit tamper changes the digest and fails verification', () => {
      need('brief');
      const stamped = getBrief(pc, { rows: 2, cols: 2, encoder: false, sensor: false, name: 'Lab Tamper Check' });
      const demo = briefTamperDemo(stamped);
      return { pass: demo.changed && demo.forgeryRejected, detail: 'keys ' + demo.from + ' -> ' + demo.to };
    });
    run('hash.roundtrip', '#pclab= encode/decode round-trips both forms', () =>
      JSON.stringify(decodeHash(encodeHash({ sel: 'studio' }))) === JSON.stringify({ v: 1, sel: 'studio' }) &&
      JSON.stringify(decodeHash(encodeHash({ r: 4, c: 5, sw: 'choc', e: 1, s: 2 }))) ===
        JSON.stringify({ v: 1, matrix: { rows: 4, cols: 5, switchType: 'Choc', encoder: true, sensor: true, sensorCount: 2 } }));
    run('hash.hostile', '#pclab= rejects hostile input fail-closed', () =>
      ['pclab=v=2&r=3&c=4', 'pclab=v=1&__proto__=x', 'pclab=v=1&constructor=1',
        'javascript:alert(1)', 'pclab=v=1&r=abc&c=4', 'pclab=v=1&r=3&r=3&c=4',
        'pclab=v=1&unknown=1&r=3&c=4', 'pclab=v=1&sel=a b', 'pclab=v=1&r=3&c=4&sw=evil',
        'pclab=', '', 'pclab=v=1&r=3', 'pclab=v=1&r=3&c=4&v=1',
        'pclab=v=1&sel=' + 'x'.repeat(60), 'pclab=v=1&r=3&c=4=5'].every(h => decodeHash(h) === null));
    run('hash.clamp', '#pclab= clamps out-of-range integers instead of crashing', () => {
      const out = decodeHash('pclab=v=1&r=99&c=0&e=5&s=9');
      return out && out.matrix.rows === 6 && out.matrix.cols === 1 &&
        out.matrix.encoder === true && out.matrix.sensorCount === 3;
    });
    run('bench.showcases', 'All four shipped presets verify end to end', () => {
      need('bench');
      const bad = [];
      for (const id of ['studio', 'sensor', 'compact', 'sweep']) {
        const cfg = pc.clampConfig(pc.SHOWCASES[id].config);
        const files = pc.generateAll(cfg);
        const v = pc.verifyBundle(cfg, files);
        if (!(v.valid && v.geometry.geometryValid)) bad.push(id);
      }
      return { pass: bad.length === 0, detail: bad.length ? 'failed: ' + bad.join(',') : '4/4 verified' };
    });
    run('bench.invariants', 'Benchmark metrics stay inside hardware budgets', () => {
      need('bench');
      for (const spec of benchmarkSpecs(pc)) {
        const m = benchmarkConfig(pc, spec.config);
        if (!(m.verified && m.geometryValid && m.gpioUsed <= m.gpioPool &&
          m.adcUsed <= 3 && m.stlBadEdges === 0 && m.stlVolumeCm3 > 0 &&
          m.pthHits > 0 && m.npthHits > 0 && m.artifactCount === Object.keys(pc.generateAll(spec.config)).length)) {
          return { pass: false, detail: spec.id };
        }
      }
      return { pass: true, detail: benchmarkSpecs(pc).length + ' designs in budget' };
    });
    run('digest.deterministic', 'The same design always stamps the same digest', () => {
      need('brief');
      const cfg = { rows: 3, cols: 4, encoder: true, sensor: false, name: 'Lab Determinism' };
      return getBrief(pc, cfg).sha256 === getBrief(pc, cfg).sha256 &&
        getBrief(pc, cfg) === getBrief(pc, cfg);
    });
    return checks;
  }

  /* =================================================================== *
   * 9. Optional DOM mount: the interactive lab panel
   * =================================================================== */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function mount(rootEl, pc, ui) {
    if (!rootEl || !pc || !ui) return null;
    const doc = rootEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElementNS !== 'function' || typeof doc.createElement !== 'function') return null;

    const el = (tag, cls, text, parent) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      if (parent) parent.appendChild(n);
      return n;
    };
    const mk = (tag, attrs, parent) => {
      const n = doc.createElementNS(SVG_NS, tag);
      if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(n);
      return n;
    };
    const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

    const specs = benchmarkSpecs(pc);
    const state = {
      sel: null,            // { kind:'bench', id } or { kind:'matrix', rows, cols, switchType }
      rows: new Map(),      // bench id -> metrics
      stamped: null,
      selfRan: false,
    };
    const refs = {};

    /* ---- Skeleton --------------------------------------------------- */
    clear(rootEl);

    const status = el('p', 'lab-status', 'Benchmarking shipped presets and edge matrices against the real engine...', rootEl);
    refs.status = status;

    const tableWrap = el('div', 'lab-table-wrap', undefined, rootEl);
    const table = el('table', 'lab-table', undefined, tableWrap);
    const thead = el('thead', null, undefined, table);
    const headRow = el('tr', null, undefined, thead);
    for (const h of ['Design', 'Matrix', 'Switch', 'Board mm', 'cm\u00B2', 'GPIO', 'STL tris', 'cm\u00B3', 'PTH', 'NPTH', 'Issues', 'Routes', 'Airwires', 'Files']) {
      el('th', null, h, headRow);
    }
    const tbody = el('tbody', null, undefined, table);
    refs.tbody = tbody;
    el('p', 'hint', 'Click a row or press Enter on it to load that exact design into the workstation.', rootEl);

    const charts = el('div', 'lab-charts', undefined, rootEl);
    const fig1 = el('figure', 'lab-fig', undefined, charts);
    el('h3', 'lab-fig-title', 'Matrix scaling and RP2040 GPIO frontier', fig1);
    const chart1 = el('div', 'lab-chart', undefined, fig1);
    el('figcaption', 'hint', 'Board area against GPIO utilization for MX and Choc footprints. Focus a marker and press Enter to load that matrix.', fig1);
    const fig2 = el('figure', 'lab-fig', undefined, charts);
    el('h3', 'lab-fig-title', 'Manufacturing breakdown by design', fig2);
    const chart2 = el('div', 'lab-chart', undefined, fig2);
    el('figcaption', 'hint', 'Drill operations, plate mesh volume and remaining routes, each scaled to its own series maximum. Click a column group to load the design.', fig2);
    refs.chart1 = chart1;
    refs.chart2 = chart2;

    const briefBox = el('div', 'lab-brief', undefined, rootEl);
    el('h3', 'lab-fig-title', 'Audited DFM proof brief', briefBox);
    const digestLine = el('p', 'lab-digest', 'Seal the current design to stamp one deterministic SHA-256 on every export surface.', briefBox);
    refs.digest = digestLine;
    const briefBtns = el('div', 'btn-row', undefined, briefBox);
    const btnSeal = el('button', 'btn primary', 'Seal current design', briefBtns); btnSeal.type = 'button';
    const btnJson = el('button', 'btn', 'Export JSON', briefBtns); btnJson.type = 'button'; btnJson.disabled = true;
    const btnCsv = el('button', 'btn', 'Export CSV', briefBtns); btnCsv.type = 'button'; btnCsv.disabled = true;
    const btnMd = el('button', 'btn', 'Export Markdown', briefBtns); btnMd.type = 'button'; btnMd.disabled = true;
    const btnVerify = el('button', 'btn', 'Verify digest', briefBtns); btnVerify.type = 'button'; btnVerify.disabled = true;
    const btnTamper = el('button', 'btn quiet', '1-unit tamper demo', briefBtns); btnTamper.type = 'button'; btnTamper.disabled = true;
    const briefResult = el('p', 'lab-brief-result', '', briefBox);
    refs.briefResult = briefResult;

    const selfBox = el('div', 'lab-selftest', undefined, rootEl);
    el('h3', 'lab-fig-title', 'Deterministic self-tests', selfBox);
    const selfRow = el('div', 'btn-row', undefined, selfBox);
    const btnSelf = el('button', 'btn', 'Run in-page self-tests', selfRow); btnSelf.type = 'button';
    const selfSummary = el('span', 'lab-self-summary', 'Not run yet.', selfRow);
    const selfList = el('ol', 'lab-self-list', undefined, selfBox);
    refs.selfSummary = selfSummary;
    refs.selfList = selfList;

    /* ---- Selection and the hash codec ------------------------------- */

    function matrixConfig(sel) {
      const sw = sel.switchType === 'Choc' ? 'Choc' : 'MX';
      return {
        name: 'Lab ' + sel.rows + 'x' + sel.cols + ' ' + sw,
        rows: sel.rows, cols: sel.cols, switchType: sw,
        keySpacing: sw === 'Choc' ? 18 : 19.05,
        encoder: !!sel.encoder, sensor: !!sel.sensor,
        sensorCount: sel.sensorCount || 1,
      };
    }

    function selTokenFromHash(decoded) {
      if (!decoded) return null;
      if (decoded.sel) {
        const spec = specs.find(sp => sp.id === decoded.sel);
        if (spec) return { kind: 'bench', id: spec.id };
        return null;
      }
      if (decoded.matrix) {
        const m = decoded.matrix;
        return { kind: 'matrix', rows: m.rows, cols: m.cols, switchType: m.switchType, encoder: m.encoder, sensor: m.sensor, sensorCount: m.sensorCount };
      }
      return null;
    }

    function writeHash() {
      try {
        if (typeof history === 'undefined' || !history.replaceState || typeof location === 'undefined') return;
        const enc = state.sel
          ? (state.sel.kind === 'bench' ? encodeHash({ sel: state.sel.id })
            : encodeHash({ r: state.sel.rows, c: state.sel.cols, sw: state.sel.switchType === 'Choc' ? 'choc' : 'mx',
              e: state.sel.encoder ? 1 : 0, s: state.sel.sensor ? (state.sel.sensorCount || 1) : 0 }))
          : null;
        if (!enc) return;
        const url = location.pathname + location.search + '#' + enc;
        history.replaceState(null, '', url);
      } catch (_) { /* hash persistence is best effort */ }
    }

    function loadSelIntoWorkstation(sel) {
      if (!sel || !ui) return;
      if (sel.kind === 'bench') {
        const spec = specs.find(sp => sp.id === sel.id);
        if (!spec) return;
        if (pc.SHOWCASES[sel.id] && typeof ui.applyShowcase === 'function') ui.applyShowcase(sel.id);
        else if (typeof ui.loadConfig === 'function') ui.loadConfig(spec.config, null);
      } else if (sel.kind === 'matrix' && typeof ui.loadConfig === 'function') {
        ui.loadConfig(matrixConfig(sel), null);
      }
    }

    function applySelection(sel, opts) {
      opts = opts || {};
      state.sel = sel;
      reflectSel();
      writeHash();
      if (!opts.silent) loadSelIntoWorkstation(sel);
    }

    function selEquals(a, b) {
      if (!a || !b || a.kind !== b.kind) return false;
      if (a.kind === 'bench') return a.id === b.id;
      return a.rows === b.rows && a.cols === b.cols && a.switchType === b.switchType &&
        !!a.encoder === !!b.encoder && !!a.sensor === !!b.sensor;
    }

    function reflectSel() {
      if (refs.rowEls) for (const [id, tr] of refs.rowEls) {
        const on = state.sel && state.sel.kind === 'bench' && state.sel.id === id;
        tr.classList.toggle('selected', !!on);
        tr.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (refs.markers) for (const m of refs.markers) {
        const on = state.sel && state.sel.kind === 'matrix' &&
          m.rows === state.sel.rows && m.cols === state.sel.cols && m.switchType === state.sel.switchType;
        m.node.classList.toggle('selected', !!on);
      }
      if (refs.groups) for (const g of refs.groups) {
        const on = state.sel && state.sel.kind === 'bench' && state.sel.id === g.id;
        g.node.classList.toggle('selected', !!on);
      }
    }

    /* ---- Comparator table ------------------------------------------- */

    refs.rowEls = new Map();
    function addBenchRow(spec, m) {
      const tr = el('tr', null, undefined, tbody);
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-pressed', 'false');
      const cells = [
        spec.label,
        m.rows + 'x' + m.cols,
        m.switchType,
        m.widthMm + ' x ' + m.heightMm,
        String(m.areaCm2),
        m.gpioUsed + '/' + m.gpioPool + (m.adcUsed ? ' +' + m.adcUsed + 'A' : ''),
        String(m.stlTriangles),
        String(m.stlVolumeCm3),
        String(m.pthHits),
        String(m.npthHits),
        String(m.copperIssues),
        String(m.remainingRoutes),
        String(m.airwires),
        String(m.artifactCount),
      ];
      cells.forEach((text, i) => el('td', i === 0 ? 'lab-name' : null, text, tr));
      const pick = () => applySelection({ kind: 'bench', id: spec.id });
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
      });
      refs.rowEls.set(spec.id, tr);
    }

    function addErrorRow(spec, error) {
      const tr = el('tr', 'lab-error-row', undefined, tbody);
      el('td', 'lab-name', spec.label, tr);
      const td = el('td', null, 'generation failed', tr);
      td.colSpan = 13;
      td.title = String(error && error.message);
    }

    /* ---- Chart helpers ----------------------------------------------- */

    function niceCeil(v, step) {
      return Math.max(step, Math.ceil(v / step) * step);
    }

    function axisTicks(min, max, count) {
      const span = max - min || 1;
      const raw = span / count;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const step = Math.ceil(raw / mag) * mag;
      const ticks = [];
      for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(round3(v));
      return { ticks, step };
    }

    /* Greedy collision-free label placement: the selected label wins, then
     * each label tries above, below, right and left before it is skipped. */
    function placeLabels(items, draw) {
      const placed = [];
      const fits = (x, y, w, h) =>
        !placed.some(b => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);
      const sorted = items.slice().sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
      for (const item of sorted) {
        const w = item.text.length * 5.4 + 4;
        const candidates = [
          { x: item.x - w / 2, y: item.y - 14, h: 10, anchor: 'middle' },
          { x: item.x - w / 2, y: item.y + 8, h: 10, anchor: 'middle' },
          { x: item.x + 8, y: item.y - 4, h: 10, anchor: 'start' },
          { x: item.x - w - 8, y: item.y - 4, h: 10, anchor: 'start' },
        ];
        for (const c of candidates) {
          if (c.x < 2 || c.x + w > 636) continue;
          if (fits(c.x, c.y, w, c.h)) {
            draw(item.text, c.x + (c.anchor === 'middle' ? w / 2 : 0), c.y + 8, c.anchor);
            placed.push({ x: c.x, y: c.y, w, h: c.h });
            break;
          }
        }
      }
    }

    /* ---- Chart 1: matrix scaling and GPIO frontier -------------------- */

    refs.markers = [];
    function renderFrontier() {
      clear(chart1);
      refs.markers = [];
      const series = matrixFrontier(pc);
      const W = 640, H = 360, m = { t: 18, r: 16, b: 46, l: 52 };
      const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
      const all = series.flatMap(s => s.points);
      const xMax = niceCeil(Math.max(...all.map(p => p.areaCm2)) * 1.05, 10);
      const yMax = niceCeil(Math.max(...all.map(p => p.gpioPct)) * 100 * 1.12, 5);
      const X = v => m.l + (v / xMax) * plotW;
      const Y = v => m.t + plotH - (v / yMax) * plotH;
      const svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'lab-svg', role: 'group',
        'aria-label': 'Board area against RP2040 GPIO utilization for MX and Choc matrices' }, chart1);

      for (const t of axisTicks(0, yMax, 5).ticks) {
        mk('line', { x1: m.l, y1: Y(t), x2: W - m.r, y2: Y(t), class: 'lab-grid' }, svg);
        const lbl = mk('text', { x: m.l - 8, y: Y(t) + 3, class: 'lab-tick', 'text-anchor': 'end' }, svg);
        lbl.textContent = t + '%';
      }
      for (const t of axisTicks(0, xMax, 6).ticks) {
        mk('line', { x1: X(t), y1: m.t, x2: X(t), y2: H - m.b, class: 'lab-grid' }, svg);
        const lbl = mk('text', { x: X(t), y: H - m.b + 16, class: 'lab-tick', 'text-anchor': 'middle' }, svg);
        lbl.textContent = t;
      }
      const xTitle = mk('text', { x: m.l + plotW / 2, y: H - 8, class: 'lab-axis', 'text-anchor': 'middle' }, svg);
      xTitle.textContent = 'Board area (cm2)';
      const yTitle = mk('text', { x: 14, y: m.t + plotH / 2, class: 'lab-axis', 'text-anchor': 'middle',
        transform: 'rotate(-90 14 ' + (m.t + plotH / 2) + ')' }, svg);
      yTitle.textContent = 'GPIO used (%)';

      series.forEach((s, si) => {
        const cls = si === 0 ? 'mx' : 'choc';
        const sorted = s.points.slice().sort((a, b) => a.keys - b.keys || a.cols - b.cols);
        mk('polyline', { class: 'lab-line ' + cls, fill: 'none',
          points: sorted.map(p => X(p.areaCm2) + ',' + Y(p.gpioPct * 100)).join(' ') }, svg);
      });

      const labelItems = [];
      series.forEach((s) => {
        for (const p of s.points) {
          const px = X(p.areaCm2), py = Y(p.gpioPct * 100);
          const g = mk('g', { class: 'lab-pt ' + (s.switchType === 'MX' ? 'mx' : 'choc'), tabindex: '0',
            role: 'button', 'aria-label': p.rows + ' by ' + p.cols + ' ' + s.switchType +
              ', ' + p.areaCm2 + ' cm2, ' + Math.round(p.gpioPct * 100) + '% GPIO' }, svg);
          mk('circle', { cx: px, cy: py, r: 23, class: 'lab-hit', fill: 'rgba(0,0,0,0)', 'pointer-events': 'all' }, g);
          mk('circle', { cx: px, cy: py, r: 4, class: 'lab-dot' }, g);
          const sel = { kind: 'matrix', rows: p.rows, cols: p.cols, switchType: s.switchType, encoder: false, sensor: false };
          const pick = () => applySelection(sel);
          g.addEventListener('click', pick);
          g.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
          });
          refs.markers.push({ node: g, rows: p.rows, cols: p.cols, switchType: s.switchType });
          labelItems.push({ x: px, y: py, text: p.rows + 'x' + p.cols,
            priority: state.sel && selEquals(sel, state.sel) });
        }
      });
      placeLabels(labelItems, (text, x, y, anchor) => {
        const lbl = mk('text', { x, y, class: 'lab-pt-label', 'text-anchor': anchor }, svg);
        lbl.textContent = text;
      });

      const legend = mk('g', { class: 'lab-legend' }, svg);
      ['MX', 'Choc'].forEach((name, i) => {
        const g = mk('g', { transform: 'translate(' + (m.l + 6 + i * 64) + ' ' + (m.t + 2) + ')' }, legend);
        mk('circle', { cx: 0, cy: -3, r: 4, class: 'lab-dot ' + name.toLowerCase() }, g);
        const lbl = mk('text', { x: 9, y: 0, class: 'lab-tick' }, g);
        lbl.textContent = name;
      });
      reflectSel();
    }

    /* ---- Chart 2: manufacturing breakdown ------------------------------ */

    refs.groups = [];
    function renderBreakdown() {
      clear(chart2);
      refs.groups = [];
      const rows = specs.map(sp => ({ id: sp.id, label: sp.label, m: state.rows.get(sp.id) }))
        .filter(r => r.m);
      if (!rows.length) return;
      const series = [
        { key: 'drill', label: 'Drill ops', get: r => r.m.pthHits + r.m.npthHits },
        { key: 'vol', label: 'Plate volume cm3', get: r => r.m.stlVolumeCm3 },
        { key: 'routes', label: 'Routes left', get: r => r.m.remainingRoutes },
      ];
      const W = 640, H = 340, m = { t: 20, r: 14, b: 52, l: 46 };
      const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
      const maxes = series.map(s => Math.max(1, ...rows.map(r => s.get(r))));
      const Y = (v, si) => m.t + plotH - (v / maxes[si]) * plotH;
      const gw = plotW / rows.length;
      const svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'lab-svg', role: 'group',
        'aria-label': 'Drill operations, plate volume and remaining routes per benchmarked design' }, chart2);

      for (const t of axisTicks(0, 100, 4).ticks) {
        const y = m.t + plotH - (t / 100) * plotH;
        mk('line', { x1: m.l, y1: y, x2: W - m.r, y2: y, class: 'lab-grid' }, svg);
        const lbl = mk('text', { x: m.l - 8, y: y + 3, class: 'lab-tick', 'text-anchor': 'end' }, svg);
        lbl.textContent = t + '%';
      }
      const yTitle = mk('text', { x: 14, y: m.t + plotH / 2, class: 'lab-axis', 'text-anchor': 'middle',
        transform: 'rotate(-90 14 ' + (m.t + plotH / 2) + ')' }, svg);
      yTitle.textContent = '% of series max';

      const barW = Math.min(18, (gw - 14) / series.length - 2);
      rows.forEach((row, gi) => {
        const gx = m.l + gi * gw;
        const visibleName = series.map((s) => String(s.get(row))).join(' ') + ' ' + row.id;
        const g = mk('g', { class: 'lab-group', tabindex: '0', role: 'button',
          'aria-label': visibleName + ', load ' + row.label + ' into the workstation' }, svg);
        mk('rect', { x: gx, y: m.t, width: gw, height: plotH, class: 'lab-hit',
          fill: 'rgba(0,0,0,0)', 'pointer-events': 'all' }, g);
        series.forEach((s, si) => {
          const v = s.get(row);
          const bw = barW;
          const bx = gx + (gw - series.length * (bw + 2) + 2) / 2 + si * (bw + 2);
          const by = Y(v, si);
          mk('rect', { x: bx, y: by, width: bw, height: Math.max(0.5, m.t + plotH - by),
            class: 'lab-bar s' + si }, g);
          const lbl = mk('text', { x: bx + bw / 2, y: by - 4, class: 'lab-bar-val', 'text-anchor': 'middle' }, g);
          lbl.textContent = v + ' ';
        });
        const lbl = mk('text', { x: gx + gw / 2, y: H - m.b + 16 + (gi % 2) * 12, class: 'lab-tick',
          'text-anchor': 'middle' }, g);
        lbl.textContent = row.id;
        const pick = () => applySelection({ kind: 'bench', id: row.id });
        g.addEventListener('click', pick);
        g.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
        });
        refs.groups.push({ node: g, id: row.id });
      });

      const legend = mk('g', { class: 'lab-legend' }, svg);
      series.forEach((s, i) => {
        const g = mk('g', { transform: 'translate(' + (m.l + 4 + i * 116) + ' ' + (m.t - 6) + ')' }, legend);
        mk('rect', { x: 0, y: -8, width: 9, height: 9, class: 'lab-bar s' + i }, g);
        const lbl = mk('text', { x: 14, y: 0, class: 'lab-tick' }, g);
        lbl.textContent = s.label;
      });
      reflectSel();
    }

    /* ---- Benchmark scheduling ---------------------------------------- */

    let idx = 0;
    function finishBench() {
      status.textContent = 'Audited ' + state.rows.size + ' designs against the real generator, verifier and geometry screen. Click a row, marker or column to load it.';
      status.className = 'lab-status ok';
      renderBreakdown();
      reflectSel();
    }

    function step() {
      if (idx >= specs.length) { finishBench(); return; }
      const spec = specs[idx++];
      try {
        const m = benchmarkConfig(pc, spec.config);
        state.rows.set(spec.id, m);
        addBenchRow(spec, m);
      } catch (error) {
        addErrorRow(spec, error);
      }
      status.textContent = 'Benchmarking ' + Math.min(idx, specs.length) + ' / ' + specs.length + ': ' + spec.label;
      renderBreakdown();
      if (typeof setTimeout === 'function') setTimeout(step, 0);
      else step();
    }

    /* ---- DFM proof brief ---------------------------------------------- */

    function setBrief(stamped, config) {
      state.stamped = stamped;
      digestLine.textContent = 'sha256 ' + stamped.sha256 + '  |  ' + stamped.design.name +
        ' (' + stamped.design.rows + 'x' + stamped.design.cols + ' ' + stamped.design.switchType + ')';
      digestLine.className = 'lab-digest sealed';
      for (const b of [btnJson, btnCsv, btnMd, btnVerify, btnTamper]) b.disabled = false;
      briefResult.textContent = 'Sealed ' + stamped.files.length + ' artifact digests into the proof brief.';
      briefResult.className = 'lab-brief-result';
    }

    btnSeal.addEventListener('click', () => {
      try {
        const snap = typeof ui.getSnapshot === 'function' ? ui.getSnapshot() : null;
        const cfg = snap && snap.config ? snap.config : null;
        if (!cfg) { briefResult.textContent = 'No workstation design to seal yet.'; return; }
        briefResult.textContent = 'Sealing ' + cfg.name + '...';
        setBrief(getBrief(pc, cfg), cfg);
      } catch (error) {
        briefResult.textContent = 'Seal failed: ' + error.message;
      }
    });
    btnJson.addEventListener('click', () => {
      if (state.stamped && ui.downloadText) ui.downloadText('dfm_brief.json', briefToJson(state.stamped));
    });
    btnCsv.addEventListener('click', () => {
      if (state.stamped && ui.downloadText) ui.downloadText('dfm_brief.csv', briefToCsv(state.stamped));
    });
    btnMd.addEventListener('click', () => {
      if (state.stamped && ui.downloadText) ui.downloadText('dfm_brief.md', briefToMarkdown(state.stamped));
    });
    btnVerify.addEventListener('click', () => {
      if (!state.stamped) return;
      const res = verifyBriefDigest(state.stamped);
      briefResult.textContent = res.valid
        ? 'Digest verified: ' + res.actual.slice(0, 24) + '... recomputed over the canonical payload.'
        : 'Digest mismatch: stamped ' + res.expected + ' recomputed ' + res.actual;
      briefResult.className = 'lab-brief-result ' + (res.valid ? 'ok' : 'bad');
    });
    btnTamper.addEventListener('click', () => {
      if (!state.stamped) return;
      const demo = briefTamperDemo(state.stamped);
      briefResult.textContent = 'Tampered ' + demo.mutatedField + ' ' + demo.from + ' -> ' + demo.to +
        '. Forged digest ' + demo.replayedDigest.slice(0, 16) + '... ' +
        (demo.forgeryRejected ? 'rejected: verification fails on the stamped digest.' : 'was not rejected (unexpected).');
      briefResult.className = 'lab-brief-result ' + (demo.forgeryRejected ? 'ok' : 'bad');
    });

    /* ---- Self tests ----------------------------------------------------- */

    btnSelf.addEventListener('click', () => {
      btnSelf.disabled = true;
      selfSummary.textContent = 'Running...';
      const run = () => {
        const checks = selfTests(pc, { zip: (typeof globalThis !== 'undefined' && globalThis.PadCraftZip) || null });
        clear(selfList);
        let pass = 0;
        for (const check of checks) {
          if (check.pass) pass++;
          const li = el('li', check.pass ? 'ok' : 'bad', undefined, selfList);
          el('span', 'lab-self-id', check.id, li);
          el('span', 'lab-self-label', check.label + (check.detail ? ' (' + check.detail + ')' : ''), li);
          el('span', 'badge ' + (check.pass ? 'ok' : 'bad'), check.pass ? 'PASS' : 'FAIL', li);
        }
        selfSummary.textContent = pass + '/' + checks.length + ' pass';
        selfSummary.className = 'lab-self-summary ' + (pass === checks.length ? 'ok' : 'bad');
        btnSelf.disabled = false;
        state.selfRan = true;
      };
      if (typeof setTimeout === 'function') setTimeout(run, 0);
      else run();
    });

    /* ---- Boot ----------------------------------------------------------- */

    renderFrontier();

    let restored = null;
    try {
      if (typeof location !== 'undefined' && location.hash) restored = selTokenFromHash(decodeHash(location.hash));
    } catch (_) { restored = null; }

    if (restored) {
      applySelection(restored);
    } else {
      const snap = typeof ui.getSnapshot === 'function' ? ui.getSnapshot() : null;
      const cfg = snap && snap.config;
      const id = cfg ? showcaseIdFor(pc, cfg) : null;
      state.sel = id ? { kind: 'bench', id } : null;
      reflectSel();
    }

    step();

    return {
      getState: () => ({ sel: state.sel, benches: state.rows.size, stamped: !!state.stamped }),
      select: applySelection,
    };
  }

  /* =================================================================== *
   * 10. Exports
   * =================================================================== */

  const api = {
    LAB_SCHEMA, MATRIX_LADDER, CANON_MAX_DEPTH,
    utf8, sha256Hex, crc32, zipEntries, canonicalJSON, csvField, csvRow,
    benchmarkSpecs, showcaseIdFor, benchmarkConfig, matrixFrontier,
    briefStateKey, getBrief, verifyBriefDigest, briefTamperDemo,
    briefToJson, briefToCsv, briefToMarkdown,
    encodeHash, decodeHash, selfTests, mount,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PadCraftLab = api;
})();
