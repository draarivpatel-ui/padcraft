/*
 * PadCraft - parametric 3D CAD, KiCad PCB, Gerber and firmware generator
 * ----------------------------------------------------------------------
 * Target programs: Hack Club Hackpad, OnBoard, Sprig and Blot.
 *
 * This file is standalone. It has no dependencies. It runs in three places:
 *   1. Node, as a library:  const pc = require('./cad.js')
 *   2. Node, as a CLI:      node cad.js stl --rows 3 --cols 4 --out plate.stl
 *   3. A browser, as a script tag: it installs globalThis.PadCraft
 *
 * Units are millimetres everywhere. The board origin is the top-left corner
 * of the plate outline, X grows to the right, Y grows downward.
 */

'use strict';

/* ===================================================================== *
 * 0. Constants and defaults
 * ===================================================================== */

const PROGRAMS = {
  Hackpad: {
    label: 'Hackpad',
    note: 'A small mechanical macropad. Start with a 3x4 diode matrix.',
    rows: 3, cols: 4, encoder: true, sensor: false, switchType: 'MX',
  },
  OnBoard: {
    label: 'OnBoard',
    note: 'A first custom PCB. Keep the matrix small and add a sensor header.',
    rows: 2, cols: 3, encoder: false, sensor: true, switchType: 'MX',
  },
  Sprig: {
    label: 'Sprig',
    note: 'A handheld console style board. Wide matrix, encoder for a dial.',
    rows: 3, cols: 6, encoder: true, sensor: false, switchType: 'Choc',
  },
  Blot: {
    label: 'Blot',
    note: 'An art and sensor board. Minimal keys, several analog inputs.',
    rows: 1, cols: 4, encoder: true, sensor: true, switchType: 'Choc',
  },
};

const DEFAULT_CONFIG = {
  name: 'PadCraft Macropad',
  program: 'Hackpad',
  rows: 3,
  cols: 4,
  keySpacing: 19.05,       // standard MX pitch
  switchCutout: 14.0,      // square plate opening for an MX switch
  plateThickness: 3.0,
  edgeMargin: 10.0,
  boardThickness: 1.6,
  switchType: 'MX',        // MX or Choc
  encoder: true,
  encoderPosition: 'top-center',
  encoderDiameter: 7.2,
  sensor: false,
  sensorCount: 1,
  mountHoleDiameter: 2.4,
  pinOffset: 0,            // skip the first N GPIOs of the RP2040 pool
  keymap: null,            // optional 2D array of KMK keycode strings
};

/* Raspberry Pi Pico physical pinout, pin 1 through pin 40. */
const PICO_PINOUT = [
  'GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7',
  'GP8', 'GP9', 'GND', 'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'GP14', 'GP15',
  'GP16', 'GP17', 'GND', 'GP18', 'GP19', 'GP20', 'GP21', 'GND', 'GP22', 'RUN',
  'GP26', 'GP27', 'GND', 'GP28', 'ADC_VREF', '3V3', '3V3_EN', 'GND', 'VSYS', 'VBUS',
];

/* GPIOs safe to use for a matrix on a stock RP2040 board. */
const RP2040_GPIO_POOL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22,
];
const RP2040_ADC_POOL = ['GP26', 'GP27', 'GP28'];

const BASE_KEYCODES = [
  'KC.ESC', 'KC.N1', 'KC.N2', 'KC.N3', 'KC.N4', 'KC.N5', 'KC.N6', 'KC.N7', 'KC.N8', 'KC.N9', 'KC.N0',
  'KC.Q', 'KC.W', 'KC.E', 'KC.R', 'KC.T', 'KC.Y', 'KC.U', 'KC.I', 'KC.O', 'KC.P',
  'KC.A', 'KC.S', 'KC.D', 'KC.F', 'KC.G', 'KC.H', 'KC.J', 'KC.K', 'KC.L', 'KC.SCLN',
  'KC.Z', 'KC.X', 'KC.C', 'KC.V', 'KC.B', 'KC.N', 'KC.M', 'KC.COMM', 'KC.DOT', 'KC.SLSH',
  'KC.TAB', 'KC.CAPS', 'KC.LSFT', 'KC.LCTL', 'KC.LGUI', 'KC.LALT', 'KC.SPC', 'KC.ENT',
  'KC.BSPC', 'KC.DEL', 'KC.LEFT', 'KC.RGHT', 'KC.UP', 'KC.DOWN', 'KC.HOME', 'KC.END',
  'KC.MUTE', 'KC.VOLU', 'KC.VOLD', 'KC.MPLY', 'KC.F1', 'KC.F2', 'KC.F3', 'KC.F4',
];

/* ===================================================================== *
 * 1. Small utilities
 * ===================================================================== */

function f(n, digits) {
  const d = digits === undefined ? 4 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(d);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function clampConfig(input) {
  const c = Object.assign({}, DEFAULT_CONFIG, input || {});
  c.name = String(c.name || DEFAULT_CONFIG.name).replace(/["\\]/g, '').slice(0, 64);
  if (!Object.prototype.hasOwnProperty.call(PROGRAMS, c.program)) c.program = 'Hackpad';
  c.rows = Math.round(clamp(Number(c.rows) || 3, 1, 6));
  c.cols = Math.round(clamp(Number(c.cols) || 4, 1, 8));
  c.keySpacing = clamp(Number(c.keySpacing) || 19.05, 16, 24);
  c.switchCutout = clamp(Number(c.switchCutout) || 14, 10, 16);
  c.plateThickness = clamp(Number(c.plateThickness) || 3, 1, 8);
  c.edgeMargin = clamp(Number(c.edgeMargin) || 10, 5, 24);
  c.boardThickness = clamp(Number(c.boardThickness) || 1.6, 0.6, 3.2);
  c.encoderDiameter = clamp(Number(c.encoderDiameter) || 7.2, 5, 12);
  c.mountHoleDiameter = clamp(Number(c.mountHoleDiameter) || 2.4, 1.5, 4);
  c.sensorCount = Math.round(clamp(Number(c.sensorCount) || 1, 1, 3));
  c.pinOffset = Math.round(clamp(Number(c.pinOffset) || 0, 0, 6));
  c.switchType = c.switchType === 'Choc' ? 'Choc' : 'MX';
  c.encoder = !!c.encoder;
  c.sensor = !!c.sensor;
  if (!['top-left', 'top-center', 'top-right'].includes(c.encoderPosition)) {
    c.encoderPosition = 'top-center';
  }
  return c;
}

function applyProgram(program) {
  const p = PROGRAMS[program];
  return p ? { program, rows: p.rows, cols: p.cols, encoder: p.encoder,
               sensor: p.sensor, switchType: p.switchType } : {};
}

function defaultKeymap(rows, cols) {
  const out = [];
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push(BASE_KEYCODES[k % BASE_KEYCODES.length]);
      k++;
    }
    out.push(row);
  }
  return out;
}

function normaliseKeymap(config) {
  let km = config.keymap;
  if (!Array.isArray(km) || km.length === 0) return defaultKeymap(config.rows, config.cols);
  const flat = Array.isArray(km[0]) ? km.slice(0, config.rows).map(r => r.slice(0, config.cols)) : null;
  if (flat) {
    return Array.from({ length: config.rows }, (_, r) =>
      Array.from({ length: config.cols }, (_, c) =>
        String((flat[r] && flat[r][c]) || 'KC.NO')));
  }
  const list = km.map(String);
  let i = 0;
  return Array.from({ length: config.rows }, () =>
    Array.from({ length: config.cols }, () => list[i++] || 'KC.NO'));
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'padcraft';
}

/* ===================================================================== *
 * 2. Geometry, pin assignment and netlist model
 * ===================================================================== */

function computeLayout(config) {
  const c = clampConfig(config);
  const topBand = c.encoder ? 20 : 0;
  const bottomBand = c.sensor ? 16 : 0;
  const width = 2 * c.edgeMargin + c.cols * c.keySpacing;
  const height = 2 * c.edgeMargin + c.rows * c.keySpacing + topBand + bottomBand;

  const keys = [];
  for (let r = 0; r < c.rows; r++) {
    for (let col = 0; col < c.cols; col++) {
      keys.push({
        row: r, col, ref: 'SW' + (r * c.cols + col + 1),
        x: c.edgeMargin + col * c.keySpacing + c.keySpacing / 2,
        y: topBand + c.edgeMargin + r * c.keySpacing + c.keySpacing / 2,
      });
    }
  }

  let encoder = null;
  if (c.encoder) {
    const ex = c.encoderPosition === 'top-left' ? c.edgeMargin + 12
      : c.encoderPosition === 'top-right' ? width - c.edgeMargin - 12
      : width / 2;
    encoder = { x: ex, y: topBand / 2 + 2, diameter: c.encoderDiameter };
  }

  const sensors = [];
  if (c.sensor) {
    for (let i = 0; i < c.sensorCount; i++) {
      sensors.push({
        ref: 'J' + (i + 1),
        x: c.edgeMargin + (i + 1) * (width - 2 * c.edgeMargin) / (c.sensorCount + 1),
        y: height - bottomBand / 2 - 1,
      });
    }
  }

  const mountX = [c.edgeMargin / 2, width - c.edgeMargin / 2];
  const mountY = [c.edgeMargin / 2 + topBand * 0.35, height - c.edgeMargin / 2 - bottomBand * 0.35];
  const mounts = [];
  for (const mx of mountX) for (const my of mountY) mounts.push({ x: mx, y: my });

  const cutouts = keys.map(k => ({ x: k.x, y: k.y, w: c.switchCutout, h: c.switchCutout, kind: 'switch' }));
  if (encoder) cutouts.push({ x: encoder.x, y: encoder.y, w: c.encoderDiameter, h: c.encoderDiameter, kind: 'encoder' });
  for (const m of mounts) cutouts.push({ x: m.x, y: m.y, w: c.mountHoleDiameter, h: c.mountHoleDiameter, kind: 'mount' });

  return { config: c, width, height, topBand, bottomBand, keys, encoder, sensors, mounts, cutouts };
}

function buildPinAssignment(config) {
  const c = clampConfig(config);
  const needed = c.rows + c.cols + (c.encoder ? 3 : 0);
  const pool = RP2040_GPIO_POOL.slice(c.pinOffset);
  if (needed > pool.length) {
    throw new Error('Not enough RP2040 GPIOs: need ' + needed + ', have ' + pool.length +
      ' with pinOffset ' + c.pinOffset + '. Reduce rows, cols, encoder or pinOffset.');
  }
  let idx = 0;
  const take = () => 'GP' + pool[idx++];
  const rows = Array.from({ length: c.rows }, take);
  const cols = Array.from({ length: c.cols }, take);
  const encoder = c.encoder ? { a: take(), b: take(), sw: take() } : null;
  const sensor = c.sensor ? RP2040_ADC_POOL.slice(0, c.sensorCount) : [];

  const usage = [];
  rows.forEach((p, i) => usage.push({ pin: p, net: 'ROW' + i, role: 'row ' + i }));
  cols.forEach((p, i) => usage.push({ pin: p, net: 'COL' + i, role: 'col ' + i }));
  if (encoder) {
    usage.push({ pin: encoder.a, net: 'ENC_A', role: 'encoder A' });
    usage.push({ pin: encoder.b, net: 'ENC_B', role: 'encoder B' });
    usage.push({ pin: encoder.sw, net: 'ENC_SW', role: 'encoder switch' });
  }
  sensor.forEach((p, i) => usage.push({ pin: p, net: 'SENSOR' + i, role: 'sensor ' + i }));

  const byPin = {};
  for (const u of usage) {
    if (byPin[u.pin]) throw new Error('Duplicate RP2040 pin assignment on ' + u.pin);
    byPin[u.pin] = u.net;
  }
  return { rows, cols, encoder, sensor, usage, byPin, needed, pool };
}

/*
 * Diode matrix net model (COL2ROW).
 *
 *   GPIO col pin -> COLc bus -> switch pad 1
 *   switch pad 2 -> key node N_Rr_Cc -> diode anode (pad 1)
 *   diode cathode (pad 2) -> ROWr bus -> GPIO row pin
 *
 * Diodes conduct from the column side toward the row side, so the cathode
 * stripe faces the row, matching DiodeOrientation.COL2ROW in KMK and
 * DIODE_DIRECTION COL2ROW in QMK.
 */
function buildNetlist(config) {
  const c = clampConfig(config);
  const pins = buildPinAssignment(c);
  const assignments = [];
  for (let r = 0; r < c.rows; r++) {
    for (let col = 0; col < c.cols; col++) {
      assignments.push({
        row: r, col,
        rowNet: 'ROW' + r, colNet: 'COL' + col,
        keyNet: 'N_R' + r + '_C' + col,
        rowPin: pins.rows[r], colPin: pins.cols[col],
        switch: 'SW' + (r * c.cols + col + 1),
        diode: 'D' + (r * c.cols + col + 1),
      });
    }
  }
  return { config: c, pins, assignments };
}

/* ===================================================================== *
 * 3. Full board model (used by PCB, Gerber, STL, SCAD and the preview)
 * ===================================================================== */

function buildBoard(config) {
  const c = clampConfig(config);
  const layout = computeLayout(c);
  const netlist = buildNetlist(c);
  const keymap = normaliseKeymap(c);

  const netNames = [];
  const netIndex = { '': 0 };
  const net = (name) => {
    if (!Object.prototype.hasOwnProperty.call(netIndex, name)) {
      netIndex[name] = netNames.length + 1;
      netNames.push(name);
    }
    return { index: netIndex[name], name };
  };
  net('GND'); net('3V3'); net('VBUS'); net('RUN'); net('ADC_VREF'); net('3V3_EN');

  const components = [];
  const traces = [];
  const drillPoints = [];
  const silk = [];

  const pushDrill = (x, y, d) => drillPoints.push({ x, y, diameter: d });

  /* Switch footprints. Offsets follow a Cherry MX / Kailh Choc switch body. */
  for (const k of layout.keys) {
    const a = netlist.assignments.find(as => as.row === k.row && as.col === k.col);
    const pads = [
      { num: '1', x: k.x - 3.81, y: k.y + 2.54, shape: 'circle', w: 2.0, h: 2.0, drill: 1.0, net: net(a.colNet) },
      { num: '2', x: k.x + 2.54, y: k.y + 5.08, shape: 'circle', w: 2.0, h: 2.0, drill: 1.0, net: net(a.keyNet) },
    ];
    const npth = [
      { num: 'NP1', x: k.x - 5.08, y: k.y + 0.0, drill: 1.7 },
      { num: 'NP2', x: k.x + 5.08, y: k.y + 0.0, drill: 1.7 },
      { num: 'NP3', x: k.x + 0.0, y: k.y + 0.0, drill: 4.0 },
    ];
    for (const p of pads) pushDrill(p.x, p.y, p.drill);
    for (const p of npth) pushDrill(p.x, p.y, p.drill);
    components.push({
      ref: k.ref, value: 'SW_' + c.switchType.toUpperCase(), x: k.x, y: k.y,
      lib: 'PadCraft:SW_' + c.switchType.toUpperCase(), kind: 'switch',
      pads, npth, outline: { w: 15.6, h: 15.6 },
      silk: [{ x: 0, y: -9, text: k.ref }],
    });
  }

  /* One series diode per key, placed just below and right of the switch. */
  for (const k of layout.keys) {
    const a = netlist.assignments.find(as => as.row === k.row && as.col === k.col);
    const dx = k.x + 7.2, dy = k.y - 7.4;
    const pads = [
      { num: '1', x: dx - 1.65, y: dy, shape: 'roundrect', w: 1.2, h: 1.6, drill: 0, net: net(a.keyNet) },
      { num: '2', x: dx + 1.65, y: dy, shape: 'roundrect', w: 1.2, h: 1.6, drill: 0, net: net(a.rowNet) },
    ];
    components.push({
      ref: a.diode, value: 'D_SOD-123', x: dx, y: dy,
      lib: 'PadCraft:D_SOD-123', kind: 'diode',
      pads, npth: [], outline: { w: 4.6, h: 2.2 },
      silk: [{ x: 0, y: -2.4, text: a.diode }],
    });
  }

  /* Column and row copper rails, used by the Gerber writer and the preview. */
  for (let col = 0; col < c.cols; col++) {
    const x = layout.keys.find(k => k.col === col).x - 3.81;
    const ys = layout.keys.filter(k => k.col === col).map(k => k.y + 2.54);
    const top = Math.min.apply(null, ys) - c.keySpacing / 2;
    const bottom = Math.max.apply(null, ys) + c.keySpacing / 2;
    traces.push({ net: 'COL' + col, layer: 'B.Cu', width: 0.25,
      points: [[x, top], [x, bottom]] });
  }
  for (let r = 0; r < c.rows; r++) {
    const y = layout.keys.find(k => k.row === r).y + 11;
    const xs = layout.keys.filter(k => k.row === r).map(k => k.x + 7.2 + 1.65);
    const left = Math.min.apply(null, xs) - c.keySpacing / 2;
    const right = Math.max.apply(null, xs) + c.keySpacing / 2;
    traces.push({ net: 'ROW' + r, layer: 'F.Cu', width: 0.25,
      points: [[left, y], [right, y]] });
  }

  /* Rotary encoder (EC11 style): A, B, common, plus a push switch. */
  if (layout.encoder) {
    const e = layout.encoder;
    const pads = [
      { num: 'A', x: e.x - 3.0, y: e.y + 4.0, shape: 'circle', w: 1.8, h: 1.8, drill: 0.9, net: net('ENC_A') },
      { num: 'B', x: e.x + 0.0, y: e.y + 4.0, shape: 'circle', w: 1.8, h: 1.8, drill: 0.9, net: net('ENC_B') },
      { num: 'C', x: e.x + 3.0, y: e.y + 4.0, shape: 'circle', w: 1.8, h: 1.8, drill: 0.9, net: net('GND') },
      { num: 'S1', x: e.x - 3.0, y: e.y - 4.0, shape: 'circle', w: 1.8, h: 1.8, drill: 0.9, net: net('ENC_SW') },
      { num: 'S2', x: e.x + 3.0, y: e.y - 4.0, shape: 'circle', w: 1.8, h: 1.8, drill: 0.9, net: net('GND') },
    ];
    for (const p of pads) pushDrill(p.x, p.y, p.drill);
    pushDrill(e.x, e.y, 6.0);
    components.push({
      ref: 'ENC1', value: 'RotaryEncoder_Alps_EC11E-Switch', x: e.x, y: e.y,
      lib: 'PadCraft:RotaryEncoder_EC11', kind: 'encoder',
      pads, npth: [{ num: 'NP1', x: e.x, y: e.y, drill: 6.0 }],
      outline: { w: 12.0, h: 12.0, round: true },
      silk: [{ x: 0, y: -8.5, text: 'ENC1' }],
    });
  }

  /* Three pin analog sensor headers. */
  if (layout.sensors.length) {
    layout.sensors.forEach((s, i) => {
      const pads = [
        { num: '1', x: s.x - 2.54, y: s.y, shape: 'circle', w: 1.7, h: 1.7, drill: 0.9, net: net('3V3') },
        { num: '2', x: s.x, y: s.y, shape: 'circle', w: 1.7, h: 1.7, drill: 0.9, net: net('SENSOR' + i) },
        { num: '3', x: s.x + 2.54, y: s.y, shape: 'circle', w: 1.7, h: 1.7, drill: 0.9, net: net('GND') },
      ];
      for (const p of pads) pushDrill(p.x, p.y, p.drill);
      components.push({
        ref: s.ref, value: 'Conn_01x03', x: s.x, y: s.y,
        lib: 'PadCraft:Conn_01x03', kind: 'sensor',
        pads, npth: [], outline: { w: 8.2, h: 3.0 },
        silk: [{ x: 0, y: -3.2, text: 'ADC' + i }],
      });
    });
  }

  /* RP2040 module, drawn as a Raspberry Pi Pico 2x20 header footprint. */
  const picoW = 21.0, picoH = 51.0;
  const picoX = layout.width / 2;
  const picoY = layout.height - (c.sensor ? layout.bottomBand : 0) - c.edgeMargin / 2 - 4 - picoH / 2 - 12;
  const picoPads = [];
  for (let i = 0; i < 40; i++) {
    const side = i < 20 ? -1 : 1;
    const rowOnSide = i < 20 ? i : 39 - i;
    const py = picoY - picoH / 2 + 3.2 + rowOnSide * 2.54;
    const px = picoX + side * (picoW / 2 - 1.6);
    const signal = PICO_PINOUT[i];
    let pn = null;
    if (signal === 'GND' || signal === '3V3' || signal === 'VBUS' || signal === 'RUN' ||
        signal === 'ADC_VREF' || signal === '3V3_EN') {
      pn = net(signal === '3V3_EN' ? '3V3_EN' : signal);
    } else if (Object.prototype.hasOwnProperty.call(netlist.pins.byPin, signal)) {
      pn = net(netlist.pins.byPin[signal]);
    }
    picoPads.push({ num: String(i + 1), x: px, y: py, shape: 'roundrect',
      w: 1.7, h: 1.7, drill: 0.9, net: pn, signal });
    pushDrill(px, py, 0.9);
  }
  components.push({
    ref: 'U1', value: 'RP2040_Pico', x: picoX, y: picoY,
    lib: 'PadCraft:RP2040_Pico', kind: 'mcu',
    pads: picoPads, npth: [], outline: { w: picoW, h: picoH },
    silk: [{ x: 0, y: -picoH / 2 - 2, text: 'U1 RP2040' }],
  });

  /* Board outline. */
  const edge = [[0, 0], [layout.width, 0], [layout.width, layout.height], [0, layout.height], [0, 0]];
  for (const m of layout.mounts) {
    silk.push({ x: m.x, y: m.y - 4, text: 'M2' });
  }

  return {
    config: c, layout, netlist, keymap,
    nets: { names: netNames, index: netIndex },
    components, traces, drillPoints, silk, edge,
    stats: {
      keys: layout.keys.length,
      diodes: layout.keys.length,
      components: components.length,
      pads: components.reduce((n, cp) => n + cp.pads.length, 0),
      nets: netNames.length,
      drills: drillPoints.length,
      width: layout.width,
      height: layout.height,
    },
  };
}

/* ===================================================================== *
 * 4. KiCad .kicad_pcb writer
 * ===================================================================== */

function padSexpr(p, cx, cy) {
  const ox = p.x - cx, oy = p.y - cy;
  const shape = p.shape === 'roundrect' ? 'roundrect' : p.shape === 'rect' ? 'rect' : 'circle';
  const layers = p.drill > 0 ? '"*.Cu" "*.Mask"' : '"F.Cu" "F.Mask" "F.Paste"';
  const netLine = p.net ? '\n        (net ' + p.net.index + ' "' + p.net.name + '")' : '';
  const drill = p.drill > 0 ? '\n        (drill ' + f(p.drill) + ')' : '';
  const rr = shape === 'roundrect' ? '\n        (roundrect_rratio 0.25)' : '';
  return '      (pad "' + p.num + '" ' + (p.drill > 0 ? 'thru_hole' : 'smd') + ' ' + shape +
    '\n        (at ' + f(ox) + ' ' + f(oy) + ')' +
    '\n        (size ' + f(p.w) + ' ' + f(p.h) + ')' +
    drill + rr +
    '\n        (layers ' + layers + ')' + netLine + '\n      )';
}

function footprintSexpr(cp, index) {
  const padLines = cp.pads.map(p => padSexpr(p, cp.x, cp.y)).join('\n');
  const npthLines = (cp.npth || []).map(p =>
    '      (pad "' + p.num + '" np_thru_hole circle' +
    '\n        (at ' + f(p.x - cp.x) + ' ' + f(p.y - cp.y) + ')' +
    '\n        (size ' + f(p.drill) + ' ' + f(p.drill) + ')' +
    '\n        (drill ' + f(p.drill) + ')' +
    '\n        (layers "*.Cu" "*.Mask")\n      )').join('\n');
  const texts = (cp.silk || []).map(t =>
    '      (fp_text reference "' + t.text + '" (at ' + f(t.x) + ' ' + f(t.y) + ')' +
    ' (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))').join('\n');
  const outline = cp.outline
    ? '      (fp_rect (start ' + f(-cp.outline.w / 2) + ' ' + f(-cp.outline.h / 2) + ')' +
      ' (end ' + f(cp.outline.w / 2) + ' ' + f(cp.outline.h / 2) + ')' +
      ' (stroke (width 0.12) (type default)) (fill none) (layer "F.SilkS"))'
    : '';
  return '    (footprint "' + cp.lib + '" (layer "F.Cu")' +
    '\n      (tstamp 00000000-0000-0000-0000-' + String(100000000000 + index).slice(-12) + ')' +
    '\n      (at ' + f(cp.x) + ' ' + f(cp.y) + ')' +
    '\n      (attr through_hole board_only exclude_from_pos_files exclude_from_bom)' +
    '\n      (fp_text reference "' + cp.ref + '" (at 0 -3) (layer "F.SilkS")' +
    ' (effects (font (size 1 1) (thickness 0.15))))' +
    '\n      (fp_text value "' + cp.value + '" (at 0 3) (layer "F.Fab")' +
    ' (effects (font (size 1 1) (thickness 0.15))))' +
    (texts ? '\n' + texts : '') +
    (outline ? '\n' + outline : '') +
    (padLines ? '\n' + padLines : '') +
    (npthLines ? '\n' + npthLines : '') +
    '\n    )';
}

function generateKiCadPcb(config) {
  const board = buildBoard(config);
  const c = board.config;
  const L = [];
  L.push('(kicad_pcb');
  L.push('  (version 20240108)');
  L.push('  (generator "padcraft")');
  L.push('  (generator_version "1.0")');
  L.push('  (general');
  L.push('    (thickness ' + f(c.boardThickness) + ')');
  L.push('    (legacy_teardrops no)');
  L.push('  )');
  L.push('  (paper "A4")');
  L.push('  (title_block');
  L.push('    (title "' + c.name + '")');
  L.push('    (date "2026-01-01")');
  L.push('    (rev "A")');
  L.push('    (company "Hack Club ' + c.program + '")');
  L.push('    (comment 1 "Generated by PadCraft")');
  L.push('  )');
  L.push('  (layers');
  const layers = [
    [0, 'F.Cu', 'signal'], [31, 'B.Cu', 'signal'],
    [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'],
    [36, 'B.SilkS', 'user', 'B.Silkscreen'], [37, 'F.SilkS', 'user', 'F.Silkscreen'],
    [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'],
    [40, 'Dwgs.User', 'user', 'User.Drawings'], [41, 'Cmts.User', 'user', 'User.Comments'],
    [44, 'Edge.Cuts', 'user'], [45, 'Margin', 'user'],
    [46, 'B.CrtYd', 'user', 'B.Courtyard'], [47, 'F.CrtYd', 'user', 'F.Courtyard'],
    [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user'],
  ];
  for (const l of layers) {
    L.push('    (' + l[0] + ' "' + l[1] + '" ' + l[2] + (l[3] ? ' "' + l[3] + '"' : '') + ')');
  }
  L.push('  )');
  L.push('  (setup');
  L.push('    (pad_to_mask_clearance 0)');
  L.push('    (solder_mask_min_width 0)');
  L.push('  )');
  L.push('  (net 0 "")');
  board.nets.names.forEach((n, i) => L.push('  (net ' + (i + 1) + ' "' + n + '")'));

  /* Copper rail segments as real track objects. */
  for (const t of board.traces) {
    const ni = board.nets.index[t.net];
    for (let i = 0; i < t.points.length - 1; i++) {
      const a = t.points[i], b = t.points[i + 1];
      L.push('  (segment');
      L.push('    (start ' + f(a[0]) + ' ' + f(a[1]) + ')');
      L.push('    (end ' + f(b[0]) + ' ' + f(b[1]) + ')');
      L.push('    (width ' + f(t.width) + ')');
      L.push('    (layer "' + t.layer + '")');
      L.push('    (net ' + ni + ')');
      L.push('    (tstamp 00000000-0000-0000-0000-000000000000)');
      L.push('  )');
    }
  }

  /* Board outline on Edge.Cuts. */
  for (let i = 0; i < board.edge.length - 1; i++) {
    const a = board.edge[i], b = board.edge[i + 1];
    L.push('  (gr_line');
    L.push('    (start ' + f(a[0]) + ' ' + f(a[1]) + ')');
    L.push('    (end ' + f(b[0]) + ' ' + f(b[1]) + ')');
    L.push('    (stroke (width 0.1) (type default))');
    L.push('    (layer "Edge.Cuts")');
    L.push('  )');
  }
  /* Mounting holes as NPTH pads in a board level footprint. */
  for (let i = 0; i < board.layout.mounts.length; i++) {
    const m = board.layout.mounts[i];
    L.push('  (footprint "PadCraft:MountingHole_2.2mm_M2" (layer "F.Cu")');
    L.push('    (tstamp 00000000-0000-0000-0000-' + String(900000000000 + i).slice(-12) + ')');
    L.push('    (at ' + f(m.x) + ' ' + f(m.y) + ')');
    L.push('    (attr board_only exclude_from_pos_files exclude_from_bom)');
    L.push('    (fp_text reference "H' + (i + 1) + '" (at 0 -3) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))');
    L.push('    (fp_text value "MountingHole" (at 0 3) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))');
    L.push('    (pad "" np_thru_hole circle (at 0 0) (size ' + f(c.mountHoleDiameter) + ' ' + f(c.mountHoleDiameter) + ') (drill ' + f(c.mountHoleDiameter) + ') (layers "*.Cu" "*.Mask"))');
    L.push('  )');
  }

  board.components.forEach((cp, i) => L.push(footprintSexpr(cp, i)));
  L.push(')');
  return L.join('\n') + '\n';
}

/* ===================================================================== *
 * 5. S-expression parser and validator
 * ===================================================================== */

function tokenizeSexp(text) {
  const tokens = [];
  let i = 0;
  const src = String(text);
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', value: ch }); i++; continue; }
    if (ch === '"') {
      let s = '';
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\\' && i + 1 < src.length) { s += src[i + 1]; i += 2; continue; }
        if (src[i] === '"') { i++; closed = true; break; }
        s += src[i]; i++;
      }
      if (!closed) throw new Error('Unterminated string at offset ' + i);
      tokens.push({ type: 'string', value: s });
      continue;
    }
    let atom = '';
    while (i < src.length && !/[\s()"]/.test(src[i])) { atom += src[i]; i++; }
    if (atom.length === 0) throw new Error('Unexpected character at offset ' + i);
    tokens.push({ type: 'atom', value: atom });
  }
  return tokens;
}

function parseSexp(text) {
  const tokens = tokenizeSexp(text);
  let pos = 0;
  function expr() {
    if (pos >= tokens.length) throw new Error('Unexpected end of input');
    const t = tokens[pos++];
    if (t.type === 'paren') {
      if (t.value === ')') throw new Error('Unexpected closing parenthesis at token ' + pos);
      const list = [];
      while (true) {
        if (pos >= tokens.length) throw new Error('Unbalanced parentheses: missing )');
        if (tokens[pos].type === 'paren' && tokens[pos].value === ')') { pos++; return list; }
        list.push(expr());
      }
    }
    return { type: t.type, value: t.value };
  }
  const forms = [];
  while (pos < tokens.length) forms.push(expr());
  return forms;
}

function validateSexp(text) {
  try {
    const forms = parseSexp(text);
    if (forms.length === 0) return { valid: false, errors: ['No S-expression found'], forms: [] };
    return { valid: true, errors: [], forms };
  } catch (e) {
    return { valid: false, errors: [e.message], forms: [] };
  }
}

function head(form) {
  return (Array.isArray(form) && form.length && form[0] && form[0].type === 'atom') ? form[0].value : null;
}

function walk(form, fn) {
  if (!Array.isArray(form)) return;
  fn(form);
  for (const child of form) if (Array.isArray(child)) walk(child, fn);
}

/* Validates a full .kicad_pcb document: balanced S-expressions, a
 * kicad_pcb root, unique ordered net declarations, and that every pad net
 * reference points at a declared net. */
function validateKiCadPcb(text) {
  const base = validateSexp(text);
  const errors = base.errors.slice();
  if (!base.valid) return { valid: false, errors, nets: [], footprints: 0, pads: 0 };

  const roots = base.forms;
  if (roots.length !== 1) errors.push('Expected exactly one root form, found ' + roots.length);
  const root = roots[0];
  if (head(root) !== 'kicad_pcb') errors.push('Root form must be kicad_pcb, found ' + head(root));

  /* Only (net ...) forms that are direct children of kicad_pcb are net
   * declarations. The (net N "name") form inside a pad is a reference and
   * must not be counted as a duplicate declaration. */
  const declared = new Map();
  for (const child of root) {
    if (Array.isArray(child) && head(child) === 'net' && child.length >= 3 && child[1].type === 'atom') {
      const idx = Number(child[1].value);
      if (declared.has(idx)) errors.push('Duplicate net declaration for index ' + idx);
      declared.set(idx, String(child[2].value));
    }
  }
  const refs = [];
  let footprints = 0, pads = 0;
  walk(root, (form) => {
    const h = head(form);
    if (h === 'footprint') footprints++;
    if (h === 'pad') {
      pads++;
      for (const child of form) {
        if (Array.isArray(child) && head(child) === 'net' && child[1]) refs.push(Number(child[1].value));
      }
    }
  });
  if (!declared.has(0)) errors.push('Missing the mandatory (net 0 "") declaration');
  const indices = Array.from(declared.keys()).sort((a, b) => a - b);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i) { errors.push('Net indices are not contiguous from 0'); break; }
  }
  for (const r of refs) {
    if (!declared.has(r)) errors.push('Pad references undeclared net index ' + r);
  }
  return {
    valid: errors.length === 0, errors,
    nets: indices.map(i => ({ index: i, name: declared.get(i) })),
    footprints, pads,
  };
}

/* ===================================================================== *
 * 6. ASCII STL plate mesher
 * ===================================================================== */

/* Cross product of (b - a) and (c - a), normalised to unit length. */
function computeNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 0, 0];
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

/* Splits a quad into two triangles, recomputing a flat facet normal for each. */
function emitQuadTriangles(a, b, c, d) {
  return [
    { a, b, c, n: computeNormal(a, b, c) },
    { a: a, b: c, c: d, n: computeNormal(a, c, d) },
  ];
}

/*
 * Axis-aligned cell decomposition. Every cutout boundary becomes a grid
 * line, so solid cells are either fully inside or fully outside a cutout.
 * Top and bottom faces come from solid cells. Wall faces are emitted on any
 * cell edge whose neighbour is empty, which covers both hole walls and the
 * outer perimeter with one consistent rule.
 *
 * Round bores (encoder, mounting holes) are emitted as square openings here;
 * the OpenSCAD source uses true cylinders. See README.md.
 */
function buildPlateMesh(config) {
  const board = buildBoard(config);
  const c = board.config;
  const W = board.layout.width, H = board.layout.height, T = c.plateThickness;
  const holes = board.layout.cutouts;

  const xs = [0, W], ys = [0, H];
  for (const h of holes) {
    xs.push(h.x - h.w / 2, h.x + h.w / 2);
    ys.push(h.y - h.h / 2, h.y + h.h / 2);
  }
  const uniq = (arr) => Array.from(new Set(arr.map(v => Math.round(v * 1e6) / 1e6)))
    .filter(v => v >= -1e-6 && v <= Math.max(W, H) + 1e-6)
    .sort((a, b) => a - b);
  const X = uniq(xs.concat([W]));
  const Y = uniq(ys.concat([H]));
  if (X[0] !== 0) X.unshift(0);
  if (Y[0] !== 0) Y.unshift(0);

  const nx = X.length - 1, ny = Y.length - 1;
  const solid = [];
  for (let i = 0; i < nx; i++) {
    solid[i] = [];
    for (let j = 0; j < ny; j++) {
      const cx = (X[i] + X[i + 1]) / 2, cy = (Y[j] + Y[j + 1]) / 2;
      const inside = holes.some(h =>
        cx > h.x - h.w / 2 && cx < h.x + h.w / 2 &&
        cy > h.y - h.h / 2 && cy < h.y + h.h / 2);
      solid[i][j] = !inside;
    }
  }

  const facets = [];
  const add = (q) => {
    for (const t of emitQuadTriangles(q[0], q[1], q[2], q[3])) {
      if (t.n[0] === 0 && t.n[1] === 0 && t.n[2] === 0) continue;
      facets.push(t);
    }
  };
  const isSolid = (i, j) => i >= 0 && i < nx && j >= 0 && j < ny && solid[i][j];

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!solid[i][j]) continue;
      const x0 = X[i], x1 = X[i + 1], y0 = Y[j], y1 = Y[j + 1];
      /* Top face, outward normal +Z. */
      add([[x0, y0, T], [x1, y0, T], [x1, y1, T], [x0, y1, T]]);
      /* Bottom face, outward normal -Z. */
      add([[x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0]]);
      /* Four vertical walls, only where the neighbour is empty. */
      if (!isSolid(i - 1, j)) add([[x0, y0, 0], [x0, y0, T], [x0, y1, T], [x0, y1, 0]]); // -X
      if (!isSolid(i + 1, j)) add([[x1, y0, 0], [x1, y1, 0], [x1, y1, T], [x1, y0, T]]); // +X
      if (!isSolid(i, j - 1)) add([[x0, y0, 0], [x1, y0, 0], [x1, y0, T], [x0, y0, T]]); // -Y
      if (!isSolid(i, j + 1)) add([[x0, y1, 0], [x0, y1, T], [x1, y1, T], [x1, y1, 0]]); // +Y
    }
  }
  return {
    facets, width: W, height: H, thickness: T,
    stats: { triangles: facets.length, cells: nx * ny, solidCells: solid.flat().filter(Boolean).length },
  };
}

function generateSTL(config) {
  const c = clampConfig(config);
  const mesh = buildPlateMesh(c);
  const name = slug(c.name) + '_plate';
  const L = ['solid ' + name];
  for (const t of mesh.facets) {
    L.push('  facet normal ' + t.n.map(v => f(v, 6)).join(' '));
    L.push('    outer loop');
    for (const v of [t.a, t.b, t.c]) L.push('      vertex ' + v.map(x => f(x, 6)).join(' '));
    L.push('    endloop');
    L.push('  endfacet');
  }
  L.push('endsolid ' + name);
  return L.join('\n') + '\n';
}

/* ===================================================================== *
 * 7. OpenSCAD parametric enclosure
 * ===================================================================== */

function generateOpenSCAD(config) {
  const board = buildBoard(config);
  const c = board.config;
  const L = [];
  L.push('// PadCraft parametric switch plate and enclosure');
  L.push('// Program: ' + c.program + ' | Board: ' + c.name);
  L.push('// All dimensions are in millimetres. Open in OpenSCAD and press F6 to render.');
  L.push('');
  L.push('// ---- Parameters -------------------------------------------------');
  L.push('rows              = ' + c.rows + ';');
  L.push('cols              = ' + c.cols + ';');
  L.push('key_spacing       = ' + f(c.keySpacing) + ';');
  L.push('switch_cutout     = ' + f(c.switchCutout) + ';');
  L.push('plate_thickness   = ' + f(c.plateThickness) + ';');
  L.push('edge_margin       = ' + f(c.edgeMargin) + ';');
  L.push('encoder_diameter  = ' + f(c.encoderDiameter) + ';');
  L.push('mount_hole_d      = ' + f(c.mountHoleDiameter) + ';');
  L.push('has_encoder       = ' + (c.encoder ? 'true' : 'false') + ';');
  L.push('has_sensor        = ' + (c.sensor ? 'true' : 'false') + ';');
  L.push('board_w           = ' + f(board.layout.width) + ';');
  L.push('board_h           = ' + f(board.layout.height) + ';');
  L.push('top_band          = ' + f(board.layout.topBand) + ';');
  L.push('bottom_band       = ' + f(board.layout.bottomBand) + ';');
  L.push('case_wall         = 2.4;');
  L.push('case_floor        = 1.6;');
  L.push('case_height       = 12.0;');
  L.push('clearance         = 0.25;');
  L.push('');
  L.push('// ---- Derived helpers --------------------------------------------');
  L.push('function key_x(col) = edge_margin + col * key_spacing + key_spacing / 2;');
  L.push('function key_y(row) = top_band + edge_margin + row * key_spacing + key_spacing / 2;');
  L.push('');
  L.push('module switch_opening(x, y) {');
  L.push('    // Square plate cutout, plus a shallow relief for the switch clips.');
  L.push('    translate([x - switch_cutout / 2, y - switch_cutout / 2, -1])');
  L.push('        cube([switch_cutout, switch_cutout, plate_thickness + 2]);');
  L.push('}');
  L.push('');
  L.push('module encoder_opening(x, y) {');
  L.push('    translate([x, y, -1])');
  L.push('        cylinder(d = encoder_diameter, h = plate_thickness + 2, $fn = 48);');
  L.push('}');
  L.push('');
  L.push('module mount_opening(x, y) {');
  L.push('    translate([x, y, -1])');
  L.push('        cylinder(d = mount_hole_d, h = plate_thickness + 2, $fn = 32);');
  L.push('}');
  L.push('');
  L.push('module plate() {');
  L.push('    difference() {');
  L.push('        cube([board_w, board_h, plate_thickness]);');
  L.push('        for (r = [0 : rows - 1], c = [0 : cols - 1])');
  L.push('            switch_opening(key_x(c), key_y(r));');
  L.push('        if (has_encoder)');
  L.push('            encoder_opening(' + f(board.layout.encoder ? board.layout.encoder.x : board.layout.width / 2) +
         ', ' + f(board.layout.encoder ? board.layout.encoder.y : 10) + ');');
  L.push('        for (mx = [edge_margin / 2, board_w - edge_margin / 2],');
  L.push('             my = [edge_margin / 2 + top_band * 0.35, board_h - edge_margin / 2 - bottom_band * 0.35])');
  L.push('            mount_opening(mx, my);');
  L.push('    }');
  L.push('}');
  L.push('');
  L.push('module case_shell() {');
  L.push('    // A simple tray. The plate drops in from the top.');
  L.push('    difference() {');
  L.push('        cube([board_w + 2 * case_wall, board_h + 2 * case_wall, case_height]);');
  L.push('        translate([case_wall, case_wall, case_floor])');
  L.push('            cube([board_w, board_h, case_height - case_floor + 1]);');
  L.push('        translate([case_wall + clearance, case_wall + clearance, case_height - plate_thickness])');
  L.push('            cube([board_w - 2 * clearance, board_h - 2 * clearance, plate_thickness + 1]);');
  L.push('    }');
  L.push('}');
  L.push('');
  L.push('// ---- Render -----------------------------------------------------');
  L.push('render_mode = "plate"; // "plate", "case" or "assembly"');
  L.push('');
  L.push('if (render_mode == "plate") {');
  L.push('    plate();');
  L.push('} else if (render_mode == "case") {');
  L.push('    case_shell();');
  L.push('} else {');
  L.push('    case_shell();');
  L.push('    translate([case_wall, case_wall, case_height - plate_thickness]) plate();');
  L.push('}');
  L.push('');
  return L.join('\n');
}

/* ===================================================================== *
 * 8. Front copper Gerber (RS-274X)
 * ===================================================================== */

function generateGerberFCu(config) {
  const board = buildBoard(config);
  const c = board.config;
  const mm = (v) => Math.round(v * 1e6); // FSLAX26Y26, units 1e-6 mm
  const L = [];
  L.push('G04 PadCraft front copper layer *');
  L.push('G04 Board: ' + c.name + ' *');
  L.push('%FSLAX26Y26Y26*%');
  L.push('%MOMM*%');
  L.push('%LPD*%');
  L.push('G01*');
  /* Aperture D10: round pad flash. D11: thin trace. D12: board outline. */
  L.push('%ADD10C,1.700000*%');
  L.push('%ADD11C,0.250000*%');
  L.push('%ADD12C,0.100000*%');

  const flashes = [];
  for (const cp of board.components) {
    for (const p of cp.pads) {
      if (p.shape === 'roundrect' && p.drill === 0) continue; // SMD diodes live on F.Cu too, keep them
      flashes.push([p.x, p.y]);
    }
  }
  for (const [x, y] of flashes) {
    L.push('D10*');
    L.push('X' + mm(x) + 'Y' + mm(y) + 'D03*');
  }
  L.push('D11*');
  for (const t of board.traces) {
    if (t.layer !== 'F.Cu') continue;
    for (let i = 0; i < t.points.length; i++) {
      const [x, y] = t.points[i];
      L.push('X' + mm(x) + 'Y' + mm(y) + (i === 0 ? 'D02*' : 'D01*'));
    }
  }
  L.push('D12*');
  for (let i = 0; i < board.edge.length; i++) {
    const [x, y] = board.edge[i];
    L.push('X' + mm(x) + 'Y' + mm(y) + (i === 0 ? 'D02*' : 'D01*'));
  }
  L.push('M02*');
  return L.join('\n') + '\n';
}

/* ===================================================================== *
 * 9. Firmware: KMK kb.py and QMK bundle
 * ===================================================================== */

function generateKMK(config) {
  const board = buildBoard(config);
  const c = board.config;
  const p = board.netlist.pins;
  const L = [];
  L.push('# ' + c.name);
  L.push('# KMK firmware generated by PadCraft for Hack Club ' + c.program + '.');
  L.push('# Copy this file to the CIRCUITPY drive as code.py (or kb.py imported by code.py).');
  L.push('#');
  L.push('# Matrix: ' + c.rows + ' rows x ' + c.cols + ' cols, COL2ROW diodes.');
  L.push('# RP2040 pins: rows ' + p.rows.join(', ') + ' | cols ' + p.cols.join(', '));
  L.push('');
  L.push('import board');
  L.push('');
  L.push('from kmk.kmk_keyboard import KMKKeyboard');
  L.push('from kmk.keys import KC');
  L.push('from kmk.scanners import DiodeOrientation');
  if (p.encoder) L.push('from kmk.modules.encoder import EncoderModule');
  if (p.sensor.length) L.push('from kmk.modules.analog import AnalogModule');
  L.push('');
  L.push('keyboard = KMKKeyboard()');
  L.push('');
  L.push('# Column pins are driven, row pins are read. Diodes face the rows.');
  L.push('keyboard.col_pins = (' + p.cols.map(x => 'board.' + x).join(', ') + (p.cols.length === 1 ? ',' : '') + ')');
  L.push('keyboard.row_pins = (' + p.rows.map(x => 'board.' + x).join(', ') + (p.rows.length === 1 ? ',' : '') + ')');
  L.push('keyboard.diode_orientation = DiodeOrientation.COL2ROW');
  L.push('');
  if (p.encoder) {
    L.push('# Rotary encoder: A, B and the push button.');
    L.push('encoder = EncoderModule()');
    L.push('encoder.pins = ((board.' + p.encoder.a + ', board.' + p.encoder.b +
           ', board.' + p.encoder.sw + ', False),)');
    L.push('encoder.map = [((KC.VOLU, KC.VOLD, KC.MUTE),)]');
    L.push('keyboard.modules.append(encoder)');
    L.push('');
  }
  L.push('# Layer 0. Edit these keycodes to build your own layout.');
  L.push('keyboard.keymap = [');
  L.push('    [');
  for (const row of board.keymap) {
    L.push('        ' + row.map(k => k).join(', ') + ',');
  }
  L.push('    ],');
  L.push(']');
  L.push('');
  if (p.sensor.length) {
    L.push('# Analog sensor inputs (RP2040 ADC pins).');
    L.push('# ' + p.sensor.join(', ') + ' map to nets ' +
      p.sensor.map((_, i) => 'SENSOR' + i).join(', ') + '.');
    L.push('');
  }
  L.push('if __name__ == "__main__":');
  L.push('    keyboard.go()');
  L.push('');
  return L.join('\n');
}

function generateQMK(config) {
  const board = buildBoard(config);
  const c = board.config;
  const p = board.netlist.pins;
  const tag = 'ortho_' + c.rows + 'x' + c.cols;
  const macro = 'LAYOUT_' + tag;

  const layout = [];
  for (let r = 0; r < c.rows; r++) {
    for (let col = 0; col < c.cols; col++) {
      layout.push({ matrix: [r, col], x: col, y: r });
    }
  }
  const info = {
    keyboard_name: c.name,
    manufacturer: 'PadCraft',
    maintainer: 'Hack Club ' + c.program,
    processor: 'RP2040',
    bootloader: 'rp2040',
    diode_direction: 'COL2ROW',
    matrix_pins: { cols: p.cols.slice(), rows: p.rows.slice() },
    layouts: { [macro]: { layout } },
  };
  if (p.encoder) {
    info.encoder = { rotary: [{ pin_a: p.encoder.a, pin_b: p.encoder.b, resolution: 4 }] };
    info.encoder.rotary[0].pin_push = p.encoder.sw;
  }

  const keymapRows = board.keymap.map(row =>
    '        ' + row.map(k => k.replace(/^KC\./, 'KC_')).join(', ') + ',').join('\n');
  const keymap = [
    '// QMK keymap generated by PadCraft for Hack Club ' + c.program + '.',
    '#include QMK_KEYBOARD_H',
    '',
    'const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {',
    '    [0] = ' + macro + '(',
    keymapRows,
    '    ),',
    '};',
    '',
  ].join('\n');

  const configH = [
    '// PadCraft generated config.h',
    '#pragma once',
    '#define MATRIX_ROWS ' + c.rows,
    '#define MATRIX_COLS ' + c.cols,
    '#define DIODE_DIRECTION COL2ROW',
    '#define RP2040_BOOTLOADER_DOUBLE_TAP_RESET',
    '',
  ].join('\n');

  const rules = [
    '# PadCraft generated rules.mk',
    'MCU = RP2040',
    'BOOTLOADER = rp2040',
    'ENCODER_ENABLE = ' + (p.encoder ? 'yes' : 'no'),
    '',
  ].join('\n');

  return { 'keyboard.json': JSON.stringify(info, null, 2) + '\n',
           'keymap.c': keymap, 'config.h': configH, 'rules.mk': rules };
}

/* ===================================================================== *
 * 10. Bundles and CLI
 * ===================================================================== */

function generateAll(config) {
  const c = clampConfig(config);
  const base = slug(c.name);
  return {
    [base + '.kicad_pcb']: generateKiCadPcb(c),
    [base + '_plate.stl']: generateSTL(c),
    [base + '_plate.scad']: generateOpenSCAD(c),
    [base + '_F_Cu.gbr']: generateGerberFCu(c),
    'kb.py': generateKMK(c),
    'qmk_bundle.json': JSON.stringify(generateQMK(c), null, 2) + '\n',
    'padcraft_config.json': JSON.stringify(c, null, 2) + '\n',
  };
}

const CLI_HELP = [
  'PadCraft - parametric macropad CAD, KiCad, Gerber and firmware generator',
  '',
  'Usage: node cad.js <command> [options]',
  '',
  'Commands:',
  '  kicad     Write a KiCad .kicad_pcb S-expression board',
  '  stl       Write an ASCII STL switch plate',
  '  scad      Write a parametric OpenSCAD plate and case',
  '  gerber    Write an RS-274X front copper Gerber',
  '  kmk       Write KMK firmware kb.py',
  '  qmk       Write a QMK bundle as JSON (keyboard.json, keymap.c, ...)',
  '  preview   Write the board model as JSON for custom renderers',
  '  validate  Check a KiCad file for S-expression and netlist validity',
  '  check     Validate every generated artifact and print a report',
  '  all       Write every artifact into --out (a directory)',
  '  presets   List the Hack Club program presets',
  '',
  'Options:',
  '  --rows N            Matrix rows (1..6)',
  '  --cols N            Matrix columns (1..8)',
  '  --program NAME      Hackpad, OnBoard, Sprig or Blot',
  '  --name NAME         Board name',
  '  --switch-type TYPE  MX or Choc',
  '  --key-spacing MM    Key pitch, default 19.05',
  '  --cutout MM         Switch plate opening, default 14',
  '  --thickness MM      Plate thickness, default 3',
  '  --margin MM         Edge margin, default 10',
  '  --encoder BOOL      true or false',
  '  --sensor BOOL       true or false',
  '  --sensor-count N    1..3',
  '  --pin-offset N      Skip N GPIOs at the start of the pool',
  '  --config FILE       Load options from a JSON file',
  '  --out FILE          Output path (or directory for all)',
  '  --in FILE           Input file for validate',
  '',
  'Examples:',
  '  node cad.js kicad --rows 3 --cols 4 --out board.kicad_pcb',
  '  node cad.js stl --program Sprig --out plate.stl',
  '  node cad.js all --config padcraft_config.json --out ./build',
  '  node cad.js check --rows 4 --cols 5',
  '',
].join('\n');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') !== 0) continue;
    const key = a.slice(2);
    let value = true;
    if (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) { value = argv[++i]; }
    const camel = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    out[camel] = value;
  }
  return out;
}

function loadConfig(args) {
  let raw = {};
  if (args.config && typeof args.config === 'string') {
    raw = JSON.parse(require('fs').readFileSync(args.config, 'utf8'));
  }
  if (args.program && typeof args.program === 'string') Object.assign(raw, applyProgram(args.program));
  const map = {
    rows: 'rows', cols: 'cols', name: 'name', keySpacing: 'keySpacing',
    switchCutout: 'switchCutout', plateThickness: 'plateThickness',
    edgeMargin: 'edgeMargin', switchType: 'switchType', sensorCount: 'sensorCount',
    pinOffset: 'pinOffset', encoderPosition: 'encoderPosition',
    encoderDiameter: 'encoderDiameter',
  };
  for (const [argKey, cfgKey] of Object.entries(map)) {
    if (args[argKey] !== undefined) raw[cfgKey] = args[argKey];
  }
  for (const flag of ['encoder', 'sensor']) {
    if (args[flag] !== undefined) {
      const v = args[flag];
      raw[flag] = v === true || v === 'true' || v === '1' || v === 'yes';
    }
  }
  for (const numKey of ['rows', 'cols', 'keySpacing', 'switchCutout', 'plateThickness',
    'edgeMargin', 'sensorCount', 'pinOffset', 'encoderDiameter']) {
    if (raw[numKey] !== undefined) raw[numKey] = Number(raw[numKey]);
  }
  return clampConfig(raw);
}

function runCLI(argv) {
  const cmd = (argv[0] || 'help').toLowerCase();
  const args = parseArgs(argv.slice(1));
  const fs = require('fs');
  const path = require('path');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(CLI_HELP); return; }
  if (cmd === 'presets') {
    for (const [k, v] of Object.entries(PROGRAMS)) {
      process.stdout.write(k.padEnd(10) + ' rows=' + v.rows + ' cols=' + v.cols +
        ' encoder=' + v.encoder + ' sensor=' + v.sensor + '  ' + v.note + '\n');
    }
    return;
  }
  if (cmd === 'validate') {
    const file = args.in || args.out;
    if (!file || typeof file !== 'string') throw new Error('validate needs --in FILE');
    const res = validateKiCadPcb(fs.readFileSync(file, 'utf8'));
    process.stdout.write(JSON.stringify({ valid: res.valid, errors: res.errors,
      nets: res.nets.length, footprints: res.footprints, pads: res.pads }, null, 2) + '\n');
    process.exitCode = res.valid ? 0 : 1;
    return;
  }

  const cfg = loadConfig(args);
  let result;
  switch (cmd) {
    case 'kicad': result = { [args.out || (slug(cfg.name) + '.kicad_pcb')]: generateKiCadPcb(cfg) }; break;
    case 'stl': result = { [args.out || (slug(cfg.name) + '_plate.stl')]: generateSTL(cfg) }; break;
    case 'scad': result = { [args.out || (slug(cfg.name) + '_plate.scad')]: generateOpenSCAD(cfg) }; break;
    case 'gerber': result = { [args.out || (slug(cfg.name) + '_F_Cu.gbr')]: generateGerberFCu(cfg) }; break;
    case 'kmk': result = { [args.out || 'kb.py']: generateKMK(cfg) }; break;
    case 'qmk': result = { [args.out || 'qmk_bundle.json']: JSON.stringify(generateQMK(cfg), null, 2) + '\n' }; break;
    case 'preview': result = { [args.out || 'padcraft_preview.json']: JSON.stringify(buildBoard(cfg), null, 2) + '\n' }; break;
    case 'all': {
      result = generateAll(cfg);
      const dir = args.out || './build';
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(result)) fs.writeFileSync(path.join(dir, name), body);
      process.stdout.write('Wrote ' + Object.keys(result).length + ' files to ' + dir + '\n');
      return;
    }
    case 'check': {
      const board = buildBoard(cfg);
      const pcb = generateKiCadPcb(cfg);
      const v = validateKiCadPcb(pcb);
      const mesh = buildPlateMesh(cfg);
      const badNormals = mesh.facets.filter(t => {
        const len = Math.sqrt(t.n[0] ** 2 + t.n[1] ** 2 + t.n[2] ** 2);
        return Math.abs(len - 1) > 1e-6;
      });
      const report = {
        board: cfg.name, program: cfg.program,
        size_mm: [board.layout.width, board.layout.height],
        keys: board.stats.keys, diodes: board.stats.diodes,
        pins: board.netlist.pins.needed, nets: board.stats.nets,
        kicad_valid: v.valid, kicad_errors: v.errors,
        kicad_footprints: v.footprints, kicad_pads: v.pads,
        stl_triangles: mesh.facets.length, stl_bad_normals: badNormals.length,
        kmk_has_keymap: generateKMK(cfg).includes('keyboard.keymap = ['),
        qmk_has_matrix: generateQMK(cfg)['keyboard.json'].includes('matrix_pins'),
      };
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exitCode = (v.valid && badNormals.length === 0) ? 0 : 1;
      return;
    }
    default:
      throw new Error('Unknown command: ' + cmd + '\n\n' + CLI_HELP);
  }
  const [name, body] = Object.entries(result)[0];
  fs.mkdirSync(path.dirname(path.resolve(name)), { recursive: true });
  fs.writeFileSync(name, body);
  process.stdout.write('Wrote ' + name + ' (' + Buffer.byteLength(body) + ' bytes)\n');
}

/* ===================================================================== *
 * 11. Exports
 * ===================================================================== */

const api = {
  PROGRAMS, DEFAULT_CONFIG, PICO_PINOUT, RP2040_GPIO_POOL, RP2040_ADC_POOL,
  CLI_HELP,
  f, clamp, clampConfig, applyProgram, defaultKeymap, normaliseKeymap, slug,
  computeLayout, buildPinAssignment, buildNetlist, buildBoard,
  generateKiCadPcb, tokenizeSexp, parseSexp, validateSexp, validateKiCadPcb,
  computeNormal, emitQuadTriangles, buildPlateMesh, generateSTL,
  generateOpenSCAD, generateGerberFCu, generateKMK, generateQMK,
  generateAll, loadConfig, parseArgs, runCLI,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PadCraft = api;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  try {
    runCLI(process.argv.slice(2));
  } catch (e) {
    process.stderr.write('PadCraft error: ' + e.message + '\n');
    process.exitCode = 1;
  }
}
