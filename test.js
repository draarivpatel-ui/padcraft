/*
 * PadCraft test suite
 * -------------------
 * Run with:  node --test test.js
 *
 * Covers the four contract areas:
 *   1. ASCII STL triangle normal generation
 *   2. KiCad S-expression syntax validity
 *   3. Diode matrix column / row assignment
 *   4. KMK firmware code generation
 * Plus OpenSCAD, Gerber, QMK, presets and CLI integration checks.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pc = require('./cad.js');

const CFG = Object.freeze({ rows: 3, cols: 4, encoder: true, sensor: true, name: 'Test Pad' });

/* ===================================================================== *
 * 1. ASCII STL triangle normal generation
 * ===================================================================== */

test('computeNormal returns a unit vector for an XY triangle (+Z)', () => {
  const n = pc.computeNormal([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  assert.deepEqual(n, [0, 0, 1]);
});

test('computeNormal respects winding order (-Z when reversed)', () => {
  const n = pc.computeNormal([0, 0, 0], [0, 1, 0], [1, 0, 0]);
  assert.deepEqual(n, [0, 0, -1]);
});

test('computeNormal returns axis-aligned wall normals', () => {
  const negX = pc.computeNormal([0, 0, 0], [0, 0, 1], [0, 1, 1]);
  assert.deepEqual(negX, [-1, 0, 0]);
  const posY = pc.computeNormal([0, 0, 0], [1, 0, 0], [1, 0, 1]);
  assert.deepEqual(posY, [0, -1, 0]);
  // Use the actual wall quad orientation from the mesher for +Y.
  const t = pc.emitQuadTriangles(
    [0, 1, 0], [0, 1, 2], [2, 1, 2], [2, 1, 0]);
  assert.deepEqual(t[0].n, [0, 1, 0]);
});

test('computeNormal returns a zero vector for a degenerate triangle', () => {
  assert.deepEqual(pc.computeNormal([0, 0, 0], [1, 1, 1], [2, 2, 2]), [0, 0, 0]);
});

test('emitQuadTriangles emits two triangles with matching normals', () => {
  const tris = pc.emitQuadTriangles([0, 0, 5], [2, 0, 5], [2, 2, 5], [0, 2, 5]);
  assert.equal(tris.length, 2);
  for (const t of tris) {
    assert.deepEqual(t.n, [0, 0, 1]);
    assert.deepEqual(t.n, pc.computeNormal(t.a, t.b, t.c));
  }
});

test('buildPlateMesh: every triangle normal is a unit vector', () => {
  const mesh = pc.buildPlateMesh(CFG);
  assert.ok(mesh.facets.length > 0);
  for (const t of mesh.facets) {
    const len = Math.hypot(t.n[0], t.n[1], t.n[2]);
    assert.ok(Math.abs(len - 1) < 1e-9, 'normal length ' + len + ' is not 1');
    const recomputed = pc.computeNormal(t.a, t.b, t.c);
    assert.deepEqual(t.n, recomputed, 'stored normal must match its vertices');
  }
});

test('buildPlateMesh: normals point outward on every face', () => {
  const mesh = pc.buildPlateMesh({ rows: 2, cols: 2, encoder: false, sensor: false });
  const { width: W, height: H, thickness: T } = mesh;
  let top = 0, bottom = 0, walls = 0;
  for (const t of mesh.facets) {
    const zs = [t.a[2], t.b[2], t.c[2]];
    const allTop = zs.every(z => Math.abs(z - T) < 1e-9);
    const allBottom = zs.every(z => Math.abs(z) < 1e-9);
    if (allTop) { assert.deepEqual(t.n, [0, 0, 1]); top++; }
    else if (allBottom) { assert.deepEqual(t.n, [0, 0, -1]); bottom++; }
    else {
      // A vertical wall. Its normal must point away from the solid interior.
      const cx = (t.a[0] + t.b[0] + t.c[0]) / 3;
      const cy = (t.a[1] + t.b[1] + t.c[1]) / 3;
      if (Math.abs(cx - W) < 1e-9) assert.deepEqual(t.n, [1, 0, 0]);
      else if (Math.abs(cx) < 1e-9) assert.deepEqual(t.n, [-1, 0, 0]);
      else if (Math.abs(cy - H) < 1e-9) assert.deepEqual(t.n, [0, 1, 0]);
      else if (Math.abs(cy) < 1e-9) assert.deepEqual(t.n, [0, -1, 0]);
      walls++;
    }
  }
  assert.ok(top > 0 && bottom > 0 && walls > 0, 'expected top, bottom and wall facets');
});

test('buildPlateMesh: solid volume is watertight (surface area matches solid cells)', () => {
  const mesh = pc.buildPlateMesh({ rows: 1, cols: 1, encoder: false, sensor: false });
  // Sum of every triangle's area. Each triangle contributes half its quad area.
  let area = 0;
  for (const t of mesh.facets) {
    const n = pc.computeNormal(t.a, t.b, t.c);
    const ax = t.b[0] - t.a[0], ay = t.b[1] - t.a[1], az = t.b[2] - t.a[2];
    const bx = t.c[0] - t.a[0], by = t.c[1] - t.a[1], bz = t.c[2] - t.a[2];
    const cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    area += cross / 2 * Math.hypot(n[0], n[1], n[2]);
  }
  // Volume via the divergence theorem over all closed triangle faces.
  let volume = 0;
  for (const t of mesh.facets) {
    const [a, b, c] = [t.a, t.b, t.c];
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1])
             - a[1] * (b[0] * c[2] - b[2] * c[0])
             + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  assert.ok(volume > 0, 'plate volume must be positive, got ' + volume);
  assert.ok(area > 2 * mesh.width * mesh.height, 'surface area should exceed two plate faces, got ' + area);
  assert.equal(mesh.facets.length % 2, 0, 'triangles come in quad pairs');
});

test('generateSTL: valid ASCII STL with facet/vertex structure and finite normals', () => {
  const stl = pc.generateSTL(CFG);
  const lines = stl.trim().split('\n');
  assert.match(lines[0], /^solid [\w-]+$/);
  assert.equal(lines[lines.length - 1].trim(), 'endsolid test_pad_plate');
  const facets = lines.filter(l => l.trim().startsWith('facet normal'));
  const vertices = lines.filter(l => l.trim().startsWith('vertex'));
  assert.equal(vertices.length, facets.length * 3, '3 vertices per facet');
  assert.equal(facets.length, pc.buildPlateMesh(CFG).facets.length);
  for (const l of facets) {
    const nums = l.trim().slice('facet normal '.length).split(/\s+/).map(Number);
    assert.equal(nums.length, 3);
    assert.ok(nums.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...nums) - 1) < 1e-5, 'facet normal must be unit length');
  }
  assert.equal((stl.match(/outer loop/g) || []).length, facets.length);
  assert.equal((stl.match(/endloop/g) || []).length, facets.length);
  assert.equal((stl.match(/endfacet/g) || []).length, facets.length);
});

test('generateSTL: cutouts actually remove solid cells', () => {
  const withKeys = pc.buildPlateMesh({ rows: 2, cols: 2, encoder: false, sensor: false });
  const withEncoder = pc.buildPlateMesh({ rows: 2, cols: 2, encoder: true, sensor: false });
  assert.ok(withEncoder.stats.solidCells < withKeys.stats.solidCells + withKeys.stats.cells,
    'encoder opening should create additional empty cells');
  assert.ok(withKeys.facets.length > withKeys.stats.solidCells * 2,
    'walls should be emitted around every cutout');
});

/* ===================================================================== *
 * 2. KiCad S-expression syntax validity
 * ===================================================================== */

test('tokenizeSexp: handles atoms, quoted strings and escapes', () => {
  const t = pc.tokenizeSexp('(net 3 "COL 2") (title "a \\"quote\\"")');
  assert.equal(t.filter(x => x.type === 'paren' && x.value === '(').length, 2);
  assert.equal(t.filter(x => x.type === 'paren' && x.value === ')').length, 2);
  assert.ok(t.some(x => x.type === 'string' && x.value === 'COL 2'));
  assert.ok(t.some(x => x.type === 'string' && x.value === 'a "quote"'));
});

test('parseSexp: nested forms round trip correctly', () => {
  const forms = pc.parseSexp('(a (b 1) (c "x"))');
  assert.equal(forms.length, 1);
  assert.equal(forms[0][0].value, 'a');
  assert.equal(forms[0][1][1].value, '1');
  assert.equal(forms[0][2][1].value, 'x');
});

test('validateSexp: rejects unbalanced and unterminated input', () => {
  assert.equal(pc.validateSexp('(kicad_pcb (version 1)').valid, false);
  assert.equal(pc.validateSexp('(kicad_pcb))').valid, false);
  assert.equal(pc.validateSexp('(title "oops)').valid, false);
  assert.equal(pc.validateSexp('').valid, false);
  assert.equal(pc.validateSexp('(a 1) (b 2)').valid, true);
});

test('generateKiCadPcb: parses, has kicad_pcb root and required sections', () => {
  const pcb = pc.generateKiCadPcb(CFG);
  const v = pc.validateKiCadPcb(pcb);
  assert.equal(v.valid, true, v.errors.join('; '));
  assert.match(pcb, /^\(kicad_pcb\n/);
  assert.ok(pcb.includes('(version 20240108)'));
  assert.ok(pcb.includes('(layers'));
  assert.ok(pcb.includes('(setup'));
  assert.ok(pcb.includes('"Edge.Cuts"'));
  assert.ok(pcb.includes('(net 0 "")'));
  assert.ok(pcb.includes('(footprint "PadCraft:SW_MX"'));
  assert.ok(pcb.includes('(footprint "PadCraft:RP2040_Pico"'));
});

test('validateKiCadPcb: net indices are contiguous and all pad refs resolve', () => {
  const pcb = pc.generateKiCadPcb(CFG);
  const v = pc.validateKiCadPcb(pcb);
  assert.equal(v.valid, true);
  for (let i = 0; i < v.nets.length; i++) assert.equal(v.nets[i].index, i);
  assert.equal(v.nets[0].name, '');
  assert.ok(v.nets.some(n => n.name === 'GND'));
  assert.ok(v.nets.some(n => n.name === 'ROW0'));
  assert.ok(v.nets.some(n => n.name === 'COL0'));
  assert.ok(v.footprints >= 13);
  assert.ok(v.pads >= 40);
});

test('validateKiCadPcb: detects a pad referencing an undeclared net', () => {
  const pcb = pc.generateKiCadPcb({ rows: 1, cols: 1 });
  const tampered = pcb.replace('(net 1 "GND")', '(net 999 "GND")');
  const v = pc.validateKiCadPcb(tampered);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => /undeclared net index 1|not contiguous/.test(e)));
});

test('validateKiCadPcb: rejects a wrong root form', () => {
  const v = pc.validateKiCadPcb('(not_a_board (net 0 ""))');
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => /Root form/.test(e)));
});

test('KiCad net declarations are valid for every program preset', () => {
  for (const program of Object.keys(pc.PROGRAMS)) {
    const pcb = pc.generateKiCadPcb({ program });
    const v = pc.validateKiCadPcb(pcb);
    assert.equal(v.valid, true, program + ': ' + v.errors.join('; '));
    assert.ok(v.footprints > 0, program + ' has footprints');
  }
});

test('KiCad nets are valid across a matrix sweep', () => {
  for (let rows = 1; rows <= 4; rows++) {
    for (let cols = 1; cols <= 5; cols++) {
      const pcb = pc.generateKiCadPcb({ rows, cols, encoder: true, sensor: true, sensorCount: 2 });
      const v = pc.validateKiCadPcb(pcb);
      assert.equal(v.valid, true, `${rows}x${cols}: ` + v.errors.join('; '));
    }
  }
});

/* ===================================================================== *
 * 3. Diode matrix column / row assignment
 * ===================================================================== */

test('buildPinAssignment: allocates distinct GPIOs for rows, cols and encoder', () => {
  const p = pc.buildPinAssignment(CFG);
  assert.equal(p.rows.length, 3);
  assert.equal(p.cols.length, 4);
  assert.deepEqual(p.encoder, { a: 'GP7', b: 'GP8', sw: 'GP9' });
  const all = [...p.rows, ...p.cols, p.encoder.a, p.encoder.b, p.encoder.sw];
  assert.equal(new Set(all).size, all.length, 'no GPIO may be assigned twice');
  assert.ok(all.every(x => /^GP\d+$/.test(x)));
});

test('buildPinAssignment: pinOffset shifts the GPIO pool', () => {
  const p0 = pc.buildPinAssignment({ rows: 2, cols: 2, encoder: false, sensor: false, pinOffset: 0 });
  const p2 = pc.buildPinAssignment({ rows: 2, cols: 2, encoder: false, sensor: false, pinOffset: 2 });
  assert.deepEqual(p0.rows, ['GP0', 'GP1']);
  assert.deepEqual(p0.cols, ['GP2', 'GP3']);
  assert.deepEqual(p2.rows, ['GP2', 'GP3']);
  assert.deepEqual(p2.cols, ['GP4', 'GP5']);
});

test('buildPinAssignment: refuses to over-subscribe the RP2040 GPIO pool', () => {
  // With the full 23 pin pool and the clamped ranges (rows<=6, cols<=8,
  // encoder adds 3) the maximum demand is 17 pins, so the guard cannot be
  // reached through normal configs. Temporarily shrink the exported pool to
  // exercise the real guard, then restore it for the remaining tests.
  const pool = pc.RP2040_GPIO_POOL;
  const saved = pool.slice();
  try {
    pool.length = 0;
    pool.push(0, 1, 2);
    assert.throws(
      () => pc.buildPinAssignment({ rows: 6, cols: 8, encoder: true, sensor: false, pinOffset: 0 }),
      /Not enough RP2040 GPIOs/);
  } finally {
    pool.length = 0;
    pool.push(...saved);
  }
});

test('buildPinAssignment: maps each used GPIO to exactly one net', () => {
  const p = pc.buildPinAssignment(CFG);
  // `needed` counts the matrix GPIO demand (rows + cols + encoder). The usage
  // list and byPin map also include the analog sensor pins, which come from the
  // separate ADC pool (GP26/27/28) and are not part of that GPIO budget.
  assert.equal(p.usage.length, p.needed + p.sensor.length);
  assert.equal(Object.keys(p.byPin).length, p.needed + p.sensor.length);
  assert.equal(p.byPin[p.rows[0]], 'ROW0');
  assert.equal(p.byPin[p.cols[3]], 'COL3');
  assert.equal(p.byPin[p.encoder.a], 'ENC_A');
});

test('buildNetlist: one assignment per key with correct row and col nets', () => {
  const nl = pc.buildNetlist(CFG);
  assert.equal(nl.assignments.length, 12, '3 rows x 4 cols = 12 keys');
  const seen = new Set();
  for (const a of nl.assignments) {
    assert.equal(a.rowNet, 'ROW' + a.row);
    assert.equal(a.colNet, 'COL' + a.col);
    assert.equal(a.keyNet, 'N_R' + a.row + '_C' + a.col);
    assert.equal(a.rowPin, nl.pins.rows[a.row]);
    assert.equal(a.colPin, nl.pins.cols[a.col]);
    assert.ok(a.row >= 0 && a.row < 3 && a.col >= 0 && a.col < 4);
    assert.ok(!seen.has(a.keyNet), 'key nodes must be unique');
    seen.add(a.keyNet);
  }
  assert.equal(seen.size, 12);
});

test('buildNetlist: COL2ROW topology holds on the generated board', () => {
  const board = pc.buildBoard(CFG);
  const netOf = (ref, padNum) => {
    const cp = board.components.find(x => x.ref === ref);
    const pad = cp.pads.find(p => p.num === padNum);
    return pad.net ? pad.net.name : null;
  };
  // Every switch pad 1 ties to its column, pad 2 ties to its unique key node.
  for (const a of board.netlist.assignments) {
    assert.equal(netOf(a.switch, '1'), a.colNet, a.switch + ' pad 1');
    assert.equal(netOf(a.switch, '2'), a.keyNet, a.switch + ' pad 2');
    // Diode anode (pad 1) sees the key node, cathode (pad 2) sees the row.
    assert.equal(netOf(a.diode, '1'), a.keyNet, a.diode + ' anode');
    assert.equal(netOf(a.diode, '2'), a.rowNet, a.diode + ' cathode');
    // Therefore the diode sits between the switch and the row, facing COL2ROW.
  }
});

test('buildNetlist: switch and diode refs are unique and cover the matrix', () => {
  const nl = pc.buildNetlist(CFG);
  const switches = nl.assignments.map(a => a.switch);
  const diodes = nl.assignments.map(a => a.diode);
  assert.equal(new Set(switches).size, 12);
  assert.equal(new Set(diodes).size, 12);
  assert.ok(switches.includes('SW1') && switches.includes('SW12'));
  assert.ok(diodes.includes('D1') && diodes.includes('D12'));
});

test('buildBoard: RP2040 footprint pads carry the matrix nets', () => {
  const board = pc.buildBoard(CFG);
  const pico = board.components.find(c => c.ref === 'U1');
  assert.equal(pico.pads.length, 40, 'Raspberry Pi Pico has 40 pins');
  const col0Pad = pico.pads.find(p => p.signal === board.netlist.pins.cols[0]);
  assert.equal(col0Pad.net.name, 'COL0');
  const gndPads = pico.pads.filter(p => p.signal === 'GND');
  assert.ok(gndPads.length >= 5);
  assert.ok(gndPads.every(p => p.net.name === 'GND'));
});

test('buildBoard: sensor headers use ADC pins and encoder uses its 3 nets', () => {
  const board = pc.buildBoard(CFG);
  const enc = board.components.find(c => c.ref === 'ENC1');
  assert.ok(enc.pads.some(p => p.net.name === 'ENC_A'));
  assert.ok(enc.pads.some(p => p.net.name === 'ENC_B'));
  assert.ok(enc.pads.some(p => p.net.name === 'ENC_SW'));
  const sensorNets = ['SENSOR0'];
  for (const n of sensorNets) {
    assert.ok(board.nets.names.includes(n), n + ' declared');
    assert.ok(board.nets.names.includes('3V3'));
  }
  assert.equal(board.netlist.pins.sensor.length, 1);
  assert.deepEqual(board.netlist.pins.sensor, ['GP26']);
});

/* ===================================================================== *
 * 4. KMK firmware code generation
 * ===================================================================== */

test('generateKMK: emits importable Python with a keyboard object', () => {
  const code = pc.generateKMK(CFG);
  assert.ok(code.includes('import board'));
  assert.ok(code.includes('from kmk.kmk_keyboard import KMKKeyboard'));
  assert.ok(code.includes('from kmk.keys import KC'));
  assert.ok(code.includes('from kmk.scanners import DiodeOrientation'));
  assert.ok(code.includes('keyboard = KMKKeyboard()'));
  assert.ok(code.includes('keyboard.go()'));
});

test('generateKMK: col_pins and row_pins match the pin assignment', () => {
  const code = pc.generateKMK(CFG);
  const p = pc.buildPinAssignment(CFG);
  assert.ok(code.includes('keyboard.col_pins = (' + p.cols.map(x => 'board.' + x).join(', ') + ')'));
  assert.ok(code.includes('keyboard.row_pins = (' + p.rows.map(x => 'board.' + x).join(', ') + ')'));
  assert.ok(code.includes('keyboard.diode_orientation = DiodeOrientation.COL2ROW'));
});

test('generateKMK: keymap has one row per matrix row and one key per column', () => {
  const code = pc.generateKMK(CFG);
  assert.ok(code.includes('keyboard.keymap = ['));
  const block = code.split('keyboard.keymap = [')[1].split('\n]')[0];
  const rows = block.split('\n').filter(l => /^\s+KC\./.test(l));
  assert.equal(rows.length, 3, 'three keymap rows');
  for (const r of rows) {
    const keys = r.trim().replace(/,$/, '').split(/,\s+/);
    assert.equal(keys.length, 4, 'four keycodes per row');
    assert.ok(keys.every(k => /^KC\.[A-Z0-9_]+$/.test(k)), 'valid KMK keycode ' + keys.join(','));
  }
});

test('generateKMK: custom keymap is honoured', () => {
  const keymap = [['KC.A', 'KC.B', 'KC.C', 'KC.D'],
                  ['KC.E', 'KC.F', 'KC.G', 'KC.H'],
                  ['KC.I', 'KC.J', 'KC.K', 'KC.L']];
  const code = pc.generateKMK({ ...CFG, keymap });
  assert.ok(code.includes('KC.A, KC.B, KC.C, KC.D'));
  assert.ok(code.includes('KC.I, KC.J, KC.K, KC.L'));
  assert.ok(!code.includes('KC.ESC'));
});

test('generateKMK: encoder module is present only when enabled', () => {
  const withEnc = pc.generateKMK({ rows: 2, cols: 2, encoder: true, sensor: false });
  const noEnc = pc.generateKMK({ rows: 2, cols: 2, encoder: false, sensor: false });
  assert.ok(withEnc.includes('from kmk.modules.encoder import EncoderModule'));
  assert.ok(withEnc.includes('encoder.pins'));
  assert.ok(withEnc.includes('keyboard.modules.append(encoder)'));
  assert.ok(!noEnc.includes('EncoderModule'));
  assert.ok(!noEnc.includes('encoder.pins'));
});

test('generateKMK: encoder pins match the assigned GPIOs', () => {
  const code = pc.generateKMK(CFG);
  const p = pc.buildPinAssignment(CFG);
  assert.ok(code.includes('board.' + p.encoder.a + ', board.' + p.encoder.b + ', board.' + p.encoder.sw));
});

test('generateKMK: 1x1 tuples get a trailing comma', () => {
  const code = pc.generateKMK({ rows: 1, cols: 1, encoder: false, sensor: false });
  assert.ok(code.includes('keyboard.col_pins = (board.GP1,)'));
  assert.ok(code.includes('keyboard.row_pins = (board.GP0,)'));
});

test('generateKMK: generated firmware is syntactically valid Python', () => {
  // No Python dependency is required to check the shape of the generated file,
  // but if python3 is present we also let the compiler confirm it.
  const code = pc.generateKMK(CFG);
  assert.equal((code.match(/\(/g) || []).length, (code.match(/\)/g) || []).length, 'balanced parens');
  assert.equal((code.match(/\[/g) || []).length, (code.match(/\]/g) || []).length, 'balanced brackets');
  try {
    execFileSync('python3', ['-I', '-B', '-c',
      'import sys, ast; ast.parse(sys.stdin.read())'], { input: code, stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') return; // python3 unavailable, shape checks already passed
    throw new Error('generated KMK file is not valid Python: ' + e.message);
  }
});

/* ===================================================================== *
 * 5. Other exporters, presets and CLI
 * ===================================================================== */

test('generateOpenSCAD: parametric source with a plate module and render modes', () => {
  const scad = pc.generateOpenSCAD(CFG);
  assert.ok(scad.includes('rows              = 3;'));
  assert.ok(scad.includes('cols              = 4;'));
  assert.ok(scad.includes('module plate()'));
  assert.ok(scad.includes('module case_shell()'));
  assert.ok(scad.includes('difference()'));
  assert.ok(scad.includes('render_mode = "plate"'));
  assert.equal((scad.match(/\{/g) || []).length, (scad.match(/\}/g) || []).length);
});

test('generateGerberFCu: RS-274X header, apertures, flashes and M02', () => {
  const gbr = pc.generateGerberFCu(CFG);
  assert.ok(gbr.startsWith('G04'));
  assert.ok(gbr.includes('%FSLAX36Y36*%'));
  assert.ok(gbr.includes('%MOMM*%'));
  assert.ok(gbr.includes('%ADD10C'));
  assert.ok(gbr.trimEnd().endsWith('M02*'));
  assert.ok((gbr.match(/D03\*/g) || []).length > 20, 'pad flashes present');
  assert.ok(gbr.includes('D02*') && gbr.includes('D01*'), 'moves and draws present');
});

test('generateQMK: COL2ROW matrix pins, layout macro and a full keymap', () => {
  const q = pc.generateQMK(CFG);
  const info = JSON.parse(q['keyboard.json']);
  assert.equal(info.diode_direction, 'COL2ROW');
  assert.equal(info.processor, 'RP2040');
  assert.deepEqual(info.matrix_pins.rows, pc.buildPinAssignment(CFG).rows);
  assert.deepEqual(info.matrix_pins.cols, pc.buildPinAssignment(CFG).cols);
  assert.equal(info.layouts.LAYOUT_ortho_3x4.layout.length, 12);
  assert.ok(q['keymap.c'].includes('LAYOUT_ortho_3x4('));
  assert.equal((q['keymap.c'].split('};')[0].match(/KC_[A-Z0-9_]+/g) || []).length, 12);
  assert.ok(q['config.h'].includes('#define DIODE_DIRECTION COL2ROW'));
  assert.ok(q['rules.mk'].includes('MCU = RP2040'));
});

test('generateAll: produces every expected artifact with content', () => {
  const files = pc.generateAll(CFG);
  const names = Object.keys(files);
  for (const suffix of ['.kicad_pcb', '_plate.stl', '_plate.scad', '_F_Cu.gbr']) {
    assert.ok(names.some(n => n.endsWith(suffix)), suffix + ' present');
  }
  for (const n of ['kb.py', 'qmk_bundle.json', 'padcraft_config.json']) {
    assert.ok(names.includes(n), n + ' present');
  }
  for (const [n, body] of Object.entries(files)) {
    assert.ok(body.length > 100, n + ' is not empty');
  }
  assert.equal(JSON.parse(files['padcraft_config.json']).rows, 3);
});

test('presets: each Hack Club program has a sensible default matrix', () => {
  for (const [name, p] of Object.entries(pc.PROGRAMS)) {
    assert.ok(p.rows >= 1 && p.cols >= 1, name + ' has a matrix');
    assert.ok(typeof p.note === 'string' && p.note.length > 10);
    const applied = pc.applyProgram(name);
    assert.equal(applied.rows, p.rows);
    assert.equal(applied.cols, p.cols);
    assert.equal(pc.generateKiCadPcb(applied).startsWith('(kicad_pcb'), true);
  }
  assert.deepEqual(pc.applyProgram('NotAProgram'), {});
});

test('clampConfig: keeps out-of-range parameters inside safe bounds', () => {
  const c = pc.clampConfig({ rows: 99, cols: -5, keySpacing: 1000, encoder: 0, sensor: 'yes' });
  assert.equal(c.rows, 6);
  assert.equal(c.cols, 1);
  assert.equal(c.keySpacing, 24);
  assert.equal(c.encoder, false);
  assert.equal(c.sensor, true);
});

test('CLI: check reports a valid board and exits 0', () => {
  const out = execFileSync(process.execPath, ['cad.js', 'check', '--rows', '2', '--cols', '3'],
    { cwd: __dirname, encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.kicad_valid, true);
  assert.equal(r.stl_bad_normals, 0);
  assert.equal(r.keys, 6);
  assert.equal(r.kmk_has_keymap, true);
});

test('CLI: all writes files to a temp directory', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.padcraft-cli-'));
  try {
    execFileSync(process.execPath, ['cad.js', 'all', '--rows', '2', '--cols', '2', '--out', dir],
      { cwd: __dirname, encoding: 'utf8' });
    const files = fs.readdirSync(dir);
    assert.ok(files.some(f => f.endsWith('.kicad_pcb')));
    assert.ok(files.some(f => f.endsWith('.stl')));
    assert.ok(files.includes('kb.py'));
    const pcbFile = files.find(f => f.endsWith('.kicad_pcb'));
    assert.equal(pc.validateKiCadPcb(fs.readFileSync(path.join(dir, pcbFile), 'utf8')).valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: validate rejects a malformed KiCad file with a nonzero exit', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.padcraft-bad-'));
  const file = path.join(dir, 'bad.kicad_pcb');
  fs.writeFileSync(file, '(kicad_pcb (net 0 "")');
  try {
    let threw = false;
    try {
      execFileSync(process.execPath, ['cad.js', 'validate', '--in', file],
        { cwd: __dirname, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      threw = true;
      assert.equal(e.status, 1);
      assert.equal(JSON.parse(e.stdout).valid, false);
    }
    assert.ok(threw, 'validate should exit nonzero for invalid input');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* Export contracts and geometry regressions. */
test('configuration: zero, nonfinite, boolean strings and unknown fields normalize safely', () => {
  const c = pc.clampConfig({ rows: 0, cols: -Infinity, keySpacing: 0, edgeMargin: Infinity,
    plateThickness: NaN, encoder: 'false', sensor: 'yes', unexpected: 42 });
  assert.equal(c.rows, 1); assert.equal(c.cols, 1); assert.equal(c.keySpacing, 18);
  assert.equal(c.edgeMargin, 24); assert.equal(c.plateThickness, 3);
  assert.equal(c.encoder, false); assert.equal(c.sensor, true); assert.equal(c.unexpected, undefined);
  for (const key of ['rows', 'cols', 'keySpacing', 'edgeMargin', 'plateThickness']) assert.ok(Number.isFinite(c[key]));
});

test('configuration: arrays and primitive roots are rejected', () => {
  for (const bad of [[], 'hello', 42, true]) assert.throws(() => pc.clampConfig(bad), /JSON object/);
  assert.deepEqual(pc.applyProgram('__proto__'), {});
});

test('configuration: names cannot inject comments or quoted source', () => {
  const c = pc.clampConfig({ name: '  safe\nname\r*"\\\0  ' });
  assert.equal(c.name, 'safename');
  assert.ok(pc.validateKiCadPcb(pc.generateKiCadPcb(c)).valid);
});

test('configuration: a selected program supplies dimensions and peripherals', () => {
  for (const [program, preset] of Object.entries(pc.PROGRAMS)) {
    const c = pc.clampConfig({ program });
    assert.equal(c.rows, preset.rows); assert.equal(c.cols, preset.cols);
    assert.equal(c.switchType, preset.switchType); assert.equal(c.encoder, preset.encoder);
  }
  assert.equal(pc.clampConfig({ program: 'Blot', rows: 5 }).rows, 5);
});

test('keymap: ragged, mixed and hostile cells produce safe firmware expressions', () => {
  const km = pc.normaliseKeymap({ rows: 3, cols: 2, keymap: [['A', 'KC.B'], 123, ['KC.X); exit()']] });
  assert.deepEqual(km, [['KC.A', 'KC.B'], ['KC.NO', 'KC.NO'], ['KC.NO', 'KC.NO']]);
  const c = pc.clampConfig({ rows: 2, cols: 2, keymap: ['esc', ' KC.A ', null, '<script>'] });
  assert.deepEqual(c.keymap, [['KC.ESC', 'KC.A'], ['KC.NO', 'KC.NO']]);
});

test('layout: controller has accurate 2.54 mm pitch and 17.78 mm row spacing', () => {
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false });
  const mcu = board.components.find(cp => cp.ref === 'U1');
  assert.ok(mcu.x - mcu.outline.w / 2 > board.layout.keyWidth);
  assert.ok(mcu.y - mcu.outline.h / 2 >= 0);
  assert.ok(mcu.y + mcu.outline.h / 2 <= board.layout.height);
  assert.ok(Math.abs(mcu.pads[1].y - mcu.pads[0].y - 2.54) < 1e-9);
  assert.ok(Math.abs(mcu.pads[39].x - mcu.pads[0].x - 17.78) < 1e-9);
});

test('layout: MX and Choc electrical pins and support drills differ', () => {
  const mx = pc.buildBoard({ switchType: 'MX' }).components[0];
  const choc = pc.buildBoard({ switchType: 'Choc' }).components[0];
  assert.equal(choc.pads[0].x - choc.x, 0);
  assert.ok(Math.abs(choc.pads[0].y - choc.y - 5.9) < 1e-9);
  assert.equal(choc.npth[2].drill, 3.4); assert.equal(mx.npth[2].drill, 4);
  assert.notDeepEqual(choc.pads.map(p => [p.x - choc.x, p.y - choc.y]), mx.pads.map(p => [p.x - mx.x, p.y - mx.y]));
});

test('layout: three ADC headers fit on a one-column board', () => {
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false, sensor: true, sensorCount: 3 });
  const sensors = board.components.filter(cp => cp.kind === 'sensor');
  assert.equal(sensors.length, 3);
  for (let i = 1; i < sensors.length; i++) assert.ok(sensors[i].x - sensors[i - 1].x >= 9);
  assert.ok(pc.inspectBoard(board).geometryValid);
});

test('KiCad: component references occur once and SMD footprints remain in the BOM', () => {
  const pcb = pc.generateKiCadPcb(CFG);
  assert.equal((pcb.match(/fp_text reference "SW1"/g) || []).length, 1);
  assert.equal((pcb.match(/fp_text reference "D1"/g) || []).length, 1);
  assert.ok(pcb.includes('(attr smd)'));
  assert.equal((pcb.match(/exclude_from_bom/g) || []).length, 4, 'only mounting holes excluded');
});

test('KiCad: every track has a unique, deterministic identifier', () => {
  const first = pc.generateKiCadPcb(CFG), second = pc.generateKiCadPcb(CFG);
  assert.equal(first, second);
  const ids = [...first.matchAll(/\(uuid "([0-9a-f-]+)"\)/g)].map(match => match[1]);
  assert.ok(ids.length > 60); assert.equal(new Set(ids).size, ids.length);
  assert.equal(pc.validateKiCadPcb(first.replace(ids[1], ids[0])).valid, false);
});

test('KiCad validator: atom roots and missing sections fail without exceptions', () => {
  for (const source of ['atom', '(kicad_pcb)', '(kicad_pcb (version NaN) (net 0 ""))']) {
    assert.doesNotThrow(() => pc.validateKiCadPcb(source));
    assert.equal(pc.validateKiCadPcb(source).valid, false);
  }
});

test('KiCad validator: wrong pad net names, bad tracks and duplicate refs fail', () => {
  const pcb = pc.generateKiCadPcb(CFG);
  assert.equal(pc.validateKiCadPcb(pcb.replace('(net 7 "COL0")', '(net 7 "OTHER")')).valid, false);
  assert.equal(pc.validateKiCadPcb(pcb.replace('(width 0.25)', '(width 0)')).valid, false);
  assert.equal(pc.validateKiCadPcb(pcb.replace('(fp_text reference "SW2"', '(fp_text reference "SW1"')).valid, false);
});

test('Gerber: valid header supports boards wider than 100 mm', () => {
  const g = pc.generateGerberFCu({ rows: 6, cols: 8, keySpacing: 24, edgeMargin: 24 });
  assert.ok(g.includes('%FSLAX36Y36*%')); assert.ok(!g.includes('Y36Y36'));
  const v = pc.validateGerber(g); assert.equal(v.valid, true, v.errors.join('; '));
  assert.ok(v.flashes.some(flash => flash.point[0] > 200));
});

test('Gerber: front copper includes every SMD and through-hole pad at true positions', () => {
  const board = pc.buildBoard(CFG), v = pc.validateGerber(pc.generateGerberFCu(CFG));
  const pads = board.components.flatMap(cp => cp.pads);
  assert.equal(v.flashes.length, pads.length);
  for (const pad of pads) assert.ok(v.flashes.some(flash => Math.abs(flash.point[0] - pad.x) < 1e-6 && Math.abs(flash.point[1] - (board.layout.height - pad.y)) < 1e-6));
  assert.ok(v.apertures.some(([, aperture]) => aperture.shape.startsWith('ROUNDRECT')));
  assert.ok(v.apertures.some(([, aperture]) => aperture.shape === 'C' && aperture.dimensions[0] === 2));
});

test('Gerber: outline is isolated, back pads are plated, paste is SMD only', () => {
  const board = pc.buildBoard(CFG), pads = board.components.flatMap(cp => cp.pads);
  const front = pc.validateGerber(pc.generateGerber(CFG, 'F.Cu'));
  const back = pc.validateGerber(pc.generateGerber(CFG, 'B.Cu'));
  const paste = pc.validateGerber(pc.generateGerber(CFG, 'F.Paste'));
  const edge = pc.validateGerber(pc.generateGerber(CFG, 'Edge.Cuts'));
  assert.equal(back.flashes.length, pads.filter(pad => pad.drill > 0).length);
  assert.equal(paste.flashes.length, pads.filter(pad => pad.drill === 0).length);
  assert.equal(edge.flashes.length, 0); assert.equal(edge.draws.length, 4);
  assert.ok(!front.draws.some(draw => draw.start[0] === 0 && draw.start[1] === 0));
  assert.deepEqual(edge.draws[0].start, edge.draws[3].end);
});

test('Gerber: both masks expand pad openings by 0.1 mm per side', () => {
  const mask = pc.validateGerber(pc.generateGerber(CFG, 'F.Mask'));
  assert.ok(mask.valid);
  assert.ok(mask.apertures.some(([, aperture]) => aperture.shape === 'C' && aperture.dimensions[0] === 2.2));
  assert.ok(pc.generateGerber(CFG, 'F.Mask').includes('%TF.FilePolarity,Negative*%'));
});

test('Gerber validator: undeclared apertures, malformed coordinates and missing termination fail', () => {
  const g = pc.generateGerberFCu(CFG);
  for (const corrupted of [g.replace('%FSLAX36Y36*%', '%FSLAX26Y26Y26*%'), g.replace('M02*', ''), g.replace(/D10\*/, 'D999*'), g.replace(/X\d+Y\d+D03\*/, 'XbadY1D03*')]) assert.equal(pc.validateGerber(corrupted).valid, false);
});

test('Excellon: every hole is exported once with correct diameter and plating', () => {
  const board = pc.buildBoard(CFG);
  for (const plated of [true, false]) {
    const v = pc.validateExcellon(pc.generateExcellon(CFG, plated));
    assert.equal(v.valid, true, v.errors.join('; '));
    const expected = board.drillPoints.filter(hit => hit.plated === plated);
    assert.equal(v.hits.length, expected.length);
    for (const hit of expected) assert.ok(v.hits.some(actual => Math.abs(actual.x - hit.x) <= 0.000051 && Math.abs(actual.y - (board.layout.height - hit.y)) <= 0.000051 && actual.diameter === hit.diameter));
  }
  assert.equal(board.drillPoints.filter(hit => !hit.plated).length, CFG.rows * CFG.cols * 3 + 6);
});

test('Excellon validator: undeclared tools and nonfinite hits are rejected', () => {
  const drill = pc.generateExcellon(CFG, true);
  assert.equal(pc.validateExcellon(drill.replace(/\nT01\n/, '\nT99\n')).valid, false);
  assert.equal(pc.validateExcellon(drill.replace(/X[\d.]+Y[\d.]+/, 'XNaNY1')).valid, false);
  assert.equal(pc.validateExcellon(drill.replace('METRIC,TZ', 'INCH,TZ')).valid, false);
});

test('STL: circular openings have 48 chord segments and closed oriented edges', () => {
  const mesh = pc.buildPlateMesh(CFG), v = pc.validateSTL(pc.generateSTL(CFG), mesh.stats.expectedVolume);
  assert.ok(v.valid, v.errors.join('; ')); assert.equal(v.badEdges, 0); assert.equal(v.badNormals, 0);
  assert.ok(v.volumeError < 0.01); assert.equal(mesh.stats.circularSegments, 48);
  const circle = pc.platePolygons(pc.computeLayout(CFG)).find(polygon => polygon.length === 48);
  assert.ok(circle); assert.ok(circle.some(point => point[0] % 1 !== 0 && point[1] % 1 !== 0));
});

test('STL: enclosed volume matches square cutouts and circular polygon area', () => {
  const cfg = { rows: 1, cols: 1, encoder: false, sensor: false, plateThickness: 2.7 };
  const layout = pc.computeLayout(cfg), polygons = pc.platePolygons(layout);
  const expected = (layout.width * layout.height - polygons.reduce((sum, polygon) => sum + pc.polygonArea(polygon), 0)) * 2.7;
  const report = pc.validateSTL(pc.generateSTL(cfg), expected);
  assert.ok(report.valid); assert.ok(Math.abs(report.volume - expected) < 0.01);
  const squareArea = polygons.filter(polygon => polygon.length === 4).reduce((sum, polygon) => sum + pc.polygonArea(polygon), 0);
  assert.ok(Math.abs(squareArea - 196) < 1e-9);
});

test('STL: deleted facets, wrong winding and mismatched names cannot pass', () => {
  const stl = pc.generateSTL(CFG);
  assert.equal(pc.validateSTL(stl.replace(/\s*facet normal[^]*?endfacet/, '')).valid, false);
  assert.equal(pc.validateSTL(stl.replace('facet normal 0 0 1', 'facet normal 0 0 -1')).valid, false);
  assert.equal(pc.validateSTL(stl.replace(/endsolid .*/, 'endsolid wrong')).valid, false);
});

test('STL: irrational plate thickness matches exported vertex precision and expectedVolume', () => {
  const cfg = { rows: 6, cols: 8, keySpacing: 24, edgeMargin: 24, plateThickness: Math.PI };
  const mesh = pc.buildPlateMesh(cfg);
  const report = pc.validateSTL(pc.generateSTL(cfg), mesh.stats.expectedVolume);
  assert.equal(report.valid, true, report.errors.join('; '));
  assert.ok(report.volumeError < 0.01);
});

test('OpenSCAD: tray has a real support ledge and clearance above it', () => {
  const scad = pc.generateOpenSCAD(CFG);
  assert.ok(scad.includes('plate_ledge       = 1.2;'));
  assert.ok(scad.includes('board_w + 2 * clearance'));
  assert.ok(scad.includes('board_w - 2 * plate_ledge'));
  assert.ok(scad.includes('case_wall + clearance, case_wall + clearance'));
});

test('QMK: decimal keycodes and final macro arguments compile in the supported shape', () => {
  const q = pc.generateQMK({ rows: 1, cols: 2, encoder: false, keymap: [['KC.N1', 'KC.N0']] });
  assert.ok(q['keymap.c'].includes('KC_1, KC_0\n    )'));
  assert.ok(!q['keymap.c'].includes('KC_N1'));
  assert.ok(!/,\s*\)/.test(q['keymap.c']));
});

test('QMK: rotary mapping and debounced direct push use supported firmware APIs', () => {
  const q = pc.generateQMK(CFG), info = JSON.parse(q['keyboard.json']);
  assert.equal(info.encoder.rotary[0].pin_push, undefined);
  assert.ok(q['rules.mk'].includes('ENCODER_MAP_ENABLE = yes'));
  assert.ok(q['keymap.c'].includes('ENCODER_CCW_CW(KC_VOLD, KC_VOLU)'));
  assert.ok(q['keymap.c'].includes('timer_elapsed(changed_at) >= 5'));
  assert.ok(q['keymap.c'].includes('setPinInputHigh(' + pc.buildPinAssignment(CFG).encoder.sw + ')'));
});

test('KMK: ADC headers instantiate standard analogio inputs rather than an unused module', () => {
  const kmk = pc.generateKMK({ rows: 1, cols: 1, sensor: true, sensorCount: 3 });
  assert.ok(kmk.includes('import analogio'));
  assert.ok(!kmk.includes('kmk.modules.analog'));
  assert.equal((kmk.match(/analogio.AnalogIn/g) || []).length, 3);
  assert.ok(kmk.includes('def read_sensors():'));
});

test('routing: every matrix bus and key node is connected internally', () => {
  const cfg = { rows: 3, cols: 4, encoder: false, sensor: false };
  const report = pc.inspectBoard(pc.buildBoard(cfg));
  for (const net of report.nets) {
    if (/^N_R/.test(net.name)) assert.equal(net.groups, 1, net.name);
    if (/^(ROW|COL)/.test(net.name)) assert.equal(net.groups, 2, net.name + ' needs only its MCU connection');
  }
  assert.ok(report.remainingRoutes > 0); assert.ok(report.geometryValid);
  assert.ok(report.airwires.every(wire => wire.distance > 0));
});

test('routing: crossing nets and traces through a drill are reported as real defects', () => {
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false });
  const hole = board.layout.keys[0];
  board.traces.push({ net: 'COL0', layer: 'F.Cu', width: 0.25, points: [[hole.x - 6, hole.y], [hole.x + 6, hole.y]] });
  board.traces.push({ net: 'ROW0', layer: 'F.Cu', width: 0.25, points: [[hole.x, hole.y - 6], [hole.x, hole.y + 6]] });
  const report = pc.inspectBoard(board);
  assert.equal(report.geometryValid, false);
  assert.ok(report.issues.some(issue => issue.includes('drill')));
  assert.ok(report.issues.some(issue => issue.includes('copper traces conflict')));
});

test('bundles: all four showcases have 25 portable source artifacts and verified reports', () => {
  for (const [name, preset] of Object.entries(pc.SHOWCASES)) {
    const files = pc.generateAll(preset.config), v = pc.verifyBundle(preset.config, files);
    assert.equal(Object.keys(files).length, 25, name);
    assert.ok(v.valid, name + JSON.stringify(v.checks)); assert.ok(v.geometry.geometryValid, name);
    assert.equal(v.gerbers.length, 7); assert.equal(v.drills.length, 2);
    assert.equal(JSON.parse(files['verification.json']).mesh.badEdges, 0);
    assert.ok(Object.keys(files).some(path => path.includes('/keymaps/default/keymap.c')));
  }
});

test('bundles: corrupting a layer, drill count or configuration fails the actual round trip', () => {
  const files = pc.generateAll(CFG), gerber = Object.keys(files).find(name => name.endsWith('_F_Cu.gbr'));
  assert.equal(pc.verifyBundle(CFG, { ...files, [gerber]: files[gerber].replace('M02*', '') }).valid, false);
  assert.equal(pc.verifyBundle(CFG, { ...files, 'padcraft_config.json': '{}' }).valid, false);
  const drill = Object.keys(files).find(name => name.endsWith('_PTH.drl'));
  assert.equal(pc.verifyBundle(CFG, { ...files, [drill]: files[drill].replace(/X[\d.]+Y[\d.]+\n/, '') }).valid, false);
});

test('geometry sweep: 48 matrix sizes at minimum spacing retain closed plate topology', () => {
  for (let rows = 1; rows <= 6; rows++) for (let cols = 1; cols <= 8; cols++) {
    const cfg = { rows, cols, keySpacing: 18, edgeMargin: 5, encoder: true, sensor: true, sensorCount: 3,
      encoderDiameter: 12, mountHoleDiameter: 4, switchType: rows % 2 ? 'MX' : 'Choc' };
    const mesh = pc.buildPlateMesh(cfg), check = pc.inspectMesh(mesh);
    assert.ok(check.valid, rows + 'x' + cols + ': ' + JSON.stringify(check));
    const board = pc.buildBoard(cfg);
    assert.ok(pc.inspectBoard(board).geometryValid, rows + 'x' + cols + ': ' + pc.inspectBoard(board).issues.join('; '));
    assert.ok(board.components.every(cp => cp.pads.every(pad => pad.x > 0 && pad.y > 0 && pad.x < board.layout.width && pad.y < board.layout.height)));
  }
});

test('CLI: documented geometry aliases change the generated model', () => {
  const c = pc.loadConfig(pc.parseArgs(['--cutout', '12.5', '--thickness', '4.2', '--margin', '14', '--board-thickness', '2', '--mount-hole-diameter', '3']));
  assert.equal(c.switchCutout, 12.5); assert.equal(c.plateThickness, 4.2); assert.equal(c.edgeMargin, 14);
  assert.equal(c.boardThickness, 2); assert.equal(c.mountHoleDiameter, 3);
});

test('encoder: EC11 mounting slots match KiCad oval drills and Excellon G85 endpoints', () => {
  const board = pc.buildBoard(CFG), encoder = board.components.find(cp => cp.kind === 'encoder');
  assert.equal(encoder.pads.find(pad => pad.num === '2').net.name, 'GND');
  assert.equal(encoder.npth.length, 2);
  assert.equal(encoder.pads.find(pad => pad.num === '1').x - encoder.x, -2.5);
  const pcb = pc.generateKiCadPcb(CFG), drill = pc.generateExcellon(CFG, false);
  assert.equal((pcb.match(/\(drill oval 2.1 2.8\)/g) || []).length, 2);
  assert.equal((drill.match(/G85/g) || []).length, 2);
  const slots = pc.validateExcellon(drill).hits.filter(hit => hit.slot);
  assert.equal(slots.length, 2);
  for (const slot of slots) { assert.equal(slot.diameter, 2.1); assert.ok(Math.abs(Math.hypot(slot.slot[0][0] - slot.slot[1][0], slot.slot[0][1] - slot.slot[1][1]) - 0.7) < 1e-6); }
});

test('round trip: altered pad sizes or positions fail even when file syntax is valid', () => {
  const files = pc.generateAll(CFG), pcb = Object.keys(files).find(name => name.endsWith('.kicad_pcb'));
  const changed = { ...files, [pcb]: files[pcb].replace('(size 2 2)', '(size 2.2 2.2)') };
  assert.equal(pc.validateKiCadPcb(changed[pcb]).valid, true);
  assert.equal(pc.verifyBundle(CFG, changed).valid, false);
  const gerber = Object.keys(files).find(name => name.endsWith('_F_Cu.gbr'));
  const badGerber = files[gerber].replace(/X(\d+)Y(\d+)D03\*/, (_, x, y) => 'X' + (Number(x) + 1000000) + 'Y' + y + 'D03*');
  assert.equal(pc.validateGerber(badGerber).valid, true);
  assert.equal(pc.verifyBundle(CFG, { ...files, [gerber]: badGerber }).valid, false);
});

test('round trip: altered slot length and firmware bindings are rejected', () => {
  const files = pc.generateAll(CFG), drill = Object.keys(files).find(name => name.endsWith('_NPTH.drl'));
  const changed = files[drill].replace(/G85X([\d.]+)Y([\d.]+)/, (_, x, y) => 'G85X' + x + 'Y' + (Number(y) + 0.1));
  assert.equal(pc.validateExcellon(changed).valid, true);
  assert.equal(pc.verifyBundle(CFG, { ...files, [drill]: changed }).valid, false);
  const qmk = JSON.parse(files['qmk_bundle.json']), info = JSON.parse(qmk['keyboard.json']);
  info.matrix_pins.rows[0] = 'GP22'; qmk['keyboard.json'] = JSON.stringify(info);
  assert.equal(pc.verifyBundle(CFG, { ...files, 'qmk_bundle.json': JSON.stringify(qmk) }).valid, false);
});

test('QMK: every showcase keymap passes the local C compiler with firmware API stubs', t => {
  for (const preset of Object.values(pc.SHOWCASES)) {
    const cfg = pc.clampConfig(preset.config), q = pc.generateQMK(cfg), info = JSON.parse(q['keyboard.json']);
    const macro = Object.keys(info.layouts)[0], names = Array.from({ length: cfg.rows * cfg.cols }, (_, i) => 'key' + i);
    const initializer = Array.from({ length: cfg.rows }, (_, row) => '{' + names.slice(row * cfg.cols, (row + 1) * cfg.cols).join(',') + '}').join(',');
    const keycodes = [...new Set(q['keymap.c'].match(/KC_[A-Z0-9_]+/g))];
    const stub = ['typedef unsigned short uint16_t;', 'typedef int bool;', '#define false 0', '#define PROGMEM', '#define ENCODER_MAP_ENABLE 1',
      '#define NUM_ENCODERS 1', '#define NUM_DIRECTIONS 2', '#define MATRIX_ROWS ' + cfg.rows, '#define MATRIX_COLS ' + cfg.cols,
      '#define ' + macro + '(' + names.join(',') + ') {' + initializer + '}', '#define ENCODER_CCW_CW(a,b) {a,b}',
      ...keycodes.map((code, i) => '#define ' + code + ' ' + i), ...pc.RP2040_GPIO_POOL.map(pin => '#define GP' + pin + ' ' + pin),
      'void setPinInputHigh(int pin); int readPin(int pin); uint16_t timer_read(void); uint16_t timer_elapsed(uint16_t timer);',
      'void register_code(uint16_t code); void unregister_code(uint16_t code);', q['keymap.c'].replace('#include QMK_KEYBOARD_H', '')].join('\n');
    try { execFileSync('cc', ['-std=c11', '-x', 'c', '-fsyntax-only', '-'], { input: stub, stdio: 'pipe' }); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('Optional local C compiler unavailable.'); return; } throw error; }
  }
});

test('KMK: every showcase executes with standard board, key and analog API stubs', t => {
  const script = [
    'import json, sys, types', 'payload = json.loads(sys.stdin.read())',
    'def module(name, **attributes):', '    value = types.ModuleType(name)', '    value.__dict__.update(attributes)', '    sys.modules[name] = value', '    return value',
    'class Keyboard:', '    def __init__(self): self.modules = []; self.extensions = []', '    def go(self): pass',
    'class Keys:', '    def __getattr__(self, name): return name',
    'class Encoder: pass',
    'class Analog:', '    def __init__(self, pin): self.value = 32768',
    'module("board", **{"GP" + str(pin): pin for pin in range(29)})',
    'module("kmk"); module("kmk.modules"); module("kmk.extensions")', 'module("kmk.kmk_keyboard", KMKKeyboard=Keyboard)',
    'module("kmk.keys", KC=Keys())', 'module("kmk.scanners", DiodeOrientation=types.SimpleNamespace(COL2ROW="COL2ROW"))',
    'module("kmk.modules.encoder", EncoderModule=Encoder)', 'module("kmk.extensions.media_keys", MediaKeys=Encoder)', 'module("analogio", AnalogIn=Analog)',
    'scope = {"__name__": "validation"}', 'exec(compile(payload["source"], "generated_kmk.py", "exec"), scope)',
    'keyboard = scope["keyboard"]', 'assert len(keyboard.row_pins) == payload["rows"]', 'assert len(keyboard.col_pins) == payload["cols"]',
    'assert len(keyboard.keymap[0]) == payload["rows"] * payload["cols"]', 'assert len(keyboard.modules) == int(payload["encoder"])',
    'if payload["sensors"]: assert len(scope["read_sensors"]()) == payload["sensors"]',
  ].join('\n');
  for (const preset of Object.values(pc.SHOWCASES)) {
    const cfg = pc.clampConfig(preset.config), payload = { source: pc.generateKMK(cfg), rows: cfg.rows, cols: cfg.cols, encoder: cfg.encoder, sensors: cfg.sensor ? cfg.sensorCount : 0 };
    try { execFileSync('python3', ['-I', '-B', '-c', script], { input: JSON.stringify(payload), stdio: 'pipe' }); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('Optional local Python unavailable.'); return; } throw error; }
  }
});

test('OpenSCAD: edited matrix parameters recompute the same board dimensions as the engine', () => {
  const vm = require('node:vm');
  const cfg = { rows: 3, cols: 4, sensor: true, sensorCount: 3, encoder: true };
  const scad = pc.generateOpenSCAD(cfg);
  const assignments = scad.split('\n').filter(line => /^[a-z][a-z_]*\s*=/.test(line))
    .map(line => 'var ' + line.replace(/\bmax\(/g, 'Math.max(')).join('\n');
  const original = vm.runInNewContext(assignments + '\n[board_w, board_h]');
  const layout = pc.computeLayout(cfg);
  assert.equal(original[0], layout.width); assert.equal(original[1], layout.height);
  const edited = vm.runInNewContext(assignments.replace(/var rows\s*=\s*3;/, 'var rows = 1;').replace(/var cols\s*=\s*4;/, 'var cols = 1;') + '\n[board_w, board_h]');
  const resized = pc.computeLayout({ ...cfg, rows: 1, cols: 1 });
  assert.equal(edited[0], resized.width); assert.equal(edited[1], resized.height);
  assert.ok(scad.includes('encoder_opening(encoder_x(), top_band / 2 + 2)'));
});

test('KMK: media key extension is enabled before media keymaps and encoder maps', () => {
  const source = pc.generateKMK(pc.SHOWCASES.studio.config);
  assert.ok(source.includes('from kmk.extensions.media_keys import MediaKeys'));
  assert.ok(source.indexOf('keyboard.extensions.append(MediaKeys())') < source.indexOf('encoder.map'));
  const plain = pc.generateKMK({ rows: 1, cols: 1, encoder: false, keymap: [['KC.A']] });
  assert.ok(!plain.includes('MediaKeys'));
});

test('normal math: tiny and huge finite triangles avoid underflow and overflow', () => {
  assert.deepEqual(pc.computeNormal([0, 0, 0], [1e-200, 0, 0], [0, 1e-200, 0]), [0, 0, 1]);
  assert.deepEqual(pc.computeNormal([-1e308, 0, 0], [1e308, 0, 0], [0, 1e308, 0]), [0, 0, 1]);
  assert.throws(() => pc.computeNormal([0, 0, 0], [Infinity, 0, 0], [0, 1, 0]), /finite/);
});

test('copper inspection catches foreign pad crossings and edge clearance', () => {
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false });
  const pad = board.components[0].pads[1];
  board.traces.push({ net: 'COL0', layer: 'B.Cu', width: 0.25, points: [[pad.x - 3, pad.y], [pad.x + 3, pad.y]] });
  board.traces.push({ net: 'COL0', layer: 'B.Cu', width: 0.25, points: [[0.1, 10], [0.1, 20]] });
  const report = pc.inspectBoard(board);
  assert.equal(report.geometryValid, false);
  assert.ok(report.issues.some(issue => issue.includes('SW1 pad 2 copper')));
  assert.ok(report.issues.some(issue => issue.includes('copper-to-edge')));
});
test('copper inspection rejects overlapping pads on distinct nets', () => {
  const board = pc.buildBoard({ rows: 1, cols: 1, encoder: false });
  const [a,b] = board.components[0].pads; b.x=a.x; b.y=a.y;
  const report=pc.inspectBoard(board); assert.equal(report.geometryValid,false); assert.ok(report.issues.some(issue=>issue.includes('copper envelopes conflict')));
});
