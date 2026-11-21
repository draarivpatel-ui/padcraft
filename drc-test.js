/*
 * PadCraft design-rule audit, BOM and export determinism tests
 * ------------------------------------------------------------
 * Run with:  node --test drc-test.js
 *
 * Covers:
 *   1. SHA-256 and UTF-8 fingerprint plumbing against Node's crypto
 *   2. Fingerprinted bill of materials (JSON + CSV)
 *   3. Physical and electrical DRC invariants, including planted defects
 *   4. Matrix pin bounds across the whole legal configuration space
 *   5. Byte-for-byte export determinism and the layout proof manifest
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const pc = require('./cad.js');

const CFG = Object.freeze({ rows: 3, cols: 4, encoder: true, sensor: true, name: 'DRC Test Pad' });
const checkOf = (audit, id) => audit.checks.find(ch => ch.id === id);
const padCountOf = board => {
  const count = {};
  for (const cp of board.components) for (const p of cp.pads) {
    if (p.net) count[p.net.name] = (count[p.net.name] || 0) + 1;
  }
  return count;
};

/* ===================================================================== *
 * 1. Fingerprints: UTF-8 and SHA-256
 * ===================================================================== */

test('sha256Hex: matches Node crypto on empty, ASCII and known vectors', () => {
  assert.equal(pc.sha256Hex(''), crypto.createHash('sha256').update('').digest('hex'));
  assert.equal(pc.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(pc.sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('sha256Hex: matches Node crypto across block boundaries and repeats', () => {
  for (const len of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
    const s = 'x'.repeat(len);
    assert.equal(pc.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), 'length ' + len);
  }
});

test('sha256Hex: multi-byte UTF-8 input matches Node crypto', () => {
  for (const s of ['café', '中文字符', 'emoji 😀 mix ñ', 'combining é marks', 'ﬁ']) {
    assert.equal(pc.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), s);
  }
});

test('sha256Hex: accepts Uint8Array and is deterministic', () => {
  const bytes = new TextEncoder().encode('binary payload');
  assert.equal(pc.sha256Hex(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(pc.sha256Hex('repeat'), pc.sha256Hex('repeat'));
});

test('utf8Bytes: encodes BMP and astral characters correctly', () => {
  assert.deepEqual([...pc.utf8Bytes('A')], [0x41]);
  assert.deepEqual([...pc.utf8Bytes('é')], [0xC3, 0xA9]);
  assert.deepEqual([...pc.utf8Bytes('中')], [0xE4, 0xB8, 0xAD]);
  assert.deepEqual([...pc.utf8Bytes('😀')], [0xF0, 0x9F, 0x98, 0x80]);
  assert.equal(pc.utf8Bytes('mixed Aé中😀').length, new TextEncoder().encode('mixed Aé中😀').length);
});

/* ===================================================================== *
 * 2. Bill of materials
 * ===================================================================== */

test('bom: schema, design identity and board envelope are populated', () => {
  const bom = pc.buildBom(CFG);
  assert.equal(bom.schema, pc.BOM_SCHEMA);
  assert.equal(bom.schema, 'padcraft.bom/1');
  assert.equal(bom.design, 'DRC Test Pad');
  assert.ok(bom.board.widthMm > 0 && bom.board.heightMm > 0);
  assert.equal(bom.board.areaMm2, Math.round(bom.board.widthMm * bom.board.heightMm * 1000) / 1000);
});

test('bom: every line item carries line, category, refs, qty, value, footprint', () => {
  const bom = pc.buildBom(CFG);
  assert.ok(bom.items.length >= 6);
  bom.items.forEach((item, i) => {
    assert.equal(item.line, i + 1);
    assert.ok(typeof item.category === 'string' && item.category.length > 0);
    assert.ok(Array.isArray(item.refs) && item.refs.length === item.qty);
    assert.ok(item.qty > 0);
    assert.ok(typeof item.value === 'string' && item.value.length > 0);
    assert.ok(typeof item.footprint === 'string');
  });
});

test('bom: switch line covers SW1 through SWn in order with the right package', () => {
  const bom = pc.buildBom(CFG);
  const line = bom.items.find(item => item.category === 'electromechanical' && item.refs[0] === 'SW1');
  assert.equal(line.qty, 12);
  assert.deepEqual(line.refs, Array.from({ length: 12 }, (_, i) => 'SW' + (i + 1)));
  assert.match(line.value, /MX/);
  const choc = pc.buildBom({ rows: 2, cols: 2, switchType: 'Choc', encoder: false });
  assert.match(choc.items[0].value, /Choc/);
});

test('bom: one 1N4148 SOD-123 diode per key position', () => {
  const bom = pc.buildBom({ rows: 2, cols: 5, encoder: false });
  const line = bom.items.find(item => item.category === 'semiconductor');
  assert.equal(line.qty, 10);
  assert.match(line.value, /1N4148/);
  assert.equal(line.footprint, 'SOD-123');
  assert.deepEqual(line.refs, Array.from({ length: 10 }, (_, i) => 'D' + (i + 1)));
});

test('bom: controller, encoder and sensor lines follow the configuration', () => {
  const bom = pc.buildBom({ rows: 2, cols: 3, encoder: true, sensor: true, sensorCount: 3 });
  assert.ok(bom.items.some(item => item.refs[0] === 'U1' && item.qty === 1));
  assert.ok(bom.items.some(item => item.refs[0] === 'ENC1'));
  const headers = bom.items.find(item => item.category === 'connector');
  assert.equal(headers.qty, 3);
  assert.deepEqual(headers.refs, ['J1', 'J2', 'J3']);
  const bare = pc.buildBom({ rows: 2, cols: 2, encoder: false, sensor: false });
  assert.ok(!bare.items.some(item => item.refs[0] === 'ENC1'));
  assert.ok(!bare.items.some(item => item.category === 'connector'));
});

test('bom: mounting hardware and fabrication lines are always present', () => {
  const bom = pc.buildBom({ rows: 1, cols: 1, encoder: false });
  const mounts = bom.items.find(item => item.category === 'hardware');
  assert.equal(mounts.qty, 4);
  assert.deepEqual(mounts.refs, ['H1', 'H2', 'H3', 'H4']);
  const fab = bom.items.filter(item => item.category === 'fabrication');
  assert.equal(fab.length, 2);
  assert.match(fab[0].value, /FR-4/);
  assert.match(fab[1].value, /plate/i);
});

test('bom: totals reconcile with quantities and board stats', () => {
  const board = pc.buildBoard(CFG), bom = pc.buildBom(CFG);
  assert.equal(bom.totals.lines, bom.items.length);
  assert.equal(bom.totals.parts, bom.items.reduce((n, item) => n + item.qty, 0));
  assert.equal(bom.totals.switches, board.stats.keys);
  assert.equal(bom.totals.diodes, board.stats.diodes);
  assert.equal(bom.totals.gpioUsed, board.netlist.pins.needed);
  assert.equal(bom.totals.adcChannels, board.netlist.pins.sensor.length);
});

test('bom: fingerprint is a stable 64 hex digest that tracks the design', () => {
  const a = pc.buildBom(CFG), again = pc.buildBom(CFG);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(a.fingerprint, again.fingerprint);
  assert.deepEqual(a, again);
  const different = pc.buildBom({ ...CFG, rows: 4 });
  assert.notEqual(different.fingerprint, a.fingerprint);
});

test('bom csv: schema comment, fingerprint and header precede the rows', () => {
  const bom = pc.buildBom(CFG), csv = pc.buildBomCsv(bom);
  const lines = csv.split('\n');
  assert.ok(lines[0].startsWith('# padcraft.bom/1'));
  assert.ok(lines[0].includes(bom.fingerprint));
  assert.equal(lines[1], 'line,category,refs,qty,value,footprint,notes');
  assert.equal(lines.filter(l => l && !l.startsWith('#')).length - 1, bom.items.length);
  assert.ok(csv.endsWith('\n'));
});

test('bom csv: data rows echo the item order and quantities', () => {
  const bom = pc.buildBom(CFG), csv = pc.buildBomCsv(bom);
  const rows = csv.split('\n').filter(l => l && !l.startsWith('#')).slice(1);
  assert.equal(rows.length, bom.items.length);
  bom.items.forEach((item, i) => {
    const fields = rows[i].split(',');
    assert.equal(fields[0], String(item.line));
    assert.equal(fields[1], item.category);
    assert.equal(fields[3], String(item.qty));
  });
});

test('bom csv: fields containing commas or quotes are escaped', () => {
  const bom = pc.buildBom({ rows: 1, cols: 1, encoder: false });
  bom.items[0].value = 'switch, "cherry" style';
  const csv = pc.buildBomCsv(bom);
  const row = csv.split('\n').filter(l => l && !l.startsWith('#'))[1];
  assert.ok(row.includes('"switch, ""cherry"" style"'));
});

test('bom csv: byte deterministic across runs', () => {
  const a = pc.buildBomCsv(pc.buildBom(CFG)), b = pc.buildBomCsv(pc.buildBom(CFG));
  assert.equal(a, b);
});

/* ===================================================================== *
 * 3. Design rule audit structure
 * ===================================================================== */

test('audit: schema, identity and summary counters are consistent', () => {
  const audit = pc.auditDesign(CFG);
  assert.equal(audit.schema, 'padcraft.drc/1');
  assert.equal(audit.design, 'DRC Test Pad');
  assert.equal(audit.valid, true);
  assert.equal(audit.errors, 0);
  assert.equal(audit.errors + audit.warnings + audit.passed, audit.checks.length);
  assert.match(audit.fingerprint, /^[0-9a-f]{64}$/);
});

test('audit: every check carries id, domain, label, severity, outcome and evidence', () => {
  const audit = pc.auditDesign(CFG);
  const ids = new Set();
  const domains = new Set(['mechanical', 'electrical', 'firmware']);
  const severities = new Set(['error', 'warning', 'info']);
  for (const ch of audit.checks) {
    assert.ok(ch.id && !ids.has(ch.id), 'unique check id ' + ch.id);
    ids.add(ch.id);
    assert.ok(domains.has(ch.domain), ch.domain);
    assert.ok(severities.has(ch.severity), ch.severity);
    assert.ok(typeof ch.label === 'string' && ch.label.length > 0);
    assert.ok(typeof ch.detail === 'string' && ch.detail.length > 0, ch.id + ' evidence');
    assert.ok(typeof ch.valid === 'boolean');
  }
  assert.ok(audit.checks.length >= 15);
});

test('audit: all four showcases pass with zero errors', () => {
  for (const [id, sc] of Object.entries(pc.SHOWCASES)) {
    const audit = pc.auditDesign(sc.config);
    assert.equal(audit.valid, true, id);
    assert.equal(audit.errors, 0, id);
  }
});

test('audit: warnings are advisory and do not fail the design', () => {
  const audit = pc.auditDesign({ rows: 3, cols: 4, edgeMargin: 5, mountHoleDiameter: 4, encoder: true });
  const web = checkOf(audit, 'mechanical.plate-web');
  assert.equal(web.severity, 'warning');
  assert.equal(web.valid, false);
  assert.ok(audit.warnings >= 1);
  assert.equal(audit.valid, true);
});

test('audit: envelope and matrix summaries carry real measurements', () => {
  const audit = pc.auditDesign(CFG);
  assert.equal(audit.matrix.rows, 3);
  assert.equal(audit.matrix.cols, 4);
  assert.equal(audit.matrix.keys, 12);
  assert.equal(audit.matrix.diodeOrientation, 'COL2ROW');
  assert.equal(audit.matrix.pinsNeeded, 3 + 4 + 3);
  assert.ok(audit.envelope.widthMm > 0 && audit.envelope.heightMm > 0);
});

test('audit: deterministic, and the fingerprint reacts to design changes', () => {
  const a = pc.auditDesign(CFG), b = pc.auditDesign(CFG);
  assert.deepEqual(a, b);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(pc.auditDesign({ ...CFG, cols: 5 }).fingerprint, a.fingerprint);
});

/* ===================================================================== *
 * 4. Mechanical invariants
 * ===================================================================== */

test('drc key-pitch: measured spacing equals the configured pitch everywhere', () => {
  for (const keySpacing of [18, 19.05, 20.4, 24]) {
    for (const [rows, cols] of [[1, 1], [2, 3], [4, 6], [6, 8]]) {
      const audit = pc.auditDesign({ rows, cols, keySpacing, encoder: rows > 1 });
      const ch = checkOf(audit, 'mechanical.key-pitch');
      assert.equal(ch.valid, true, rows + 'x' + cols + ' @ ' + keySpacing + ': ' + ch.detail);
      const layout = pc.computeLayout({ rows, cols, keySpacing });
      for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
        const k = layout.keys[r * cols + col];
        if (col + 1 < cols) {
          const n = layout.keys[r * cols + col + 1];
          assert.ok(Math.abs(Math.hypot(n.x - k.x, n.y - k.y) - keySpacing) < 1e-9);
        }
        if (r + 1 < rows) {
          const n = layout.keys[(r + 1) * cols + col];
          assert.ok(Math.abs(Math.hypot(n.x - k.x, n.y - k.y) - keySpacing) < 1e-9);
        }
      }
    }
  }
});

test('drc key-pitch: a dragged switch is flagged as an error', () => {
  const board = pc.buildBoard(CFG);
  board.layout.keys[0].x += 0.5;
  const ch = checkOf(pc.auditBoard(board), 'mechanical.key-pitch');
  assert.equal(ch.valid, false);
  assert.equal(ch.severity, 'error');
});

test('drc enclosure: courtyards, pads and drills stay inside Edge.Cuts', () => {
  const audit = pc.auditDesign({ rows: 6, cols: 8, encoder: true, sensor: true, sensorCount: 3, pinOffset: 6 });
  assert.equal(checkOf(audit, 'mechanical.enclosure').valid, true);
});

test('drc enclosure: a pad dragged off the board is caught', () => {
  const board = pc.buildBoard(CFG);
  board.components[0].pads[0].x = board.layout.width + 1;
  const audit = pc.auditBoard(board);
  const ch = checkOf(audit, 'mechanical.enclosure');
  assert.equal(ch.valid, false);
  assert.equal(ch.severity, 'error');
  assert.equal(audit.valid, false);
});

test('drc plate-web: openings keep at least 2 mm of stock', () => {
  const audit = pc.auditDesign({ rows: 3, cols: 4, keySpacing: 19.05, switchCutout: 14, encoder: false });
  const ch = checkOf(audit, 'mechanical.plate-web');
  assert.equal(ch.valid, true);
  assert.equal(ch.severity, 'warning');
  assert.match(ch.detail, /minimum \d/);
});

test('drc plate-web: overlapping openings are errors, thin webs are warnings', () => {
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false });
  const first = board.layout.cutouts[0];
  board.layout.cutouts.push({ x: first.x + 1, y: first.y, w: first.w, h: first.h, kind: 'switch' });
  const audit = pc.auditBoard(board);
  const ch = checkOf(audit, 'mechanical.plate-web');
  assert.equal(ch.severity, 'error');
  assert.equal(ch.valid, false);
  assert.equal(audit.valid, false);
});

test('drc controller-bay: no non-mcu footprint crosses into the bay', () => {
  for (const [id, sc] of Object.entries(pc.SHOWCASES)) {
    const audit = pc.auditDesign(sc.config);
    assert.equal(checkOf(audit, 'mechanical.controller-bay').valid, true, id);
  }
});

test('drc controller-bay: a part pushed into the bay is caught', () => {
  const board = pc.buildBoard(CFG);
  const diode = board.components.find(cp => cp.ref === 'D1');
  diode.x = board.layout.keyWidth + 1;
  assert.equal(checkOf(pc.auditBoard(board), 'mechanical.controller-bay').valid, false);
});

test('drc courtyards: compact 18 mm pitch is flagged as tight but legal', () => {
  const audit = pc.auditDesign(pc.SHOWCASES.compact.config);
  const ch = checkOf(audit, 'mechanical.courtyards');
  assert.equal(ch.severity, 'warning');
  assert.equal(ch.valid, false);
  assert.match(ch.detail, /0\.1 mm/);
});

test('drc drills: every plated hit lands on a pad; orphans are caught', () => {
  const audit = pc.auditDesign(CFG);
  const ch = checkOf(audit, 'mechanical.drills');
  assert.equal(ch.valid, true);
  const board = pc.buildBoard(CFG);
  board.drillPoints.push({ x: 2, y: 2, diameter: 0.9, plated: true });
  const planted = checkOf(pc.auditBoard(board), 'mechanical.drills');
  assert.equal(planted.valid, false);
});

/* ===================================================================== *
 * 5. Electrical invariants and matrix pin bounds
 * ===================================================================== */

test('pins: needed, unique and legal across the whole legal configuration space', () => {
  for (let rows = 1; rows <= 6; rows++) for (let cols = 1; cols <= 8; cols++) {
    for (const encoder of [true, false]) for (let pinOffset = 0; pinOffset <= 6; pinOffset++) {
      const c = pc.clampConfig({ rows, cols, encoder, pinOffset });
      const pins = pc.buildPinAssignment(c);
      assert.equal(pins.needed, rows + cols + (encoder ? 3 : 0), 'needed');
      assert.ok(pins.needed <= pins.pool.length, 'budget');
      assert.equal(pins.pool.length, pc.RP2040_GPIO_POOL.length - pinOffset, 'pool');
      assert.equal(pins.usage.length, pins.needed, 'usage length');
      const names = pins.usage.map(u => u.pin);
      assert.equal(new Set(names).size, names.length, 'unique');
      const legal = new Set([...pc.RP2040_GPIO_POOL.slice(pinOffset).map(n => 'GP' + n), ...pc.RP2040_ADC_POOL]);
      for (const u of pins.usage) assert.ok(legal.has(u.pin), u.pin + ' legal');
      assert.equal(pins.rows.length, rows);
      assert.equal(pins.cols.length, cols);
      assert.equal(pins.encoder !== null, encoder);
    }
  }
});

test('pins: the 48-key sweep fits the RP2040 budget exactly at the bound', () => {
  const pins = pc.buildPinAssignment(pc.clampConfig(pc.SHOWCASES.sweep.config));
  assert.equal(pins.needed, 6 + 8 + 3);
  assert.equal(pins.pool.length, 23 - 6);
  assert.equal(pins.needed, pins.pool.length);
  const audit = pc.auditDesign(pc.SHOWCASES.sweep.config);
  assert.equal(checkOf(audit, 'electrical.pin-budget').valid, true);
});

test('drc pin-uniqueness: a duplicated assignment is caught', () => {
  const board = pc.buildBoard(CFG);
  board.netlist.pins.usage[1].pin = board.netlist.pins.usage[0].pin;
  const ch = checkOf(pc.auditBoard(board), 'electrical.pin-uniqueness');
  assert.equal(ch.valid, false);
  assert.match(ch.detail, new RegExp(board.netlist.pins.usage[0].pin));
});

test('drc pin-legality: pins outside the pools are caught', () => {
  const board = pc.buildBoard(CFG);
  board.netlist.pins.usage.push({ pin: 'GP25', net: 'ROGUE', role: 'planted' });
  const ch = checkOf(pc.auditBoard(board), 'electrical.pin-legality');
  assert.equal(ch.valid, false);
  assert.match(ch.detail, /GP25/);
});

test('drc pin-legality: offset pools exclude skipped GPIOs', () => {
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false, pinOffset: 2 });
  board.netlist.pins.usage.push({ pin: 'GP0', net: 'EARLY', role: 'planted' });
  assert.equal(checkOf(pc.auditBoard(board), 'electrical.pin-legality').valid, false);
});

test('drc adc-bounds: sensor pins stay inside GP26 to GP28', () => {
  const audit = pc.auditDesign({ rows: 2, cols: 2, sensor: true, sensorCount: 3 });
  const ch = checkOf(audit, 'electrical.adc-bounds');
  assert.equal(ch.valid, true);
  assert.match(ch.detail, /GP26/);
  const board = pc.buildBoard({ rows: 1, cols: 1, sensor: true, sensorCount: 1 });
  board.netlist.pins.sensor.push('GP29');
  assert.equal(checkOf(pc.auditBoard(board), 'electrical.adc-bounds').valid, false);
});

test('drc diode-polarity: anode to key node and cathode to row on every key', () => {
  const board = pc.buildBoard(CFG);
  const audit = pc.auditBoard(board);
  const ch = checkOf(audit, 'electrical.diode-polarity');
  assert.equal(ch.valid, true);
  assert.match(ch.detail, /12 diodes/);
  for (const a of board.netlist.assignments) {
    const dio = board.components.find(cp => cp.ref === a.diode);
    assert.equal(dio.pads[0].net.name, a.keyNet, a.diode + ' anode');
    assert.equal(dio.pads[1].net.name, a.rowNet, a.diode + ' cathode');
    const sw = board.components.find(cp => cp.ref === a.switch);
    assert.equal(sw.pads[0].net.name, a.colNet);
    assert.equal(sw.pads[1].net.name, a.keyNet);
  }
});

test('drc diode-polarity: a flipped diode is caught', () => {
  const board = pc.buildBoard(CFG);
  const dio = board.components.find(cp => cp.ref === 'D1');
  const tmp = dio.pads[0].net;
  dio.pads[0].net = dio.pads[1].net;
  dio.pads[1].net = tmp;
  const audit = pc.auditBoard(board);
  const ch = checkOf(audit, 'electrical.diode-polarity');
  assert.equal(ch.valid, false);
  assert.equal(audit.valid, false);
});

test('drc anti-ghosting: every key node is shared by exactly one switch and one diode', () => {
  for (const cfg of [CFG, { rows: 1, cols: 1, encoder: false }, { rows: 6, cols: 8, pinOffset: 6, encoder: true }]) {
    const board = pc.buildBoard(cfg), pads = padCountOf(board);
    for (const a of board.netlist.assignments) {
      assert.equal(pads[a.keyNet], 2, a.keyNet + ' fanout');
    }
    for (let r = 0; r < board.config.rows; r++) assert.equal(pads['ROW' + r], board.config.cols + 1, 'ROW' + r);
    for (let col = 0; col < board.config.cols; col++) assert.equal(pads['COL' + col], board.config.rows + 1, 'COL' + col);
    assert.equal(checkOf(pc.auditBoard(board), 'electrical.anti-ghosting').valid, true);
  }
});

test('drc anti-ghosting: removing a diode breaks key isolation', () => {
  const board = pc.buildBoard(CFG);
  const i = board.components.findIndex(cp => cp.ref === 'D1');
  board.components.splice(i, 1);
  const audit = pc.auditBoard(board);
  assert.equal(checkOf(audit, 'electrical.anti-ghosting').valid, false);
  assert.equal(audit.valid, false);
});

test('drc anti-ghosting: a duplicated key node is caught', () => {
  const board = pc.buildBoard(CFG);
  board.netlist.assignments.push({ ...board.netlist.assignments[0] });
  assert.equal(checkOf(pc.auditBoard(board), 'electrical.anti-ghosting').valid, false);
});

test('drc net-fanout: every signal net has at least two terminals', () => {
  const board = pc.buildBoard(CFG);
  assert.equal(checkOf(pc.auditBoard(board), 'electrical.net-fanout').valid, true);
  board.components.find(cp => cp.ref === 'SW1').pads[1].net = null;
  const audit = pc.auditBoard(board);
  assert.equal(checkOf(audit, 'electrical.net-fanout').valid, false);
});

test('drc ground: GND pads exist and sensor designs carry 3V3', () => {
  const withSensor = pc.auditDesign({ rows: 2, cols: 2, sensor: true, sensorCount: 2 });
  assert.equal(checkOf(withSensor, 'electrical.ground').valid, true);
  const board = pc.buildBoard({ rows: 2, cols: 2, sensor: true, sensorCount: 2 });
  for (const cp of board.components) for (const p of cp.pads) {
    if (p.net && p.net.name === '3V3') p.net = null;
  }
  assert.equal(checkOf(pc.auditBoard(board), 'electrical.ground').valid, false);
});

test('drc copper-clearance: clean boards pass and planted shorts fail', () => {
  const audit = pc.auditDesign(CFG);
  assert.equal(checkOf(audit, 'electrical.copper-clearance').valid, true);
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false });
  const hole = board.layout.keys[0];
  board.traces.push({ net: 'COL0', layer: 'F.Cu', width: 0.25, points: [[hole.x - 6, hole.y], [hole.x + 6, hole.y]] });
  board.traces.push({ net: 'ROW0', layer: 'F.Cu', width: 0.25, points: [[hole.x, hole.y - 6], [hole.x, hole.y + 6]] });
  assert.equal(checkOf(pc.auditBoard(board), 'electrical.copper-clearance').valid, false);
});

test('drc routing: unfinished connections are informational, never an error', () => {
  const audit = pc.auditDesign(CFG);
  const ch = checkOf(audit, 'electrical.routing');
  assert.equal(ch.severity, 'info');
  assert.equal(ch.valid, true);
  assert.match(ch.detail, /airwires/);
});

/* ===================================================================== *
 * 6. Firmware and keymap checks
 * ===================================================================== */

test('drc keymap: covers every matrix cell with sanitized keycodes', () => {
  const audit = pc.auditDesign(CFG);
  assert.equal(checkOf(audit, 'firmware.keymap').valid, true);
  const board = pc.buildBoard(CFG);
  board.keymap[0][0] = 'not a keycode';
  assert.equal(checkOf(pc.auditBoard(board), 'firmware.keymap').valid, false);
});

test('drc firmware: KMK and QMK mirror the same matrix and COL2ROW polarity', () => {
  const audit = pc.auditDesign(CFG);
  const ch = checkOf(audit, 'firmware.consistency');
  assert.equal(ch.valid, true);
  const kmk = pc.generateKMK(CFG);
  const qmk = JSON.parse(pc.generateQMK(CFG)['keyboard.json']);
  const pins = pc.buildPinAssignment(CFG);
  assert.ok(kmk.includes('DiodeOrientation.COL2ROW'));
  assert.deepEqual(qmk.matrix_pins.rows, pins.rows);
  assert.deepEqual(qmk.matrix_pins.cols, pins.cols);
  assert.equal(qmk.diode_direction, 'COL2ROW');
});

/* ===================================================================== *
 * 7. Export byte determinism and layout proof
 * ===================================================================== */

test('exports: the bundle ships bom, drc and layout proof artifacts', () => {
  const files = pc.generateAll(CFG);
  assert.equal(Object.keys(files).length, 25);
  const base = pc.slug(CFG.name);
  for (const suffix of ['_bom.json', '_bom.csv', '_drc.json', '_layout_proof.json']) {
    assert.ok(Object.prototype.hasOwnProperty.call(files, base + suffix), suffix);
  }
});

test('exports: generateAll is byte-for-byte deterministic', () => {
  const a = pc.generateAll(CFG), b = pc.generateAll(CFG);
  assert.deepEqual(a, b);
});

test('exports: determinism survives interleaved designs', () => {
  const other = { rows: 2, cols: 3, encoder: false, sensor: true, name: 'Second Pad' };
  const a1 = pc.generateAll(CFG);
  pc.generateAll(other);
  const a2 = pc.generateAll(CFG);
  assert.deepEqual(a1, a2);
});

test('exports: drc.json round-trips into a clean audit report', () => {
  const files = pc.generateAll(CFG);
  const name = pc.slug(CFG.name) + '_drc.json';
  const report = JSON.parse(files[name]);
  assert.equal(report.schema, 'padcraft.drc/1');
  assert.equal(report.valid, true);
  assert.equal(report.errors, 0);
  assert.ok(report.checks.length >= 15);
  assert.equal(files[name], JSON.stringify(pc.auditDesign(CFG), null, 2) + '\n');
});

test('exports: bom.json round-trips with an intact fingerprint', () => {
  const files = pc.generateAll(CFG);
  const bom = JSON.parse(files[pc.slug(CFG.name) + '_bom.json']);
  assert.equal(bom.schema, 'padcraft.bom/1');
  const canonical = bom.items.map(item =>
    [item.category, item.refs.join('|'), item.qty, item.value, item.footprint, item.notes].join('')).join('\n');
  assert.equal(bom.fingerprint, pc.sha256Hex(canonical));
});

test('exports: layout proof lists every artifact except itself with real digests', () => {
  const files = pc.generateAll(CFG);
  const proof = JSON.parse(files[pc.slug(CFG.name) + '_layout_proof.json']);
  assert.equal(proof.schema, 'padcraft.proof/1');
  const expected = Object.keys(files).filter(n => !n.endsWith('_layout_proof.json'));
  assert.equal(proof.files.length, expected.length);
  assert.deepEqual(new Set(proof.files.map(e => e.name)), new Set(expected));
  for (const entry of proof.files) {
    assert.equal(entry.sha256, pc.sha256Hex(files[entry.name]), entry.name);
    assert.equal(entry.bytes, pc.utf8Bytes(files[entry.name]).length, entry.name);
  }
});

test('exports: layout proof fingerprint recomputes and tracks content', () => {
  const files = pc.generateAll(CFG);
  const proof = JSON.parse(files[pc.slug(CFG.name) + '_layout_proof.json']);
  const expected = proof.files.map(e => e.name + ':' + e.bytes + ':' + e.sha256).join('\n');
  assert.equal(proof.fingerprint, pc.sha256Hex(expected));
  const tampered = { ...files, 'kb.py': files['kb.py'] + ' ' };
  const proof2 = pc.buildLayoutProof(CFG, tampered);
  assert.notEqual(proof2.fingerprint, proof.fingerprint);
});

test('exports: layout proof carries the bounding envelope and matrix facts', () => {
  const proof = pc.buildLayoutProof(CFG, pc.generateAll(CFG));
  const board = pc.buildBoard(CFG);
  assert.equal(proof.envelope.widthMm, Math.round(board.layout.width * 1000) / 1000);
  assert.equal(proof.envelope.heightMm, Math.round(board.layout.height * 1000) / 1000);
  assert.equal(proof.envelope.boardThicknessMm, 1.6);
  assert.equal(proof.matrix.keys, 12);
  assert.equal(proof.matrix.pinsNeeded, board.netlist.pins.needed);
});

test('exports: verification report now includes the audit and BOM round trips', () => {
  const files = pc.generateAll(CFG);
  const v = JSON.parse(files['verification.json']);
  const labels = v.checks.map(ch => ch.label);
  assert.ok(labels.includes('Design rule audit is clean'));
  assert.ok(labels.includes('Bill of materials round trip'));
  assert.equal(v.valid, true);
  assert.equal(v.checks.find(ch => ch.label === 'Design rule audit is clean').valid, true);
  assert.equal(v.checks.find(ch => ch.label === 'Bill of materials round trip').valid, true);
});

test('exports: a tampered drc report fails the bundle round trip', () => {
  const files = pc.generateAll(CFG);
  const name = Object.keys(files).find(n => n.endsWith('_drc.json'));
  const report = JSON.parse(files[name]);
  report.valid = false; report.errors = 2;
  const v = pc.verifyBundle(CFG, { ...files, [name]: JSON.stringify(report, null, 2) + '\n' });
  assert.equal(v.checks.find(ch => ch.label === 'Design rule audit is clean').valid, false);
  assert.equal(v.valid, false);
});

test('exports: a tampered BOM fingerprint fails the bundle round trip', () => {
  const files = pc.generateAll(CFG);
  const name = Object.keys(files).find(n => n.endsWith('_bom.json'));
  const bom = JSON.parse(files[name]);
  bom.fingerprint = '0'.repeat(64);
  const v = pc.verifyBundle(CFG, { ...files, [name]: JSON.stringify(bom, null, 2) + '\n' });
  assert.equal(v.checks.find(ch => ch.label === 'Bill of materials round trip').valid, false);
  assert.equal(v.valid, false);
});

test('exports: a tampered CSV row fails the bundle round trip', () => {
  const files = pc.generateAll(CFG);
  const name = Object.keys(files).find(n => n.endsWith('_bom.csv'));
  const tampered = { ...files, [name]: files[name].replace('electromechanical', 'bogus') };
  const v = pc.verifyBundle(CFG, tampered);
  assert.equal(v.checks.find(ch => ch.label === 'Bill of materials round trip').valid, false);
  assert.equal(v.valid, false);
});

/* ===================================================================== *
 * 8. Audit across the configuration grid
 * ===================================================================== */

test('drc sweep: every legal matrix size produces a clean audit', () => {
  for (let rows = 1; rows <= 6; rows++) for (let cols = 1; cols <= 8; cols++) {
    for (const encoder of [true, false]) {
      const audit = pc.auditDesign({ rows, cols, encoder, switchType: (rows + cols) % 2 ? 'MX' : 'Choc' });
      assert.equal(audit.valid, true, rows + 'x' + cols + ' enc=' + encoder + ': ' +
        JSON.stringify(audit.checks.filter(ch => !ch.valid && ch.severity === 'error')));
    }
  }
});

test('drc sweep: pin margins stay nonnegative at every offset and size', () => {
  for (let pinOffset = 0; pinOffset <= 6; pinOffset++) {
    for (let rows = 1; rows <= 6; rows++) for (let cols = 1; cols <= 8; cols++) {
      const audit = pc.auditDesign({ rows, cols, encoder: true, pinOffset });
      assert.equal(checkOf(audit, 'electrical.pin-budget').valid, true, rows + 'x' + cols + ' off=' + pinOffset);
      assert.ok(audit.matrix.pinsAvailable - audit.matrix.pinsNeeded >= 0);
    }
  }
});

/* ===================================================================== *
 * 9. CLI surface
 * ===================================================================== */

test('CLI: drc prints a clean audit report and exits zero', () => {
  const out = execFileSync(process.execPath, ['cad.js', 'drc', '--rows', '2', '--cols', '3'],
    { cwd: __dirname, encoding: 'utf8' });
  const audit = JSON.parse(out);
  assert.equal(audit.schema, 'padcraft.drc/1');
  assert.equal(audit.valid, true);
  assert.ok(audit.checks.length >= 15);
  assert.match(audit.fingerprint, /^[0-9a-f]{64}$/);
});

test('CLI: bom and bomcsv write parseable artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padcraft-bom-'));
  try {
    execFileSync(process.execPath, ['cad.js', 'bom', '--rows', '2', '--cols', '2', '--out', path.join(dir, 'b.json')],
      { cwd: __dirname, encoding: 'utf8' });
    const bom = JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'));
    assert.equal(bom.schema, 'padcraft.bom/1');
    assert.equal(bom.totals.switches, 4);
    execFileSync(process.execPath, ['cad.js', 'bomcsv', '--rows', '2', '--cols', '2', '--out', path.join(dir, 'b.csv')],
      { cwd: __dirname, encoding: 'utf8' });
    const csv = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8');
    assert.ok(csv.startsWith('# padcraft.bom/1'));
    assert.ok(csv.includes(bom.fingerprint));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: check reports drc fields alongside the existing validators', () => {
  const out = execFileSync(process.execPath, ['cad.js', 'check', '--rows', '2', '--cols', '2'],
    { cwd: __dirname, encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.drc_valid, true);
  assert.equal(report.drc_errors, 0);
  assert.match(report.drc_fingerprint, /^[0-9a-f]{64}$/);
});

test('CLI: all writes the new artifacts into a directory', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.padcraft-cli-'));
  try {
    execFileSync(process.execPath, ['cad.js', 'all', '--rows', '1', '--cols', '2', '--out', dir],
      { cwd: __dirname, encoding: 'utf8' });
    const names = fs.readdirSync(dir);
    for (const suffix of ['_bom.json', '_bom.csv', '_drc.json', '_layout_proof.json']) {
      assert.ok(names.some(n => n.endsWith(suffix)), suffix);
    }
    const proof = JSON.parse(fs.readFileSync(path.join(dir, names.find(n => n.endsWith('_layout_proof.json'))), 'utf8'));
    assert.equal(proof.files.length, 24);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
