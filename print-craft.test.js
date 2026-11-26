const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = fs.readFileSync('style.css', 'utf8');

test('print craft: mobile touch targets reach 44px', () => {
  assert.match(css, /@media \(max-width: 580px\)[\s\S]*?\.btn,[\s\S]*?min-height: 44px/);
  assert.match(css, /input\.km-cell/);
  assert.match(css, /\.footer-links a/);
});

test('print craft: print output hides app chrome and keeps a light report', () => {
  const print = css.match(/@media print \{[\s\S]*$/)?.[0] || '';
  assert.match(print, /@page/);
  assert.match(print, /:root, :root\[data-theme="light"\]/);
  assert.match(print, /button, input, select, textarea, summary/);
  assert.match(print, /\.controls/);
  assert.match(print, /\.lab-table/);
});

test('print craft: brand accessible name matches its visible text', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.doesNotMatch(html, /class="brand"[^>]*aria-label="PadCraft home"/);
});

test('print craft: SVG lab controls have direct focus rings', () => {
  assert.match(css, /\.lab-pt:focus-visible/);
  assert.match(css, /\.lab-group:focus-visible/);
});

test('print craft: lab table rows use their visible cells as the accessible name', () => {
  const lab = fs.readFileSync('pad-lab.js', 'utf8');
  assert.doesNotMatch(lab, /tr\.setAttribute\('aria-label', 'Load '/);
});

test('print craft: mobile header select and file buttons override compact sizing', () => {
  assert.match(css, /\.brand,[\s\S]*?\.file-btn[\s\S]*?min-height: 44px/);
  assert.match(css, /\.net-filter select/);
});

test('print craft: chart group names include their visible text before the action', () => {
  const lab = fs.readFileSync('pad-lab.js', 'utf8');
  assert.match(lab, /visibleName = series\.map/);
  assert.match(lab, /aria-label': visibleName \+ ', load '/);
});

test('print craft: mobile lab rows reach touch target height', () => {
  assert.match(css, /\.lab-table td \{[\s\S]*?padding-top: 14px/);
});

test('print craft: interactive SVG charts are groups with touch-sized hit areas', () => {
  const lab = fs.readFileSync('pad-lab.js', 'utf8');
  assert.equal((lab.match(/role: 'group'/g) || []).length, 2);
  assert.match(lab, /r: 23, class: 'lab-hit'/);
  assert.match(css, /\.lab-chart \.lab-svg \{[\s\S]*?min-width: 640px/);
});

test('print craft: visible SVG value labels are separated for accessible-name matching', () => {
  const lab = fs.readFileSync('pad-lab.js', 'utf8');
  assert.match(lab, /lbl\.textContent = v \+ ' '/);
});
