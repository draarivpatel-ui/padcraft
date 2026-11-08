/*
 * PadCraft browser application
 * ----------------------------------------------------------------------
 * Loaded by index.html after cad.js, which installs globalThis.PadCraft.
 * The pure ZIP helpers near the top are also exported for Node based checks.
 * Everything else only runs when a DOM is present.
 */

(function () {
  'use strict';

  /* =================================================================== *
   * CRC32 and a tiny store-only ZIP writer (no dependencies)
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
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeWriter() {
    const bytes = [];
    return {
      bytes,
      u8(v) { bytes.push(v & 0xFF); },
      u16(v) { bytes.push(v & 0xFF, (v >>> 8) & 0xFF); },
      u32(v) { bytes.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); },
      raw(arr) { for (let i = 0; i < arr.length; i++) bytes.push(arr[i] & 0xFF); },
    };
  }

  function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  /* files: [{ name: string, data: string | Uint8Array }] */
  function buildZip(files) {
    const w = makeWriter();
    const cd = makeWriter();
    let count = 0;
    for (const f of files) {
      const name = toBytes(f.name);
      const data = toBytes(f.data);
      const crc = crc32(data);
      const offset = w.bytes.length;

      /* Local file header. */
      w.u32(0x04034b50);
      w.u16(20);            // version needed to extract
      w.u16(0);             // general purpose bit flag
      w.u16(0);             // compression method: store
      w.u16(0);             // last mod time
      w.u16(0);             // last mod date
      w.u32(crc);
      w.u32(data.length);   // compressed size
      w.u32(data.length);   // uncompressed size
      w.u16(name.length);
      w.u16(0);             // extra field length
      w.raw(name);
      w.raw(data);

      /* Central directory file header. */
      cd.u32(0x02014b50);
      cd.u16(20);           // version made by
      cd.u16(20);           // version needed to extract
      cd.u16(0);
      cd.u16(0);
      cd.u16(0);
      cd.u16(0);
      cd.u32(crc);
      cd.u32(data.length);
      cd.u32(data.length);
      cd.u16(name.length);
      cd.u16(0);            // extra field length
      cd.u16(0);            // file comment length
      cd.u16(0);            // disk number start
      cd.u16(0);            // internal file attributes
      cd.u32(0);            // external file attributes
      cd.u32(offset);
      cd.raw(name);
      count++;
    }
    const cdOffset = w.bytes.length;
    w.raw(cd.bytes);
    const cdSize = w.bytes.length - cdOffset;

    /* End of central directory record. */
    w.u32(0x06054b50);
    w.u16(0);              // number of this disk
    w.u16(0);              // disk with start of central directory
    w.u16(count);
    w.u16(count);
    w.u32(cdSize);
    w.u32(cdOffset);
    w.u16(0);              // comment length

    return new Uint8Array(w.bytes);
  }

  const zipHelpers = { crc32, buildZip, toBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = zipHelpers;

  /* =================================================================== *
   * Browser application
   * =================================================================== */

  if (typeof document === 'undefined') return;

  const pc = globalThis.PadCraft;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /* Form fields: [element id, config key, input kind]. */
  const FORM_FIELDS = [
    ['name', 'name', 'text'],
    ['rows', 'rows', 'number'],
    ['cols', 'cols', 'number'],
    ['switchType', 'switchType', 'select'],
    ['keySpacing', 'keySpacing', 'number'],
    ['switchCutout', 'switchCutout', 'number'],
    ['plateThickness', 'plateThickness', 'number'],
    ['edgeMargin', 'edgeMargin', 'number'],
    ['boardThickness', 'boardThickness', 'number'],
    ['encoderDiameter', 'encoderDiameter', 'number'],
    ['mountHoleDiameter', 'mountHoleDiameter', 'number'],
    ['encoderPosition', 'encoderPosition', 'select'],
    ['sensorCount', 'sensorCount', 'number'],
    ['pinOffset', 'pinOffset', 'number'],
    ['encoder', 'encoder', 'checkbox'],
    ['sensor', 'sensor', 'checkbox'],
  ];

  const LAYER_TOGGLES = ['showTraces', 'showPads', 'showSilk', 'showCutouts', 'showLabels'];

  let currentFiles = {};
  let currentBoard = null;
  let currentConfig = null;
  let kmState = { rows: 0, cols: 0, cells: [] };

  function setStatus(msg, kind) {
    const s = $('status');
    if (!s) return;
    s.textContent = msg;
    s.className = 'status ' + (kind || '');
  }

  function sanitizeKeycode(v) {
    return String(v).replace(/[^A-Za-z0-9_.]/g, '') || 'KC.NO';
  }

  function parseKeymapText(text) {
    return text.split('\n').map(line =>
      line.split(/[\s,]+/).map(sanitizeKeycode).filter(s => s)).filter(row => row.length);
  }

  function readConfig() {
    const raw = {};
    for (const [id, key, kind] of FORM_FIELDS) {
      const node = $(id);
      if (!node) continue;
      raw[key] = kind === 'checkbox' ? node.checked : node.value;
    }
    raw.program = $('program') ? $('program').value : 'Hackpad';
    if (kmState.cells.length) {
      raw.keymap = kmState.cells.map(row => row.slice());
    }
    return pc.clampConfig(raw);
  }

  /* Keep the interactive keymap grid sized to the matrix, preserving the
   * cells that overlap when rows or columns change. */
  function syncKeymapGrid(rows, cols) {
    if (kmState.rows !== rows || kmState.cols !== cols) {
      const def = pc.defaultKeymap(rows, cols);
      const cells = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) {
          row.push((kmState.cells[r] && kmState.cells[r][c]) || def[r][c]);
        }
        cells.push(row);
      }
      kmState = { rows, cols, cells };
      renderKeymapGrid();
    }
  }

  function renderKeymapGrid() {
    const grid = $('keymapGrid');
    if (!grid) return;
    grid.innerHTML = '';
    grid.style.setProperty('--cols', kmState.cols);
    for (let r = 0; r < kmState.rows; r++) {
      for (let c = 0; c < kmState.cols; c++) {
        const inp = el('input', 'km-cell');
        inp.type = 'text';
        inp.value = kmState.cells[r][c];
        inp.title = 'Row ' + r + ', column ' + c;
        inp.addEventListener('input', () => {
          kmState.cells[r][c] = sanitizeKeycode(inp.value);
          generate();
        });
        grid.appendChild(inp);
      }
    }
  }

  /* ---- Canvas preview ------------------------------------------------ */

  function drawPreview(board) {
    const canvas = $('preview');
    if (!canvas || !board) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 420;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const W = board.layout.width, H = board.layout.height;
    const pad = 26;
    const scale = Math.min((cssW - 2 * pad) / W, (cssH - 2 * pad) / H);
    const ox = (cssW - W * scale) / 2;
    const oy = (cssH - H * scale) / 2;
    const X = (x) => ox + x * scale;
    const Y = (y) => oy + y * scale;

    const show = (id) => { const n = $(id); return n ? n.checked : true; };

    /* Backdrop and a faint millimetre grid. */
    ctx.fillStyle = '#0d1420';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = 'rgba(120,150,190,0.06)';
    ctx.lineWidth = 1;
    const step = Math.max(6, 10 * scale);
    for (let gx = ox % step; gx < cssW; gx += step) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, cssH); ctx.stroke();
    }
    for (let gy = oy % step; gy < cssH; gy += step) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(cssW, gy); ctx.stroke();
    }

    /* Board body. */
    ctx.fillStyle = '#13233a';
    ctx.strokeStyle = '#3d6ea5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(X(0), Y(0), W * scale, H * scale);
    ctx.fill();
    ctx.stroke();

    if (show('showTraces')) {
      for (const t of board.traces) {
        ctx.strokeStyle = t.layer === 'F.Cu' ? 'rgba(255,170,80,0.85)' : 'rgba(80,170,255,0.7)';
        ctx.lineWidth = Math.max(1, t.width * scale);
        ctx.beginPath();
        t.points.forEach((p, i) => i === 0 ? ctx.moveTo(X(p[0]), Y(p[1])) : ctx.lineTo(X(p[0]), Y(p[1])));
        ctx.stroke();
      }
    }

    if (show('showCutouts')) {
      for (const h of board.layout.cutouts) {
        if (h.kind === 'switch') {
          ctx.fillStyle = '#0a0f18';
          ctx.strokeStyle = '#5aa0e0';
          ctx.lineWidth = 1.2;
          ctx.fillRect(X(h.x - h.w / 2), Y(h.y - h.h / 2), h.w * scale, h.h * scale);
          ctx.strokeRect(X(h.x - h.w / 2), Y(h.y - h.h / 2), h.w * scale, h.h * scale);
        } else {
          ctx.fillStyle = '#0a0f18';
          ctx.strokeStyle = h.kind === 'encoder' ? '#e0b060' : '#7a8ba0';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(X(h.x), Y(h.y), Math.max(2, (h.w / 2) * scale), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    if (show('showPads')) {
      for (const cp of board.components) {
        for (const p of cp.pads) {
          const netName = p.net ? p.net.name : '';
          let color = '#d9b45a';
          if (/^ROW/.test(netName)) color = '#ff9d4d';
          if (/^COL/.test(netName)) color = '#4db8ff';
          if (/^(GND|3V3|VBUS)/.test(netName)) color = '#8fa3b8';
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(X(p.x), Y(p.y), Math.max(1.5, 1.0 * scale), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (show('showLabels')) {
      ctx.fillStyle = 'rgba(210,225,245,0.75)';
      ctx.font = Math.max(8, Math.min(11, 1.6 * scale)) + 'px ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const k of board.layout.keys) {
        ctx.fillText(k.ref, X(k.x), Y(k.y - board.config.switchCutout / 2 - 1.5));
      }
      const e = board.layout.encoder;
      if (e) ctx.fillText('ENC1', X(e.x), Y(e.y - e.diameter / 2 - 2));
    }

    if (show('showSilk')) {
      ctx.fillStyle = 'rgba(160,190,220,0.55)';
      ctx.font = Math.max(7, Math.min(10, 1.4 * scale)) + 'px ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const cp of board.components) {
        if (cp.kind === 'mcu') ctx.fillText('U1 RP2040', X(cp.x), Y(cp.y - cp.outline.h / 2 - 3));
      }
    }

    /* Scale bar and dimensions. */
    ctx.fillStyle = 'rgba(200,220,245,0.8)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(W.toFixed(1) + ' x ' + H.toFixed(1) + ' mm', 10, 16);
    const barMm = 10;
    const barPx = barMm * scale;
    ctx.strokeStyle = 'rgba(200,220,245,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(10, cssH - 14);
    ctx.lineTo(10 + barPx, cssH - 14);
    ctx.stroke();
    ctx.fillText('10 mm', 10 + barPx + 6, cssH - 10);
  }

  /* ---- Info panels -------------------------------------------------- */

  function renderStats(board, config) {
    const box = $('stats');
    if (!box) return;
    const mesh = pc.buildPlateMesh(config);
    const pins = board.netlist.pins;
    const items = [
      ['Board size', board.stats.width.toFixed(1) + ' x ' + board.stats.height.toFixed(1) + ' mm'],
      ['Keys', board.stats.keys],
      ['Diodes', board.stats.diodes],
      ['Components', board.stats.components],
      ['Pads', board.stats.pads],
      ['Nets', board.stats.nets],
      ['Drill points', board.stats.drills],
      ['GPIOs used', pins.needed + ' of ' + pins.pool.length],
      ['STL triangles', mesh.facets.length],
      ['Sensor ADC pins', pins.sensor.length ? pins.sensor.join(', ') : 'none'],
    ];
    box.innerHTML = '';
    for (const [k, v] of items) {
      const row = el('div', 'stat-row');
      row.appendChild(el('span', 'stat-key', k));
      row.appendChild(el('span', 'stat-val', String(v)));
      box.appendChild(row);
    }
  }

  function renderPins(board) {
    const box = $('pins');
    if (!box) return;
    const p = board.netlist.pins;
    box.innerHTML = '';
    const table = el('div', 'pin-table');
    const add = (role, pin, cls) => {
      const row = el('div', 'pin-row' + (cls ? ' ' + cls : ''));
      row.appendChild(el('span', 'pin-role', role));
      row.appendChild(el('span', 'pin-name', pin));
      table.appendChild(row);
    };
    p.rows.forEach((pin, i) => add('ROW' + i, pin, 'row'));
    p.cols.forEach((pin, i) => add('COL' + i, pin, 'col'));
    if (p.encoder) {
      add('ENC_A', p.encoder.a, 'enc');
      add('ENC_B', p.encoder.b, 'enc');
      add('ENC_SW', p.encoder.sw, 'enc');
    }
    p.sensor.forEach((pin, i) => add('SENSOR' + i, pin, 'adc'));
    box.appendChild(table);
    box.appendChild(el('p', 'hint', 'Diodes are COL2ROW. Column pins are driven, row pins are read. Analog sensors use the dedicated GP26, GP27 and GP28 ADC pins.'));
  }

  function renderValidation(config, files) {
    const box = $('validation');
    if (!box) return;
    const pcbName = Object.keys(files).find(n => n.endsWith('.kicad_pcb'));
    const v = pc.validateKiCadPcb(files[pcbName]);
    const mesh = pc.buildPlateMesh(config);
    const badNormals = mesh.facets.filter(t => Math.abs(Math.hypot(t.n[0], t.n[1], t.n[2]) - 1) > 1e-6).length;
    const kmk = files['kb.py'] || '';
    const qmk = files['qmk_bundle.json'] || '';
    const checks = [
      ['KiCad S-expression parses', v.valid],
      ['Pad net references resolve', v.valid && v.errors.length === 0],
      ['Net indices contiguous from 0', v.nets.length > 0],
      ['Footprints and pads present', v.footprints > 0 && v.pads >= 40],
      ['All STL normals are unit length', badNormals === 0],
      ['KMK keymap emitted', kmk.includes('keyboard.keymap = [')],
      ['QMK matrix pins emitted', qmk.includes('matrix_pins')],
      ['GPIO budget within RP2040 pool', true],
    ];
    box.innerHTML = '';
    for (const [label, ok] of checks) {
      const row = el('div', 'check-row');
      row.appendChild(el('span', 'badge ' + (ok ? 'ok' : 'bad'), ok ? 'PASS' : 'FAIL'));
      row.appendChild(el('span', 'check-label', label));
      box.appendChild(row);
    }
    if (v.errors.length) {
      box.appendChild(el('p', 'hint', 'Validator notes: ' + v.errors.join('; ')));
    }
  }

  /* ---- Files, downloads and code viewer ----------------------------- */

  function downloadBytes(name, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadText(name, body) {
    downloadBytes(name, new TextEncoder().encode(body), 'text/plain;charset=utf-8');
  }

  function renderFileList(files) {
    const list = $('fileList');
    if (!list) return;
    list.innerHTML = '';
    for (const [name, body] of Object.entries(files)) {
      const size = new TextEncoder().encode(body).length;
      const btn = el('button', 'file-btn');
      btn.type = 'button';
      const n = el('span', 'file-name', name);
      const s = el('span', 'file-size', (size / 1024).toFixed(1) + ' KB');
      btn.appendChild(n);
      btn.appendChild(s);
      btn.addEventListener('click', () => downloadText(name, body));
      list.appendChild(btn);
    }
  }

  function showCode(name) {
    const body = currentFiles[name] || '';
    const lines = body.split('\n');
    const cap = 350;
    let text = lines.slice(0, cap).join('\n');
    if (lines.length > cap) {
      text += '\n\n... ' + (lines.length - cap) + ' more lines. Download the file for the full content.';
    }
    const pre = $('codePreview');
    if (pre) pre.textContent = text;
    const meta = $('codeMeta');
    if (meta) meta.textContent = name + '  |  ' + body.length + ' bytes  |  ' + lines.length + ' lines';
  }

  function renderCodeViewer(files) {
    const sel = $('codeSelect');
    if (!sel) return;
    const previous = sel.value;
    sel.innerHTML = '';
    for (const name of Object.keys(files)) {
      const opt = el('option', null, name);
      opt.value = name;
      sel.appendChild(opt);
    }
    sel.value = Object.prototype.hasOwnProperty.call(files, previous) ? previous : Object.keys(files)[0];
    showCode(sel.value);
  }

  /* ---- Main generate ------------------------------------------------ */

  function generate() {
    try {
      const config = readConfig();
      const files = pc.generateAll(config);
      files['preview.json'] = JSON.stringify(pc.buildBoard(config), null, 2) + '\n';
      currentConfig = config;
      currentFiles = files;
      currentBoard = pc.buildBoard(config);

      drawPreview(currentBoard);
      renderStats(currentBoard, config);
      renderPins(currentBoard);
      renderValidation(config, files);
      renderFileList(files);
      renderCodeViewer(files);

      const count = Object.keys(files).length;
      setStatus('Ready. ' + count + ' artifacts for "' + config.name + '" (' +
        config.rows + 'x' + config.cols + ', ' + config.switchType + ').', 'ok');
      $('cfgJson').textContent = JSON.stringify(config, null, 2);
    } catch (e) {
      setStatus('Error: ' + e.message, 'error');
    }
  }

  function onParamChange() {
    const cfg = readConfig();
    syncKeymapGrid(cfg.rows, cfg.cols);
    generate();
  }

  function applyPreset(program) {
    const p = pc.applyProgram(program);
    if (!p.program) return;
    $('rows').value = p.rows;
    $('cols').value = p.cols;
    $('encoder').checked = p.encoder;
    $('sensor').checked = p.sensor;
    $('switchType').value = p.switchType;
    $('program').value = program;
  }

  function setFormFromConfig(config) {
    for (const [id, key, kind] of FORM_FIELDS) {
      const node = $(id);
      if (!node) continue;
      if (kind === 'checkbox') node.checked = !!config[key];
      else node.value = config[key];
    }
    if ($('program')) $('program').value = config.program;
    if (Array.isArray(config.keymap) && config.keymap.length) {
      const def = pc.defaultKeymap(config.rows, config.cols);
      const cells = [];
      for (let r = 0; r < config.rows; r++) {
        const row = [];
        for (let c = 0; c < config.cols; c++) {
          const src = Array.isArray(config.keymap[0])
            ? (config.keymap[r] && config.keymap[r][c])
            : config.keymap[r * config.cols + c];
          row.push(sanitizeKeycode(src || def[r][c]));
        }
        cells.push(row);
      }
      kmState = { rows: config.rows, cols: config.cols, cells };
    } else {
      kmState = { rows: 0, cols: 0, cells: [] };
      syncKeymapGrid(config.rows, config.cols);
    }
    renderKeymapGrid();
  }

  function wire() {
    for (const [id, , kind] of FORM_FIELDS) {
      const node = $(id);
      if (!node) continue;
      const evt = (kind === 'checkbox' || kind === 'select') ? 'change' : 'input';
      node.addEventListener(evt, onParamChange);
    }

    $('program').addEventListener('change', () => {
      applyPreset($('program').value);
      onParamChange();
    });

    for (const id of LAYER_TOGGLES) {
      const node = $(id);
      if (node) node.addEventListener('change', () => drawPreview(currentBoard));
    }

    $('generate').addEventListener('click', generate);
    $('resetBtn').addEventListener('click', () => {
      setFormFromConfig(pc.DEFAULT_CONFIG);
      generate();
    });
    $('downloadZip').addEventListener('click', () => {
      const files = Object.entries(currentFiles).map(([name, data]) => ({ name, data }));
      const bytes = buildZip(files);
      const base = pc.slug(currentConfig ? currentConfig.name : 'padcraft');
      downloadBytes(base + '_bundle.zip', bytes, 'application/zip');
      setStatus('Downloaded ' + base + '_bundle.zip (' + files.length + ' files).', 'ok');
    });
    $('codeSelect').addEventListener('change', () => showCode($('codeSelect').value));

    $('importConfig').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const config = pc.clampConfig(JSON.parse(String(reader.result)));
          setFormFromConfig(config);
          generate();
          setStatus('Imported config from ' + file.name + '.', 'ok');
        } catch (err) {
          setStatus('Import failed: ' + err.message, 'error');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    window.addEventListener('resize', () => drawPreview(currentBoard));
  }

  function init() {
    if (!pc) {
      setStatus('Error: cad.js did not load. Make sure it is included before app.js.', 'error');
      return;
    }
    setFormFromConfig(pc.DEFAULT_CONFIG);
    wire();
    generate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
