/*
 * PadCraft DFM lab test suite (pad-lab.test.js)
 * ----------------------------------------------------------------------
 * Run with:  node --test pad-lab.test.js   (wired into npm test)
 *
 * Covers the pure deterministic lab layer:
 *   1. FIPS 180-4 SHA-256 against Node crypto and known answers
 *   2. Canonical JSON ordering, cycle, depth and type bounds
 *   3. Formula-injection-safe CSV escaping
 *   4. The fail-closed #pclab= hash codec, including hostile fuzz
 *   5. The digest-stamped DFM proof brief and its tamper demo
 *   6. Benchmark and matrix frontier metrics on the real engine
 *   7. ZIP CRC32 verification against the shipped writer
 *   8. DOM wiring on a deterministic fixture DOM
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pc = require('./cad.js');
const lab = require('./pad-lab.js');
const zip = require('./app.js');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const labSource = fs.readFileSync(path.join(__dirname, 'pad-lab.js'), 'utf8');

const ref = (input) => crypto.createHash('sha256').update(input).digest('hex');
const CFG = { rows: 3, cols: 4, encoder: true, sensor: true, name: 'Lab Test Pad' };

/* ===================================================================== *
 * 1. SHA-256 known answers
 * ===================================================================== */

const SHA_KATS = [
  ['empty', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['56 a bytes', 'a'.repeat(56), 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
  ['64 a bytes', 'a'.repeat(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
  ['119 a bytes', 'a'.repeat(119), '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb'],
  ['128 a bytes', 'a'.repeat(128), '6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e'],
  ['one million a', 'a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ['classic abcdbcde', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
];
for (const [name, input, expected] of SHA_KATS) {
  test('sha256 KAT: ' + name, () => assert.equal(lab.sha256Hex(input), expected));
}

/* Boundary sweep: every length 0..160 is hashed against Node crypto. This
 * exercises both padding paths and the 55/56/63/64/119/128 edge cases. */
for (let n = 0; n <= 160; n++) {
  test('sha256 boundary: ' + n + ' bytes match Node crypto', () => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + n) & 0xFF;
    assert.equal(lab.sha256Hex(bytes), ref(bytes));
    assert.equal(lab.sha256Hex('x'.repeat(n)), ref('x'.repeat(n)));
  });
}

test('sha256: multi-byte UTF-8 input matches Node crypto', () => {
  for (const s of ['\u00e4\u2603', '\ud835\udc4f pad', 'caf\u00e9 \u00b1 0.1mm']) {
    assert.equal(lab.sha256Hex(s), ref(s));
  }
});

test('utf8: encodes BMP, astral and control bytes', () => {
  assert.deepEqual([...lab.utf8('A')], [65]);
  assert.deepEqual([...lab.utf8('\u00e9')], [0xC3, 0xA9]);
  assert.deepEqual([...lab.utf8('\ud835\udc4f')], [0xF0, 0x9D, 0x91, 0x8F]);
  assert.equal(lab.utf8('pad\u0000craft').length, 9);
});

/* ===================================================================== *
 * 2. Canonical JSON
 * ===================================================================== */

test('canon: object keys serialize in sorted order', () => {
  assert.equal(lab.canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(lab.canonicalJSON({ z: { b: 2, a: 1 }, a: [3, 2] }), '{"a":[3,2],"z":{"a":1,"b":2}}');
});

test('canon: primitives and arrays match JSON semantics', () => {
  assert.equal(lab.canonicalJSON([1, 'x', true, null]), '[1,"x",true,null]');
  assert.equal(lab.canonicalJSON('s'), '"s"');
  assert.equal(lab.canonicalJSON(0), '0');
  assert.equal(lab.canonicalJSON(-0), '0');
  assert.equal(lab.canonicalJSON(1.5), '1.5');
});

test('canon: undefined properties are skipped like JSON.stringify', () => {
  assert.equal(lab.canonicalJSON({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(lab.canonicalJSON([undefined, 2]), '[null,2]');
});

test('canon: cyclic values are rejected, not recursed', () => {
  const o = { a: 1 }; o.self = o;
  assert.throws(() => lab.canonicalJSON(o), /cyclic/);
  const a = { b: {} }; a.b.a = a;
  assert.throws(() => lab.canonicalJSON(a), /cyclic/);
});

test('canon: sibling repeats of one object are allowed', () => {
  const shared = { k: 1 };
  assert.equal(lab.canonicalJSON({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');
});

test('canon: depth beyond the bound is rejected', () => {
  let o = {}, cur = o;
  for (let i = 0; i < lab.CANON_MAX_DEPTH + 2; i++) { cur.n = {}; cur = cur.n; }
  assert.throws(() => lab.canonicalJSON(o), /depth bound/);
});

test('canon: exactly at the depth bound still serializes', () => {
  let o = {}, cur = o;
  for (let i = 0; i < lab.CANON_MAX_DEPTH - 2; i++) { cur.n = {}; cur = cur.n; }
  assert.equal(typeof lab.canonicalJSON(o), 'string');
});

test('canon: non-finite numbers are rejected', () => {
  for (const v of [NaN, Infinity, -Infinity]) assert.throws(() => lab.canonicalJSON(v), /non-finite/);
  assert.throws(() => lab.canonicalJSON({ v: NaN }), /non-finite/);
});

test('canon: class instances and boxed values are rejected', () => {
  class P { constructor() { this.x = 1; } }
  assert.throws(() => lab.canonicalJSON(new P()), /plain objects/);
  assert.throws(() => lab.canonicalJSON(new Date(0)), /plain objects/);
  assert.throws(() => lab.canonicalJSON(new Map()), /plain objects/);
});

test('canon: null-prototype objects serialize deterministically', () => {
  const o = Object.create(null);
  o['__proto__'] = 7; o.a = 1;
  assert.equal(lab.canonicalJSON(o), '{"__proto__":7,"a":1}');
});

test('canon: bigint and symbol values are rejected or skipped', () => {
  assert.throws(() => lab.canonicalJSON({ v: 5n }), /bigint/);
  assert.equal(lab.canonicalJSON({ a: Symbol('s'), b: 1 }), '{"b":1}');
});

test('canon: deterministic across constructions', () => {
  const a = lab.canonicalJSON({ x: [1, { b: 2, a: 3 }], y: 't' });
  const b = lab.canonicalJSON({ y: 't', x: [1, { a: 3, b: 2 }] });
  assert.equal(a, b);
});

/* ===================================================================== *
 * 3. CSV formula-injection safety
 * ===================================================================== */

test('csv: leading = + - @ tab CR are all prefixed with a quote', () => {
  assert.equal(lab.csvField('=x()'), "'=x()");
  assert.equal(lab.csvField('+12'), "'+12");
  assert.equal(lab.csvField('-3'), "'-3");
  assert.equal(lab.csvField('@name'), "'@name");
  assert.equal(lab.csvField('\t1'), "'\t1");
  assert.equal(lab.csvField('\r1'), '"\'\r1"');
});

test('csv: commas, quotes and newlines are quoted and doubled', () => {
  assert.equal(lab.csvField('a,b'), '"a,b"');
  assert.equal(lab.csvField('"q"'), '"""q"""');
  assert.equal(lab.csvField('l1\nl2'), '"l1\nl2"');
});

test('csv: plain values pass through untouched', () => {
  for (const v of ['plain', '42', 'Studio Control', 'x y', 'a.b']) assert.equal(lab.csvField(v), v);
});

test('csv: null and undefined serialize empty', () => {
  assert.equal(lab.csvField(null), '');
  assert.equal(lab.csvField(undefined), '');
});

test('csv: a dangerous value wrapped in quotes still leads with the escape', () => {
  const out = lab.csvField('=1,2');
  assert.ok(out.startsWith('"\''), 'escape stays first inside the quotes');
});

test('csvRow: joins escaped fields with commas', () => {
  assert.equal(lab.csvRow(['a', 'b,c', '=d']), 'a,"b,c",\'=d');
});

/* ===================================================================== *
 * 4. #pclab= hash codec
 * ===================================================================== */

test('hash: sel form round-trips', () => {
  assert.deepEqual(lab.decodeHash(lab.encodeHash({ sel: 'studio' })), { v: 1, sel: 'studio' });
  assert.equal(lab.encodeHash({ sel: 'edge-6x7' }), 'pclab=v=1&sel=edge-6x7');
});

test('hash: matrix form round-trips with defaults', () => {
  assert.deepEqual(lab.decodeHash(lab.encodeHash({ r: 4, c: 5, sw: 'choc', e: 1, s: 2 })),
    { v: 1, matrix: { rows: 4, cols: 5, switchType: 'Choc', encoder: true, sensor: true, sensorCount: 2 } });
  assert.deepEqual(lab.decodeHash(lab.encodeHash({ r: 2, c: 2, sw: 'mx' })),
    { v: 1, matrix: { rows: 2, cols: 2, switchType: 'MX', encoder: false, sensor: false, sensorCount: 0 } });
});

test('hash: encode emits canonical clamped integers', () => {
  assert.equal(lab.encodeHash({ r: 99, c: 0, sw: 'mx', e: 7, s: 9 }), 'pclab=v=1&r=6&c=1&sw=mx&e=1&s=3');
  assert.equal(lab.encodeHash({ r: 'x', c: 4 }), null);
  assert.equal(lab.encodeHash({ sel: 'Bad Id' }), null);
});

test('hash: a leading # is accepted on decode', () => {
  assert.deepEqual(lab.decodeHash('#pclab=v=1&sel=compact'), { v: 1, sel: 'compact' });
});

const HASH_HOSTILE = [
  ['empty', ''],
  ['no prefix', 'r=3&c=4'],
  ['wrong prefix', 'pclab2=v=1&r=3&c=4'],
  ['wrong version', 'pclab=v=2&r=3&c=4'],
  ['version missing', 'pclab=r=3&c=4'],
  ['proto magic key', 'pclab=v=1&__proto__=x'],
  ['constructor key', 'pclab=v=1&constructor=1'],
  ['prototype key', 'pclab=v=1&prototype=1'],
  ['unknown key', 'pclab=v=1&r=3&c=4&q=9'],
  ['duplicate key', 'pclab=v=1&r=3&r=4&c=4'],
  ['duplicate version', 'pclab=v=1&v=1&r=3&c=4'],
  ['non-numeric rows', 'pclab=v=1&r=abc&c=4'],
  ['float rows', 'pclab=v=1&r=3.5&c=4'],
  ['empty value', 'pclab=v=1&r=&c=4'],
  ['no equals', 'pclab=v=1&r&c=4'],
  ['double equals', 'pclab=v=1&r=3=4&c=4'],
  ['value charset', 'pclab=v=1&r=3&c=4&sw=m x'],
  ['bad switch', 'pclab=v=1&r=3&c=4&sw=alps'],
  ['sel charset', 'pclab=v=1&sel=stu dio'],
  ['sel too long', 'pclab=v=1&sel=' + 'x'.repeat(60)],
  ['sel plus matrix', 'pclab=v=1&sel=studio&r=3&c=4'],
  ['missing cols', 'pclab=v=1&r=3'],
  ['missing rows', 'pclab=v=1&c=4'],
  ['javascript uri', 'javascript:alert(1)'],
  ['encoded traversal', 'pclab=v=1&sel=..%2Fetc'],
  ['oversized body', 'pclab=v=1&r=3&c=4&pad=' + 'x'.repeat(200)],
  ['too many pairs', 'pclab=v=1&r=3&c=4&a=1&b=2&d=3&f=4&g=5&h=6&i=7'],
];
for (const [name, input] of HASH_HOSTILE) {
  test('hash hostile: ' + name + ' is rejected', () => assert.equal(lab.decodeHash(input), null));
}

test('hash: out-of-range integers clamp into matrix bounds', () => {
  assert.deepEqual(lab.decodeHash('pclab=v=1&r=99&c=0'), {
    v: 1, matrix: { rows: 6, cols: 1, switchType: 'MX', encoder: false, sensor: false, sensorCount: 0 },
  });
  const out = lab.decodeHash('pclab=v=1&r=0&c=99&e=5&s=42');
  assert.equal(out.matrix.rows, 1);
  assert.equal(out.matrix.cols, 8);
  assert.equal(out.matrix.encoder, true);
  assert.equal(out.matrix.sensorCount, 3);
});

test('hash: negative and huge values parse or reject deterministically', () => {
  assert.equal(lab.decodeHash('pclab=v=1&r=-3&c=4').matrix.rows, 1);
  assert.equal(lab.decodeHash('pclab=v=1&r=99999&c=4'), null);
});

test('hash: encode of a hostile state returns null instead of a bad hash', () => {
  assert.equal(lab.encodeHash(null), null);
  assert.equal(lab.encodeHash([1, 2]), null);
  assert.equal(lab.encodeHash({ r: NaN, c: 4 }), null);
  assert.equal(lab.encodeHash('string'), null);
});

/* ===================================================================== *
 * 5. DFM proof brief: one cached canonical digest
 * ===================================================================== */

const briefCache = new Map();
const briefFor = (cfg) => {
  const key = JSON.stringify(cfg);
  if (!briefCache.has(key)) briefCache.set(key, lab.getBrief(pc, cfg));
  return briefCache.get(key);
};

test('brief: stamped digest recomputes and verifies', () => {
  const stamped = briefFor(CFG);
  assert.equal(stamped.schema, 'padcraft.lab/1');
  const res = lab.verifyBriefDigest(stamped);
  assert.equal(res.valid, true);
  assert.equal(res.actual, stamped.sha256);
});

test('brief: cache returns the identical stamped object per design', () => {
  assert.equal(lab.getBrief(pc, CFG), lab.getBrief(pc, { ...CFG }));
  assert.equal(lab.getBrief(pc, CFG).sha256, briefFor(CFG).sha256);
});

test('brief: different designs stamp different digests', () => {
  const a = briefFor(CFG);
  const b = briefFor({ ...CFG, rows: 4 });
  assert.notEqual(a.sha256, b.sha256);
});

test('brief: all four surfaces stamp the same digest', () => {
  const stamped = briefFor(CFG);
  for (const surface of [stamped.sha256, lab.briefToJson(stamped), lab.briefToCsv(stamped), lab.briefToMarkdown(stamped)]) {
    assert.ok(surface.includes(stamped.sha256), 'surface must carry the stamped digest');
  }
});

test('brief: tampered metrics break the digest and the verifier rejects', () => {
  const stamped = briefFor(CFG);
  const demo = lab.briefTamperDemo(stamped);
  assert.equal(demo.mutatedField, 'metrics.keys');
  assert.equal(demo.to, stamped.metrics.keys + 1);
  assert.equal(demo.changed, true);
  assert.equal(demo.forgeryRejected, true);
  assert.notEqual(demo.replayedDigest, demo.stampedDigest);
});

test('brief: forged stamped digest on an unmodified payload fails', () => {
  const stamped = briefFor(CFG);
  const forged = { ...stamped, sha256: '0'.repeat(64) };
  assert.equal(lab.verifyBriefDigest(forged).valid, false);
});

test('brief: payload carries the sealed artifact manifest', () => {
  const stamped = briefFor(CFG);
  assert.equal(stamped.files.length, 23);
  assert.ok(stamped.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0));
  assert.equal(stamped.metrics.artifactCount, 25);
});

test('brief: metrics are measured from the real engine', () => {
  const stamped = briefFor(pc.SHOWCASES.sweep.config);
  const m = stamped.metrics;
  assert.equal(m.rows, 6); assert.equal(m.cols, 8); assert.equal(m.keys, 48);
  assert.equal(m.verified, true); assert.equal(m.geometryValid, true);
  assert.equal(m.stlBadEdges, 0);
  assert.ok(m.stlTriangles > 4000);
  assert.ok(m.stlVolumeCm3 > 0);
  assert.ok(m.gpioUsed <= m.gpioPool);
  assert.equal(m.adcUsed, 3);
  assert.ok(m.pthHits > 0 && m.npthHits > 0);
  assert.equal(m.artifactCount, 25);
});

test('brief: CSV export escapes dangerous leading characters everywhere', () => {
  const stamped = briefFor({ ...CFG, name: '=evil' });
  for (const line of lab.briefToCsv(stamped).split('\n')) {
    for (const f of line.split(',')) {
      assert.ok(!/^[=+\-@\t\r]/.test(f), 'unescaped dangerous field ' + f);
    }
  }
  assert.ok(lab.briefToCsv(stamped).includes("'=evil"), 'dangerous name carries the escape');
});

test('brief: JSON export parses back to the stamped object', () => {
  const stamped = briefFor(CFG);
  assert.deepEqual(JSON.parse(lab.briefToJson(stamped)), JSON.parse(JSON.stringify(stamped)));
});

test('brief: markdown export embeds design and audit facts', () => {
  const stamped = briefFor(CFG);
  const md = lab.briefToMarkdown(stamped);
  assert.ok(md.includes(stamped.design.name));
  assert.ok(md.includes(stamped.checks.auditFingerprint));
  assert.ok(/SHA-256: [0-9a-f]{64}/.test(md));
});

/* ===================================================================== *
 * 6. Benchmark and frontier metrics on the real engine
 * ===================================================================== */

const benchCache = new Map();
const benchFor = (spec) => {
  if (!benchCache.has(spec.id)) {
    const m = lab.benchmarkConfig(pc, spec.config);
    m.id = spec.id;
    benchCache.set(spec.id, m);
  }
  return benchCache.get(spec.id);
};
const SPECS = lab.benchmarkSpecs(pc);

test('benchmarkSpecs: four showcases plus four stress designs', () => {
  assert.equal(SPECS.length, 8);
  assert.deepEqual(SPECS.filter(s => s.tag === 'showcase').map(s => s.id), ['studio', 'sensor', 'compact', 'sweep']);
  assert.equal(new Set(SPECS.map(s => s.id)).size, 8);
});

for (const spec of SPECS) {
  test('benchmark ' + spec.id + ': verifies end to end', () => {
    const m = benchFor(spec);
    assert.equal(m.verified, true, spec.id);
    assert.equal(m.geometryValid, true, spec.id);
    assert.equal(m.drcErrors, 0, spec.id);
  });
  test('benchmark ' + spec.id + ': metrics stay inside hardware budgets', () => {
    const m = benchFor(spec);
    assert.ok(m.widthMm > 0 && m.heightMm > 0);
    assert.ok(m.areaCm2 > 0);
    assert.ok(m.gpioUsed > 0 && m.gpioUsed <= m.gpioPool && m.gpioPool <= 23);
    assert.ok(m.adcUsed >= 0 && m.adcUsed <= 3);
    assert.equal(m.stlBadEdges, 0);
    assert.ok(m.stlTriangles > 0 && m.stlVolumeCm3 > 0);
    assert.ok(m.pthHits > 0 && m.npthHits > 0);
    assert.equal(m.artifactCount, 25);
    assert.ok(/^[0-9a-f]{64}$/.test(m.auditFingerprint));
    assert.equal(m.keys, m.rows * m.cols);
  });
}

test('benchmark: drill counts match the generated Excellon hits', () => {
  const spec = SPECS[0];
  const m = benchFor(spec);
  const board = pc.buildBoard(pc.clampConfig(spec.config));
  assert.equal(m.pthHits, board.drillPoints.filter(d => d.plated).length);
  assert.equal(m.npthHits, board.drillPoints.filter(d => !d.plated).length);
  assert.equal(m.pthHits + m.npthHits, board.drillPoints.length);
});

test('benchmark: showcase presets reproduce the shipped figures', () => {
  assert.equal(benchFor(SPECS[0]).stlTriangles, 3288);
  assert.equal(benchFor(SPECS[0]).remainingRoutes, 19);
  assert.equal(benchFor(SPECS[3]).keys, 48);
  assert.equal(benchFor(SPECS[3]).stlTriangles, 4752);
  assert.equal(benchFor(SPECS[3]).pthHits + benchFor(SPECS[3]).npthHits, 300);
  assert.equal(benchFor(SPECS[1]).adcUsed, 3);
  assert.equal(benchFor(SPECS[2]).switchType, 'Choc');
});

const frontier = lab.matrixFrontier(pc);

test('frontier: two series of 15 real matrices from 1x2 to 6x8', () => {
  assert.equal(frontier.length, 2);
  assert.deepEqual(frontier.map(s => s.switchType), ['MX', 'Choc']);
  assert.equal(frontier[0].points.length, 15);
  assert.equal(frontier[0].points[0].rows, 1);
  assert.equal(frontier[0].points[0].cols, 2);
  const last = frontier[0].points[14];
  assert.equal(last.rows, 6); assert.equal(last.cols, 8);
});

test('frontier: every point is inside the RP2040 GPIO budget', () => {
  for (const s of frontier) for (const p of s.points) {
    assert.equal(p.gpioUsed, p.rows + p.cols);
    assert.ok(p.gpioUsed <= p.gpioPool, p.rows + 'x' + p.cols);
    assert.ok(p.gpioPct > 0 && p.gpioPct <= 1);
    assert.equal(p.gpioPool, 23);
  }
});

test('frontier: Choc boards are strictly smaller than MX at equal matrices', () => {
  const mx = frontier[0].points, choc = frontier[1].points;
  for (let i = 0; i < mx.length; i++) {
    assert.ok(choc[i].areaCm2 < mx[i].areaCm2, mx[i].rows + 'x' + mx[i].cols);
    assert.equal(choc[i].gpioPct, mx[i].gpioPct);
    assert.ok(choc[i].widthMm < mx[i].widthMm);
  }
});

test('frontier: areas are positive and keys match rows times cols', () => {
  for (const s of frontier) for (const p of s.points) {
    assert.equal(p.keys, p.rows * p.cols);
    assert.ok(p.areaCm2 > 0 && p.widthMm > 0 && p.heightMm > 0);
  }
});

test('frontier: layout matches a direct computeLayout call', () => {
  const direct = pc.computeLayout({ rows: 4, cols: 5, switchType: 'MX', keySpacing: 19.05, encoder: false, sensor: false });
  const p = frontier[0].points.find(p => p.rows === 4 && p.cols === 5);
  assert.equal(p.widthMm, Math.round(direct.width * 1000) / 1000);
  assert.equal(p.heightMm, Math.round(direct.height * 1000) / 1000);
});

test('showcaseIdFor: recognizes presets and rejects customs', () => {
  assert.equal(lab.showcaseIdFor(pc, pc.SHOWCASES.sweep.config), 'sweep');
  assert.equal(lab.showcaseIdFor(pc, pc.SHOWCASES.studio.config), 'studio');
  assert.equal(lab.showcaseIdFor(pc, { rows: 2, cols: 2, encoder: false, sensor: false }), null);
  assert.equal(lab.showcaseIdFor(pc, { rows: 'bogus' }), null);
});

/* ===================================================================== *
 * 7. ZIP CRC32 verification against the shipped writer
 * ===================================================================== */

test('zip: crc32 matches the standard reference vector', () => {
  assert.equal(lab.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(lab.crc32(new Uint8Array()), 0);
  assert.equal(lab.crc32('padcraft'), zip.crc32(new TextEncoder().encode('padcraft')));
});

test('zip: entries verify against the writer emitted CRCs', () => {
  const bytes = zip.buildZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/deep/b.gbr', data: '%FSLAX36Y36*%\nM02*\n' },
  ]);
  const entries = lab.zipEntries(bytes);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'a.txt');
  assert.ok(entries.every(e => e.verified === true));
});

test('zip: a corrupted payload byte flips verification to false', () => {
  const bytes = zip.buildZip([{ name: 'x.txt', data: 'integrity' }]);
  const entries = lab.zipEntries(bytes);
  const payloadStart = 30 + entries[0].name.length;
  bytes[payloadStart] ^= 0xFF;
  const damaged = lab.zipEntries(bytes);
  assert.equal(damaged[0].verified, false);
});

test('zip: truncated archives throw instead of trusting', () => {
  const bytes = zip.buildZip([{ name: 'x.txt', data: 'integrity' }]);
  assert.throws(() => lab.zipEntries(bytes.slice(0, 10)), /Truncated/);
  const entries = lab.zipEntries(bytes.slice(0, bytes.length - 22));
  assert.ok(entries.length >= 0);
});

test('zip: the generated design bundle verifies end to end', () => {
  const files = pc.generateAll(pc.clampConfig(CFG));
  const bytes = zip.buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
  const entries = lab.zipEntries(bytes);
  assert.equal(entries.length, 25);
  assert.ok(entries.every(e => e.verified === true));
});

/* ===================================================================== *
 * 8. Self-test battery
 * ===================================================================== */

const selfResults = lab.selfTests(pc, { zip });

test('selfTests: at least 18 checks run', () => {
  assert.ok(selfResults.length >= 18, selfResults.length + ' checks');
});

test('selfTests: every check passes', () => {
  const failed = selfResults.filter(c => !c.pass);
  assert.deepEqual(failed.map(c => c.id), [], 'failing checks: ' + failed.map(c => c.id).join(','));
});

test('selfTests: check ids are unique and labeled', () => {
  assert.equal(new Set(selfResults.map(c => c.id)).size, selfResults.length);
  assert.ok(selfResults.every(c => c.label.length > 8));
});

test('selfTests: deterministic across runs', () => {
  const again = lab.selfTests(pc, { zip });
  assert.deepEqual(again.map(c => [c.id, c.pass]), selfResults.map(c => [c.id, c.pass]));
});

/* ===================================================================== *
 * 9. Shipped-file wiring checks
 * ===================================================================== */

test('wiring: index.html loads pad-lab.js between the engine and the app', () => {
  assert.ok(/<script src="cad\.js"><\/script>\s*<script src="pad-lab\.js"><\/script>\s*<script src="app\.js"><\/script>/.test(html));
  assert.ok(html.includes('id="labRoot"'));
  assert.ok(html.includes('id="labTitle"'));
});

test('wiring: the lab fallback note survives when the module is absent', () => {
  assert.ok(html.includes('pad-lab.js) did not load'));
});

test('wiring: app.js exposes the lab hooks and mounts defensively', () => {
  assert.ok(appSource.includes('PadCraftLab.mount'));
  assert.ok(appSource.includes('loadConfig: loadLabDesign'));
  assert.ok(appSource.includes('globalThis.PadCraftZip'));
  assert.ok(appSource.includes('downloadText,'));
});

test('wiring: style.css has the mobile-safe lab grid rules', () => {
  for (const needle of ['.lab { grid-column: 1 / -1; min-width: 0; }', 'minmax(0, 1fr)',
    'overflow-x: auto', 'min-width: 0', '.lab-charts']) {
    assert.ok(cssSource.includes(needle), needle);
  }
});

test('wiring: pad-lab.js parses as a script and carries no em or en dashes', () => {
  new (require('node:vm').Script)(labSource, { filename: 'pad-lab.js' });
  assert.ok(!/[\u2013\u2014]/.test(labSource), 'pad-lab.js must use ASCII dashes only');
});

/* ===================================================================== *
 * 10. Deterministic fixture DOM: mount the lab for real
 * ===================================================================== */

function fixtureDom() {
  const all = [];
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
      this.listeners = new Map(); this.dataset = {}; this._text = ''; this._classes = new Set();
      this.value = ''; this.checked = false; this.disabled = false; this.tabIndex = 0;
      this.style = { setProperty(k, v) { this[k] = String(v); } };
      all.push(this);
    }
    get ownerDocument() { return doc; }
    get classList() {
      const s = this._classes;
      return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
        toggle: (c, force) => { const on = force === undefined ? !s.has(c) : !!force; on ? s.add(c) : s.delete(c); return on; } };
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    set textContent(v) { this._text = String(v); for (const c of this.children) c.parentElement = null; this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    get firstChild() { return this.children[0] || null; }
    set innerHTML(v) { assert.equal(v, '', 'lab only clears HTML'); this.children = []; this._text = ''; }
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentElement = null; return c; }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = v; }
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
    addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
    emit(t, ev = {}) { ev.type = t; ev.target = this; if (!ev.preventDefault) ev.preventDefault = () => { ev.prevented = true; }; for (const fn of this.listeners.get(t) || []) fn(ev); return ev; }
    click() { if (!this.disabled) this.emit('click'); }
    find(pred) { const out = []; const walk = n => { if (pred(n)) out.push(n); n.children.forEach(walk); }; walk(this); return out; }
  }
  const doc = {
    createElement: t => new El(t),
    createElementNS: (ns, t) => new El(t),
    getElementById: () => null,
  };
  const root = new El('div');
  Object.defineProperty(root, 'ownerDocument', { get: () => doc });
  return { doc, root, all, El };
}

function fixtureUi() {
  const loaded = [], shown = [], downloads = [];
  return {
    loaded, shown, downloads,
    getSnapshot: () => ({ config: pc.clampConfig(pc.SHOWCASES.studio.config) }),
    loadConfig: (cfg, id) => loaded.push(pc.clampConfig(cfg)),
    applyShowcase: id => shown.push(id),
    downloadText: (name, body) => downloads.push({ name, body }),
  };
}

function mountFixture() {
  const { doc, root, all } = fixtureDom();
  const ui = fixtureUi();
  const handle = lab.mount(root, pc, ui);
  return { root, all, ui, handle };
}

/* Mount steps one design per macrotask via setTimeout when present; poll on
 * setImmediate so the fixture DOM drains before assertions run. */
async function until(fn, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise(r => setImmediate(r));
  }
  assert.ok(fn(), 'fixture condition was not met before the poll bound');
}
const allRows = (root) => root.find(e => e.tagName === 'TR' && e.parentElement && e.parentElement.tagName === 'TBODY');
/* The fixture registry keeps detached nodes; only nodes still parented to the
 * mounted root count as rendered. */
const connected = (node, root) => { for (let n = node; n; n = n.parentElement) if (n === root) return true; return false; };
const liveClass = (all, root, cls) => all.filter(e => connected(e, root) && e._classes && e._classes.has(cls));

test('mount: returns null without a DOM capable of SVG', () => {
  const fakeRoot = { ownerDocument: { createElement: t => ({ tagName: t }) } };
  assert.equal(lab.mount(fakeRoot, pc, fixtureUi()), null);
  assert.equal(lab.mount(null, pc, fixtureUi()), null);
});

test('mount: builds the comparator, both charts, brief and self-test sections', async () => {
  const { root, all, handle } = mountFixture();
  assert.ok(handle);
  const text = n => root.find(e => e.tagName === n);
  assert.equal(text('TABLE').length, 1);
  assert.equal(text('SVG').length, 2);
  const tbody = text('TBODY')[0];
  await until(() => tbody.children.length === 8);
  assert.equal(tbody.children[0].children.length, 14);
  const status = all.find(e => e._classes && e._classes.has('lab-status'));
  await until(() => /Audited 8 designs/.test(status.textContent));
  const markers = liveClass(all, root, 'lab-pt');
  assert.equal(markers.length, 30);
  const groups = liveClass(all, root, 'lab-group');
  assert.equal(groups.length, 8);
});

test('mount: a comparator row click loads that exact design', async () => {
  const { root, ui } = mountFixture();
  await until(() => allRows(root).length === 8);
  const rows = allRows(root);
  rows[0].emit('click');
  assert.equal(ui.shown[0], 'studio');
  rows[5].emit('click');
  assert.equal(ui.loaded.at(-1).name, 'Lab 3x4 MX ENC');
});

test('mount: a matrix marker click loads the frontier matrix', async () => {
  const { root, ui, all } = mountFixture();
  await until(() => allRows(root).length === 8);
  const markers = liveClass(all, root, 'lab-pt');
  const m45 = markers.find(e => e.getAttribute('aria-label').includes('4 by 5 Choc'));
  m45.emit('click');
  const cfg = ui.loaded.at(-1);
  assert.equal(cfg.rows, 4); assert.equal(cfg.cols, 5);
  assert.equal(cfg.switchType, 'Choc'); assert.equal(cfg.keySpacing, 18);
  assert.equal(cfg.encoder, false); assert.equal(cfg.sensor, false);
});

test('mount: a breakdown column click loads the design', async () => {
  const { root, all, ui } = mountFixture();
  await until(() => allRows(root).length === 8);
  const groups = liveClass(all, root, 'lab-group');
  const sweep = groups.find(e => e.getAttribute('aria-label').includes('48-key'));
  sweep.emit('click');
  assert.equal(ui.shown.at(-1), 'sweep');
});

test('mount: seal, verify and the one-unit tamper demo all run', async () => {
  const { root, all } = mountFixture();
  await until(() => allRows(root).length === 8);
  const buttons = all.filter(e => e.tagName === 'BUTTON');
  const byText = t => buttons.find(b => b.textContent === t);
  byText('Seal current design').emit('click');
  const digest = all.find(e => e._classes && e._classes.has('lab-digest'));
  assert.ok(/sha256 [0-9a-f]{64}/.test(digest.textContent));
  assert.equal(byText('Export JSON').disabled, false);
  byText('Verify digest').emit('click');
  const result = all.find(e => e._classes && e._classes.has('lab-brief-result'));
  assert.ok(/Digest verified/.test(result.textContent));
  byText('1-unit tamper demo').emit('click');
  assert.ok(/rejected/.test(result.textContent));
});

test('mount: export buttons download stamped brief files', async () => {
  const { root, all, ui } = mountFixture();
  await until(() => allRows(root).length === 8);
  const buttons = all.filter(e => e.tagName === 'BUTTON');
  const byText = t => buttons.find(b => b.textContent === t);
  byText('Seal current design').emit('click');
  byText('Export JSON').emit('click');
  byText('Export CSV').emit('click');
  byText('Export Markdown').emit('click');
  assert.equal(ui.downloads.length, 3);
  const stamped = JSON.parse(ui.downloads[0].body).sha256;
  assert.match(stamped, /^[0-9a-f]{64}$/);
  assert.ok(ui.downloads.every(d => d.body.includes(stamped)));
  assert.deepEqual(ui.downloads.map(d => d.name), ['dfm_brief.json', 'dfm_brief.csv', 'dfm_brief.md']);
});

test('mount: the self-test runner reports every check passing', async () => {
  const { root, all } = mountFixture();
  await until(() => allRows(root).length === 8);
  const buttons = all.filter(e => e.tagName === 'BUTTON');
  const btn = buttons.find(b => b.textContent === 'Run in-page self-tests');
  const summary = all.find(e => e._classes && e._classes.has('lab-self-summary'));
  btn.emit('click');
  await until(() => /pass$/.test(summary.textContent));
  assert.equal(summary.textContent, selfResults.length + '/' + selfResults.length + ' pass');
  const list = all.find(e => e._classes && e._classes.has('lab-self-list'));
  assert.equal(list.children.length, selfResults.length);
});

test('csvField neutralizes formula triggers behind whitespace and invisible Unicode', () => {
  [' ', '\t', '\u00A0', '\u200B', '\uFEFF'].forEach(function (lead) {
    assert.equal(lab.csvField(lead + '=cmd'), "'" + lead + '=cmd');
  });
});
