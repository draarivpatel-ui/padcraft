'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { crc32, buildZip } = require('./app.js');
const pc = require('./cad.js');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const cadSource = fs.readFileSync(path.join(__dirname, 'cad.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

/* A deterministic DOM fixture exercises the shipped HTML IDs and real scripts.
 * Canvas calls reject nonfinite geometry. Downloads and file reads stay in memory. */
function boot(options = {}) {
  const events = new Map(), nodes = new Map(), showcaseButtons = [], downloads = [], calls = [], errors = [];
  let document;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {};
      this.dataset = {}; this.style = { setProperty(key, value) { this[key] = String(value); } };
      this.value = ''; this.checked = false; this.disabled = false; this._text = ''; this.files = [];
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { assert.equal(value, '', 'UI only clears HTML and creates safe nodes'); this._text = ''; this.children = []; }
    get innerHTML() { return ''; }
    appendChild(child) { this.children.push(child); child.parentElement = this; if (this.tagName === 'SELECT' && !this.value) this.value = child.value; return child; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] === undefined ? null : this.attributes[key]; }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
    emit(type, supplied = {}) {
      const event = { type, target: this, key: '', prevented: false, preventDefault() { this.prevented = true; }, ...supplied };
      for (const handler of this.listeners.get(type) || []) handler(event);
      return event;
    }
    click() { if (!this.disabled) { if (this.tagName === 'A') downloads.push({ name: this.download, href: this.href }); this.emit('click'); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth || 0, height: this.clientHeight || 0 }; }
  }
  document = { readyState: options.loading ? 'loading' : 'complete', activeElement: null,
    documentElement: new Element('html'), body: new Element('body'),
    getElementById(id) { return nodes.get(id) || null; },
    createElement(tag) { return new Element(tag); },
    querySelectorAll(selector) { assert.equal(selector, '[data-showcase]'); return showcaseButtons; },
    addEventListener(type, handler) { if (!events.has(type)) events.set(type, []); events.get(type).push(handler); },
    emit(type, event = {}) { for (const handler of events.get(type) || []) handler(event); },
  };
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*)>/gi)) {
    const [, tag, attributes] = match;
    const id = /\bid="([^"]+)"/.exec(attributes), showcase = /\bdata-showcase="([^"]+)"/.exec(attributes);
    if (!id && !showcase) continue;
    const node = new Element(tag);
    for (const attr of attributes.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) node.setAttribute(attr[1], attr[2]);
    if (id) nodes.set(id[1], node);
    const value = /\bvalue="([^"]*)"/.exec(attributes); if (value) node.value = value[1];
    node.checked = /\bchecked\b/.test(attributes); node.disabled = /\bdisabled\b/.test(attributes);
    if (showcase) { node.dataset.showcase = showcase[1]; showcaseButtons.push(node); }
  }
  const canvas = nodes.get('preview');
  canvas.clientWidth = options.width || 740; canvas.clientHeight = options.height || 410;
  const context = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      assert.ok(args.filter(value => typeof value === 'number').every(Number.isFinite), key + ' requires finite canvas coordinates');
      if (key === 'arc') assert.ok(args[2] >= 0, 'arc radius must be nonnegative');
      calls.push({ key, args });
    };
  } });
  canvas.getContext = () => options.noCanvas ? null : context;
  const windowEvents = new Map(), storage = new Map();
  if (options.theme) storage.set('padcraft.theme', options.theme);
  const window = { devicePixelRatio: options.dpr || 1, localStorage: {
    getItem(key) { if (options.storageFailure) throw new Error('storage disabled'); return storage.get(key); },
    setItem(key, value) { if (options.storageFailure) throw new Error('storage disabled'); storage.set(key, value); },
  }, addEventListener(type, handler) { windowEvents.set(type, handler); } };
  const blobs = new Map();
  class FileReader {
    readAsText(file) { if (file.readError) this.onerror(); else { this.result = file.data; this.onload(); } }
  }
  let observerCallback;
  class ResizeObserver { constructor(callback) { observerCallback = callback; } observe() {} }
  const sandbox = vm.createContext({ document, window, FileReader, ResizeObserver, TextEncoder, Uint8Array, Blob,
    URL: { createObjectURL(blob) { const url = 'blob:fixture-' + blobs.size; blobs.set(url, blob); return url; }, revokeObjectURL() {} },
    setTimeout(callback) { callback(); return 1; },
    console: { log() {}, warn(message) { errors.push(message); }, error(message) { errors.push(message); } },
  });
  new vm.Script(cadSource, { filename: 'cad.js' }).runInContext(sandbox);
  new vm.Script(appSource, { filename: 'app.js' }).runInContext(sandbox);
  if (options.loading) document.emit('DOMContentLoaded');
  return { sandbox, document, nodes, showcaseButtons, downloads, blobs, calls, errors, storage,
    snapshot() { return sandbox.PadCraftUI.getSnapshot(); },
    resize(width, height, dpr = window.devicePixelRatio) { canvas.clientWidth = width; canvas.clientHeight = height; window.devicePixelRatio = dpr; windowEvents.get('resize')(); },
    observeResize() { observerCallback(); },
    import(data, extras = {}) { const node = nodes.get('importConfig'); node.files = [{ name: 'design.json', data, size: data.length, ...extras }]; node.emit('change'); },
  };
}

function findEocd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= 0; offset--) if (view.getUint32(offset, true) === 0x06054b50) return { view, offset };
  assert.fail('missing ZIP end record');
}

test('ZIP: CRC32 matches the standard reference vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('ZIP: Unicode paths have UTF-8 flags, CRCs and consistent directory offsets', () => {
  const source = [{ name: 'qmk/example/keymaps/default/keymap.c', data: 'abc' }, { name: 'caf\u00e9.json', data: '{"name":"caf\u00e9"}' }];
  const bytes = buildZip(source), { view, offset } = findEocd(bytes);
  assert.equal(view.getUint16(offset + 10, true), 2);
  const directoryOffset = view.getUint32(offset + 16, true), directorySize = view.getUint32(offset + 12, true);
  assert.equal(directoryOffset + directorySize, offset);
  let cursor = 0;
  for (const file of source) {
    assert.equal(view.getUint32(cursor, true), 0x04034b50);
    assert.equal(view.getUint16(cursor + 6, true), 0x0800); assert.equal(view.getUint16(cursor + 8, true), 0);
    assert.equal(view.getUint16(cursor + 12, true), 0x21);
    const nameLength = view.getUint16(cursor + 26, true), length = view.getUint32(cursor + 22, true);
    assert.equal(new TextDecoder().decode(bytes.subarray(cursor + 30, cursor + 30 + nameLength)), file.name);
    const data = bytes.subarray(cursor + 30 + nameLength, cursor + 30 + nameLength + length);
    assert.equal(crc32(data), view.getUint32(cursor + 14, true));
    assert.equal(new TextDecoder().decode(data), file.data);
    cursor += 30 + nameLength + length;
  }
  assert.equal(cursor, directoryOffset);
  assert.equal(view.getUint32(directoryOffset, true), 0x02014b50);
  assert.equal(view.getUint16(directoryOffset + 8, true), 0x0800);
});

test('ZIP: empty archives work and ambiguous paths are rejected', () => {
  assert.equal(findEocd(buildZip([])).view.getUint16(10, true), 0);
  for (const name of ['../secret', '/absolute', 'a/../b', 'a\\b', 'a//b', '']) assert.throws(() => buildZip([{ name, data: '' }]), /relative paths/);
  assert.throws(() => buildZip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /unique/);
});

test('HTML: actual script order, syntax, control IDs and labels are coherent', () => {
  const scripts = [...html.matchAll(/<script(?:\s+src="([^"]+)")?[^>]*>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map(match => match[1]), ['cad.js', 'pad-lab.js', 'app.js']);
  for (const script of scripts) new vm.Script(script[1] ? fs.readFileSync(path.join(__dirname, script[1]), 'utf8') : script[2]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/<label\b[^>]*for="([^"]+)"/g)) assert.ok(ids.includes(match[1]), 'label targets ' + match[1]);
  assert.ok(html.includes('lang="en"')); assert.ok(html.includes('class="skip-link"'));
  assert.ok(!/\b(?:src|href)="https?:\/\//.test(html), 'runtime resources are local');
});

/* .canvas-shell clips overflow, so the canvas focus ring must paint inside
 * its own border box or keyboard users see nothing (WCAG 2.4.7). The ring
 * is inset past the 8px corner radius on every side, and each theme picks a
 * ring color that holds 4.5:1 against the dark canvas surface it overlays
 * (the canvas paints the same dark drafting sheet in both themes). */
test('CSS: the PCB canvas keeps a visible focus indicator inside the clipped shell', () => {
  const shell = /\.canvas-shell\s*\{([^}]*)\}/.exec(cssSource);
  assert.ok(shell && /overflow:\s*hidden/.test(shell[1]), 'canvas shell clips overflow');
  assert.match(shell[1], /border-radius:\s*8px/, 'shell corner radius is 8px');
  const rule = /#preview:focus-visible\s*\{([^}]*)\}/.exec(cssSource);
  assert.ok(rule, 'canvas has a focus-visible rule');
  assert.match(rule[1], /outline:\s*3px solid var\(--canvas-ring\)/);
  assert.match(rule[1], /outline-offset:\s*-6px/);
  assert.ok(!/outline-offset:\s*\d/.test(rule[1]), 'canvas offset stays negative');
  const dark = /--canvas-ring:\s*(#[0-9a-fA-F]{6})/.exec(cssSource);
  const light = /:root\[data-theme="light"\][\s\S]*?--canvas-ring:\s*(#[0-9a-fA-F]{6})/.exec(cssSource);
  assert.ok(dark && light, 'ring color is defined per theme');
  assert.notEqual(dark[1].toLowerCase(), light[1].toLowerCase());
});

test('DOM: initial boot generates 25 artifacts and displays verified geometry without console errors', () => {
  const ui = boot(), state = ui.snapshot();
  assert.equal(state.config.name, 'Studio Control'); assert.equal(Object.keys(state.files).length, 25);
  assert.equal(state.verification.valid, true); assert.equal(state.verification.geometry.geometryValid, true);
  assert.equal(state.audit.valid, true); assert.equal(state.audit.errors, 0);
  assert.match(state.audit.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(ui.nodes.get('downloadZip').disabled, false);
  assert.match(ui.nodes.get('status').textContent, /19 routes to finish/);
  assert.ok(!ui.nodes.get('status').textContent.includes('DRC PASS'));
  assert.deepEqual(ui.errors, []);
});

test('DOM: DOMContentLoaded initialization is safe', () => {
  const ui = boot({ loading: true });
  assert.equal(Object.keys(ui.snapshot().files).length, 25); assert.deepEqual(ui.errors, []);
});

test('DOM: every showcase regenerates matching files, dimensions and pressed state', () => {
  const ui = boot();
  for (const button of ui.showcaseButtons) {
    button.click(); const state = ui.snapshot(), preset = pc.SHOWCASES[button.dataset.showcase];
    assert.equal(state.config.rows, preset.config.rows); assert.equal(state.config.cols, preset.config.cols);
    assert.equal(state.config.name, preset.config.name); assert.equal(state.verification.valid, true);
    assert.equal(ui.showcaseButtons.filter(item => item.getAttribute('aria-pressed') === 'true').length, 1);
  }
  assert.deepEqual(ui.errors, []);
});

test('DOM: row and column edits preserve overlapping shortcuts and resize every export', () => {
  const ui = boot(), grid = ui.nodes.get('keymapGrid');
  grid.children[0].value = 'KC.A'; grid.children[0].emit('input');
  const rows = ui.nodes.get('rows'), cols = ui.nodes.get('cols');
  rows.value = '4'; rows.emit('input'); cols.value = '5'; cols.emit('input');
  assert.equal(grid.children.length, 20); assert.equal(ui.snapshot().config.keymap[0][0], 'KC.A');
  const pcb = Object.values(ui.snapshot().files).find(body => body.startsWith('(kicad_pcb'));
  assert.equal(pc.validateKiCadPcb(pcb).valid, true); assert.ok(ui.snapshot().files['kb.py'].includes('KC.A'));
  assert.equal(ui.showcaseButtons.filter(button => button.getAttribute('aria-pressed') === 'true').length, 0);
});

test('DOM: imported ragged keymaps are normalized and visible in the editor', () => {
  const ui = boot();
  ui.import(JSON.stringify({ name: 'Imported', rows: 2, cols: 2, encoder: false, keymap: [['KC.A'], 4] }));
  assert.equal(ui.snapshot().config.name, 'Imported');
  assert.equal(ui.nodes.get('keymapGrid').children.length, 4);
  assert.equal(ui.nodes.get('keymapGrid').children[3].value, 'KC.NO');
  assert.equal(ui.snapshot().verification.valid, true);
});

test('DOM: malformed, oversized and unreadable imports preserve the previous good design', () => {
  const ui = boot();
  for (const [data, options] of [['{', {}], ['[]', {}], ['{}', { size: 2 * 1024 * 1024 }], ['{}', { readError: true }]]) {
    ui.import(data, options);
    assert.match(ui.nodes.get('status').textContent, /Import failed/);
    assert.equal(ui.snapshot().config.name, 'Studio Control');
    assert.equal(ui.nodes.get('downloadZip').disabled, false);
  }
});

test('DOM: a solver failure clears stale files and disables ZIP, then recovers', () => {
  const ui = boot(), original = ui.sandbox.PadCraft.generateAll;
  ui.sandbox.PadCraft.generateAll = () => { throw new Error('fixture failure'); };
  ui.nodes.get('generate').click();
  assert.equal(Object.keys(ui.snapshot().files).length, 0); assert.equal(ui.snapshot().config, null);
  assert.equal(ui.nodes.get('downloadZip').disabled, true); assert.match(ui.nodes.get('status').textContent, /fixture failure/);
  assert.equal(ui.nodes.get('stats').textContent, ''); assert.equal(ui.nodes.get('pins').textContent, '');
  assert.equal(ui.nodes.get('routingReadout').textContent, 'Generation paused');
  ui.nodes.get('downloadZip').click(); assert.equal(ui.downloads.length, 0);
  ui.sandbox.PadCraft.generateAll = original; ui.nodes.get('generate').click();
  assert.equal(ui.snapshot().verification.valid, true); assert.equal(ui.nodes.get('downloadZip').disabled, false);
});

test('DOM: net isolation updates the inspection text and highlighted selection', () => {
  const ui = boot(), select = ui.nodes.get('netSelect');
  select.value = 'ROW0'; select.emit('change');
  assert.equal(ui.snapshot().selectedNet, 'ROW0'); assert.match(ui.nodes.get('inspectInfo').textContent, /Isolated net ROW0/);
  select.value = ''; select.emit('change'); assert.equal(ui.snapshot().selectedNet, '');
});

test('DOM: keyboard inspection covers the first and last switch and clears with Escape', () => {
  const ui = boot(), canvas = ui.nodes.get('preview');
  assert.equal(canvas.emit('keydown', { key: 'Home' }).prevented, true);
  assert.equal(ui.snapshot().selectedRef, 'SW1'); assert.match(ui.nodes.get('inspectInfo').textContent, /KC.MUTE/);
  canvas.emit('keydown', { key: 'ArrowDown' }); assert.equal(ui.snapshot().selectedRef, 'SW5');
  canvas.emit('keydown', { key: 'End' }); assert.equal(ui.snapshot().selectedRef, 'SW12');
  canvas.emit('keydown', { key: 'Escape' }); assert.equal(ui.snapshot().selectedRef, ''); assert.equal(ui.snapshot().selectedNet, '');
});

test('DOM: keymap cells are labeled and support Alt plus arrow navigation', () => {
  const ui = boot(), cells = ui.nodes.get('keymapGrid').children;
  assert.equal(cells[0].getAttribute('aria-label'), 'Keycode for row 1, column 1');
  const event = cells[0].emit('keydown', { key: 'ArrowRight', altKey: true });
  assert.equal(event.prevented, true); assert.equal(ui.document.activeElement, cells[1]);
});

test('DOM: pointer inspection identifies SMD pads and click isolates the correct net', () => {
  const ui = boot(), board = pc.buildBoard(ui.snapshot().config), diode = board.components.find(cp => cp.ref === 'D1');
  const pad = diode.pads[0], transform = ui.snapshot().transform;
  const event = { clientX: transform.ox + pad.x * transform.scale, clientY: transform.oy + pad.y * transform.scale };
  ui.nodes.get('preview').emit('pointermove', event); assert.match(ui.nodes.get('inspectInfo').textContent, /D1 pad 1.*SMD/);
  ui.nodes.get('preview').emit('click', event); assert.equal(ui.snapshot().selectedNet, pad.net.name);
});

test('DOM: DPI and very narrow resizes retain finite transforms and positive radii', () => {
  const ui = boot({ dpr: 2 });
  assert.equal(ui.nodes.get('preview').width, 1480);
  ui.resize(280, 330, 2.5); assert.equal(ui.nodes.get('preview').width, 700);
  ui.resize(50, 70, 4); assert.equal(ui.nodes.get('preview').width, 150);
  assert.ok(ui.snapshot().transform.scale > 0); ui.observeResize();
  assert.deepEqual(ui.errors, []);
});

test('DOM: SMD copper is drawn as rectangles without fake drill centers', () => {
  const ui = boot(), board = pc.buildBoard(ui.snapshot().config), pad = board.components.find(cp => cp.ref === 'D1').pads[0];
  const { ox, oy, scale } = ui.snapshot().transform;
  const x = ox + pad.x * scale, y = oy + pad.y * scale;
  assert.ok(ui.calls.some(call => call.key === 'fillRect' && Math.abs(call.args[0] - (x - pad.w / 2 * scale)) < 1e-8));
  assert.ok(!ui.calls.some(call => call.key === 'arc' && Math.abs(call.args[0] - x) < 1e-8 && Math.abs(call.args[1] - y) < 1e-8));
});

test('DOM: absent Canvas and restricted storage do not break source generation', () => {
  const ui = boot({ noCanvas: true, storageFailure: true });
  assert.equal(ui.snapshot().verification.valid, true); assert.deepEqual(ui.errors, []);
});

test('DOM: light and dark theme controls expose and persist accessible state', () => {
  const ui = boot({ theme: 'light' }), button = ui.nodes.get('themeToggle');
  assert.equal(ui.document.documentElement.dataset.theme, 'light'); assert.equal(button.getAttribute('aria-pressed'), 'true');
  button.click(); assert.equal(ui.document.documentElement.dataset.theme, 'dark');
  assert.equal(button.getAttribute('aria-label'), 'Switch to light theme'); assert.equal(ui.storage.get('padcraft.theme'), 'dark');
});

test('DOM: layers redraw and the source buffer selection survives parameter changes', () => {
  const ui = boot(), select = ui.nodes.get('codeSelect');
  select.value = 'kb.py'; select.emit('change'); assert.match(ui.nodes.get('codePreview').textContent, /KMKKeyboard/);
  const count = ui.calls.length; ui.nodes.get('showAirwires').checked = false; ui.nodes.get('showAirwires').emit('change');
  assert.ok(ui.calls.length > count);
  ui.nodes.get('cols').value = '3'; ui.nodes.get('cols').emit('input');
  assert.equal(select.value, 'kb.py'); assert.match(ui.nodes.get('codePreview').textContent, /keyboard.keymap/);
});

test('DOM: ZIP downloads contain every artifact and individual downloads use source bytes', async () => {
  const ui = boot(); ui.nodes.get('downloadZip').click();
  assert.equal(ui.downloads.length, 1); assert.equal(ui.downloads[0].name, 'studio_control_bundle.zip');
  const bytes = new Uint8Array(await ui.blobs.get(ui.downloads[0].href).arrayBuffer());
  const { view, offset } = findEocd(bytes); assert.equal(view.getUint16(offset + 10, true), 25);
  ui.nodes.get('fileList').children[0].click(); assert.equal(ui.downloads.length, 2);
  assert.equal(ui.downloads[1].name, 'studio_control.kicad_pcb');
  assert.equal(await ui.blobs.get(ui.downloads[1].href).text(), ui.snapshot().files['studio_control.kicad_pcb']);
});

test('DOM: reset restores defaults and progress values reflect actual connectivity', () => {
  const ui = boot(); ui.showcaseButtons[3].click(); ui.nodes.get('resetBtn').click();
  assert.equal(ui.snapshot().config.rows, 3); assert.equal(ui.snapshot().config.cols, 4);
  const continuity = ui.snapshot().verification.geometry.continuityPercent;
  assert.equal(ui.nodes.get('routingMeter').getAttribute('aria-valuenow'), String(continuity));
  assert.equal(ui.nodes.get('routingFill').style.width, continuity + '%');
});

test('DOM: every configuration field is bound to the live normalized model', () => {
  const ui = boot();
  const fields = [['name', 'Bound controls', 'input'], ['rows', 2, 'input'], ['cols', 3, 'input'],
    ['switchType', 'Choc', 'change'], ['keySpacing', 21, 'input'], ['switchCutout', 12, 'input'],
    ['plateThickness', 4, 'input'], ['edgeMargin', 12, 'input'], ['boardThickness', 2, 'input'],
    ['encoderDiameter', 8, 'input'], ['mountHoleDiameter', 3, 'input'], ['encoderPosition', 'top-left', 'change'],
    ['sensorCount', 2, 'input'], ['pinOffset', 3, 'input'], ['encoder', false, 'change'], ['sensor', true, 'change']];
  for (const [id, value, event] of fields) {
    const node = ui.nodes.get(id);
    if (typeof value === 'boolean') node.checked = value; else node.value = String(value);
    node.emit(event);
    assert.equal(ui.snapshot().config[id], value, id + ' is wired to the current model');
    assert.equal(ui.snapshot().verification.valid, true, id + ' retains valid exports');
  }
  assert.deepEqual(ui.errors, []);
});

test('DOM: design rule audit renders every check with a fingerprint footer', () => {
  const ui = boot(), audit = ui.snapshot().audit, box = ui.nodes.get('drcAudit');
  assert.equal(audit.valid, true); assert.equal(audit.errors, 0);
  assert.ok(audit.checks.length >= 15);
  assert.equal(box.children.length, audit.checks.length + 1);
  box.children.slice(0, -1).forEach((row, i) => {
    const check = audit.checks[i];
    assert.equal(row.children[0].textContent,
      check.valid ? (check.severity === 'info' ? 'INFO' : 'PASS') : (check.severity === 'warning' ? 'WARN' : 'FAIL'),
      check.id);
    assert.ok(row.children[1].textContent.includes(check.label), check.id);
  });
  assert.match(box.children.at(-1).textContent, /0 errors, 0 warnings \| audit [0-9a-f]{16}/);
});

test('DOM: Enter on the focused switch cycles its nets', () => {
  const ui = boot(), canvas = ui.nodes.get('preview');
  canvas.emit('keydown', { key: 'Home' });
  assert.equal(ui.snapshot().selectedRef, 'SW1');
  assert.equal(canvas.emit('keydown', { key: 'Enter' }).prevented, true);
  assert.equal(ui.snapshot().selectedNet, 'COL0');
  canvas.emit('keydown', { key: 'Enter' });
  assert.match(ui.snapshot().selectedNet, /^N_/);
  canvas.emit('keydown', { key: 'Enter' });
  assert.equal(ui.snapshot().selectedNet, '');
  canvas.emit('keydown', { key: 'Enter' });
  assert.equal(ui.snapshot().selectedNet, 'COL0');
  assert.match(ui.nodes.get('inspectInfo').textContent, /COL0/);
});

test('DOM: showcase buttons support arrow, Home and End navigation', () => {
  const ui = boot(), buttons = ui.showcaseButtons;
  assert.equal(buttons[0].emit('keydown', { key: 'ArrowRight' }).prevented, true);
  assert.equal(ui.document.activeElement, buttons[1]);
  buttons[1].emit('keydown', { key: 'End' });
  assert.equal(ui.document.activeElement, buttons[buttons.length - 1]);
  buttons[buttons.length - 1].emit('keydown', { key: 'ArrowRight' });
  assert.equal(ui.document.activeElement, buttons[buttons.length - 1]);
  buttons[buttons.length - 1].emit('keydown', { key: 'Home' });
  assert.equal(ui.document.activeElement, buttons[0]);
  buttons[0].emit('keydown', { key: 'ArrowLeft' });
  assert.equal(ui.document.activeElement, buttons[0]);
  assert.equal(buttons[0].emit('keydown', { key: 'ArrowDown' }).prevented, false);
});

test('DOM: live regions, roles and group semantics are exposed to assistive tech', () => {
  const ui = boot();
  assert.equal(ui.nodes.get('announcer').getAttribute('aria-live'), 'polite');
  assert.equal(ui.nodes.get('announcer').getAttribute('role'), 'status');
  assert.equal(ui.nodes.get('status').getAttribute('aria-live'), 'polite');
  assert.equal(ui.nodes.get('preview').getAttribute('role'), 'application');
  assert.equal(ui.nodes.get('showcases').getAttribute('role'), 'group');
  assert.match(ui.nodes.get('showcases').getAttribute('aria-label'), /showcase/i);
});

test('DOM: showcase loads and resets announce through the polite live region', () => {
  const ui = boot(), announcer = ui.nodes.get('announcer');
  assert.match(announcer.textContent, /Studio control loaded\. 3 by 4 matrix/);
  ui.showcaseButtons[1].click();
  assert.match(announcer.textContent, /Sensor console loaded\. \d+ by \d+ matrix.*25 artifacts/);
  ui.nodes.get('resetBtn').click();
  assert.match(announcer.textContent, /reset to 3 by 4 defaults/);
});

test('DOM: invalid numeric input is flagged then recovered to the normalized value', () => {
  const ui = boot(), rows = ui.nodes.get('rows'), announcer = ui.nodes.get('announcer');
  rows.value = '99'; rows.emit('input');
  assert.equal(rows.getAttribute('aria-invalid'), 'true');
  assert.equal(ui.snapshot().config.rows, 6);
  rows.emit('change');
  assert.equal(rows.value, '6'); assert.equal(rows.getAttribute('aria-invalid'), 'false');
  assert.match(announcer.textContent, /Rows adjusted to 6 \(allowed range 1 to 6\)/);
  rows.value = 'abc'; rows.emit('input');
  assert.equal(rows.getAttribute('aria-invalid'), 'true');
  rows.emit('change');
  assert.equal(rows.value, '3'); assert.equal(rows.getAttribute('aria-invalid'), 'false');
  assert.match(announcer.textContent, /Rows adjusted to 3/);
});
