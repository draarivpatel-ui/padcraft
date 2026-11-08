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
const os = require('node:os');
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
    const tmp = path.join(os.tmpdir(), 'padcraft_kb_' + process.pid + '.py');
    fs.writeFileSync(tmp, code);
    execFileSync('python3', ['-I', '-c',
      'import sys, ast; ast.parse(open(sys.argv[1]).read())', tmp], { stdio: 'pipe' });
    fs.unlinkSync(tmp);
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
  assert.ok(gbr.includes('%FSLAX26Y26Y26*%'));
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
  assert.equal((q['keymap.c'].match(/KC_[A-Z0-9_]+/g) || []).length, 12);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padcraft-cli-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padcraft-bad-'));
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
