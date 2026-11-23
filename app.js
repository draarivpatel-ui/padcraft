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
    if (!Array.isArray(files) || files.length > 65535) throw new Error('ZIP supports at most 65535 files.');
    const w = makeWriter();
    const cd = makeWriter();
    const seen = new Set();
    let count = 0;
    for (const f of files) {
      if (!f || typeof f.name !== 'string' || !f.name || /[\\\x00]/.test(f.name) || f.name.startsWith('/') || f.name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(f.name)) throw new Error('ZIP filenames must be unique relative paths.');
      seen.add(f.name);
      const name = toBytes(f.name);
      const data = toBytes(f.data);
      if (name.length > 65535 || data.length > 0xFFFFFFFF) throw new Error('ZIP file exceeds the classic format limits.');
      const crc = crc32(data);
      const offset = w.bytes.length;

      /* Local file header. */
      w.u32(0x04034b50);
      w.u16(20);            // version needed to extract
      w.u16(0x0800);        // UTF-8 names
      w.u16(0);             // compression method: store
      w.u16(0);             // last mod time
      w.u16(0x21);          // January 1, 1980
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
      cd.u16(0x0800);
      cd.u16(0);
      cd.u16(0);
      cd.u16(0x21);
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
  if (typeof globalThis !== 'undefined') globalThis.PadCraftZip = zipHelpers;

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

  const LAYER_TOGGLES = ['showTraces', 'showPads', 'showSilk', 'showCutouts', 'showLabels', 'showAirwires'];

  let currentFiles = {};
  let currentBoard = null;
  let currentConfig = null;
  let currentVerification = null;
  let currentAudit = null;
  let selectedNet = '';
  let selectedRef = '';
  let viewTransform = null;
  let kmState = { rows: 0, cols: 0, cells: [] };

  const FIELD_LABELS = {
    rows: 'Rows', cols: 'Columns', keySpacing: 'Key pitch', switchCutout: 'Square cutout',
    plateThickness: 'Plate thickness', edgeMargin: 'Edge margin', boardThickness: 'Board thickness',
    encoderDiameter: 'Dial bore', mountHoleDiameter: 'Mounting bore',
    sensorCount: 'Analog channels', pinOffset: 'GPIO pool offset',
  };

  function setStatus(msg, kind) {
    const s = $('status');
    if (!s) return;
    s.textContent = msg;
    s.className = 'status ' + (kind || '');
  }

  function announce(message) {
    const node = $('announcer');
    if (!node) return;
    node.textContent = '';
    node.textContent = message;
  }

  function fieldBounds(node) {
    const min = node.getAttribute('min'), max = node.getAttribute('max');
    return {
      min: min === null ? -Infinity : Number(min),
      max: max === null ? Infinity : Number(max),
    };
  }

  function markFieldValidity(node) {
    const raw = String(node.value).trim();
    const bounds = fieldBounds(node);
    const num = Number(raw);
    const invalid = raw !== '' && (!Number.isFinite(num) || num < bounds.min || num > bounds.max);
    node.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  }

  /* On commit, restore an out-of-range or unreadable field to the normalized
   * value the model actually used, and say so through the announcer. */
  function recoverField(node, key) {
    const normalized = readConfig()[key];
    const raw = String(node.value).trim();
    const num = Number(raw);
    if (raw !== '' && Number.isFinite(num) && num === normalized) {
      node.setAttribute('aria-invalid', 'false');
      return;
    }
    node.value = String(normalized);
    node.setAttribute('aria-invalid', 'false');
    const bounds = fieldBounds(node);
    const range = Number.isFinite(bounds.min) && Number.isFinite(bounds.max)
      ? ' (allowed range ' + bounds.min + ' to ' + bounds.max + ')' : '';
    announce((FIELD_LABELS[key] || 'Field') + ' adjusted to ' + normalized + range + '.');
  }

  function sanitizeKeycode(v) {
    return pc.sanitizeKeycode(v);
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
        inp.setAttribute('aria-label', 'Keycode for row ' + (r + 1) + ', column ' + (c + 1));
        inp.setAttribute('autocomplete', 'off');
        inp.setAttribute('spellcheck', 'false');
        inp.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !event.altKey) return;
          event.preventDefault();
          const dr = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
          const dc = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          const target = grid.children[pc.clamp(r + dr, 0, kmState.rows - 1) * kmState.cols + pc.clamp(c + dc, 0, kmState.cols - 1)];
          if (target) target.focus();
        });
        inp.addEventListener('input', () => {
          kmState.cells[r][c] = sanitizeKeycode(inp.value);
          markShowcase('');
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
    if (!ctx) return;
    const dpr = pc.clamp(Number(window.devicePixelRatio) || 1, 1, 3);
    const cssW = canvas.clientWidth || 640;
    const cssH = canvas.clientHeight || 450;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const W = board.layout.width, H = board.layout.height;
    const rulerW = 24;
    const pad = 34;
    const availW = Math.max(1, cssW - rulerW - 2 * pad);
    const availH = Math.max(1, cssH - rulerW - 2 * pad);
    const scale = Math.min(availW / W, availH / H);
    const ox = rulerW + (cssW - rulerW - W * scale) / 2;
    const oy = rulerW + (cssH - rulerW - H * scale) / 2;
    const X = (x) => ox + x * scale;
    const Y = (y) => oy + y * scale;
    viewTransform = { scale, ox, oy };

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
        ctx.globalAlpha = selectedNet && selectedNet !== t.net ? 0.2 : 1;
        ctx.strokeStyle = t.layer === 'F.Cu' ? 'rgba(200, 75, 49, 0.90)' : 'rgba(59, 130, 166, 0.85)';
        ctx.lineWidth = Math.max(1.3, t.width * scale);
        ctx.beginPath();
        t.points.forEach((p, i) => i === 0 ? ctx.moveTo(X(p[0]), Y(p[1])) : ctx.lineTo(X(p[0]), Y(p[1])));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
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

          const padR = Math.max(0.8, p.w / 2 * scale);
          ctx.globalAlpha = selectedNet && netName !== selectedNet ? 0.25 : 1;
          ctx.fillStyle = ringColor;
          if (p.shape === 'circle') {
            ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), padR, 0, Math.PI * 2); ctx.fill();
          } else ctx.fillRect(X(p.x - p.w / 2), Y(p.y - p.h / 2), p.w * scale, p.h * scale);

          /* Plated through-hole drill center. */
          if (p.drill > 0) {
            ctx.fillStyle = '#09110c';
            ctx.beginPath();
            ctx.arc(X(p.x), Y(p.y), Math.max(0.4, p.drill / 2 * scale), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        for (const hole of cp.npth || []) {
          ctx.fillStyle = '#09110c'; ctx.beginPath();
          if (hole.w && hole.h) ctx.ellipse(X(hole.x), Y(hole.y), hole.w / 2 * scale, hole.h / 2 * scale, 0, 0, Math.PI * 2);
          else ctx.arc(X(hole.x), Y(hole.y), hole.drill / 2 * scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (show('showAirwires') && currentVerification) {
      ctx.strokeStyle = 'rgba(211,200,136,.55)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      for (const wire of currentVerification.geometry.airwires) {
        if (selectedNet && wire.net !== selectedNet) continue;
        ctx.beginPath(); ctx.moveTo(X(wire.a[0]), Y(wire.a[1])); ctx.lineTo(X(wire.b[0]), Y(wire.b[1])); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (selectedRef) {
      const component = board.components.find(cp => cp.ref === selectedRef);
      if (component && component.outline) {
        ctx.strokeStyle = '#f0d5a4'; ctx.lineWidth = 2;
        ctx.strokeRect(X(component.x - component.outline.w / 2), Y(component.y - component.outline.h / 2), component.outline.w * scale, component.outline.h * scale);
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

  }

  /* ---- Info panels -------------------------------------------------- */

  function renderStats(board, config) {
    const box = $('stats');
    if (!box) return;
    const mesh = currentVerification && currentVerification.mesh;
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
      ['Plate STL facets', mesh ? mesh.triangles : 'pending'],
      ['Plate volume', mesh ? mesh.volume.toFixed(1) + ' mm3' : 'pending'],
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
    box.appendChild(el('p', 'hint', 'COL2ROW: rows drive low and columns are sensed with pull-ups. Sensor headers use GP26, GP27 and GP28.'));
  }

  function renderValidation() {
    const box = $('validation');
    if (!box || !currentVerification) return;
    box.innerHTML = '';
    const checks = [...currentVerification.checks,
      { label: 'Copper geometry checks', valid: currentVerification.geometry.geometryValid,
        detail: currentVerification.geometry.issues.length ? currentVerification.geometry.issues.join('; ') : '0.20 mm track clearance and drill boundaries' }];
    for (const check of checks) {
      const row = el('div', 'check-row');
      row.appendChild(el('span', 'badge ' + (check.valid ? 'ok' : 'bad'), check.valid ? 'PASS' : 'FAIL'));
      const label = el('span', 'check-label', check.label);
      label.appendChild(el('small', 'check-detail', check.detail));
      row.appendChild(label); box.appendChild(row);
    }
  }

  function renderAudit() {
    const box = $('drcAudit');
    if (!box) return;
    box.innerHTML = '';
    if (!currentAudit) return;
    for (const check of currentAudit.checks) {
      const row = el('div', 'check-row');
      const state = check.valid ? (check.severity === 'info' ? 'info' : 'ok')
        : (check.severity === 'warning' ? 'warn' : 'bad');
      const text = check.valid ? (check.severity === 'info' ? 'INFO' : 'PASS')
        : (check.severity === 'warning' ? 'WARN' : 'FAIL');
      row.appendChild(el('span', 'badge ' + state, text));
      const label = el('span', 'check-label', check.label);
      label.appendChild(el('small', 'check-detail', check.detail));
      row.appendChild(label); box.appendChild(row);
    }
    box.appendChild(el('p', 'check-fingerprint',
      currentAudit.errors + ' errors, ' + currentAudit.warnings + ' warnings | audit ' +
      currentAudit.fingerprint.slice(0, 16)));
  }

  function renderNetFilter() {
    const select = $('netSelect');
    if (!select || !currentBoard) return;
    const names = currentBoard.nets.names;
    if (!names.includes(selectedNet)) selectedNet = '';
    select.innerHTML = '';
    const all = el('option', null, 'All nets'); all.value = ''; select.appendChild(all);
    for (const name of names) { const option = el('option', null, name); option.value = name; select.appendChild(option); }
    select.value = selectedNet;
  }

  function inspectText(text, active) {
    const box = $('inspectInfo');
    if (box) { if (box.textContent !== text) box.textContent = text; box.className = 'inspection' + (active ? ' active' : ''); }
  }

  function inspectComponent(ref) {
    if (!currentBoard) return;
    const component = currentBoard.components.find(item => item.ref === ref);
    if (!component) return;
    selectedRef = ref;
    const key = currentBoard.layout.keys.find(item => item.ref === ref);
    const shortcut = key ? ' | ' + currentBoard.keymap[key.row][key.col] + ' | ' + 'ROW' + key.row + ' / COL' + key.col : '';
    inspectText(ref + ' | ' + component.value + ' | x ' + component.x.toFixed(2) + ', y ' + component.y.toFixed(2) + ' mm' + shortcut, true);
  }

  function hitAt(event) {
    if (!viewTransform || !currentBoard) return null;
    const rect = $('preview').getBoundingClientRect();
    const point = [(event.clientX - rect.left - viewTransform.ox) / viewTransform.scale,
      (event.clientY - rect.top - viewTransform.oy) / viewTransform.scale];
    let closest = null;
    for (const component of currentBoard.components) for (const pad of component.pads) {
      const distance = Math.hypot(point[0] - pad.x, point[1] - pad.y);
      if (distance * viewTransform.scale <= Math.max(6, pad.w * viewTransform.scale) && (!closest || distance < closest.distance)) closest = { component, pad, distance, point };
    }
    return closest || { point };
  }

  function inspectPointer(event, select) {
    const hit = hitAt(event);
    if (!hit) return;
    if (hit.pad) {
      const net = hit.pad.net ? hit.pad.net.name : 'unassigned';
      inspectText(hit.component.ref + ' pad ' + hit.pad.num + ' | ' + net + ' | x ' + hit.pad.x.toFixed(2) + ', y ' + hit.pad.y.toFixed(2) + ' mm | ' + (hit.pad.drill > 0 ? hit.pad.drill + ' mm plated drill' : hit.pad.w + ' x ' + hit.pad.h + ' mm SMD'), true);
      if (select) { selectedNet = hit.pad.net ? net : ''; selectedRef = hit.component.ref; $('netSelect').value = selectedNet; drawPreview(currentBoard); }
    } else if (!selectedRef) inspectText('x ' + hit.point[0].toFixed(2) + ', y ' + hit.point[1].toFixed(2) + ' mm | Hover a copper pad to inspect its net.', false);
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
      btn.disabled = !currentVerification || !currentVerification.valid || !currentVerification.geometry.geometryValid;
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
    if (meta) meta.textContent = name ? name + '  |  ' + new TextEncoder().encode(body).length + ' B  |  ' + lines.length + ' lines' : 'No artifact selected';
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
      const config = readConfig(), files = pc.generateAll(config), board = pc.buildBoard(config);
      const verification = pc.verifyBundle(config, files);
      const audit = pc.auditDesign(config);
      currentConfig = config; currentFiles = files; currentBoard = board; currentVerification = verification; currentAudit = audit;
      if (!board.components.some(component => component.ref === selectedRef)) selectedRef = '';
      renderNetFilter(); drawPreview(board); renderStats(board, config); renderPins(board); renderValidation(); renderAudit();
      renderFileList(files); renderCodeViewer(files);
      const count = Object.keys(files).length, routes = verification.geometry.remainingRoutes;
      $('downloadZip').disabled = !verification.valid || !verification.geometry.geometryValid;
      $('cfgJson').textContent = JSON.stringify(config, null, 2);
      $('heroKeys').textContent = config.rows * config.cols;
      $('heroLayers').textContent = verification.gerbers.length;
      $('heroFiles').textContent = count;
      $('artifactCount').textContent = count + ' ARTIFACTS';
      $('heroVerified').textContent = verification.valid ? 'Export schemas checked. ' + routes + ' routes to finish.' : 'An export check failed. See the report below.';
      $('routingReadout').textContent = verification.geometry.connectedConnections + ' / ' + verification.geometry.totalConnections + ' pad connections | ' + routes + ' routes remaining';
      $('routingMeter').setAttribute('aria-valuenow', verification.geometry.continuityPercent);
      $('routingFill').style.width = verification.geometry.continuityPercent + '%';
      const auditNote = audit.errors ? audit.errors + ' audit errors' : audit.warnings ? audit.warnings + ' audit warnings' : 'audit clean';
      setStatus((verification.valid && verification.geometry.geometryValid ? 'CHECKED' : 'CHECK FAILED') + ' | ' + config.rows + ' x ' + config.cols + ' ' + config.switchType + ' | ' + count + ' artifacts | ' + routes + ' routes to finish | ' + auditNote, verification.valid && verification.geometry.geometryValid ? 'ok' : 'error');
    } catch (error) {
      currentFiles = {}; currentBoard = null; currentConfig = null; currentVerification = null; currentAudit = null; viewTransform = null;
      selectedNet = ''; selectedRef = '';
      $('downloadZip').disabled = true;
      renderFileList({}); renderCodeViewer({});
      if ($('drcAudit')) $('drcAudit').textContent = '';
      $('validation').textContent = 'Resolve the configuration error to regenerate the design.';
      $('heroVerified').textContent = 'Generation paused. Export is unavailable.';
      $('heroKeys').textContent = '-'; $('heroFiles').textContent = '0'; $('heroLayers').textContent = '-';
      $('artifactCount').textContent = '0 ARTIFACTS'; $('cfgJson').textContent = '';
      $('stats').textContent = ''; $('pins').textContent = ''; $('netSelect').innerHTML = '';
      $('routingReadout').textContent = 'Generation paused'; $('routingFill').style.width = '0%';
      $('routingMeter').setAttribute('aria-valuenow', '0');
      inspectText('Generation paused. Fix the design error and recheck the configuration.', false);
      const canvas = $('preview'), context = canvas && canvas.getContext('2d');
      if (context) { context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height); }
      setStatus('Design error: ' + error.message, 'error');
    }
  }

  function onParamChange() {
    markShowcase('');
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
    for (const [id, key, kind] of FORM_FIELDS) {
      const node = $(id);
      if (!node) continue;
      const evt = (kind === 'checkbox' || kind === 'select') ? 'change' : 'input';
      node.addEventListener(evt, onParamChange);
      if (kind === 'number') {
        node.addEventListener('input', () => markFieldValidity(node));
        node.addEventListener('change', () => recoverField(node, key));
      }
    }

    $('program').addEventListener('change', () => {
      applyPreset($('program').value);
      markShowcase('');
      onParamChange();
    });

    for (const id of LAYER_TOGGLES) {
      const node = $(id);
      if (node) node.addEventListener('change', () => drawPreview(currentBoard));
    }

    $('generate').addEventListener('click', generate);
    $('resetBtn').addEventListener('click', () => {
      setFormFromConfig(pc.DEFAULT_CONFIG);
      markShowcase('');
      generate();
      announce('Configuration reset to ' + pc.DEFAULT_CONFIG.rows + ' by ' + pc.DEFAULT_CONFIG.cols + ' defaults.');
    });
    $('downloadZip').addEventListener('click', exportZip);
    $('importButton').addEventListener('click', () => $('importConfig').click());
    $('netSelect').addEventListener('change', () => {
      selectedNet = $('netSelect').value; selectedRef = '';
      inspectText(selectedNet ? 'Isolated net ' + selectedNet + '. Copper pads, traces and remaining airwires are highlighted.' : 'Showing every net. Hover a pad to inspect it.', !!selectedNet);
      drawPreview(currentBoard);
    });
    $('themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
    const showcaseButtons = [...document.querySelectorAll('[data-showcase]')];
    for (const button of showcaseButtons) {
      button.addEventListener('click', () => {
        applyShowcase(button.dataset.showcase);
        if ($('workstation').scrollIntoView) $('workstation').scrollIntoView({ block: 'start' });
        $('preview').focus({ preventScroll: true });
      });
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = showcaseButtons.indexOf(event.target);
        if (index === -1) return;
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? showcaseButtons.length - 1
          : pc.clamp(index + (event.key === 'ArrowRight' ? 1 : -1), 0, showcaseButtons.length - 1);
        showcaseButtons[target].focus();
      });
    }
    $('preview').addEventListener('pointermove', event => inspectPointer(event, false));
    $('preview').addEventListener('click', event => inspectPointer(event, true));
    $('preview').addEventListener('pointerleave', () => { if (!selectedRef && !selectedNet) inspectText('Hover a pad or use arrow keys on the canvas to inspect switches.', false); });
    $('preview').addEventListener('keydown', event => {
      if (!currentBoard) return;
      const keys = currentBoard.layout.keys;
      if (event.key === 'Escape') { event.preventDefault(); selectedRef = ''; selectedNet = ''; $('netSelect').value = ''; inspectText('Selection cleared.', false); drawPreview(currentBoard); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const component = currentBoard.components.find(cp => cp.ref === selectedRef);
        if (!component) { inspectText('Focus a switch with the arrow keys, then press Enter to isolate its nets.', false); return; }
        const nets = [...new Set(component.pads.map(p => (p.net ? p.net.name : '')).filter(Boolean))];
        if (!nets.length) { inspectText(component.ref + ' has no assigned nets.', false); return; }
        const next = nets[(nets.indexOf(selectedNet) + 1) % (nets.length + 1)] || '';
        selectedNet = next; $('netSelect').value = next;
        inspectText(next
          ? component.ref + ' net ' + next + ' isolated. Enter cycles its nets; Escape clears.'
          : 'Showing every net. ' + component.ref + ' stays selected.', !!next);
        drawPreview(currentBoard);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let index = Math.max(0, keys.findIndex(key => key.ref === selectedRef));
      const delta = event.key === 'ArrowDown' ? currentBoard.config.cols : event.key === 'ArrowUp' ? -currentBoard.config.cols : event.key === 'ArrowLeft' ? -1 : 1;
      index = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : pc.clamp(index + delta, 0, keys.length - 1);
      inspectComponent(keys[index].ref); drawPreview(currentBoard);
    });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); exportZip(); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generate(); }
    });
    $('codeSelect').addEventListener('change', () => showCode($('codeSelect').value));

    $('importConfig').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) { setStatus('Import failed: configuration files must be smaller than 1 MB.', 'error'); e.target.value = ''; return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const config = pc.clampConfig(JSON.parse(String(reader.result)));
          setFormFromConfig(config);
          markShowcase('');
          generate();
          if (currentConfig) setStatus('Loaded configuration from ' + file.name + '.', 'ok');
        } catch (err) {
          setStatus('Import failed: ' + err.message, 'error');
        }
      };
      reader.onerror = () => setStatus('Import failed: the selected file could not be read.', 'error');
      reader.readAsText(file);
      e.target.value = '';
    });

    window.addEventListener('resize', () => drawPreview(currentBoard));
    if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(() => drawPreview(currentBoard)); observer.observe($('preview')); }
  }

  function markShowcase(id) {
    for (const button of document.querySelectorAll('[data-showcase]')) {
      const active = button.dataset.showcase === id;
      button.className = 'showcase' + (active ? ' active' : ''); button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function applyShowcase(id) {
    const scenario = pc.SHOWCASES[id];
    if (!scenario) return;
    selectedNet = ''; selectedRef = '';
    const config = pc.clampConfig(scenario.config);
    setFormFromConfig(config); markShowcase(id); generate();
    inspectText(scenario.description + ' Hover a pad to inspect the design.', false);
    announce(scenario.label + ' loaded. ' + config.rows + ' by ' + config.cols + ' matrix' +
      (config.encoder ? ' with a rotary dial' : '') + ', ' + Object.keys(currentFiles).length + ' artifacts.');
  }

  /* The audit lab loads a design it benchmarked back into the workstation.
   * Showcase ids go through applyShowcase so aria state and announcements
   * stay identical to the showcase buttons; custom matrices take the same
   * normalized path an imported JSON configuration uses. */
  function loadLabDesign(config, showcaseId) {
    if (showcaseId && pc.SHOWCASES[showcaseId]) { applyShowcase(showcaseId); return; }
    selectedNet = ''; selectedRef = '';
    let normalized;
    try { normalized = pc.clampConfig(config); } catch (error) { setStatus('Lab load failed: ' + error.message, 'error'); return; }
    setFormFromConfig(normalized);
    markShowcase('');
    generate();
    inspectText('Loaded ' + normalized.name + ' from the audit lab. Hover a pad to inspect the design.', false);
    announce(normalized.name + ' loaded from the audit lab. ' + normalized.rows + ' by ' + normalized.cols + ' matrix.');
    if ($('workstation').scrollIntoView) $('workstation').scrollIntoView({ block: 'start' });
  }

  function exportZip() {
    if (!currentConfig || !currentVerification || !currentVerification.valid || !currentVerification.geometry.geometryValid || !Object.keys(currentFiles).length) return;
    try {
      const files = Object.entries(currentFiles).map(([name, data]) => ({ name, data }));
      const base = pc.slug(currentConfig.name);
      downloadBytes(base + '_bundle.zip', buildZip(files), 'application/zip');
      setStatus('Downloaded ' + base + '_bundle.zip | ' + files.length + ' artifacts | ' + currentVerification.geometry.remainingRoutes + ' routes still require KiCad routing.', 'ok');
    } catch (error) { setStatus('Download failed: ' + error.message, 'error'); }
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('themeToggle').textContent = theme === 'light' ? 'Dark theme' : 'Light theme';
    $('themeToggle').setAttribute('aria-label', 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' theme');
    $('themeToggle').setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    try { window.localStorage.setItem('padcraft.theme', theme); } catch (_) { /* Private browsing can disable storage. */ }
  }

  function init() {
    if (!pc) { setStatus('Error: cad.js did not load before app.js.', 'error'); return; }
    let theme = 'dark';
    try { const stored = window.localStorage.getItem('padcraft.theme'); if (stored === 'light' || stored === 'dark') theme = stored; } catch (_) { /* Storage is optional. */ }
    setTheme(theme); wire(); applyShowcase('studio');
    globalThis.PadCraftUI = {
      getSnapshot: () => ({ config: currentConfig ? JSON.parse(JSON.stringify(currentConfig)) : null,
        files: { ...currentFiles }, verification: currentVerification ? JSON.parse(JSON.stringify(currentVerification)) : null,
        audit: currentAudit ? JSON.parse(JSON.stringify(currentAudit)) : null,
        selectedNet, selectedRef, transform: viewTransform ? { ...viewTransform } : null }),
      loadConfig: loadLabDesign,
      applyShowcase,
      downloadText,
    };
    /* The lab is optional: without pad-lab.js or a full DOM the fallback
     * note inside #labRoot stays and the workstation is unaffected. */
    if (globalThis.PadCraftLab && typeof globalThis.PadCraftLab.mount === 'function') {
      try { globalThis.PadCraftLab.mount($('labRoot'), pc, PadCraftUI); } catch (error) { /* lab is optional */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
