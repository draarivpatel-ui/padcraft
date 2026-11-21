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

function numeric(value, fallback) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const result = Number(value);
  return Number.isNaN(result) ? fallback : result;
}

function clampConfig(input) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError('Configuration must be a JSON object.');
  }
  const base = { ...DEFAULT_CONFIG, ...applyProgram(input && input.program) };
  const c = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key =>
    [key, input && Object.prototype.hasOwnProperty.call(input, key) ? input[key] : base[key]]));
  c.name = String(c.name || DEFAULT_CONFIG.name).replace(/["\\*\x00-\x1f\x7f]/g, '').trim().slice(0, 64) || DEFAULT_CONFIG.name;
  if (!Object.prototype.hasOwnProperty.call(PROGRAMS, c.program)) c.program = 'Hackpad';
  c.rows = Math.round(clamp(numeric(c.rows, 3), 1, 6));
  c.cols = Math.round(clamp(numeric(c.cols, 4), 1, 8));
  c.keySpacing = clamp(numeric(c.keySpacing, 19.05), 18, 24);
  c.switchCutout = clamp(numeric(c.switchCutout, 14), 10, Math.min(16, c.keySpacing - 1));
  c.plateThickness = clamp(numeric(c.plateThickness, 3), 1, 8);
  c.edgeMargin = clamp(numeric(c.edgeMargin, 10), 5, 24);
  c.boardThickness = clamp(numeric(c.boardThickness, 1.6), 0.6, 3.2);
  c.encoderDiameter = clamp(numeric(c.encoderDiameter, 7.2), 5, 12);
  c.mountHoleDiameter = clamp(numeric(c.mountHoleDiameter, 2.4), 1.5, 4);
  c.sensorCount = Math.round(clamp(numeric(c.sensorCount, 1), 1, 3));
  c.pinOffset = Math.round(clamp(numeric(c.pinOffset, 0), 0, 6));
  c.switchType = c.switchType === 'Choc' ? 'Choc' : 'MX';
  const enabled = value => typeof value === 'string' ? /^(true|1|yes)$/i.test(value) : !!value;
  c.encoder = enabled(c.encoder);
  c.sensor = enabled(c.sensor);
  if (!['top-left', 'top-center', 'top-right'].includes(c.encoderPosition)) {
    c.encoderPosition = 'top-center';
  }
  c.keymap = c.keymap === null ? null : normaliseKeymap(c);
  return c;
}

function applyProgram(program) {
  const p = Object.prototype.hasOwnProperty.call(PROGRAMS, program) ? PROGRAMS[program] : null;
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
  const flat = Array.isArray(km[0]) ? km.slice(0, config.rows).map(r => Array.isArray(r) ? r.slice(0, config.cols) : []) : null;
  if (flat) {
    return Array.from({ length: config.rows }, (_, r) =>
      Array.from({ length: config.cols }, (_, c) =>
        sanitizeKeycode((flat[r] && flat[r][c]) || 'KC.NO')));
  }
  const list = km.map(sanitizeKeycode);
  let i = 0;
  return Array.from({ length: config.rows }, () =>
    Array.from({ length: config.cols }, () => list[i++] || 'KC.NO'));
}

function sanitizeKeycode(value) {
  const key = String(value || '').trim().toUpperCase();
  const qualified = key.startsWith('KC.') ? key : 'KC.' + key;
  return /^KC\.[A-Z][A-Z0-9_]*(\([0-9]+\))?$/.test(qualified) ? qualified : 'KC.NO';
}

/* The standard KMK keycode space: every flat name PadCraft can legitimately
 * emit into generated KMK firmware (and into QMK via the KC_ name). Anything
 * outside this set, such as KC.NOT_A_KEY, a bare KC.MO with no layer
 * argument or any layer-switch keycode, is invalid and must fail design
 * validation instead of reaching a firmware artifact. */
const KMK_FLAT_KEYCODES = [
  'KC.NO', 'KC.TRNS',
  'KC.ESC', 'KC.ENT', 'KC.TAB', 'KC.SPC', 'KC.BSPC', 'KC.DEL', 'KC.INS',
  'KC.HOME', 'KC.END', 'KC.PGUP', 'KC.PGDN',
  'KC.UP', 'KC.DOWN', 'KC.LEFT', 'KC.RIGHT', 'KC.RGHT',
  'KC.CAPS', 'KC.PSCR', 'KC.PAUS',
  'KC.LCTL', 'KC.LSFT', 'KC.LALT', 'KC.LGUI',
  'KC.RCTL', 'KC.RSFT', 'KC.RALT', 'KC.RGUI',
  'KC.MINS', 'KC.EQL', 'KC.LBRC', 'KC.RBRC', 'KC.BSLS',
  'KC.SCLN', 'KC.QUOT', 'KC.GRV', 'KC.COMM', 'KC.DOT', 'KC.SLSH',
  'KC.PSLS', 'KC.PAST', 'KC.PMNS', 'KC.PPLS', 'KC.PENT',
  'KC.PDOT', 'KC.PEQL', 'KC.PCMM',
  'KC.KP_SLASH', 'KC.KP_ASTERISK', 'KC.KP_MINUS', 'KC.KP_PLUS',
  'KC.KP_ENTER', 'KC.KP_DOT', 'KC.KP_EQUAL', 'KC.KP_COMMA',
  'KC.MUTE', 'KC.VOLU', 'KC.VOLD', 'KC.BRIU', 'KC.BRID',
  'KC.MNXT', 'KC.MPRV', 'KC.MSTP', 'KC.MPLY', 'KC.EJCT',
  'KC.MFFD', 'KC.MRWD',
];
for (let i = 0; i < 26; i++) KMK_FLAT_KEYCODES.push('KC.' + String.fromCharCode(65 + i));
for (let i = 0; i <= 9; i++) KMK_FLAT_KEYCODES.push('KC.N' + i, 'KC.P' + i, 'KC.KP_' + i);
for (let i = 1; i <= 24; i++) KMK_FLAT_KEYCODES.push('KC.F' + i);
const VALID_KMK_KEYCODES = new Set(KMK_FLAT_KEYCODES);

/* Layer-switching keycodes take a single layer argument 0-15 and exist in
 * both KMK (KC.MO(1)) and QMK (MO(1)) forms. KMK has no OSL, and LM/LT/FD
 * take extra arguments. The pattern is retained so kmkToQmk can still name
 * the QMK forms, but the generated KMK firmware never imports or
 * instantiates kmk.modules.layers.Layers, so every layer switch crashes on
 * hardware. isValidKeycode therefore accepts flat keycodes only: no
 * layer-switch keycode, including a switch to layer 0, is valid. */
const LAYER_KEYCODE_RE = /^KC\.(MO|TG|TO|TT|DF)\(([0-9]|1[0-5])\)$/;

function isValidKeycode(key) {
  return typeof key === 'string' && VALID_KMK_KEYCODES.has(key);
}

/* The generated KMK and QMK firmware defines exactly one layer (layer 0).
 * A layer-switch keycode may only target layer 0 to name an existing
 * layer; anything higher references a layer absent from the exports. This
 * is a layer-existence check only: isValidKeycode already rejects every
 * layer-switch keycode because the KMK firmware ships without the Layers
 * module. */
const DEFINED_KEYMAP_LAYERS = 1;

function keycodeLayer(key) {
  const match = LAYER_KEYCODE_RE.exec(String(key));
  return match ? Number(match[2]) : null;
}

function keycodeLayerDefined(key) {
  const layer = keycodeLayer(key);
  return layer === null || layer < DEFINED_KEYMAP_LAYERS;
}

/* KMK spells keycodes KC.X and KC.MO(n); QMK spells them KC_X and MO(n). */
function kmkToQmk(key) {
  const layer = LAYER_KEYCODE_RE.exec(String(key));
  if (layer) return layer[1] + '(' + layer[2] + ')';
  return String(key).replace(/^KC\.N([0-9])$/, 'KC_$1').replace(/^KC\./, 'KC_');
}

function stableUuid(namespace, index) {
  return '70616463-7261-4674-8' + String(namespace).padStart(3, '0') + '-' + String(index).padStart(12, '0');
}

const SHOWCASES = {
  studio: { label: 'Studio control', description: '12 shortcuts, one volume dial, two copper layers.',
    config: { ...DEFAULT_CONFIG, name: 'Studio Control', keymap: [['KC.MUTE', 'KC.VOLD', 'KC.VOLU', 'KC.MPLY'], ['KC.F1', 'KC.F2', 'KC.F3', 'KC.F4'], ['KC.LEFT', 'KC.DOWN', 'KC.UP', 'KC.RGHT']] } },
  sensor: { label: 'Sensor console', description: 'Six keys and three dedicated analog channels.',
    config: { ...DEFAULT_CONFIG, ...applyProgram('OnBoard'), name: 'Sensor Console', sensorCount: 3 } },
  compact: { label: 'Pocket instrument', description: 'Eight low profile keys with a rotary dial.',
    config: { ...DEFAULT_CONFIG, ...applyProgram('Sprig'), name: 'Pocket Instrument', rows: 2, cols: 4, keySpacing: 18 } },
  sweep: { label: '48-key stress test', description: 'Maximum matrix, encoder and all ADC headers.',
    config: { ...DEFAULT_CONFIG, name: 'Matrix 48', rows: 6, cols: 8, encoder: true, sensor: true, sensorCount: 3, pinOffset: 6 } },
};

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
  const keyWidth = 2 * c.edgeMargin + Math.max(c.cols * c.keySpacing, c.sensor ? (c.sensorCount + 1) * 9 : 0);
  const controllerBay = 32;
  const width = keyWidth + controllerBay;
  const height = Math.max(2 * c.edgeMargin + c.rows * c.keySpacing + topBand + bottomBand,
    55 + 2 * c.edgeMargin);

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
      : c.encoderPosition === 'top-right' ? keyWidth - c.edgeMargin - 12
      : keyWidth / 2;
    encoder = { x: ex, y: topBand / 2 + 2, diameter: c.encoderDiameter };
  }

  const sensors = [];
  if (c.sensor) {
    for (let i = 0; i < c.sensorCount; i++) {
      sensors.push({
        ref: 'J' + (i + 1),
        x: c.edgeMargin + (i + 1) * (keyWidth - 2 * c.edgeMargin) / (c.sensorCount + 1),
        y: height - bottomBand / 2 - 1,
      });
    }
  }

  const mountX = [c.edgeMargin / 2, width - c.edgeMargin / 2];
  const mountY = [c.edgeMargin / 2 + topBand * 0.35, height - c.edgeMargin / 2 - bottomBand * 0.35];
  const mounts = [];
  /* The Pico pad column sits inside the controller bay and can reach the
   * corner mount lanes on short boards. Each lane bends vertically so a
   * nominal bore keeps copper clearance from the pad envelopes; a wider
   * requested bore that still clips is reported by the drill audit. */
  const padHalf = 0.85;
  const mountLaneClearance = 0.2;
  const nominalReach = 1.8 + mountLaneClearance;
  const picoPadCx = keyWidth + controllerBay / 2 + 8.89;
  const padTop = height / 2 - 19 * 2.54 / 2 - padHalf;
  const padBottom = height / 2 + 19 * 2.54 / 2 + padHalf;
  for (const mx of mountX) {
    const dxEff = Math.max(0,
      Math.min(Math.abs(mx - picoPadCx), Math.abs(mx - (picoPadCx - 2 * 8.89))) - padHalf);
    const dyNeeded = dxEff >= nominalReach ? 0 :
      Math.sqrt(nominalReach * nominalReach - dxEff * dxEff);
    for (const my of mountY) {
      let y = my;
      if (dyNeeded > 0) {
        y = my < height / 2 ? Math.min(my, padTop - dyNeeded) : Math.max(my, padBottom + dyNeeded);
      }
      mounts.push({ x: mx, y });
    }
  }

  const cutouts = keys.map(k => ({ x: k.x, y: k.y, w: c.switchCutout, h: c.switchCutout, kind: 'switch' }));
  if (encoder) cutouts.push({ x: encoder.x, y: encoder.y, w: c.encoderDiameter, h: c.encoderDiameter, kind: 'encoder' });
  for (const m of mounts) cutouts.push({ x: m.x, y: m.y, w: c.mountHoleDiameter, h: c.mountHoleDiameter, kind: 'mount' });

  return { config: c, width, height, keyWidth, controllerBay, topBand, bottomBand, keys, encoder, sensors, mounts, cutouts };
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

  const pushDrill = (x, y, d, plated) => drillPoints.push({ x, y, diameter: d, plated: !!plated });

  /* Switch footprints. Offsets follow a Cherry MX / Kailh Choc switch body. */
  for (const k of layout.keys) {
    const a = netlist.assignments.find(as => as.row === k.row && as.col === k.col);
    const electricalOffsets = c.switchType === 'Choc' ? [[0, 5.9], [5, 3.8]] : [[-3.81, 2.54], [2.54, 5.08]];
    const pads = electricalOffsets.map((offset, i) => ({ num: String(i + 1),
      x: k.x + offset[0], y: k.y + offset[1], shape: 'circle', w: 2, h: 2,
      drill: 1, net: net(i === 0 ? a.colNet : a.keyNet) }));
    const supportOffset = c.switchType === 'Choc' ? 5.5 : 5.08;
    const npth = [
      { num: '', x: k.x - supportOffset, y: k.y, drill: c.switchType === 'Choc' ? 1.9 : 1.7 },
      { num: '', x: k.x + supportOffset, y: k.y, drill: c.switchType === 'Choc' ? 1.9 : 1.7 },
      { num: '', x: k.x, y: k.y, drill: c.switchType === 'Choc' ? 3.4 : 4 },
    ];
    for (const p of pads) pushDrill(p.x, p.y, p.drill, true);
    for (const p of npth) pushDrill(p.x, p.y, p.drill);
    components.push({
      ref: k.ref, value: 'SW_' + c.switchType.toUpperCase(), x: k.x, y: k.y,
      lib: 'PadCraft:SW_' + c.switchType.toUpperCase(), kind: 'switch',
      pads, npth, outline: { w: 15.6, h: 15.6 },
      silk: [{ x: 0, y: -9, text: k.ref }],
    });
  }

  /* One series diode per key, placed in the gap above its switch. */
  for (const k of layout.keys) {
    const a = netlist.assignments.find(as => as.row === k.row && as.col === k.col);
    const dx = k.x + 6, dy = k.y - c.keySpacing / 2;
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
    const columnPads = components.filter(cp => cp.kind === 'switch').map(cp => cp.pads[0])
      .filter((pad, i) => i % c.cols === col);
    const x = columnPads[0].x - (c.switchType === 'Choc' ? 3 : 0);
    const ys = columnPads.map(p => p.y);
    const top = Math.min(...ys) - 3;
    const bottom = Math.max(...ys) + 3;
    traces.push({ net: 'COL' + col, layer: 'B.Cu', width: 0.25,
      points: [[x, top], [x, bottom]] });
    for (const p of columnPads) if (p.x !== x) traces.push({ net: 'COL' + col, layer: 'B.Cu', width: 0.25,
      points: [[p.x, p.y], [x, p.y]] });
  }
  for (let r = 0; r < c.rows; r++) {
    const y = layout.keys.find(k => k.row === r).y - c.keySpacing / 2 - 1.5;
    const xs = layout.keys.filter(k => k.row === r).map(k => k.x + 6 + 1.65);
    const left = Math.min.apply(null, xs) - c.keySpacing / 2;
    const right = Math.max.apply(null, xs);
    traces.push({ net: 'ROW' + r, layer: 'F.Cu', width: 0.25,
      points: [[left, y], [right, y]] });
  }

  for (const k of layout.keys) {
    const assignment = netlist.assignments[k.row * c.cols + k.col];
    const sw = components.find(cp => cp.ref === k.ref);
    const diode = components.find(cp => cp.ref === assignment.diode);
    const node = sw.pads[1], anode = diode.pads[0], cathode = diode.pads[1];
    traces.push({ net: assignment.keyNet, layer: 'F.Cu', width: 0.25,
      points: [[node.x, node.y], [k.x + 7, node.y], [k.x + 7, anode.y + 2], [anode.x, anode.y + 2], [anode.x, anode.y]] });
    traces.push({ net: assignment.rowNet, layer: 'F.Cu', width: 0.25,
      points: [[cathode.x, cathode.y], [cathode.x, k.y - c.keySpacing / 2 - 1.5]] });
  }

  /* Rotary encoder (EC11 style): A, B, common, plus a push switch. */
  if (layout.encoder) {
    const e = layout.encoder;
    const pads = [
      { num: '1', x: e.x - 2.5, y: e.y + 7.5, shape: 'circle', w: 1.8, h: 1.8, drill: 1, net: net('ENC_A') },
      { num: '3', x: e.x + 2.5, y: e.y + 7.5, shape: 'circle', w: 1.8, h: 1.8, drill: 1, net: net('ENC_B') },
      { num: '2', x: e.x, y: e.y + 7.5, shape: 'circle', w: 1.8, h: 1.8, drill: 1, net: net('GND') },
      { num: '4', x: e.x - 2.5, y: e.y - 7, shape: 'circle', w: 1.8, h: 1.8, drill: 1, net: net('ENC_SW') },
      { num: '5', x: e.x + 2.5, y: e.y - 7, shape: 'circle', w: 1.8, h: 1.8, drill: 1, net: net('GND') },
    ];
    for (const p of pads) pushDrill(p.x, p.y, p.drill, true);
    const mountingSlots = [-5.6, 5.6].map(offset => ({ num: '', x: e.x + offset, y: e.y, drill: 2.1, w: 2.1, h: 2.8 }));
    for (const slot of mountingSlots) drillPoints.push({ x: slot.x, y: slot.y, diameter: 2.1, plated: false,
      slot: [[slot.x, slot.y - 0.35], [slot.x, slot.y + 0.35]] });
    components.push({
      ref: 'ENC1', value: 'RotaryEncoder_Alps_EC11E-Switch', x: e.x, y: e.y,
      lib: 'PadCraft:RotaryEncoder_EC11', kind: 'encoder',
      pads, npth: mountingSlots,
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
      for (const p of pads) pushDrill(p.x, p.y, p.drill, true);
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
  const picoX = layout.keyWidth + layout.controllerBay / 2;
  const picoY = layout.height / 2;
  const picoPads = [];
  for (let i = 0; i < 40; i++) {
    const side = i < 20 ? -1 : 1;
    const rowOnSide = i < 20 ? i : 39 - i;
    const py = picoY - 19 * 2.54 / 2 + rowOnSide * 2.54;
    const px = picoX + side * 8.89;
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
    pushDrill(px, py, 0.9, true);
  }
  components.push({
    ref: 'U1', value: 'RP2040_Pico', x: picoX, y: picoY,
    lib: 'PadCraft:RP2040_Pico', kind: 'mcu',
    pads: picoPads, npth: [], outline: { w: picoW, h: picoH },
    silk: [{ x: 0, y: -picoH / 2 - 2, text: 'U1 RP2040' }],
  });

  /* Board outline. */
  const edge = [[0, 0], [layout.width, 0], [layout.width, layout.height], [0, layout.height], [0, 0]];
  layout.mounts.forEach((m, i) => {
    drillPoints.push({ x: m.x, y: m.y, diameter: c.mountHoleDiameter, plated: false, ref: 'H' + (i + 1) });
    silk.push({ x: m.x, y: m.y - 4, text: 'M2' });
  });

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
    '      (pad "' + p.num + '" np_thru_hole ' + (p.w && p.h && p.w !== p.h ? 'oval' : 'circle') +
    '\n        (at ' + f(p.x - cp.x) + ' ' + f(p.y - cp.y) + ')' +
    '\n        (size ' + f(p.w || p.drill) + ' ' + f(p.h || p.drill) + ')' +
    '\n        (drill ' + (p.w && p.h && p.w !== p.h ? 'oval ' + f(p.w) + ' ' + f(p.h) : f(p.drill)) + ')' +
    '\n        (layers "*.Cu" "*.Mask")\n      )').join('\n');
  const texts = (cp.silk || []).filter(t => t.text !== cp.ref).map(t =>
    '      (fp_text user "' + t.text + '" (at ' + f(t.x) + ' ' + f(t.y) + ')' +
    ' (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))').join('\n');
  const outline = cp.outline
    ? '      (fp_rect (start ' + f(-cp.outline.w / 2) + ' ' + f(-cp.outline.h / 2) + ')' +
      ' (end ' + f(cp.outline.w / 2) + ' ' + f(cp.outline.h / 2) + ')' +
      ' (stroke (width 0.12) (type default)) (fill none) (layer "F.SilkS"))'
    : '';
  return '    (footprint "' + cp.lib + '" (layer "F.Cu")' +
    '\n      (uuid "' + stableUuid(1, index) + '")' +
    '\n      (at ' + f(cp.x) + ' ' + f(cp.y) + ')' +
    '\n      (attr ' + (cp.pads.every(p => p.drill === 0) ? 'smd' : 'through_hole') + ')' +
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
  L.push('  (generator_version "2.0")');
  L.push('  (general');
  L.push('    (thickness ' + f(c.boardThickness) + ')');
  L.push('  )');
  L.push('  (paper "A4")');
  L.push('  (title_block');
  L.push('    (title "' + c.name + '")');
  L.push('    (rev "B")');
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
  let trackIndex = 0;
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
      L.push('    (uuid "' + stableUuid(2, trackIndex++) + '")');
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
    L.push('    (uuid "' + stableUuid(3, i) + '")');
    L.push('  )');
  }
  /* Mounting holes as NPTH pads in a board level footprint. */
  for (let i = 0; i < board.layout.mounts.length; i++) {
    const m = board.layout.mounts[i];
    L.push('  (footprint "PadCraft:MountingHole_2.2mm_M2" (layer "F.Cu")');
    L.push('    (uuid "' + stableUuid(4, i) + '")');
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
  const empty = () => ({ valid: false, errors, nets: [], footprints: 0, pads: 0, padEntries: [] });
  if (!base.valid) return empty();
  if (base.forms.length !== 1) errors.push('Expected exactly one root form, found ' + base.forms.length);
  const root = base.forms[0];
  if (head(root) !== 'kicad_pcb') {
    errors.push('Root form must be kicad_pcb, found ' + head(root));
    return empty();
  }
  const childOf = (form, name) => form.find(child => Array.isArray(child) && head(child) === name);
  for (const section of ['version', 'generator', 'general', 'layers', 'setup']) {
    if (!childOf(root, section)) errors.push('Missing required ' + section + ' section');
  }
  const version = childOf(root, 'version');
  if (version && Number(version[1] && version[1].value) !== 20240108) errors.push('Expected KiCad 8 version 20240108');
  const declared = new Map(), names = new Set();
  for (const form of root) {
    if (head(form) !== 'net') continue;
    const index = Number(form[1] && form[1].value);
    const name = form[2] && form[2].value;
    if (!Number.isInteger(index) || index < 0 || typeof name !== 'string') {
      errors.push('Invalid net declaration');
      continue;
    }
    if (declared.has(index)) errors.push('Duplicate net declaration for index ' + index);
    if (names.has(name)) errors.push('Duplicate net name ' + name);
    declared.set(index, name);
    names.add(name);
  }
  if (declared.get(0) !== '') errors.push('Missing the mandatory (net 0 "") declaration');
  const indices = [...declared.keys()].sort((a, b) => a - b);
  if (indices.some((value, index) => value !== index)) errors.push('Net indices are not contiguous from 0');
  let footprints = 0, pads = 0;
  const padEntries = [];
  const uuids = new Set(), references = new Set();
  const coordinate = (form, name, count) => {
    const found = childOf(form, name);
    if (!found || found.length < count + 1 || found.slice(1, count + 1).some(atom => !Number.isFinite(Number(atom.value)))) {
      errors.push('Invalid ' + head(form) + ' ' + name + ' coordinates');
      return null;
    }
    return found.slice(1, count + 1).map(atom => Number(atom.value));
  };
  walk(root, form => {
    const kind = head(form);
    if (kind === 'uuid' || kind === 'tstamp') {
      const id = form[1] && form[1].value;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) errors.push('Invalid object UUID');
      if (uuids.has(id)) errors.push('Duplicate object UUID ' + id);
      uuids.add(id);
    }
    if (kind === 'footprint') {
      footprints++;
      coordinate(form, 'at', 2);
      const refs = form.filter(child => head(child) === 'fp_text' && child[1] && child[1].value === 'reference');
      if (refs.length !== 1) errors.push('Footprint must have exactly one reference text');
      const ref = refs[0] && refs[0][2] && refs[0][2].value;
      if (ref && references.has(ref)) errors.push('Duplicate component reference ' + ref);
      if (ref) references.add(ref);
      const origin = coordinate(form, 'at', 2);
      for (const pad of form.filter(child => head(child) === 'pad' && child[2] && child[2].value !== 'np_thru_hole')) {
        const at = coordinate(pad, 'at', 2), size = coordinate(pad, 'size', 2), net = childOf(pad, 'net');
        if (origin && at && size) padEntries.push({ ref, number: pad[1] && pad[1].value,
          x: origin[0] + at[0], y: origin[1] + at[1], width: size[0], height: size[1],
          net: net && net[2] ? net[2].value : null });
      }
    }
    if (kind === 'pad') {
      pads++;
      coordinate(form, 'at', 2);
      const size = coordinate(form, 'size', 2);
      if (size && size.some(value => value <= 0)) errors.push('Pad size must be positive');
      const drill = childOf(form, 'drill');
      if (drill) {
        const oval = drill[1] && drill[1].value === 'oval';
        const dimensions = drill.slice(oval ? 2 : 1, oval ? 4 : 2).map(atom => Number(atom.value));
        if (dimensions.length !== (oval ? 2 : 1) || dimensions.some((dimension, i) => !Number.isFinite(dimension) || dimension <= 0 || (size && dimension > (oval ? size[i] : Math.min(...size))))) errors.push('Invalid pad drill diameter');
      }
    }
    if (kind === 'segment') {
      coordinate(form, 'start', 2); coordinate(form, 'end', 2);
      const width = coordinate(form, 'width', 1);
      if (width && width[0] <= 0) errors.push('Track width must be positive');
      const layer = childOf(form, 'layer');
      if (!layer || !['F.Cu', 'B.Cu'].includes(layer[1] && layer[1].value)) errors.push('Track must use a declared copper layer');
    }
    if (kind === 'pad' || kind === 'segment') {
      const net = childOf(form, 'net');
      if (net) {
        const index = Number(net[1] && net[1].value);
        if (!declared.has(index)) errors.push((kind === 'pad' ? 'Pad' : 'Track') + ' references undeclared net index ' + index);
        if (net[2] && declared.get(index) !== net[2].value) errors.push('Pad net name does not match declaration at index ' + index);
      }
    }
  });
  return { valid: errors.length === 0, errors,
    nets: indices.map(index => ({ index, name: declared.get(index) })), footprints, pads, padEntries };
}

/* ===================================================================== *
 * 6. ASCII STL plate mesher
 * ===================================================================== */

/* Cross product of (b - a) and (c - a), normalised to unit length. */
function computeNormal(a, b, c) {
  if (![...a, ...b, ...c].every(Number.isFinite)) throw new TypeError('Triangle vertices must be finite.');
  let u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
  if (![...u, ...v].every(Number.isFinite)) {
    const scale = Math.max(...a.map(Math.abs), ...b.map(Math.abs), ...c.map(Math.abs));
    u = b.map((value, i) => value / scale - a[i] / scale);
    v = c.map((value, i) => value / scale - a[i] / scale);
  }
  const uScale = Math.max(...u.map(Math.abs)), vScale = Math.max(...v.map(Math.abs));
  if (uScale === 0 || vScale === 0) return [0, 0, 0];
  u = u.map(value => value / uScale); v = v.map(value => value / vScale);
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...cross);
  return length === 0 ? [0, 0, 0] : cross.map(value => value / length || 0);
}

/* Splits a quad into two triangles, recomputing a flat facet normal for each. */
function emitQuadTriangles(a, b, c, d) {
  return [
    { a, b, c, n: computeNormal(a, b, c) },
    { a: a, b: c, c: d, n: computeNormal(a, c, d) },
  ];
}

/* Vertical slabs follow every hole vertex. Shared slab edges are split at
 * every boundary event, including circular tangencies, so exported triangles
 * have no T junctions. Circular bores use 48 chord segments. */
function platePolygons(layout) {
  return layout.cutouts.map(hole => {
    if (hole.kind === 'switch') return [[hole.x - hole.w / 2, hole.y - hole.h / 2],
      [hole.x + hole.w / 2, hole.y - hole.h / 2], [hole.x + hole.w / 2, hole.y + hole.h / 2],
      [hole.x - hole.w / 2, hole.y + hole.h / 2]];
    return Array.from({ length: 48 }, (_, i) => {
      const angle = i * Math.PI * 2 / 48;
      return [hole.x + hole.w / 2 * Math.cos(angle), hole.y + hole.h / 2 * Math.sin(angle)];
    });
  }).map(polygon => polygon.map(point => point.map(value => Math.round(value * 1e6) / 1e6)));
}

function polygonArea(polygon) {
  return Math.abs(polygon.reduce((sum, point, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
}

function buildPlateMesh(config) {
  const c = clampConfig(config), layout = computeLayout(c);
  const round = value => Math.round(value * 1e6) / 1e6;
  const W = round(layout.width), H = round(layout.height);
  const T = round(c.plateThickness), polygons = platePolygons(layout);
  const edges = polygons.map(polygon => polygon.map((point, i) => [point, polygon[(i + 1) % polygon.length]]));
  const X = [...new Set([0, W, ...polygons.flat().map(point => point[0])])].filter(x => x >= 0 && x <= W).sort((a, b) => a - b);
  const yOn = (edge, x) => round(edge[0][1] + (edge[1][1] - edge[0][1]) * (x - edge[0][0]) / (edge[1][0] - edge[0][0]));
  const yEvents = x => [...new Set([0, H, ...edges.flatMap(loop => loop.flatMap(edge => {
    const lo = Math.min(edge[0][0], edge[1][0]), hi = Math.max(edge[0][0], edge[1][0]);
    if (x < lo - 1e-9 || x > hi + 1e-9) return [];
    return lo === hi ? [edge[0][1], edge[1][1]] : [yOn(edge, x)];
  }))])].sort((a, b) => a - b);
  const events = X.map(yEvents), facets = [];
  const triangle = (a, b, c) => {
    const n = computeNormal(a, b, c);
    if (Math.hypot(...n) > 0) facets.push({ a, b, c, n });
  };
  const quad = (a, b, c, d) => { triangle(a, b, c); triangle(a, c, d); };
  let cells = 0;
  for (let slab = 0; slab < X.length - 1; slab++) {
    const x0 = X[slab], x1 = X[slab + 1], mid = (x0 + x1) / 2;
    const intervals = edges.map(loop => loop.filter(edge => mid > Math.min(edge[0][0], edge[1][0]) && mid < Math.max(edge[0][0], edge[1][0]))
      .map(edge => ({ edge, y: yOn(edge, mid) })).sort((a, b) => a.y - b.y)).filter(found => found.length >= 2)
      .map(found => ({ lower: found[0].edge, upper: found[found.length - 1].edge, y: found[0].y })).sort((a, b) => a.y - b.y);
    const limits = [{ lower: null, upper: intervals[0] && intervals[0].lower }];
    intervals.forEach((interval, i) => limits.push({ lower: interval.upper, upper: intervals[i + 1] && intervals[i + 1].lower }));
    for (const limit of limits) {
      const bottom0 = limit.lower ? yOn(limit.lower, x0) : 0;
      const bottom1 = limit.lower ? yOn(limit.lower, x1) : 0;
      const top0 = limit.upper ? yOn(limit.upper, x0) : H;
      const top1 = limit.upper ? yOn(limit.upper, x1) : H;
      if ((top0 - bottom0) + (top1 - bottom1) < 1e-8) continue;
      const points = [[x0, bottom0], [x1, bottom1],
        ...events[slab + 1].filter(y => y > bottom1 && y < top1).map(y => [x1, y]), [x1, top1], [x0, top0],
        ...events[slab].filter(y => y > bottom0 && y < top0).reverse().map(y => [x0, y])];
      const clean = points.filter((point, i) => i === 0 || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1]);
      const center = [clean.reduce((sum, point) => sum + point[0], 0) / clean.length,
        clean.reduce((sum, point) => sum + point[1], 0) / clean.length];
      for (let i = 0; i < clean.length; i++) {
        const a = clean[i], b = clean[(i + 1) % clean.length];
        triangle([...center, T], [...a, T], [...b, T]);
        triangle([...center, 0], [...b, 0], [...a, 0]);
      }
      cells++;
    }
  }
  const wallLoop = (polygon, hole) => {
    polygon.forEach((a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      const cuts = [0, 1, ...X.filter(x => x > Math.min(a[0], b[0]) && x < Math.max(a[0], b[0])).map(x => (x - a[0]) / (b[0] - a[0]))].sort((a, b) => a - b);
      for (let j = 0; j < cuts.length - 1; j++) {
        const point = t => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
        const p = point(cuts[j]), q = point(cuts[j + 1]);
        if (hole) quad([...p, 0], [...p, T], [...q, T], [...q, 0]);
        else quad([...p, 0], [...q, 0], [...q, T], [...p, T]);
      }
    });
  };
  wallLoop([[0, 0], [W, 0], [W, H], [0, H]], false);
  polygons.forEach(polygon => wallLoop(polygon, true));
  return { facets, width: W, height: H, thickness: T,
    stats: { triangles: facets.length, cells, solidCells: cells, circularSegments: 48,
      expectedVolume: (W * H - polygons.reduce((sum, polygon) => sum + polygonArea(polygon), 0)) * T } };
}

function inspectMesh(mesh) {
  const edges = new Map();
  let volume = 0, badNormals = 0;
  const key = point => point.map(value => f(value, 6)).join(',');
  for (const triangle of mesh.facets) {
    const { a, b, c, n } = triangle;
    if (!Number.isFinite(Math.hypot(...n)) || Math.abs(Math.hypot(...n) - 1) > 1e-6) badNormals++;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const pk = key(p), qk = key(q), edge = pk < qk ? pk + '|' + qk : qk + '|' + pk;
      const entry = edges.get(edge) || { count: 0, winding: 0 };
      entry.count++; entry.winding += pk < qk ? 1 : -1; edges.set(edge, entry);
    }
  }
  const badEdges = [...edges.values()].filter(edge => edge.count !== 2 || edge.winding !== 0).length;
  const volumeError = Math.abs(volume - mesh.stats.expectedVolume);
  return { valid: badNormals === 0 && badEdges === 0 && volume > 0 && volumeError < 0.01,
    badNormals, badEdges, volume, expectedVolume: mesh.stats.expectedVolume, volumeError, triangles: mesh.facets.length };
}

function validateSTL(source, expectedVolume) {
  const text = String(source).trim(), lines = text.split(/\r?\n/).map(line => line.trim()), errors = [], facets = [];
  const start = /^solid ([a-zA-Z0-9_-]+)$/.exec(lines[0]);
  if (!start || lines[lines.length - 1] !== 'endsolid ' + (start && start[1])) errors.push('STL solid names must match');
  const vector = (line, prefix) => {
    if (!line || !line.startsWith(prefix)) return null;
    const values = line.slice(prefix.length).trim().split(/\s+/).map(Number);
    return values.length === 3 && values.every(Number.isFinite) ? values : null;
  };
  for (let i = 1; i < lines.length - 1; i += 7) {
    const n = vector(lines[i], 'facet normal '), a = vector(lines[i + 2], 'vertex '), b = vector(lines[i + 3], 'vertex '), c = vector(lines[i + 4], 'vertex ');
    if (!n || !a || !b || !c || lines[i + 1] !== 'outer loop' || lines[i + 5] !== 'endloop' || lines[i + 6] !== 'endfacet') {
      errors.push('Malformed STL facet at line ' + (i + 1)); continue;
    }
    const computed = computeNormal(a, b, c);
    if (n.some((value, axis) => Math.abs(value - computed[axis]) > 1e-5)) errors.push('STL facet normal does not match winding');
    facets.push({ a, b, c, n });
  }
  if (!facets.length) errors.push('STL has no triangles');
  const mesh = inspectMesh({ facets, stats: { expectedVolume: Number.isFinite(expectedVolume) ? expectedVolume : 0 } });
  if (!Number.isFinite(expectedVolume)) {
    mesh.expectedVolume = mesh.volume; mesh.volumeError = 0;
    mesh.valid = mesh.badNormals === 0 && mesh.badEdges === 0 && mesh.volume > 0;
  }
  if (!mesh.valid) errors.push('STL must be closed, consistently wound and have positive volume');
  return { ...mesh, valid: errors.length === 0, errors };
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
  /* key_spacing and edge_margin feed every mount-bore expression through
   * key_area_w, board_w and board_h, so they emit the shortest decimal
   * that round-trips to the same double (String, not f's 4 decimals):
   * the SCAD evaluator then sees bit-identical literals and the bores
   * land on board.layout.mounts exactly. */
  L.push('key_spacing       = ' + String(c.keySpacing) + ';');
  L.push('switch_cutout     = ' + f(c.switchCutout) + ';');
  L.push('plate_thickness   = ' + f(c.plateThickness) + ';');
  L.push('edge_margin       = ' + String(c.edgeMargin) + ';');
  L.push('encoder_diameter  = ' + f(c.encoderDiameter) + ';');
  L.push('mount_hole_d      = ' + f(c.mountHoleDiameter) + ';');
  L.push('has_encoder       = ' + (c.encoder ? 'true' : 'false') + ';');
  L.push('has_sensor        = ' + (c.sensor ? 'true' : 'false') + ';');
  L.push('sensor_count      = ' + c.sensorCount + ';');
  L.push('encoder_position  = "' + c.encoderPosition + '";');
  L.push('controller_bay    = 32;');
  L.push('top_band          = has_encoder ? 20 : 0;');
  L.push('bottom_band       = has_sensor ? 16 : 0;');
  L.push('key_area_w        = 2 * edge_margin + max(cols * key_spacing, has_sensor ? (sensor_count + 1) * 9 : 0);');
  L.push('board_w           = key_area_w + controller_bay;');
  L.push('board_h           = max(2 * edge_margin + rows * key_spacing + top_band + bottom_band, 55 + 2 * edge_margin);');
  L.push('case_wall         = 2.4;');
  L.push('case_floor        = 1.6;');
  L.push('case_height       = 12.0;');
  L.push('clearance         = 0.25;');
  L.push('plate_ledge       = 1.2;');
  L.push('assert(rows >= 1 && rows <= 6 && cols >= 1 && cols <= 8);');
  L.push('assert(key_spacing >= 18 && key_spacing <= 24 && switch_cutout > 0 && switch_cutout < key_spacing);');
  L.push('assert(edge_margin >= 5 && plate_thickness >= 1 && plate_thickness <= 8);');
  L.push('');
  L.push('// ---- Derived helpers --------------------------------------------');
  L.push('function key_x(col) = edge_margin + col * key_spacing + key_spacing / 2;');
  L.push('function key_y(row) = top_band + edge_margin + row * key_spacing + key_spacing / 2;');
  L.push('function encoder_x() = encoder_position == "top-left" ? edge_margin + 12 : encoder_position == "top-right" ? key_area_w - edge_margin - 12 : key_area_w / 2;');
  L.push('');
  /* Mount bores recompute the board layout math so editing rows, cols,
   * key_spacing, edge_margin or the bands moves the holes with board_w and
   * board_h. The Pico pad column can reach the corner lanes, so each lane
   * bends vertically to keep the same copper clearance the layout audit
   * enforces. verifyBundle evaluates these expressions against
   * board.layout.mounts. */
  L.push('function pico_pad_cx() = key_area_w + controller_bay / 2 + 8.89;');
  L.push('function mount_pad_top() = board_h / 2 - 19 * 2.54 / 2 - 0.85;');
  L.push('function mount_pad_bottom() = board_h / 2 + 19 * 2.54 / 2 + 0.85;');
  L.push('function mount_dx_eff(mx) = max(0, min(abs(mx - pico_pad_cx()), abs(mx - (pico_pad_cx() - 2 * 8.89))) - 0.85);');
  L.push('function mount_dy_needed(mx) = mount_dx_eff(mx) >= 2.0 ? 0 : sqrt(2.0 * 2.0 - mount_dx_eff(mx) * mount_dx_eff(mx));');
  L.push('function mount_lane_x(i) = i == 0 ? edge_margin / 2 : board_w - edge_margin / 2;');
  L.push('function mount_lane_y(i) = i == 0 ? edge_margin / 2 + top_band * 0.35 : board_h - edge_margin / 2 - bottom_band * 0.35;');
  L.push('function mount_bend_y(my, mx) = mount_dy_needed(mx) > 0 ? (my < board_h / 2 ? min(my, mount_pad_top() - mount_dy_needed(mx)) : max(my, mount_pad_bottom() + mount_dy_needed(mx))) : my;');
  L.push('');
  L.push('module switch_opening(x, y) {');
  L.push('    // Exact square plate opening.');
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
  L.push('        cylinder(d = mount_hole_d, h = plate_thickness + 2, $fn = 48);');
  L.push('}');
  L.push('');
  L.push('module plate() {');
  L.push('    difference() {');
  L.push('        cube([board_w, board_h, plate_thickness]);');
  L.push('        for (r = [0 : rows - 1], c = [0 : cols - 1])');
  L.push('            switch_opening(key_x(c), key_y(r));');
  L.push('        if (has_encoder)');
  L.push('            encoder_opening(encoder_x(), top_band / 2 + 2);');
  /* Mount bores are parametric expressions over the lane functions above,
   * emitted in the same order as board.layout.mounts (x lane outer, y lane
   * inner), so the plate agrees with the KiCad, Gerber, drill and STL
   * exports for every parameter combination. */
  board.layout.mounts.forEach((m, k) => {
    const i = Math.floor(k / 2), j = k % 2;
    L.push('        mount_opening(mount_lane_x(' + i + '), mount_bend_y(mount_lane_y(' + j + '), mount_lane_x(' + i + ')));');
  });
  L.push('    }');
  L.push('}');
  L.push('');
  L.push('module case_shell() {');
  L.push('    // A simple tray. The plate drops in from the top.');
  L.push('    difference() {');
  L.push('        cube([board_w + 2 * (case_wall + clearance), board_h + 2 * (case_wall + clearance), case_height]);');
  L.push('        translate([case_wall + clearance + plate_ledge, case_wall + clearance + plate_ledge, case_floor])');
  L.push('            cube([board_w - 2 * plate_ledge, board_h - 2 * plate_ledge, case_height - case_floor + 1]);');
  L.push('        translate([case_wall, case_wall, case_height - plate_thickness])');
  L.push('            cube([board_w + 2 * clearance, board_h + 2 * clearance, plate_thickness + 1]);');
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
  L.push('    translate([case_wall + clearance, case_wall + clearance, case_height - plate_thickness]) plate();');
  L.push('}');
  L.push('');
  return L.join('\n');
}

/* The OpenSCAD exporter writes mount_opening() calls whose arguments are
 * expressions over the parameter variables and the mount_* functions. The
 * evaluator below covers exactly that emitted subset: numbers, strings,
 * booleans, identifiers, + - * / %, comparisons, && || !, ternaries,
 * parentheses and calls to abs, min, max, sqrt or the emitted functions.
 * Anything else throws, so a malformed or hostile expression fails the
 * bundle check instead of being guessed. */
const SCAD_BINPREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function scadParseExpr(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '"') {
      let j = i + 1, out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        out += src[j]; j++;
      }
      if (j >= src.length) throw new Error('unterminated string in SCAD expression');
      tokens.push({ t: 'str', v: out }); i = j + 1; continue;
    }
    const rest = src.slice(i);
    const num = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) { tokens.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_]\w*/.exec(rest);
    if (id) { tokens.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    const two = src.substr(i, 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
      tokens.push({ t: 'op', v: two }); i += 2; continue;
    }
    if ('+-*/%(),?:<>!'.indexOf(ch) !== -1) { tokens.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error('unexpected character ' + JSON.stringify(ch) + ' in SCAD expression');
  }
  tokens.push({ t: 'eof', v: '' });
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  function parseExpr() {
    const cond = parseBinary(1);
    if (peek().t === 'op' && peek().v === '?') {
      take();
      const a = parseExpr();
      if (!(peek().t === 'op' && peek().v === ':')) throw new Error('expected : in SCAD ternary');
      take();
      return { k: 'tern', c: cond, a, b: parseExpr() };
    }
    return cond;
  }
  function parseBinary(minPrec) {
    let left = parseUnary();
    while (peek().t === 'op' && SCAD_BINPREC[peek().v] !== undefined && SCAD_BINPREC[peek().v] >= minPrec) {
      const op = take().v;
      left = { k: 'bin', op, l: left, r: parseBinary(SCAD_BINPREC[op] + 1) };
    }
    return left;
  }
  function parseUnary() {
    const tok = peek();
    if (tok.t === 'op' && (tok.v === '-' || tok.v === '!')) {
      take();
      return { k: tok.v === '-' ? 'neg' : 'not', e: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = take();
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'str') return { k: 'str', v: tok.v };
    if (tok.t === 'id') {
      if (tok.v === 'true') return { k: 'bool', v: true };
      if (tok.v === 'false') return { k: 'bool', v: false };
      if (peek().t === 'op' && peek().v === '(') {
        take();
        const args = [];
        if (!(peek().t === 'op' && peek().v === ')')) {
          args.push(parseExpr());
          while (peek().t === 'op' && peek().v === ',') { take(); args.push(parseExpr()); }
        }
        if (!(peek().t === 'op' && peek().v === ')')) throw new Error('expected ) in SCAD call ' + tok.v);
        take();
        return { k: 'call', name: tok.v, args };
      }
      return { k: 'var', name: tok.v };
    }
    if (tok.t === 'op' && tok.v === '(') {
      const inner = parseExpr();
      if (!(peek().t === 'op' && peek().v === ')')) throw new Error('expected ) in SCAD expression');
      take();
      return inner;
    }
    throw new Error('unexpected token ' + JSON.stringify(tok.v) + ' in SCAD expression');
  }
  const ast = parseExpr();
  if (peek().t !== 'eof') throw new Error('trailing tokens in SCAD expression');
  return ast;
}

const SCAD_BUILTINS = {
  abs: x => Math.abs(x),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sqrt: x => Math.sqrt(x),
};

function scadEval(node, env) {
  switch (node.k) {
    case 'num': case 'str': case 'bool': return node.v;
    case 'var':
      if (node.name in env) return env[node.name];
      throw new Error('undefined SCAD name ' + node.name);
    case 'neg': return -scadEval(node.e, env);
    case 'not': return !scadEval(node.e, env);
    case 'tern': return scadEval(node.c, env) ? scadEval(node.a, env) : scadEval(node.b, env);
    case 'bin': {
      const l = scadEval(node.l, env), r = scadEval(node.r, env);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '%': return l % r;
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        case '==': return l === r;
        case '!=': return l !== r;
        case '&&': return Boolean(l && r);
        case '||': return Boolean(l || r);
      }
      throw new Error('unsupported SCAD operator ' + node.op);
    }
    case 'call': {
      const args = node.args.map(arg => scadEval(arg, env));
      if (Object.prototype.hasOwnProperty.call(SCAD_BUILTINS, node.name)) {
        return SCAD_BUILTINS[node.name](...args);
      }
      if (!(node.name in env)) throw new Error('unknown SCAD function ' + node.name);
      const fn = env[node.name];
      if (!fn || typeof fn !== 'object' || !Array.isArray(fn.scadParams) || args.length !== fn.scadParams.length) {
        throw new Error('bad SCAD call ' + node.name);
      }
      const child = Object.create(env);
      fn.scadParams.forEach((param, i) => { child[param] = args[i]; });
      return scadEval(fn.scadBody, child);
    }
  }
  throw new Error('unsupported SCAD node ' + node.k);
}

/* Comments and string literals can carry braces or the text
 * mount_opening( (for example a board name like "Studio { Control" in the
 * emitted header comment). scadCode returns a same-length copy with
 * comments blanked to spaces (newlines preserved), and optionally blanks
 * string interiors when scanning structural tokens while keeping string
 * contents intact for expression evaluation. */
function scadCode(text, blankStrings = true) {
  const src = String(text), out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') break;
        j++;
      }
      if (blankStrings) blank(i + 1, Math.min(j, src.length));
      i = j < src.length ? j + 1 : src.length;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      const end = Math.min(j + 2, src.length);
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

/* Top-level `name = expr;` assignments and `function name(args) = expr;`
 * definitions, in file order. Anything inside a module body (brace depth
 * above zero) is ignored. Structural matching uses blanked strings while
 * expression slicing reads the comment-stripped source with string values
 * intact. */
function scadStatements(text) {
  const stmts = [];
  const scanLines = scadCode(text, true).split(/\r?\n/);
  const evalLines = scadCode(text, false).split(/\r?\n/);
  let depth = 0;
  for (let idx = 0; idx < scanLines.length; idx++) {
    const scanLine = scanLines[idx].trim();
    const evalLine = evalLines[idx].trim();
    if (depth === 0) {
      let m = /^function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=\s*(.+?);\s*$/.exec(scanLine);
      if (m) {
        const eqIdx = scanLine.indexOf('=');
        const semiIdx = scanLine.lastIndexOf(';');
        stmts.push({
          fn: m[1],
          params: m[2].split(',').map(s => s.trim()).filter(Boolean),
          expr: evalLine.slice(eqIdx + 1, semiIdx).trim(),
        });
      } else {
        m = /^([A-Za-z_]\w*)\s*=\s*([^;]+);\s*$/.exec(scanLine);
        if (m) {
          const eqIdx = scanLine.indexOf('=');
          const semiIdx = scanLine.lastIndexOf(';');
          stmts.push({ var: m[1], expr: evalLine.slice(eqIdx + 1, semiIdx).trim() });
        }
      }
    }
    for (const ch of scanLine) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth < 0) depth = 0;
  }
  return stmts;
}

function scadSplitArgs(inner) {
  const args = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      i++;
      while (i < inner.length && inner[i] !== '"') { if (inner[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { args.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  args.push(inner.slice(start).trim());
  return args;
}

/* Every mount_opening(...) call site in the file, as raw argument
 * expression pairs. The module definition line is skipped. */
function scadMountCalls(text) {
  const scan = scadCode(text, true), evalSrc = scadCode(text, false), calls = [];
  const re = /mount_opening\s*\(/g;
  let m;
  while ((m = re.exec(scan))) {
    const lineStart = scan.lastIndexOf('\n', m.index) + 1;
    if (/\bmodule\s*$/.test(scan.slice(lineStart, m.index))) continue;
    const open = m.index + m[0].length - 1;
    let depth = 1, i = open + 1;
    for (; i < scan.length && depth > 0; i++) {
      const ch = scan[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"') { i++; while (i < scan.length && scan[i] !== '"') { if (scan[i] === '\\') i++; i++; } }
    }
    if (depth !== 0) throw new Error('unbalanced mount_opening call in SCAD');
    calls.push(scadSplitArgs(evalSrc.slice(open + 1, i - 1)));
  }
  return calls;
}

/* Evaluate the parametric mount bores of an exported .scad. Returns an
 * array of [x, y] points in call order, or throws on any construct outside
 * the emitted subset. */
function scadMountPoints(text) {
  const src = String(text);
  const env = Object.create(null);
  for (const st of scadStatements(src)) {
    if (st.var !== undefined) env[st.var] = scadEval(scadParseExpr(st.expr), env);
    else env[st.fn] = { scadParams: st.params, scadBody: scadParseExpr(st.expr) };
  }
  return scadMountCalls(src).map(args => {
    if (args.length !== 2) throw new Error('mount_opening expects 2 arguments');
    return [scadEval(scadParseExpr(args[0]), env), scadEval(scadParseExpr(args[1]), env)];
  });
}

/* ===================================================================== *
 * 8. Front copper Gerber (RS-274X)
 * ===================================================================== */

const GERBER_LAYERS = {
  'F.Cu': { suffix: 'F_Cu', fileFunction: 'Copper,L1,Top' },
  'B.Cu': { suffix: 'B_Cu', fileFunction: 'Copper,L2,Bot' },
  'F.Mask': { suffix: 'F_Mask', fileFunction: 'Soldermask,Top' },
  'B.Mask': { suffix: 'B_Mask', fileFunction: 'Soldermask,Bot' },
  'F.Paste': { suffix: 'F_Paste', fileFunction: 'Paste,Top' },
  'F.SilkS': { suffix: 'F_SilkS', fileFunction: 'Legend,Top' },
  'Edge.Cuts': { suffix: 'Edge_Cuts', fileFunction: 'Profile,NP' },
};

function generateGerber(config, layer) {
  if (!Object.prototype.hasOwnProperty.call(GERBER_LAYERS, layer)) throw new Error('Unknown Gerber layer ' + layer);
  const board = buildBoard(config), apertures = new Map(), definitions = [], commands = [];
  const mm = value => Math.round(value * 1e6);
  const xy = point => 'X' + mm(point[0]) + 'Y' + mm(board.layout.height - point[1]);
  const aperture = (shape, width, height, cornerRadius) => {
    const key = shape + ':' + f(width, 6) + ':' + f(height, 6) + ':' + f(cornerRadius || 0, 6);
    if (apertures.has(key)) return apertures.get(key);
    const id = 10 + apertures.size;
    apertures.set(key, id);
    if (shape === 'roundrect') {
      const radius = cornerRadius === undefined ? Math.min(width, height) * 0.25 : cornerRadius, macro = 'ROUNDRECT' + id;
      const parts = ['21,1,' + f(width - 2 * radius, 6) + ',' + f(height, 6) + ',0,0,0',
        '21,1,' + f(width, 6) + ',' + f(height - 2 * radius, 6) + ',0,0,0'];
      for (const x of [-width / 2 + radius, width / 2 - radius]) for (const y of [-height / 2 + radius, height / 2 - radius]) {
        parts.push('1,1,' + f(2 * radius, 6) + ',' + f(x, 6) + ',' + f(y, 6) + ',0');
      }
      definitions.push('%AM' + macro + '*' + parts.join('*') + '*%');
      definitions.push('%ADD' + id + macro + '*%');
    } else definitions.push('%ADD' + id + (shape === 'rect' ? 'R,' + f(width, 6) + 'X' + f(height, 6) : 'C,' + f(width, 6)) + '*%');
    return id;
  };
  const path = (points, width) => {
    commands.push('D' + aperture('circle', width, width) + '*');
    points.forEach((point, i) => commands.push(xy(point) + (i ? 'D01*' : 'D02*')));
  };
  if (layer.endsWith('.Cu') || layer.endsWith('.Mask') || layer === 'F.Paste') {
    for (const component of board.components) for (const pad of component.pads) {
      if ((layer.startsWith('B.') && pad.drill === 0) || (layer === 'F.Paste' && pad.drill > 0)) continue;
      const expansion = layer.endsWith('.Mask') ? 0.1 : 0;
      commands.push('D' + aperture(pad.shape, pad.w + expansion * 2, pad.h + expansion * 2,
        pad.shape === 'roundrect' ? Math.min(pad.w, pad.h) * 0.25 + expansion : undefined) + '*');
      commands.push(xy([pad.x, pad.y]) + 'D03*');
    }
    if (layer.endsWith('.Cu')) for (const trace of board.traces) if (trace.layer === layer) path(trace.points, trace.width);
  } else if (layer === 'Edge.Cuts') path(board.edge, 0.1);
  else if (layer === 'F.SilkS') {
    for (const component of board.components) {
      const { x, y, outline } = component;
      if (!outline) continue;
      const w = outline.w / 2, h = outline.h / 2;
      path([[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h], [x - w, y - h]], 0.12);
      if (component.kind === 'diode') path([[x + w * 0.55, y - h], [x + w * 0.55, y + h]], 0.2);
    }
  }
  return ['G04 PadCraft ' + layer + ' - ' + board.config.name + ' *',
    'G04 Origin bottom-left; same coordinates in all Gerber and drill files *',
    '%FSLAX36Y36*%', '%MOMM*%', '%TF.FileFunction,' + GERBER_LAYERS[layer].fileFunction + '*%',
    '%TF.FilePolarity,' + (layer.endsWith('.Mask') ? 'Negative' : 'Positive') + '*%', '%LPD*%', 'G01*',
    ...definitions, ...commands, 'M02*', ''].join('\n');
}

function generateGerberFCu(config) { return generateGerber(config, 'F.Cu'); }

function validateGerber(source) {
  const errors = [], text = String(source), apertures = new Map(), flashes = [], draws = [];
  const macros = new Set([...text.matchAll(/%AM([A-Z0-9_]+)\*/g)].map(match => match[1]));
  const macroDimensions = new Map();
  for (const match of text.matchAll(/%AM([A-Z0-9_]+)\*([^%]+)\*%/g)) {
    const parts = match[2].split('*').filter(Boolean).map(primitive => primitive.split(',').map(Number));
    if (parts.length !== 6 || parts.filter(part => part[0] === 21).length !== 2 || parts.filter(part => part[0] === 1).length !== 4 || parts.some(part => part.some(value => !Number.isFinite(value)) || part[1] !== 1 || part[2] <= 0)) errors.push('Invalid rounded rectangle aperture macro');
    else macroDimensions.set(match[1], [parts[1][2], parts[0][3]]);
  }
  if (!text.includes('%FSLAX36Y36*%') || (text.match(/%FS/g) || []).length !== 1) errors.push('Expected one RS-274X 3:6 coordinate format');
  if (!text.includes('%MOMM*%')) errors.push('Expected millimetre units');
  if (!/M02\*\s*$/.test(text) || (text.match(/M02\*/g) || []).length !== 1) errors.push('Expected one M02 terminator');
  for (const match of text.matchAll(/%ADD(\d+)(C|R|[A-Z][A-Z0-9_]*)(?:,([^*]+))?\*%/g)) {
    const id = Number(match[1]), shape = match[2], dimensions = (match[3] || '').split('X').filter(Boolean).map(Number);
    if (id < 10 || apertures.has(id)) errors.push('Invalid or duplicate aperture ' + id);
    if ((shape === 'C' && dimensions.length !== 1) || (shape === 'R' && dimensions.length !== 2) || dimensions.some(value => !Number.isFinite(value) || value <= 0)) errors.push('Invalid aperture dimensions');
    if (!['C', 'R'].includes(shape) && !macros.has(shape)) errors.push('Undefined aperture macro ' + shape);
    apertures.set(id, { shape, kind: macros.has(shape) ? 'roundrect' : shape === 'C' ? 'circle' : 'rect',
      dimensions: macroDimensions.get(shape) || dimensions });
  }
  let selected = null, previous = null;
  for (const line of text.split(/\r?\n/)) {
    const select = /^D(\d+)\*$/.exec(line);
    if (select) { selected = Number(select[1]); if (!apertures.has(selected)) errors.push('Selected undeclared aperture ' + selected); }
    const command = /^X(-?\d+)Y(-?\d+)D(0[123])\*$/.exec(line);
    if (!command) {
      if (/^X|^Y/.test(line)) errors.push('Malformed coordinate command');
      continue;
    }
    const point = [Number(command[1]) / 1e6, Number(command[2]) / 1e6];
    if (point.some(value => !Number.isFinite(value) || value < 0 || value >= 1000)) errors.push('Coordinate outside 3:6 range');
    if (!apertures.has(selected)) errors.push('Coordinate uses undeclared aperture');
    if (command[3] === '03') flashes.push({ point, aperture: selected });
    if (command[3] === '01') {
      if (!previous) errors.push('Draw without preceding move');
      else draws.push({ start: previous, end: point, aperture: selected });
    }
    previous = point;
  }
  return { valid: errors.length === 0, errors, apertures: [...apertures.entries()], flashes, draws };
}

function generateExcellon(config, plated) {
  const board = buildBoard(config), tools = new Map(), hits = board.drillPoints.filter(hit => hit.plated === !!plated);
  for (const hit of hits) if (!tools.has(f(hit.diameter, 4))) tools.set(f(hit.diameter, 4), tools.size + 1);
  const lines = ['M48', '; PadCraft ' + (plated ? 'plated' : 'non-plated') + ' drills',
    ';FILE_FORMAT=3:4', 'METRIC,TZ', ...[...tools].map(([diameter, tool]) => 'T' + String(tool).padStart(2, '0') + 'C' + diameter), '%', 'G90', 'G05'];
  for (const [diameter, tool] of tools) {
    lines.push('T' + String(tool).padStart(2, '0'));
    for (const hit of hits.filter(hit => f(hit.diameter, 4) === diameter)) {
      const coordinate = point => 'X' + f(point[0], 4) + 'Y' + f(board.layout.height - point[1], 4);
      lines.push(hit.slot ? coordinate(hit.slot[0]) + 'G85' + coordinate(hit.slot[1]) : coordinate([hit.x, hit.y]));
      if (hit.slot) lines.push('G05');
    }
  }
  lines.push('M30', '');
  return lines.join('\n');
}

function validateExcellon(source) {
  const errors = [], text = String(source), tools = new Map(), hits = [];
  if (!/^M48\n/.test(text) || !text.includes('METRIC,TZ') || !/M30\s*$/.test(text)) errors.push('Invalid Excellon header, units or terminator');
  if (!text.includes('\n%\nG90\n')) errors.push('Expected absolute coordinate body');
  let selected = null;
  for (const line of text.split(/\r?\n/)) {
    const tool = /^T(\d+)(?:C(\d+(?:\.\d+)?))?$/.exec(line);
    if (tool) {
      const id = Number(tool[1]);
      if (tool[2]) {
        const diameter = Number(tool[2]);
        if (!Number.isFinite(diameter) || diameter <= 0 || tools.has(id)) errors.push('Invalid drill tool');
        tools.set(id, diameter);
      } else { selected = id; if (!tools.has(id)) errors.push('Undeclared drill tool'); }
    }
    const slot = /^X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)G85X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)$/.exec(line);
    if (slot) {
      const endpoints = [[Number(slot[1]), Number(slot[2])], [Number(slot[3]), Number(slot[4])]];
      if (!tools.has(selected) || endpoints.flat().some(value => !Number.isFinite(value) || value < 0)) errors.push('Invalid drill slot');
      hits.push({ x: (endpoints[0][0] + endpoints[1][0]) / 2, y: (endpoints[0][1] + endpoints[1][1]) / 2,
        diameter: tools.get(selected), tool: selected, slot: endpoints });
      continue;
    }
    const point = /^X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)$/.exec(line);
    if (point) {
      const x = Number(point[1]), y = Number(point[2]);
      if (!tools.has(selected) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) errors.push('Invalid drill hit');
      hits.push({ x, y, diameter: tools.get(selected), tool: selected });
    } else if (/^[XY]/.test(line)) errors.push('Malformed drill coordinate');
  }
  return { valid: errors.length === 0, errors, tools: [...tools.entries()], hits };
}

/* ===================================================================== *
 * 9. Firmware: KMK kb.py and QMK bundle
 * ===================================================================== */

function generateKMK(config) {
  const board = buildBoard(config);
  const c = board.config;
  const p = board.netlist.pins;
  const hasMedia = !!p.encoder || board.keymap.flat().some(key => /KC\.(MUTE|VOLU|VOLD|MPLY|MSTP|MNXT|MPRV|BRIU|BRID|EJCT|MFFD|MRWD)$/.test(key));
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
  if (hasMedia) L.push('from kmk.extensions.media_keys import MediaKeys');
  if (p.encoder) L.push('from kmk.modules.encoder import EncoderModule');
  if (p.sensor.length) L.push('import analogio');
  L.push('');
  L.push('keyboard = KMKKeyboard()');
  if (hasMedia) L.push('keyboard.extensions.append(MediaKeys())');
  L.push('');
  L.push('# Rows drive low; columns are read with pull-ups. Cathodes face rows.');
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
    L.push('analog_inputs = (' + p.sensor.map(pin => 'analogio.AnalogIn(board.' + pin + ')').join(', ') + (p.sensor.length === 1 ? ',' : '') + ')');
    L.push('def read_sensors():');
    L.push('    return tuple(sensor.value / 65535 for sensor in analog_inputs)');
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
    maintainer: 'draarivpatel-ui',
    processor: 'RP2040',
    bootloader: 'rp2040',
    usb: { vid: '0xFEED', pid: '0x2040', device_version: '1.0.0' },
    diode_direction: 'COL2ROW',
    matrix_pins: { cols: p.cols.slice(), rows: p.rows.slice() },
    layouts: { [macro]: { layout } },
  };
  if (p.encoder) {
    info.encoder = { rotary: [{ pin_a: p.encoder.a, pin_b: p.encoder.b, resolution: 4 }] };
  }

  const keymapRows = board.keymap.map(row =>
    '        ' + row.map(kmkToQmk).join(', ')).join(',\n');
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

  let hardware = '';
  if (p.encoder) {
    hardware = [
      '#if defined(ENCODER_MAP_ENABLE)',
      'const uint16_t PROGMEM encoder_map[][NUM_ENCODERS][NUM_DIRECTIONS] = {',
      '    [0] = { ENCODER_CCW_CW(KC_VOLD, KC_VOLU) },',
      '};', '#endif', '',
      'void matrix_init_user(void) { setPinInputHigh(' + p.encoder.sw + '); }',
      'void matrix_scan_user(void) {',
      '    static bool raw = false, stable = false;',
      '    static uint16_t changed_at = 0;',
      '    bool pressed = !readPin(' + p.encoder.sw + ');',
      '    if (pressed != raw) { raw = pressed; changed_at = timer_read(); }',
      '    if (pressed != stable && timer_elapsed(changed_at) >= 5) {',
      '        stable = pressed;',
      '        if (pressed) register_code(KC_MUTE); else unregister_code(KC_MUTE);',
      '    }', '}', '',
    ].join('\n');
  }

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
    'ENCODER_MAP_ENABLE = ' + (p.encoder ? 'yes' : 'no'),
    'EXTRAKEY_ENABLE = yes',
    '',
  ].join('\n');

  return { 'keyboard.json': JSON.stringify(info, null, 2) + '\n',
           'keymap.c': keymap + hardware, 'config.h': configH, 'rules.mk': rules };
}

/* ===================================================================== *
 * 10. Bundles and CLI
 * ===================================================================== */

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  return [distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b)].some(distance => distance < 1e-7);
}

/* Distance from a point to a pad envelope: zero inside, otherwise the gap
 * to the nearest edge or arc. */
function pointToPadDistance(x, y, pad) {
  if (pad.shape === 'circle') return Math.max(0, Math.hypot(x - pad.x, y - pad.y) - pad.w / 2);
  const dx = Math.max(0, Math.abs(x - pad.x) - pad.w / 2);
  const dy = Math.max(0, Math.abs(y - pad.y) - pad.h / 2);
  return Math.hypot(dx, dy);
}

/* Minimum distance between a pad envelope and a slot capsule's centreline:
 * exact for convex pairs (segment endpoints to the rect, rect corners to
 * the segment, plus intersection). */
function rectToSegmentDistance(pad, a, b) {
  const left = pad.x - pad.w / 2, right = pad.x + pad.w / 2;
  const top = pad.y - pad.h / 2, bottom = pad.y + pad.h / 2;
  const inside = point => point[0] >= left && point[0] <= right && point[1] >= top && point[1] <= bottom;
  if (inside(a) || inside(b)) return 0;
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom]];
  let distance = Math.min(pointToPadDistance(a[0], a[1], pad), pointToPadDistance(b[0], b[1], pad));
  for (let index = 0; index < 4; index++) {
    const p = corners[index], q = corners[(index + 1) % 4];
    if (segmentsIntersect(a, b, p, q)) return 0;
    distance = Math.min(distance, distanceToSegment(p, a, b), distanceToSegment(q, a, b));
  }
  return distance;
}

/* Conservative copper screening uses pad envelopes before native CAD DRC. */
function distanceSegmentToPad(segment, pad) {
  if (pad.shape === 'circle') return Math.max(0, distanceToSegment([pad.x, pad.y], segment.a, segment.b) - pad.w / 2);
  const left = pad.x - pad.w / 2, right = pad.x + pad.w / 2;
  const top = pad.y - pad.h / 2, bottom = pad.y + pad.h / 2;
  const inside = point => point[0] >= left && point[0] <= right && point[1] >= top && point[1] <= bottom;
  if (inside(segment.a) || inside(segment.b)) return 0;
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom]];
  let distance = Infinity;
  for (let index = 0; index < 4; index++) {
    const a = corners[index], b = corners[(index + 1) % 4];
    if (segmentsIntersect(segment.a, segment.b, a, b)) return 0;
    distance = Math.min(distance, distanceToSegment(segment.a, a, b), distanceToSegment(segment.b, a, b), distanceToSegment(a, segment.a, segment.b), distanceToSegment(b, segment.a, segment.b));
  }
  return distance;
}

function inspectBoard(board) {
  const issues = [], clearance = 0.2;
  const pads = board.components.flatMap(component => component.pads.map(pad => ({ ...pad, ref: component.ref })));
  const segments = board.traces.flatMap(trace => trace.points.slice(1).map((end, i) => ({ ...trace, a: trace.points[i], b: end })));
  for (const pad of pads) {
    if (pad.x - pad.w / 2 < 0 || pad.y - pad.h / 2 < 0 || pad.x + pad.w / 2 > board.layout.width || pad.y + pad.h / 2 > board.layout.height) issues.push(pad.ref + ' pad ' + pad.num + ' leaves board outline');
    else if (Math.min(pad.x - pad.w / 2, pad.y - pad.h / 2, board.layout.width - pad.x - pad.w / 2, board.layout.height - pad.y - pad.h / 2) < clearance) issues.push(pad.ref + ' pad ' + pad.num + ' violates copper-to-edge clearance');
  }
  for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) {
    const a = pads[i], b = pads[j];
    if (a.net && b.net && a.net.name === b.net.name) continue;
    const dx = Math.max(0, Math.abs(a.x - b.x) - (a.w + b.w) / 2);
    const dy = Math.max(0, Math.abs(a.y - b.y) - (a.h + b.h) / 2);
    if (Math.hypot(dx, dy) < clearance - 1e-7) issues.push(a.ref + ' pad ' + a.num + ' and ' + b.ref + ' pad ' + b.num + ' copper envelopes conflict');
  }
  for (const drill of board.drillPoints) {
    if (drill.x - drill.diameter / 2 < 0 || drill.y - drill.diameter / 2 < 0 || drill.x + drill.diameter / 2 > board.layout.width || drill.y + drill.diameter / 2 > board.layout.height) issues.push('Drill leaves board outline');
  }
  const nonPlated = board.drillPoints.filter(drill => !drill.plated);
  /* Non-plated bores (mounting holes, switch support pins, encoder slots)
   * must keep copper clearance from every pad envelope and stay a sane web
   * inside the board outline: a bore that clips copper or the edge is a
   * fabrication defect even when the layout still parses. */
  for (const drill of nonPlated) {
    const radius = drill.diameter / 2;
    const name = drill.ref || 'non-plated drill at (' + f(drill.x) + ', ' + f(drill.y) + ')';
    for (const pad of pads) {
      const gap = drill.slot
        ? (pad.shape === 'circle'
          ? distanceToSegment([pad.x, pad.y], drill.slot[0], drill.slot[1]) - pad.w / 2 - radius
          : rectToSegmentDistance(pad, drill.slot[0], drill.slot[1]) - radius)
        : pointToPadDistance(drill.x, drill.y, pad) - radius;
      if (gap < clearance - 1e-7) {
        issues.push(name + ' violates ' + clearance + ' mm copper clearance at ' + pad.ref + ':' + pad.num);
      }
    }
    const xs = drill.slot ? [drill.slot[0][0], drill.slot[1][0]] : [drill.x];
    const ys = drill.slot ? [drill.slot[0][1], drill.slot[1][1]] : [drill.y];
    const web = Math.min(
      Math.min(...xs) - radius, Math.min(...ys) - radius,
      board.layout.width - Math.max(...xs) - radius,
      board.layout.height - Math.max(...ys) - radius);
    if (web < clearance - 1e-7) issues.push(name + ' violates ' + clearance + ' mm drill-to-edge clearance');
  }
  for (const segment of segments) {
    if (segment.points.some(point => point[0] < 0 || point[1] < 0 || point[0] > board.layout.width || point[1] > board.layout.height)) issues.push(segment.net + ' trace leaves board outline');
    if ([segment.a, segment.b].some(point => Math.min(point[0], point[1], board.layout.width - point[0], board.layout.height - point[1]) < segment.width / 2 + clearance)) issues.push(segment.net + ' trace violates copper-to-edge clearance');
    for (const pad of pads) {
      if ((pad.net && pad.net.name === segment.net) || (pad.drill === 0 && segment.layer !== 'F.Cu')) continue;
      const margin = segment.width / 2 + clearance;
      if (Math.max(segment.a[0], segment.b[0]) + margin < pad.x - pad.w / 2 || Math.min(segment.a[0], segment.b[0]) - margin > pad.x + pad.w / 2 || Math.max(segment.a[1], segment.b[1]) + margin < pad.y - pad.h / 2 || Math.min(segment.a[1], segment.b[1]) - margin > pad.y + pad.h / 2) continue;
      if (distanceSegmentToPad(segment, pad) < margin - 1e-7) issues.push(segment.net + ' trace conflicts with ' + pad.ref + ' pad ' + pad.num + ' copper');
    }
    for (const drill of nonPlated) {
      const distance = drill.slot ? (segmentsIntersect(segment.a, segment.b, drill.slot[0], drill.slot[1]) ? 0 :
        Math.min(distanceToSegment(segment.a, drill.slot[0], drill.slot[1]), distanceToSegment(segment.b, drill.slot[0], drill.slot[1]), distanceToSegment(drill.slot[0], segment.a, segment.b), distanceToSegment(drill.slot[1], segment.a, segment.b))) :
        distanceToSegment([drill.x, drill.y], segment.a, segment.b);
      if (distance < drill.diameter / 2 + segment.width / 2 + clearance - 1e-7) issues.push(segment.net + ' trace conflicts with non-plated drill');
    }
  }
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j];
    if (a.net === b.net || a.layer !== b.layer) continue;
    const distance = segmentsIntersect(a.a, a.b, b.a, b.b) ? 0 : Math.min(distanceToSegment(a.a, b.a, b.b), distanceToSegment(a.b, b.a, b.b), distanceToSegment(b.a, a.a, a.b), distanceToSegment(b.b, a.a, a.b));
    if (distance < (a.width + b.width) / 2 + clearance - 1e-7) issues.push(a.net + ' and ' + b.net + ' copper traces conflict');
  }
  const airwires = [], nets = [];
  let totalConnections = 0, remainingRoutes = 0;
  for (const name of board.nets.names) {
    const terminals = pads.filter(pad => pad.net && pad.net.name === name);
    const traces = board.traces.filter(trace => trace.net === name);
    const parent = Array.from({ length: terminals.length + traces.length }, (_, i) => i);
    const root = index => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
    const join = (a, b) => { parent[root(a)] = root(b); };
    const pathSegments = trace => trace.points.slice(1).map((end, i) => [trace.points[i], end]);
    terminals.forEach((pad, i) => traces.forEach((trace, j) => {
      if (pad.drill === 0 && trace.layer !== 'F.Cu') return;
      if (pathSegments(trace).some(([a, b]) => distanceToSegment([pad.x, pad.y], a, b) < 1e-7)) join(i, terminals.length + j);
    }));
    for (let i = 0; i < traces.length; i++) for (let j = i + 1; j < traces.length; j++) {
      if (traces[i].layer === traces[j].layer && pathSegments(traces[i]).some(([a, b]) => pathSegments(traces[j]).some(([c, d]) => segmentsIntersect(a, b, c, d)))) join(terminals.length + i, terminals.length + j);
    }
    const groups = new Map();
    terminals.forEach((pad, i) => { const id = root(i); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(pad); });
    const sets = [...groups.values()];
    const anchor = sets.find(set => set.some(pad => pad.ref === 'U1')) || sets[0];
    for (const group of sets) {
      if (group === anchor) continue;
      let closest = null;
      for (const a of anchor) for (const b of group) {
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (!closest || distance < closest.distance) closest = { net: name, a: [a.x, a.y], b: [b.x, b.y], distance, from: a.ref, to: b.ref };
      }
      if (closest) airwires.push(closest);
    }
    const needed = Math.max(0, sets.length - 1);
    totalConnections += Math.max(0, terminals.length - 1); remainingRoutes += needed;
    nets.push({ name, pads: terminals.length, groups: sets.length, remainingRoutes: needed });
  }
  return { geometryValid: issues.length === 0, issues: [...new Set(issues)], clearance,
    remainingRoutes, totalConnections, connectedConnections: totalConnections - remainingRoutes,
    continuityPercent: totalConnections ? Math.round((totalConnections - remainingRoutes) * 100 / totalConnections) : 100,
    airwires, nets };
}

function verifyBundle(config, files) {
  const c = clampConfig(config), board = buildBoard(c), pcbName = Object.keys(files).find(name => name.endsWith('.kicad_pcb'));
  const kicad = validateKiCadPcb(files[pcbName] || '');
  const stlName = Object.keys(files).find(name => name.endsWith('_plate.stl'));
  const mesh = validateSTL(files[stlName] || '', buildPlateMesh(c).stats.expectedVolume);
  const gerbers = Object.entries(files).filter(([name]) => name.endsWith('.gbr')).map(([name, body]) => ({ name, ...validateGerber(body) }));
  const drills = Object.entries(files).filter(([name]) => name.endsWith('.drl')).map(([name, body]) => ({ name, ...validateExcellon(body) }));
  const pads = board.components.flatMap(component => component.pads.map(pad => ({ ...pad, ref: component.ref })));
  const pcbMatches = kicad.padEntries.length === pads.length && pads.every(pad => kicad.padEntries.some(actual => actual.ref === pad.ref && actual.number === pad.num && actual.net === (pad.net ? pad.net.name : null) && Math.abs(actual.x - pad.x) < 0.00011 && Math.abs(actual.y - pad.y) < 0.00011 && actual.width === pad.w && actual.height === pad.h));
  const gerbersMatch = Object.entries(GERBER_LAYERS).every(([layer, data]) => {
    const file = gerbers.find(file => file.name.endsWith('_' + data.suffix + '.gbr'));
    if (!file || !file.valid) return false;
    if (layer === 'Edge.Cuts') {
      if (file.flashes.length !== 0 || file.draws.length !== 4) return false;
      /* The outline must be the configured board rectangle, not any four
       * draws: parsed coordinates are compared against the generated edge
       * in Gerber space (origin bottom-left, Y flipped) within the 3:6
       * coordinate resolution. */
      const expectedEdge = board.edge.map(point => [point[0], board.layout.height - point[1]]);
      return file.draws.every((draw, i) =>
        Math.abs(draw.start[0] - expectedEdge[i][0]) < 0.000002 &&
        Math.abs(draw.start[1] - expectedEdge[i][1]) < 0.000002 &&
        Math.abs(draw.end[0] - expectedEdge[i + 1][0]) < 0.000002 &&
        Math.abs(draw.end[1] - expectedEdge[i + 1][1]) < 0.000002);
    }
    if (layer === 'F.SilkS') return file.flashes.length === 0 && file.draws.length > 0;
    const expected = pads.filter(pad => !(layer.startsWith('B.') && pad.drill === 0) && !(layer === 'F.Paste' && pad.drill > 0));
    const expansion = layer.endsWith('.Mask') ? 0.2 : 0;
    const apertureMap = new Map(file.apertures);
    return file.flashes.length === expected.length && expected.every(pad => file.flashes.some(flash => {
      const aperture = apertureMap.get(flash.aperture);
      const dimensions = aperture && aperture.dimensions;
      return dimensions && Math.abs(flash.point[0] - pad.x) < 0.000002 && Math.abs(flash.point[1] - (board.layout.height - pad.y)) < 0.000002 &&
        Math.abs(dimensions[0] - pad.w - expansion) < 0.000002 && (aperture.kind === 'circle' || Math.abs(dimensions[1] - pad.h - expansion) < 0.000002) && aperture.kind === pad.shape;
    }));
  });
  const drillsMatch = [true, false].every(plated => {
    const file = drills.find(file => file.name.endsWith(plated ? '_PTH.drl' : '_NPTH.drl'));
    const expected = board.drillPoints.filter(drill => drill.plated === plated);
    return file && file.valid && file.hits.length === expected.length && expected.every(drill => file.hits.some(hit => Math.abs(hit.x - drill.x) <= 0.000051 && Math.abs(hit.y - (board.layout.height - drill.y)) <= 0.000051 && Math.abs(hit.diameter - drill.diameter) < 1e-6 &&
      (!drill.slot ? !hit.slot : hit.slot && drill.slot.every((point, i) => Math.abs(point[0] - hit.slot[i][0]) <= 0.000051 && Math.abs(board.layout.height - point[1] - hit.slot[i][1]) <= 0.000051))));
  });
  /* The OpenSCAD plate emits parametric mount bores: each mount_opening
   * call's arguments are expressions over the exported variables and the
   * mount_* functions, evaluated here against the shipped source rather
   * than trusted as literals. Every argument must reference a parameter
   * name so a baked literal cannot pass for a parametric bore, and the
   * evaluated points must equal the board mounts. The SCAD writer emits
   * through f(), the same 4-decimal channel the KiCad pad check tolerates
   * at 0.00011. */
  const scadName = Object.keys(files).find(name => name.endsWith('.scad'));
  let scadMounts = null;
  if (scadName) {
    try {
      const calls = scadMountCalls(files[scadName]);
      const parametric = calls.every(args => args.length === 2 && args.every(arg => /[A-Za-z_]/.test(arg)));
      if (parametric) scadMounts = scadMountPoints(files[scadName]);
    } catch (_) { scadMounts = null; }
  }
  const mountNear = (px, py, m) => Math.abs(px - m.x) <= 0.00011 && Math.abs(py - m.y) <= 0.00011;
  const scadMountsMatch = !!(scadMounts && scadMounts.length === board.layout.mounts.length &&
    board.layout.mounts.every(m => scadMounts.some(p => mountNear(p[0], p[1], m))) &&
    scadMounts.every(p => board.layout.mounts.some(m => mountNear(p[0], p[1], m))));
  let firmwareMatches = false;
  try {
    const bundle = JSON.parse(files['qmk_bundle.json']), info = JSON.parse(bundle['keyboard.json']);
    const expectedKeys = board.keymap.flat().map(kmkToQmk);
    const actualKeys = (bundle['keymap.c'].split('};')[0].match(/KC_[A-Z0-9_]+|[A-Z]{2,4}\([0-9]+\)/g) || []);
    const kmkBlock = /keyboard\.keymap\s*=\s*\[\s*\[([\s\S]*?)\]\s*,?\s*\]/.exec(files['kb.py']);
    const kmkKeys = kmkBlock ? kmkBlock[1].match(/KC\.[A-Z][A-Z0-9_]*(\([0-9]+\))?/g) || [] : [];
    const base = slug(c.name);
    const qmkSourcesMatch = Object.entries(bundle).every(([name, body]) => files['qmk/' + base + '/' + (name === 'keymap.c' ? 'keymaps/default/' : '') + name] === body);
    firmwareMatches = JSON.stringify(info.matrix_pins.rows) === JSON.stringify(board.netlist.pins.rows) && JSON.stringify(info.matrix_pins.cols) === JSON.stringify(board.netlist.pins.cols) &&
      info.diode_direction === 'COL2ROW' && JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && !/,\s*\)/.test(bundle['keymap.c']) &&
      board.keymap.flat().every(key => isValidKeycode(key) && keycodeLayerDefined(key)) &&
      JSON.stringify(kmkKeys) === JSON.stringify(board.keymap.flat()) && files['kb.py'].includes('DiodeOrientation.COL2ROW') && qmkSourcesMatch;
  } catch (_) { firmwareMatches = false; }
  /* Integrity round trips: the shipped BOM, DRC report and layout proof are
   * compared byte for byte against the artifacts this configuration would
   * generate, so a silently patched quantity, a stubbed audit or a stale
   * manifest all fail instead of passing on structure alone. */
  let drcReport = null, drcOk = false, bomOk = false, csvOk = false, proofOk = false, artifactsOk = false;
  try {
    const base = slug(c.name);
    /* The expected bundle is regenerated from the configuration, so every
     * shipped artifact is compared byte for byte: content tampering cannot
     * survive even when the attacker reseals the layout proof. */
    const expected = generateArtifacts(c);
    artifactsOk = Object.keys(expected).every(name => files[name] === expected[name]);
    const drcName = Object.keys(files).find(name => name.endsWith('_drc.json'));
    drcReport = drcName ? JSON.parse(files[drcName]) : null;
    const expectedAudit = auditDesign(c);
    const checkIds = expectedAudit.checks.map(ch => ch.id);
    const auditDigest = audit => sha256Hex((audit.checks || []).map(ch =>
      ch.id + ':' + (ch.valid ? '1' : '0') + ':' + ch.detail).join('\n'));
    drcOk = !!(drcReport && drcReport.schema === DRC_SCHEMA &&
      Array.isArray(drcReport.checks) && drcReport.checks.length === checkIds.length &&
      checkIds.every(id => drcReport.checks.some(ch => ch.id === id)) &&
      drcReport.fingerprint === auditDigest(drcReport) &&
      files[drcName] === expected[drcName]);
    const bomName = Object.keys(files).find(name => name.endsWith('_bom.json'));
    const csvName = Object.keys(files).find(name => name.endsWith('_bom.csv'));
    const bom = bomName ? JSON.parse(files[bomName]) : null;
    const expectedBom = buildBom(c);
    if (bom && bom.schema === BOM_SCHEMA && Array.isArray(bom.items)) {
      const canonical = bom.items.map(item =>
        [item.category, item.refs.join('|'), item.qty, item.value, item.footprint, item.notes].join('')).join('\n');
      bomOk = bom.fingerprint === sha256Hex(canonical) && bom.totals.switches === board.stats.keys &&
        bom.items.reduce((n, item) => n + item.qty, 0) === bom.totals.parts &&
        files[bomName] === expected[bomName];
    }
    csvOk = !!(csvName && files[csvName] === expected[csvName]);
    /* The manifest must seal exactly the artifacts this configuration
     * exports: completeness matters as much as the digests, because a
     * bundle missing an unsealed file (the OpenSCAD source, the preview)
     * with a freshly crafted manifest would otherwise look consistent. */
    const expectedNames = new Set(Object.keys(expected));
    const proofName = Object.keys(files).find(name => name.endsWith('_layout_proof.json'));
    const proof = proofName ? JSON.parse(files[proofName]) : null;
    const sealedNames = Object.keys(files).filter(name =>
      !name.endsWith('_layout_proof.json') && name !== 'verification.json');
    proofOk = !!(proof && proof.schema === PROOF_SCHEMA && Array.isArray(proof.files) &&
      proof.files.length === expectedNames.size &&
      proof.files.every(entry => expectedNames.has(entry.name)) &&
      sealedNames.every(name => expectedNames.has(name)) &&
      files[proofName] === JSON.stringify(buildLayoutProof(c, files), null, 2) + '\n');
  } catch (_) { drcReport = null; drcOk = false; bomOk = false; csvOk = false; proofOk = false; artifactsOk = false; }
  const checks = [
    { label: 'KiCad 8 schema and net references', valid: kicad.valid && pcbMatches, detail: kicad.footprints + ' footprints, ' + kicad.pads + ' pads matched' },
    { label: 'Closed STL topology and winding', valid: mesh.valid, detail: mesh.triangles + ' triangles, ' + mesh.badEdges + ' open or misoriented edges' },
    { label: 'RS-274X layer round trip', valid: gerbers.length === Object.keys(GERBER_LAYERS).length && gerbersMatch, detail: gerbers.length + ' layers, pad positions and sizes matched' },
    { label: 'Excellon drill round trip', valid: drills.length === 2 && drillsMatch, detail: board.drillPoints.length + ' hits, diameters and plating matched' },
    { label: 'OpenSCAD mount bores match the board layout', valid: scadMountsMatch,
      detail: scadMountsMatch ? board.layout.mounts.length + ' bores at the adjusted layout coordinates' :
        (scadMounts ? scadMounts.length : 0) + ' SCAD bores diverge from ' + board.layout.mounts.length + ' board mounts' },
    { label: 'GPIO allocation is unique', valid: new Set(board.netlist.pins.usage.map(pin => pin.pin)).size === board.netlist.pins.usage.length, detail: board.netlist.pins.usage.length + ' assigned pins' },
    { label: 'Firmware matrix and keymap match', valid: firmwareMatches, detail: board.stats.keys + ' keys in KMK and QMK' },
    { label: 'Configuration round trip', valid: files['padcraft_config.json'] === JSON.stringify(c, null, 2) + '\n', detail: 'Normalized source matches exported snapshot' },
    { label: 'Design rule audit is clean', valid: !!(drcReport && drcReport.valid && drcReport.errors === 0 && drcOk),
      detail: drcReport ? (drcOk ? drcReport.errors + ' errors, ' + drcReport.warnings + ' warnings across ' + drcReport.checks.length + ' rules' : 'drc report failed the integrity round trip') : 'drc report missing or unreadable' },
    { label: 'Bill of materials round trip', valid: bomOk && csvOk, detail: 'JSON fingerprint, CSV rows and part totals recomputed' },
    { label: 'Layout proof manifest round trip', valid: proofOk, detail: 'SHA-256 digests over the exported artifacts recomputed' },
    { label: 'Exported artifacts match the regenerated bundle', valid: artifactsOk, detail: 'Every sealed file is byte-identical to a fresh export of this configuration' },
  ];
  return { valid: checks.every(check => check.valid), checks, kicad, mesh, geometry: inspectBoard(board),
    gerbers: gerbers.map(layer => ({ name: layer.name, valid: layer.valid, flashes: layer.flashes.length, draws: layer.draws.length, errors: layer.errors })),
    drills: drills.map(drill => ({ name: drill.name, valid: drill.valid, hits: drill.hits.length, errors: drill.errors })) };
}

/* ---- Deterministic fingerprints: dependency-free UTF-8 and SHA-256 ----- */

function utf8Bytes(text) {
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
  const bytes = typeof input === 'string' ? utf8Bytes(input) : Uint8Array.from(input);
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

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/* ---- Bill of materials ------------------------------------------------ */

const BOM_SCHEMA = 'padcraft.bom/1';

function buildBom(config) {
  const board = buildBoard(config);
  const c = board.config;
  const items = [];
  const add = (category, refs, value, footprint, notes) => items.push({
    line: items.length + 1, category, refs, qty: refs.length, value, footprint, notes,
  });
  const switches = board.components.filter(cp => cp.kind === 'switch').map(cp => cp.ref);
  const diodes = board.components.filter(cp => cp.kind === 'diode').map(cp => cp.ref);
  const sensors = board.components.filter(cp => cp.kind === 'sensor').map(cp => cp.ref);
  add('electromechanical', switches,
    c.switchType === 'Choc' ? 'Kailh Choc v1 low profile key switch' : 'Cherry MX compatible plate mount key switch',
    c.switchType === 'Choc' ? 'Kailh PG1350 socket' : 'MX 5 pin footprint',
    'One per matrix position');
  add('semiconductor', diodes, '1N4148W small signal switching diode', 'SOD-123',
    'Series diode per key; cathode faces the row rail');
  add('module', ['U1'], 'RP2040 Pico compatible microcontroller', '2x20 pin 2.54 mm headers',
    'Runs the exported KMK or QMK firmware');
  if (board.layout.encoder) add('electromechanical', ['ENC1'], 'EC11 rotary encoder with push switch',
    'EC11 vertical mount', 'Detent dial plus momentary push button');
  if (sensors.length) add('connector', sensors, '2.54 mm single row pin header, 3 position',
    'Conn_01x03', 'Analog sensor power, signal and ground');
  add('hardware', board.layout.mounts.map((m, i) => 'H' + (i + 1)), 'M2 screw and standoff set',
    f(c.mountHoleDiameter) + ' mm bore', 'One in each board corner');
  add('fabrication', ['PCB1'], 'Two layer FR-4 printed circuit board, ' + f(c.boardThickness) + ' mm',
    f(board.layout.width) + ' x ' + f(board.layout.height) + ' mm', 'From the exported Gerber and drill files');
  add('fabrication', ['PLATE1'], 'Switch plate, ' + f(c.plateThickness) + ' mm',
    'Per STL and SCAD exports', 'Cut or print from the plate model');
  const canonical = items.map(item =>
    [item.category, item.refs.join('|'), item.qty, item.value, item.footprint, item.notes].join('')).join('\n');
  return {
    schema: BOM_SCHEMA,
    design: c.name,
    program: c.program,
    board: {
      widthMm: round3(board.layout.width),
      heightMm: round3(board.layout.height),
      areaMm2: round3(board.layout.width * board.layout.height),
    },
    items,
    totals: {
      lines: items.length,
      parts: items.reduce((n, item) => n + item.qty, 0),
      switches: switches.length,
      diodes: diodes.length,
      gpioUsed: board.netlist.pins.needed,
      adcChannels: board.netlist.pins.sensor.length,
    },
    fingerprint: sha256Hex(canonical),
  };
}

function buildBomCsv(bom) {
  const escape = value => {
    const s = String(value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = bom.items.map(item =>
    [item.line, item.category, item.refs.join(' '), item.qty, item.value, item.footprint, item.notes]
      .map(escape).join(','));
  return [
    '# ' + bom.schema + ' | design ' + bom.design + ' | sha256 ' + bom.fingerprint,
    'line,category,refs,qty,value,footprint,notes',
    ...rows,
  ].join('\n') + '\n';
}

/* ---- Design rule audit ------------------------------------------------- */

const DRC_SCHEMA = 'padcraft.drc/1';

/* A deterministic physical and electrical audit over the board model. Every
 * check records the measurement it used so the report reads like a real DRC
 * log. severity: 'error' fails the design, 'warning' is advisory, 'info' is
 * a recorded observation. */
function auditBoard(board) {
  const c = board.config, layout = board.layout, pins = board.netlist.pins;
  const geometry = inspectBoard(board);
  const checks = [];
  const add = (id, domain, label, severity, valid, detail) => {
    checks.push({ id, domain, label, severity, valid: !!valid, detail });
  };

  /* Mechanical domain. */
  const outside = [];
  for (const cp of board.components) {
    if (cp.outline) {
      if (cp.x - cp.outline.w / 2 < -1e-9 || cp.y - cp.outline.h / 2 < -1e-9 ||
          cp.x + cp.outline.w / 2 > layout.width + 1e-9 || cp.y + cp.outline.h / 2 > layout.height + 1e-9) {
        outside.push(cp.ref + ' courtyard');
      }
    }
    for (const p of cp.pads) {
      if (p.x - p.w / 2 < -1e-9 || p.y - p.h / 2 < -1e-9 ||
          p.x + p.w / 2 > layout.width + 1e-9 || p.y + p.h / 2 > layout.height + 1e-9) {
        outside.push(cp.ref + ' pad ' + p.num);
      }
    }
  }
  board.drillPoints.forEach((d, i) => {
    if (d.x - d.diameter / 2 < -1e-9 || d.y - d.diameter / 2 < -1e-9 ||
        d.x + d.diameter / 2 > layout.width + 1e-9 || d.y + d.diameter / 2 > layout.height + 1e-9) {
      outside.push('drill hit ' + (i + 1));
    }
  });
  add('mechanical.enclosure', 'mechanical', 'Bounding enclosure holds every courtyard, pad and drill', 'error',
    outside.length === 0,
    f(layout.width) + ' x ' + f(layout.height) + ' mm Edge.Cuts bounds ' + board.components.length +
    ' footprints and ' + board.drillPoints.length + ' drill hits' +
    (outside.length ? '; outside: ' + outside.slice(0, 4).join(', ') : ''));

  const pitches = [];
  for (const k of layout.keys) {
    const right = layout.keys.find(o => o.row === k.row && o.col === k.col + 1);
    const down = layout.keys.find(o => o.row === k.row + 1 && o.col === k.col);
    if (right) pitches.push(Math.hypot(right.x - k.x, right.y - k.y));
    if (down) pitches.push(Math.hypot(down.x - k.x, down.y - k.y));
  }
  const pitchDeviation = pitches.length ? Math.max(...pitches.map(p => Math.abs(p - c.keySpacing))) : 0;
  add('mechanical.key-pitch', 'mechanical', 'Uniform key pitch across the matrix grid', 'error',
    pitchDeviation < 1e-9,
    pitches.length + ' adjacencies measured; max deviation ' + f(pitchDeviation, 6) +
    ' mm from ' + f(c.keySpacing) + ' mm pitch');

  let minWeb = Infinity;
  for (let i = 0; i < layout.cutouts.length; i++) {
    const a = layout.cutouts[i];
    minWeb = Math.min(minWeb,
      a.x - a.w / 2, a.y - a.h / 2, layout.width - a.x - a.w / 2, layout.height - a.y - a.h / 2);
    for (let j = i + 1; j < layout.cutouts.length; j++) {
      const b = layout.cutouts[j];
      minWeb = Math.min(minWeb, Math.hypot(
        Math.max(0, Math.abs(a.x - b.x) - (a.w + b.w) / 2),
        Math.max(0, Math.abs(a.y - b.y) - (a.h + b.h) / 2)));
    }
  }
  add('mechanical.plate-web', 'mechanical', 'Plate web keeps stock between openings and the edge',
    minWeb <= 0 ? 'error' : 'warning', minWeb >= 2,
    'minimum ' + f(minWeb) + ' mm web over ' + layout.cutouts.length +
    ' openings; the plate wants at least 2 mm between them');

  const bayViolations = [];
  for (const cp of board.components) {
    if (!cp.outline) continue;
    const left = cp.x - cp.outline.w / 2, right = cp.x + cp.outline.w / 2;
    if (cp.kind === 'mcu') {
      if (left < layout.keyWidth - 1e-9) bayViolations.push(cp.ref + ' crosses the bay edge');
    } else if (right > layout.keyWidth + 1e-9) bayViolations.push(cp.ref + ' enters the controller bay');
  }
  add('mechanical.controller-bay', 'mechanical', 'Controller bay stays clear of the switch field', 'error',
    bayViolations.length === 0,
    'bay starts at x=' + f(layout.keyWidth) + ' mm of ' + f(layout.width) + ' mm' +
    (bayViolations.length ? '; ' + bayViolations.slice(0, 3).join(', ') : ''));

  let minCourtyard = Infinity;
  for (let i = 0; i < board.components.length; i++) {
    const a = board.components[i];
    if (!a.outline) continue;
    for (let j = i + 1; j < board.components.length; j++) {
      const b = board.components[j];
      if (!b.outline) continue;
      const ox = Math.abs(a.x - b.x) - (a.outline.w + b.outline.w) / 2;
      const oy = Math.abs(a.y - b.y) - (a.outline.h + b.outline.h) / 2;
      const gap = ox < 0 && oy < 0 ? Math.max(ox, oy) : Math.hypot(Math.max(0, ox), Math.max(0, oy));
      minCourtyard = Math.min(minCourtyard, gap);
    }
  }
  add('mechanical.courtyards', 'mechanical', 'Footprint courtyards keep working room',
    minCourtyard <= 0 ? 'error' : 'warning', minCourtyard >= 0.5,
    'minimum ' + f(minCourtyard) + ' mm between component courtyards');

  const plated = board.drillPoints.filter(d => d.plated);
  const padDrills = [];
  for (const cp of board.components) for (const p of cp.pads) if (p.drill > 0) padDrills.push(p);
  const orphans = plated.filter(d =>
    !padDrills.some(p => Math.abs(p.x - d.x) < 1e-6 && Math.abs(p.y - d.y) < 1e-6 && p.drill === d.diameter));
  const tiny = board.drillPoints.filter(d => d.diameter < 0.3);
  const minBore = board.drillPoints.length ? Math.min(...board.drillPoints.map(d => d.diameter)) : 0;
  add('mechanical.drills', 'mechanical', 'Every plated drill lands on its pad and bores stay fab safe', 'error',
    orphans.length === 0 && tiny.length === 0,
    plated.length + ' plated hits on pads, ' + (board.drillPoints.length - plated.length) +
    ' non-plated; minimum bore ' + f(minBore) + ' mm');

  /* Non-plated bores must keep copper clearance from every pad envelope and
   * stay inside the outline: a mounting hole that clips a Pico pin or a
   * support pin that grazes a pad is a fabrication defect, not a style
   * issue. Reuses the same envelope scan as the copper geometry report. */
  const boreConflicts = geometry.issues.filter(issue =>
    issue.includes('copper clearance at') || issue.includes('drill-to-edge'));
  add('mechanical.drill-copper', 'mechanical', 'Mounting and support bores keep copper clearance', 'error',
    boreConflicts.length === 0,
    boreConflicts.length ? boreConflicts.slice(0, 4).join('; ') :
    board.drillPoints.filter(d => !d.plated).length + ' non-plated bores clear every copper pad and the edge');

  /* Electrical domain. */
  add('electrical.pin-budget', 'electrical', 'Matrix fits the RP2040 GPIO budget', 'error',
    pins.needed <= pins.pool.length,
    pins.needed + ' of ' + pins.pool.length + ' GPIOs allocated' +
    (c.pinOffset ? ' after pool offset ' + c.pinOffset : '') +
    (pins.sensor.length ? '; ' + pins.sensor.length + ' dedicated ADC channels' : ''));

  const usedPins = pins.usage.map(u => u.pin);
  const duplicated = [...new Set(usedPins.filter((p, i) => usedPins.indexOf(p) !== i))];
  add('electrical.pin-uniqueness', 'electrical', 'Every GPIO is assigned exactly once', 'error',
    duplicated.length === 0,
    usedPins.length + ' assignments' +
    (duplicated.length ? '; duplicates: ' + duplicated.join(', ') : ' on distinct pins'));

  const legalPool = new Set([
    ...RP2040_GPIO_POOL.slice(c.pinOffset).map(n => 'GP' + n), ...RP2040_ADC_POOL]);
  const illegal = usedPins.filter(p => !legalPool.has(p));
  add('electrical.pin-legality', 'electrical', 'Assignments stay inside the legal RP2040 pools', 'error',
    illegal.length === 0,
    illegal.length ? 'illegal pins: ' + illegal.join(', ') :
    usedPins.length + ' pins inside the digital pool and GP26 to GP28');

  const adcOffPool = pins.sensor.filter(p => !RP2040_ADC_POOL.includes(p));
  add('electrical.adc-bounds', 'electrical', 'Analog channels stay on GP26 to GP28', 'error',
    adcOffPool.length === 0 && pins.sensor.length <= RP2040_ADC_POOL.length,
    pins.sensor.length ? pins.sensor.join(', ') + ' assigned' : 'no analog channels in this design');

  const padCount = {};
  for (const cp of board.components) for (const p of cp.pads) {
    if (p.net) padCount[p.net.name] = (padCount[p.net.name] || 0) + 1;
  }
  const netOf = (cp, i) => (cp.pads[i] && cp.pads[i].net ? cp.pads[i].net.name : 'unconnected');
  const polarityFaults = [];
  for (const a of board.netlist.assignments) {
    const sw = board.components.find(cp => cp.ref === a.switch);
    const dio = board.components.find(cp => cp.ref === a.diode);
    if (!sw || !dio) { polarityFaults.push('missing ' + (sw ? a.diode : a.switch)); continue; }
    if (netOf(sw, 0) !== a.colNet) polarityFaults.push(a.switch + ' pad1 lands on ' + netOf(sw, 0));
    if (netOf(sw, 1) !== a.keyNet) polarityFaults.push(a.switch + ' pad2 lands on ' + netOf(sw, 1));
    if (netOf(dio, 0) !== a.keyNet) polarityFaults.push(a.diode + ' anode lands on ' + netOf(dio, 0));
    if (netOf(dio, 1) !== a.rowNet) polarityFaults.push(a.diode + ' cathode lands on ' + netOf(dio, 1));
  }
  add('electrical.diode-polarity', 'electrical', 'COL2ROW diode polarity on every key', 'error',
    polarityFaults.length === 0,
    board.netlist.assignments.length + ' diodes: anode on the key node, cathode on the row rail' +
    (polarityFaults.length ? '; faults: ' + polarityFaults.slice(0, 3).join(', ') : ''));

  const keyNets = board.netlist.assignments.map(a => a.keyNet);
  const nodesUnique = new Set(keyNets).size === keyNets.length;
  const badNodes = keyNets.filter(n => (padCount[n] || 0) !== 2);
  const fanoutFaults = [];
  for (let r = 0; r < c.rows; r++) {
    if ((padCount['ROW' + r] || 0) !== c.cols + 1) fanoutFaults.push('ROW' + r);
  }
  for (let col = 0; col < c.cols; col++) {
    if ((padCount['COL' + col] || 0) !== c.rows + 1) fanoutFaults.push('COL' + col);
  }
  add('electrical.anti-ghosting', 'electrical', 'Series diodes isolate every key against ghosting', 'error',
    nodesUnique && badNodes.length === 0 && fanoutFaults.length === 0,
    keyNets.length + ' unique key nodes, each shared by exactly one switch and one diode; ' +
    'ROW fans to ' + (c.cols + 1) + ' pads, COL to ' + (c.rows + 1) +
    (badNodes.length + fanoutFaults.length ?
      '; off spec: ' + [...badNodes, ...fanoutFaults].slice(0, 4).join(', ') : ''));

  const rails = new Set(['GND', '3V3', 'VBUS', 'RUN', 'ADC_VREF', '3V3_EN']);
  const quiet = board.nets.names.filter(n => !rails.has(n) && (padCount[n] || 0) < 2);
  add('electrical.net-fanout', 'electrical', 'Every signal net reaches at least two pads', 'error',
    quiet.length === 0,
    board.nets.names.length + ' declared nets' +
    (quiet.length ? '; single terminal: ' + quiet.slice(0, 4).join(', ') : ' all fanned out'));

  add('electrical.ground', 'electrical', 'Ground and 3V3 returns exist', 'error',
    (padCount['GND'] || 0) >= 1 && (!pins.sensor.length || (padCount['3V3'] || 0) >= 2),
    'GND on ' + (padCount['GND'] || 0) + ' pads, 3V3 on ' + (padCount['3V3'] || 0));

  add('electrical.copper-clearance', 'electrical', 'Copper clearance holds at 0.2 mm', 'error',
    geometry.geometryValid,
    geometry.issues.length ? geometry.issues.length + ' clearance conflicts' :
    'conservative envelope scan clean over ' + board.traces.length + ' copper features');

  add('electrical.routing', 'electrical', 'Unfinished connections stay visible as airwires', 'info', true,
    geometry.remainingRoutes + ' airwires span ' + geometry.totalConnections +
    ' pad connections; finish in KiCad');

  /* Firmware domain. */
  const cells = board.keymap.flat();
  const badCells = cells.filter(k => !isValidKeycode(k));
  const badLayers = cells.filter(k => !keycodeLayerDefined(k));
  add('firmware.keymap', 'firmware', 'Keymap covers every matrix position with valid keycodes', 'error',
    board.keymap.length === c.rows && board.keymap.every(r => r.length === c.cols) &&
      badCells.length === 0 && badLayers.length === 0,
    cells.length + ' keycodes over a ' + c.rows + ' x ' + c.cols + ' matrix' +
    (badCells.length ? '; invalid: ' + badCells.slice(0, 3).join(', ') : '') +
    (badLayers.length ? '; layer switch targets an undefined layer: ' + badLayers.slice(0, 3).join(', ') : ''));

  const audit = {
    schema: DRC_SCHEMA,
    design: c.name,
    program: c.program,
    checks,
    envelope: {
      widthMm: round3(layout.width),
      heightMm: round3(layout.height),
      areaMm2: round3(layout.width * layout.height),
      boardThicknessMm: c.boardThickness,
      plateThicknessMm: c.plateThickness,
    },
    matrix: {
      rows: c.rows,
      cols: c.cols,
      keys: layout.keys.length,
      pinsNeeded: pins.needed,
      pinsAvailable: pins.pool.length,
      adcChannels: pins.sensor.length,
      diodeOrientation: 'COL2ROW',
      remainingRoutes: geometry.remainingRoutes,
    },
  };
  return sealAudit(audit);
}

function sealAudit(audit) {
  audit.errors = audit.checks.filter(ch => !ch.valid && ch.severity === 'error').length;
  audit.warnings = audit.checks.filter(ch => !ch.valid && ch.severity === 'warning').length;
  audit.passed = audit.checks.filter(ch => ch.valid).length;
  audit.valid = audit.errors === 0;
  audit.fingerprint = sha256Hex(audit.checks.map(ch =>
    ch.id + ':' + (ch.valid ? '1' : '0') + ':' + ch.detail).join('\n'));
  return audit;
}

/* Full audit: physical and electrical rules plus a firmware cross-check that
 * the generated KMK and QMK sources mirror the same matrix and polarity. */
function auditDesign(config) {
  const c = clampConfig(config);
  const board = buildBoard(c);
  const audit = auditBoard(board);
  const kmk = generateKMK(c);
  const qmkInfo = JSON.parse(generateQMK(c)['keyboard.json']);
  const faults = [];
  if (!kmk.includes('DiodeOrientation.COL2ROW')) faults.push('KMK diode orientation');
  const named = [...board.netlist.pins.rows, ...board.netlist.pins.cols,
    ...(board.netlist.pins.encoder ? Object.values(board.netlist.pins.encoder) : []),
    ...board.netlist.pins.sensor];
  for (const pin of named) if (!kmk.includes('board.' + pin)) faults.push('KMK missing ' + pin);
  if (JSON.stringify(qmkInfo.matrix_pins.rows) !== JSON.stringify(board.netlist.pins.rows)) faults.push('QMK row pins diverge');
  if (JSON.stringify(qmkInfo.matrix_pins.cols) !== JSON.stringify(board.netlist.pins.cols)) faults.push('QMK column pins diverge');
  if (qmkInfo.diode_direction !== 'COL2ROW') faults.push('QMK diode direction');
  audit.checks.push({
    id: 'firmware.consistency', domain: 'firmware',
    label: 'KMK and QMK mirror the same matrix, pins and diode direction',
    severity: 'error', valid: faults.length === 0,
    detail: faults.length ? faults.slice(0, 3).join(', ') :
      'COL2ROW over ' + board.netlist.pins.needed + ' GPIOs on both firmware exports',
  });
  return sealAudit(audit);
}

/* ---- Layout proof: a fingerprinted manifest of the whole export -------- */

const PROOF_SCHEMA = 'padcraft.proof/1';

function buildLayoutProof(config, files) {
  const c = clampConfig(config);
  const board = buildBoard(c);
  /* The manifest covers every generated artifact except itself and the
   * verification report it feeds: verification.json is emitted after the
   * proof, so it can never hash its own contents. Entries are sorted by
   * name so a repacked bundle with a different member order still hashes
   * to the same manifest. */
  const entries = Object.entries(files)
    .filter(([name]) => !name.endsWith('_layout_proof.json') && name !== 'verification.json')
    .map(([name, body]) => ({ name, bytes: utf8Bytes(body).length, sha256: sha256Hex(body) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    schema: PROOF_SCHEMA,
    design: c.name,
    program: c.program,
    envelope: {
      widthMm: round3(board.layout.width),
      heightMm: round3(board.layout.height),
      areaMm2: round3(board.layout.width * board.layout.height),
      boardThicknessMm: c.boardThickness,
      plateThicknessMm: c.plateThickness,
    },
    matrix: {
      rows: c.rows,
      cols: c.cols,
      keys: board.stats.keys,
      pinsNeeded: board.netlist.pins.needed,
      pinsAvailable: board.netlist.pins.pool.length,
      diodeOrientation: 'COL2ROW',
    },
    files: entries,
    fingerprint: sha256Hex(entries.map(e => e.name + ':' + e.bytes + ':' + e.sha256).join('\n')),
  };
}

/* Every exportable artifact except the layout proof and the verification
 * report: verification.json is the consumer of those artifacts, and the
 * proof seals them. verifyBundle() regenerates this exact set so bundle
 * integrity is content equality, not just structural checks. */
function generateArtifacts(config) {
  const c = clampConfig(config), base = slug(c.name);
  const bom = buildBom(c);
  const files = {
    [base + '.kicad_pcb']: generateKiCadPcb(c),
    [base + '_plate.stl']: generateSTL(c),
    [base + '_plate.scad']: generateOpenSCAD(c),
    ...Object.fromEntries(Object.entries(GERBER_LAYERS).map(([layer, data]) => [base + '_' + data.suffix + '.gbr', generateGerber(c, layer)])),
    [base + '_PTH.drl']: generateExcellon(c, true),
    [base + '_NPTH.drl']: generateExcellon(c, false),
    'kb.py': generateKMK(c),
    'qmk_bundle.json': JSON.stringify(generateQMK(c), null, 2) + '\n',
    'padcraft_config.json': JSON.stringify(c, null, 2) + '\n',
    'preview.json': JSON.stringify(buildBoard(c), null, 2) + '\n',
    [base + '_bom.json']: JSON.stringify(bom, null, 2) + '\n',
    [base + '_bom.csv']: buildBomCsv(bom),
    [base + '_drc.json']: JSON.stringify(auditDesign(c), null, 2) + '\n',
  };
  const qmk = generateQMK(c);
  for (const [name, body] of Object.entries(qmk)) {
    files['qmk/' + base + '/' + (name === 'keymap.c' ? 'keymaps/default/' : '') + name] = body;
  }
  return files;
}

function generateAll(config) {
  const c = clampConfig(config), base = slug(c.name);
  const files = generateArtifacts(c);
  /* The layout proof seals the artifact digests first; the verification
   * report is emitted last so its manifest check can audit the shipped
   * proof instead of assuming one exists. */
  files[base + '_layout_proof.json'] = JSON.stringify(buildLayoutProof(c, files), null, 2) + '\n';
  files['verification.json'] = JSON.stringify(verifyBundle(c, files), null, 2) + '\n';
  return files;
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
  '  drill     Write a plated Excellon drill file',
  '  kmk       Write KMK firmware kb.py',
  '  qmk       Write a QMK bundle as JSON (keyboard.json, keymap.c, ...)',
  '  bom       Write the fingerprinted bill of materials as JSON',
  '  bomcsv    Write the bill of materials as CSV',
  '  preview   Write the board model as JSON for custom renderers',
  '  validate  Check a KiCad file for S-expression and netlist validity',
  '  drc       Run the design rule audit and print the report',
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
    encoderDiameter: 'encoderDiameter', boardThickness: 'boardThickness', mountHoleDiameter: 'mountHoleDiameter',
  };
  const aliases = { cutout: 'switchCutout', thickness: 'plateThickness', margin: 'edgeMargin' };
  for (const [alias, target] of Object.entries(aliases)) if (args[alias] !== undefined && args[target] === undefined) args[target] = args[alias];
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
    'edgeMargin', 'sensorCount', 'pinOffset', 'encoderDiameter', 'boardThickness', 'mountHoleDiameter']) {
    if (raw[numKey] !== undefined) raw[numKey] = Number(raw[numKey]);
  }
  return clampConfig(raw);
}

/* Commands that write an artifact share the browser download's gate: the
 * design audit must report zero errors before anything reaches disk.
 * Warnings stay advisory and never block an export. */
const CLI_WRITE_COMMANDS = new Set(['kicad', 'stl', 'drill', 'scad', 'gerber',
  'kmk', 'bom', 'bomcsv', 'qmk', 'preview', 'all']);

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
  if (CLI_WRITE_COMMANDS.has(cmd)) {
    const audit = auditDesign(cfg);
    if (!audit.valid) {
      process.stderr.write(JSON.stringify(audit, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }
  }
  let result;
  switch (cmd) {
    case 'kicad': result = { [args.out || (slug(cfg.name) + '.kicad_pcb')]: generateKiCadPcb(cfg) }; break;
    case 'stl': result = { [args.out || (slug(cfg.name) + '_plate.stl')]: generateSTL(cfg) }; break;
    case 'drill': result = { [args.out || (slug(cfg.name) + '_PTH.drl')]: generateExcellon(cfg, true) }; break;
    case 'scad': result = { [args.out || (slug(cfg.name) + '_plate.scad')]: generateOpenSCAD(cfg) }; break;
    case 'gerber': result = { [args.out || (slug(cfg.name) + '_F_Cu.gbr')]: generateGerberFCu(cfg) }; break;
    case 'kmk': result = { [args.out || 'kb.py']: generateKMK(cfg) }; break;
    case 'bom': result = { [args.out || (slug(cfg.name) + '_bom.json')]: JSON.stringify(buildBom(cfg), null, 2) + '\n' }; break;
    case 'bomcsv': result = { [args.out || (slug(cfg.name) + '_bom.csv')]: buildBomCsv(buildBom(cfg)) }; break;
    case 'drc': {
      const audit = auditDesign(cfg);
      process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
      process.exitCode = audit.valid ? 0 : 1;
      return;
    }
    case 'qmk': result = { [args.out || 'qmk_bundle.json']: JSON.stringify(generateQMK(cfg), null, 2) + '\n' }; break;
    case 'preview': result = { [args.out || 'padcraft_preview.json']: JSON.stringify(buildBoard(cfg), null, 2) + '\n' }; break;
    case 'all': {
      result = generateAll(cfg);
      const dir = args.out || './build';
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(result)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
      }
      process.stdout.write('Wrote ' + Object.keys(result).length + ' files to ' + dir + '\n');
      return;
    }
    case 'check': {
      const board = buildBoard(cfg);
      const bundle = generateAll(cfg), verified = verifyBundle(cfg, bundle);
      const pcb = generateKiCadPcb(cfg);
      const v = validateKiCadPcb(pcb);
      const mesh = buildPlateMesh(cfg);
      const badNormals = mesh.facets.filter(t => {
        const len = Math.sqrt(t.n[0] ** 2 + t.n[1] ** 2 + t.n[2] ** 2);
        return Math.abs(len - 1) > 1e-6;
      });
      const audit = auditDesign(cfg);
      const report = {
        board: cfg.name, program: cfg.program,
        size_mm: [board.layout.width, board.layout.height],
        keys: board.stats.keys, diodes: board.stats.diodes,
        pins: board.netlist.pins.needed, nets: board.stats.nets,
        drc_valid: audit.valid, drc_errors: audit.errors, drc_warnings: audit.warnings,
        drc_fingerprint: audit.fingerprint,
        kicad_valid: v.valid, kicad_errors: v.errors,
        kicad_footprints: v.footprints, kicad_pads: v.pads,
        stl_triangles: mesh.facets.length, stl_bad_normals: badNormals.length,
        kmk_has_keymap: generateKMK(cfg).includes('keyboard.keymap = ['),
        qmk_has_matrix: generateQMK(cfg)['keyboard.json'].includes('matrix_pins'),
        bundle_valid: verified.valid,
        gerber_layers: verified.gerbers.length, drill_files: verified.drills.length,
        stl_open_edges: verified.mesh.badEdges, stl_volume_error_mm3: verified.mesh.volumeError,
        routing_remaining: verified.geometry.remainingRoutes,
        geometry_issues: verified.geometry.issues,
      };
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exitCode = (verified.valid && verified.geometry.geometryValid) ? 0 : 1;
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
  PROGRAMS, SHOWCASES, GERBER_LAYERS, DEFAULT_CONFIG, PICO_PINOUT, RP2040_GPIO_POOL, RP2040_ADC_POOL,
  BOM_SCHEMA, DRC_SCHEMA, PROOF_SCHEMA, CLI_HELP,
  f, clamp, numeric, clampConfig, applyProgram, defaultKeymap, normaliseKeymap, sanitizeKeycode, stableUuid, slug,
  VALID_KMK_KEYCODES, isValidKeycode, keycodeLayerDefined, kmkToQmk, pointToPadDistance, rectToSegmentDistance,
  scadMountPoints,
  computeLayout, buildPinAssignment, buildNetlist, buildBoard,
  generateKiCadPcb, tokenizeSexp, parseSexp, validateSexp, validateKiCadPcb,
  computeNormal, emitQuadTriangles, platePolygons, polygonArea, buildPlateMesh, inspectMesh, generateSTL,
  generateOpenSCAD, generateGerber, generateGerberFCu, validateGerber, generateExcellon, validateExcellon, generateKMK, generateQMK,
  distanceToSegment, segmentsIntersect, distanceSegmentToPad, inspectBoard, verifyBundle,
  utf8Bytes, sha256Hex, round3, buildBom, buildBomCsv, auditBoard, auditDesign, sealAudit, buildLayoutProof,
  generateAll, loadConfig, parseArgs, runCLI, validateSTL,
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
