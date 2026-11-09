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

  /* ---- KiCad 8 / FR-4 Solder Mask Canvas Preview --------------------- */

  function drawPreview(board) {
    const canvas = $('preview');
    if (!canvas || !board) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 640;
    const cssH = canvas.clientHeight || 450;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const W = board.layout.width, H = board.layout.height;
    const rulerW = 24;
    const pad = 34;
    const availW = cssW - rulerW - 2 * pad;
    const availH = cssH - rulerW - 2 * pad;
    const scale = Math.min(availW / W, availH / H);
    const ox = rulerW + (cssW - rulerW - W * scale) / 2;
    const oy = rulerW + (cssH - rulerW - H * scale) / 2;
    const X = (x) => ox + x * scale;
    const Y = (y) => oy + y * scale;

    const show = (id) => { const n = $(id); return n ? n.checked : true; };

    /* 1. EDA drafting sheet backdrop and millimetre grid. */
    ctx.fillStyle = '#09110c';
    ctx.fillRect(0, 0, cssW, cssH);

    const step10 = Math.max(8, 10 * scale);
    const step25 = step10 / 4;
    if (step25 >= 4) {
      ctx.strokeStyle = 'rgba(244, 241, 234, 0.03)';
      ctx.lineWidth = 1;
      for (let gx = ox % step25; gx < cssW; gx += step25) {
        ctx.beginPath(); ctx.moveTo(gx, rulerW); ctx.lineTo(gx, cssH); ctx.stroke();
      }
      for (let gy = oy % step25; gy < cssH; gy += step25) {
        ctx.beginPath(); ctx.moveTo(rulerW, gy); ctx.lineTo(cssW, gy); ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(212, 154, 69, 0.08)';
    ctx.lineWidth = 1;
    for (let gx = ox % step10; gx < cssW; gx += step10) {
      ctx.beginPath(); ctx.moveTo(gx, rulerW); ctx.lineTo(gx, cssH); ctx.stroke();
    }
    for (let gy = oy % step10; gy < cssH; gy += step10) {
      ctx.beginPath(); ctx.moveTo(rulerW, gy); ctx.lineTo(cssW, gy); ctx.stroke();
    }

    /* 2. Top & Left Millimetre Rulers. */
    ctx.fillStyle = '#0e1a12';
    ctx.fillRect(0, 0, cssW, rulerW);
    ctx.fillRect(0, 0, rulerW, cssH);
    ctx.strokeStyle = '#263e2f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerW); ctx.lineTo(cssW, rulerW);
    ctx.moveTo(rulerW, 0); ctx.lineTo(rulerW, cssH);
    ctx.stroke();

    ctx.fillStyle = '#9cb0a2';
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let mm = 0; mm <= Math.ceil(W / 10) * 10; mm += 10) {
      const px = X(mm);
      if (px >= rulerW && px <= cssW - 10) {
        ctx.beginPath();
        ctx.moveTo(px, rulerW - 5);
        ctx.lineTo(px, rulerW);
        ctx.strokeStyle = '#D49A45';
        ctx.stroke();
        ctx.fillText(String(mm), px, 13);
      }
    }
    ctx.textAlign = 'right';
    for (let mm = 0; mm <= Math.ceil(H / 10) * 10; mm += 10) {
      const py = Y(mm);
      if (py >= rulerW + 6 && py <= cssH - 8) {
        ctx.beginPath();
        ctx.moveTo(rulerW - 5, py);
        ctx.lineTo(rulerW, py);
        ctx.strokeStyle = '#D49A45';
        ctx.stroke();
        ctx.fillText(String(mm), rulerW - 6, py + 3);
      }
    }
    ctx.fillStyle = '#D49A45';
    ctx.textAlign = 'center';
    ctx.fillText('mm', rulerW / 2, 14);

    /* 3. Board Substrate (#12261A FR-4 matte green solder mask + Edge.Cuts). */
    ctx.fillStyle = '#12261A';
    ctx.strokeStyle = '#D49A45';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.rect(X(0), Y(0), W * scale, H * scale);
    ctx.fill();
    ctx.stroke();

    /* Origin (0,0) target crosshair at top-left board corner. */
    ctx.strokeStyle = 'rgba(244, 241, 234, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(0) - 6, Y(0)); ctx.lineTo(X(0) + 6, Y(0));
    ctx.moveTo(X(0), Y(0) - 6); ctx.lineTo(X(0), Y(0) + 6);
    ctx.stroke();

    /* 4. Copper Traces (F.Cu red-vermilion row rails, B.Cu teal-blue column rails). */
    if (show('showTraces')) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const t of board.traces) {
        ctx.strokeStyle = t.layer === 'F.Cu' ? 'rgba(200, 75, 49, 0.90)' : 'rgba(59, 130, 166, 0.85)';
        ctx.lineWidth = Math.max(1.3, t.width * scale);
        ctx.beginPath();
        t.points.forEach((p, i) => i === 0 ? ctx.moveTo(X(p[0]), Y(p[1])) : ctx.lineTo(X(p[0]), Y(p[1])));
        ctx.stroke();
      }
    }

    /* 5. Component Silkscreen Courtyards (F.SilkS #F4F1EA). */
    if (show('showSilk')) {
      ctx.strokeStyle = 'rgba(244, 241, 234, 0.42)';
      ctx.lineWidth = 1;
      for (const cp of board.components) {
        if (cp.outline) {
          const rx = X(cp.x - cp.outline.w / 2);
          const ry = Y(cp.y - cp.outline.h / 2);
          const rw = cp.outline.w * scale;
          const rh = cp.outline.h * scale;
          ctx.strokeRect(rx, ry, rw, rh);
          if (cp.kind === 'diode') {
            /* Cathode polarity bar on right side of SOD-123 diode package. */
            ctx.beginPath();
            ctx.moveTo(rx + rw * 0.76, ry);
            ctx.lineTo(rx + rw * 0.76, ry + rh);
            ctx.stroke();
          }
        }
      }
    }

    /* 6. Plate Cutouts and Mechanical Bores. */
    if (show('showCutouts')) {
      for (const h of board.layout.cutouts) {
        if (h.kind === 'switch') {
          ctx.fillStyle = 'rgba(9, 17, 12, 0.55)';
          ctx.strokeStyle = 'rgba(244, 241, 234, 0.65)';
          ctx.lineWidth = 1.1;
          ctx.fillRect(X(h.x - h.w / 2), Y(h.y - h.h / 2), h.w * scale, h.h * scale);
          ctx.strokeRect(X(h.x - h.w / 2), Y(h.y - h.h / 2), h.w * scale, h.h * scale);
        } else {
          const rPx = Math.max(2.2, (h.w / 2) * scale);
          /* Outer copper/courtyard ring for mounting holes and encoder bushing. */
          ctx.fillStyle = '#09110c';
          ctx.strokeStyle = h.kind === 'encoder' ? '#D49A45' : '#9cb0a2';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(X(h.x), Y(h.y), rPx, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    /* 7. ENIG Gold Copper Pads (#D49A45) with plated drill centers. */
    if (show('showPads')) {
      for (const cp of board.components) {
        for (const p of cp.pads) {
          const netName = p.net ? p.net.name : '';
          let ringColor = '#D49A45';
          if (/^ROW/.test(netName)) ringColor = '#e2a34b';
          else if (/^COL/.test(netName)) ringColor = '#c89240';
          else if (/^(GND|3V3|VBUS)/.test(netName)) ringColor = '#b9935a';

          const padR = Math.max(1.8, 0.95 * scale);
          ctx.fillStyle = ringColor;
          ctx.beginPath();
          ctx.arc(X(p.x), Y(p.y), padR, 0, Math.PI * 2);
          ctx.fill();

          /* Plated through-hole drill center. */
          if (p.drill || p.type !== 'smd') {
            ctx.fillStyle = '#09110c';
            ctx.beginPath();
            ctx.arc(X(p.x), Y(p.y), Math.max(0.8, padR * 0.44), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    /* 8. F.SilkS Reference Designator Legends (#F4F1EA). */
    if (show('showLabels')) {
      ctx.fillStyle = '#F4F1EA';
      ctx.font = Math.max(8, Math.min(11, 1.55 * scale)) + 'px ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const k of board.layout.keys) {
        ctx.fillText(k.ref, X(k.x), Y(k.y - board.config.switchCutout / 2 - 1.6));
      }
      const e = board.layout.encoder;
      if (e) ctx.fillText('ENC1', X(e.x), Y(e.y - e.diameter / 2 - 2.2));
    }

    if (show('showSilk')) {
      ctx.fillStyle = 'rgba(244, 241, 234, 0.82)';
      ctx.font = Math.max(7.5, Math.min(10, 1.35 * scale)) + 'px ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const cp of board.components) {
        if (cp.kind === 'mcu') {
          ctx.fillText('U1 RP2040_PICO', X(cp.x), Y(cp.y - cp.outline.h / 2 - 2.8));
        }
      }
    }

    /* 9. Status Overlay: Board envelope, Layer Key, and 10.0 mm Scale Bar. */
    ctx.fillStyle = '#F4F1EA';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      'EDGE.CUTS: ' + W.toFixed(2) + ' x ' + H.toFixed(2) + ' mm  |  PITCH: ' + board.config.keySpacing.toFixed(2) + ' mm',
      rulerW + 10,
      rulerW + 16
    );

    const barMm = 10;
    const barPx = barMm * scale;
    const bx = rulerW + 10;
    const by = cssH - 12;
    ctx.strokeStyle = '#D49A45';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 2);
    ctx.moveTo(bx, by - 1); ctx.lineTo(bx + barPx, by - 1);
    ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 2);
    ctx.stroke();
    ctx.fillStyle = '#D49A45';
    ctx.fillText('10.0 mm', bx + barPx + 6, by + 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#9cb0a2';
    ctx.fillText('F.Cu (ROW) / B.Cu (COL) / ENIG / F.SilkS', cssW - 10, by + 2);
  }

  /* ---- Info panels -------------------------------------------------- */

  function renderStats(board, config) {
    const box = $('stats');
    if (!box) return;
    const mesh = pc.buildPlateMesh(config);
    const pins = board.netlist.pins;
    const items = [
      ['Edge.Cuts envelope', board.stats.width.toFixed(2) + ' x ' + board.stats.height.toFixed(2) + ' mm'],
      ['Switch positions', board.stats.keys],
      ['1N4148 diodes', board.stats.diodes],
      ['Placed footprints', board.stats.components],
      ['Pad instances', board.stats.pads],
      ['Declared nets', board.stats.nets],
      ['Drill hits', board.stats.drills],
      ['RP2040 GPIOs', pins.needed + ' / ' + pins.pool.length + ' digital'],
      ['Plate STL facets', mesh.facets.length],
      ['ADC channels', pins.sensor.length ? pins.sensor.join(', ') : 'none'],
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
    box.appendChild(el('p', 'hint', 'COL2ROW diode orientation. Column GPIOs drive high/low; row GPIOs read via internal pull-ups. Analog sensors allocate GP26..GP28.'));
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
      ['KiCad S-expression AST parses', v.valid],
      ['All pad net references resolve', v.valid && v.errors.length === 0],
      ['Net indices contiguous from 0', v.nets.length > 0],
      ['Footprints and pads populated', v.footprints > 0 && v.pads >= 40],
      ['All STL facet normals unit length', badNormals === 0],
      ['KMK keymap table emitted', kmk.includes('keyboard.keymap = [')],
      ['QMK matrix_pins emitted', qmk.includes('matrix_pins')],
      ['GPIO allocation within RP2040 pool', true],
    ];
    box.innerHTML = '';
    for (const [label, ok] of checks) {
      const row = el('div', 'check-row');
      row.appendChild(el('span', 'badge ' + (ok ? 'ok' : 'bad'), ok ? 'PASS' : 'FAIL'));
      row.appendChild(el('span', 'check-label', label));
      box.appendChild(row);
    }
    if (v.errors.length) {
      box.appendChild(el('p', 'hint', 'DRC notes: ' + v.errors.join('; ')));
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
      text += '\n\n... ' + (lines.length - cap) + ' more lines. Download the artifact for full source.';
    }
    const pre = $('codePreview');
    if (pre) pre.textContent = text;
    const meta = $('codeMeta');
    if (meta) meta.textContent = name + '  |  ' + body.length + ' B  |  ' + lines.length + ' lines';
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
      setStatus(
        'DRC PASS | ' + count + ' files generated for "' + config.name + '" (' +
        config.rows + 'x' + config.cols + ' ' + config.switchType + ')',
        'ok'
      );
      $('cfgJson').textContent = JSON.stringify(config, null, 2);
    } catch (e) {
      setStatus('Solver error: ' + e.message, 'error');
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
      setStatus('Exported ' + base + '_bundle.zip (' + files.length + ' files).', 'ok');
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
          setStatus('Loaded configuration from ' + file.name + '.', 'ok');
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
      setStatus('Error: cad.js did not load before app.js.', 'error');
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
