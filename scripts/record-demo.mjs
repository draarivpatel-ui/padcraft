#!/usr/bin/env node
// record-demo.mjs - deterministic narrated demo capture for PadCraft.
//
//   node scripts/record-demo.mjs synth     narration.txt -> narration.wav,
//                                        timing.json, captions.ass,
//                                        padcraft-demo.srt
//   node scripts/record-demo.mjs capture   verify tests + audits live, then
//                                        serve + headless Chrome drive ->
//                                        padcraft-demo.mp4 (and proof.html)
//   node scripts/record-demo.mjs all       synth (if stale) then capture
//   node scripts/record-demo.mjs check     ffprobe report on the mp4
//
// Voiceover uses Aariv's local OmniVoice clone (mlx-community/OmniVoice-bf16,
// voice-ref.wav + voice-ref.txt) via scripts/omnivoice_say.py - never macOS
// `say`. No API keys, no network. The video
// is recorded by a throwaway headless Chrome with an empty profile inside
// PADCRAFT_DEMO_TMP (default: a fresh /tmp/omnivoice-l159-* dir that is
// always deleted). It never touches a signed-in browser, never downloads to
// ~/Downloads, and aborts if the page navigates off the demo origin.
//
// Before recording, `capture` re-runs the node test suite and the station
// honesty harness, writes demo/test-proof.txt and a rendered demo/proof.html
// from that live output, and refuses to record if any check is not green.
// The drive ends on the proof page so the video's verification card quotes
// the same run that produced it.
//
// steps.json vocabulary (times in ms unless noted):
//   { "do": "at", "s": 12.5 }            wait until 12.5 s after record start
//   { "do": "at", "mark": "2.1" }        wait until sentence para 2 sent 1
//                                      starts (resolved via demo/timing.json)
//   { "do": "at", "mark": "end" }        wait until narration end
//   { "do": "wait", "ms": 1500 }
//   { "do": "scroll", "selector": "#x", "offset": 80, "ms": 900 }
//   { "do": "move", "selector": "#x", "ms": 700 }
//   { "do": "click", "selector": "#x" }
//   { "do": "slide", "selector": "#x", "to": 20, "ms": 1800 }  range input
//   { "do": "type", "selector": "#x", "text": "hi", "cps": 16 }
//   { "do": "select", "selector": "#x", "value": "v" }
//   { "do": "key", "key": "Enter" }
//   { "do": "eval", "js": "..." }

import { spawn, execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createStaticServer } from './serve.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO = join(ROOT, 'demo');
const NARRATION_TXT = join(DEMO, 'narration.txt');
const NARRATION_WAV = join(DEMO, 'narration.wav');
const TIMING_JSON = join(DEMO, 'timing.json');
const CAPTIONS_ASS = join(DEMO, 'captions.ass');
const OUT_SRT = join(DEMO, 'padcraft-demo.srt');
const OUT_MP4 = join(DEMO, 'padcraft-demo.mp4');
const OUT_PROOF = join(DEMO, 'test-proof.txt');
const OUT_PROOF_HTML = join(DEMO, 'proof.html');
const STEPS_JSON = join(DEMO, 'steps.json');
const HARNESS = resolve(ROOT, '..', '..', 'hark_honesty_and_defect_harness.py');

const OMNI_PY = process.env.PADCRAFT_OMNI_PY || join(homedir(), 'mlx-audio-venv', 'bin', 'python');
const OMNI_HELPER = join(ROOT, 'scripts', 'omnivoice_say.py');
const OMNI_SEED = Number(process.env.PADCRAFT_OMNI_SEED || 1);
const ATEMPO = Number(process.env.PADCRAFT_ATEMPO || 1.0); // pace factor so the video stays <= 180 s
const SR = 24000;
const LEAD = 0.6, GAP_SENT = 0.3, GAP_PARA = 0.75, TAIL = 1.0;
const FPS = 30, W = 1920, H = 1080;

const work = process.env.PADCRAFT_DEMO_TMP || mkdtempSync(join('/tmp', 'omnivoice-l159-'));
mkdirSync(work, { recursive: true });
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- synth ---------------------------------------------------------

function parseNarration(text) {
  const paras = [];
  for (const raw of text.split(/\n\s*\n/)) {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) paras.push(lines);
  }
  return paras;
}

async function afDuration(file) {
  const { stdout } = await run('afinfo', [file]);
  const m = stdout.match(/estimated duration:\s*([\d.]+)/);
  if (!m) throw new Error(`afinfo could not read duration of ${file}`);
  return Number(m[1]);
}

async function synth() {
  const paras = parseNarration(readFileSync(NARRATION_TXT, 'utf8'));
  const cache = process.env.PADCRAFT_TTS_CACHE || join(work, 'tts');
  mkdirSync(cache, { recursive: true });
  const units = [];
  for (let p = 0; p < paras.length; p++)
    for (let s = 0; s < paras[p].length; s++)
      units.push({ id: `s${p}-${s}`, text: paras[p][s], para: p, sent: s });
  // One OmniVoice batch job covers every missing sentence (one model load).
  // A unit is synthesised only when neither its normalised wav nor its raw
  // model-rate src.wav already sits in the cache.
  const missing = units.filter((u) => !existsSync(join(cache, `${u.id}.wav`)) && !existsSync(join(cache, `${u.id}.src.wav`)));
  if (missing.length) {
    const job = join(work, 'omnivoice-job.json');
    writeFileSync(job, JSON.stringify({ seed: OMNI_SEED, units: missing.map((u) => ({ id: u.id, text: u.text, out: join(cache, `${u.id}.src.wav`) })) }, null, 1) + '\n');
    execFileSync('nice', ['-n', '19', OMNI_PY, OMNI_HELPER, job], { stdio: 'inherit' });
  }
  const sents = [];
  const inputs = [];
  let t = LEAD;
  let prevPara = -1;
  inputs.push(['-f', 'lavfi', '-i', `aevalsrc=0:d=${LEAD}:s=${SR}`]);
  for (const u of units) {
    const src = join(cache, `${u.id}.src.wav`);
    const wav = join(cache, `${u.id}.wav`);
    if (!existsSync(wav)) {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-af', `atempo=${ATEMPO}`, '-ar', String(SR), '-ac', '1', wav]);
    }
    const dur = await afDuration(wav);
    const gap = prevPara === -1 ? 0 : (u.para !== prevPara ? GAP_PARA : GAP_SENT);
    if (gap > 0) inputs.push(['-f', 'lavfi', '-i', `aevalsrc=0:d=${gap}:s=${SR}`]);
    t += gap;
    sents.push({ para: u.para, sent: u.sent, text: u.text, dur: Math.round(dur * 1000) / 1000, start: Math.round(t * 1000) / 1000 });
    inputs.push(['-i', wav]);
    t += dur;
    prevPara = u.para;
  }
  inputs.push(['-f', 'lavfi', '-i', `aevalsrc=0:d=${TAIL}:s=${SR}`]);
  const total = Math.round((t + TAIL) * 1000) / 1000;

  const flat = inputs.flat();
  const labels = inputs.map((_, i) => `[${i}:a]`).join('');
  await run('ffmpeg', ['-v', 'error', '-y', ...flat, '-filter_complex', `${labels}concat=n=${inputs.length}:v=0:a=1[a]`, '-map', '[a]', '-ar', String(SR), '-ac', '1', '-threads', '4', NARRATION_WAV]);
  const actual = await afDuration(NARRATION_WAV);
  const timing = {
    voice: 'OmniVoice-bf16 (Aariv voice clone)', seed: OMNI_SEED, sr: SR, lead: LEAD, gap_sent: GAP_SENT, gap_para: GAP_PARA, tail: TAIL,
    total, wav_seconds: Math.round(actual * 1000) / 1000,
    words: sents.reduce((a, e) => a + e.text.split(/\s+/).length, 0),
    sentences: sents,
  };
  writeFileSync(TIMING_JSON, JSON.stringify(timing, null, 1) + '\n');
  writeCaptions(timing);
  writeSrt(timing);
  console.log(`synth: ${sents.length} sentences, ${timing.words} words, narration ${timing.wav_seconds}s -> ${NARRATION_WAV}`);
}

const tsAss = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  let cs = Math.round((t - Math.floor(t)) * 100);
  if (cs === 100) { cs = 0; }
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};
const tsSrt = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

function captionWindows(sents) {
  // Same windowing as the station's captions_hark.py: LEAD_IN 0.08, TAIL_PAD 0.05, MIN_GAP 0.04.
  const wins = sents.map((e) => ({ start: e.start - 0.08, end: e.start + e.dur + 0.05, text: e.text }));
  for (let i = 1; i < wins.length; i++) {
    if (wins[i].start < wins[i - 1].end + 0.04) wins[i].start = wins[i - 1].end + 0.04;
  }
  return wins;
}

function writeCaptions(timing) {
  const header = `[Script Info]
Title: padcraft demo captions
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Helvetica,42,&H00FFFFFF,&H000019FF,&H88141414,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,2,120,120,46,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = captionWindows(timing.sentences).map(
    (w) => `Dialogue: 0,${tsAss(w.start)},${tsAss(w.end)},Cap,,0,0,0,,${w.text}`
  );
  writeFileSync(CAPTIONS_ASS, header + lines.join('\n') + '\n');
}

function writeSrt(timing) {
  const out = captionWindows(timing.sentences).map(
    (w, i) => `${i + 1}\n${tsSrt(w.start)} --> ${tsSrt(w.end)}\n${w.text}\n`
  );
  writeFileSync(OUT_SRT, out.join('\n'));
}

// ---------- proof ---------------------------------------------------------

function runCmd(cmd, args, opts = {}) {
  try {
    const out = execFileSync('nice', ['-n', '19', cmd, ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: opts.timeout || 300000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, out: `${out}` };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, err: e.message };
  }
}

const ascii = (s) => s.replace(/[^\x20-\x7e\n]/g, '-');

// Re-runs every verification the video claims, writes the proof artifacts,
// and throws (so capture aborts before a single frame) unless all are green.
function buildProof() {
  const sha = (() => {
    try {
      const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
      return head.startsWith('ref:') ? runCmd('git', ['rev-parse', '--short', 'HEAD']).out.trim() : head.slice(0, 7);
    } catch { return 'unknown'; }
  })();
  const lines = [
    'PadCraft - verification proof',
    `commit: ${sha} (captured during scripts/record-demo.mjs)`,
    '',
    '$ node --test test.js ui-test.js drc-test.js pad-lab.test.js',
  ];
  const tests = runCmd('node', ['--test', 'test.js', 'ui-test.js', 'drc-test.js', 'pad-lab.test.js'], { timeout: 240000 });
  const tn = tests.out.match(/tests\s+(\d+)/), tp = tests.out.match(/pass\s+(\d+)/), tf = tests.out.match(/fail\s+(\d+)/);
  lines.push(tn ? `  tests ${tn[1]}, pass ${tp ? tp[1] : '?'}, fail ${tf ? tf[1] : '?'}` : `  ${ascii(tests.out.trim().split('\n').pop() || 'no output')}`);
  const testsGreen = tests.ok && tn && tp && tf && tn[1] === '489' && tp[1] === '489' && tf[1] === '0';

  let harnessGreen = true;
  if (existsSync(HARNESS)) {
    lines.push('$ hark_honesty_and_defect_harness.py --audit <repo>');
    const hon = runCmd('python3', [HARNESS, '--audit', ROOT], { timeout: 120000 });
    const hl = hon.out.split('\n').filter((l) => /violation|Audited/i.test(l)).slice(-2);
    for (const l of hl) lines.push(`  ${ascii(l.trim())}`);
    harnessGreen = hon.ok && /0 violation/.test(hon.out);
  }

  const text = `${lines.join('\n')}\n`;
  mkdirSync(DEMO, { recursive: true });
  writeFileSync(OUT_PROOF, text);
  writeFileSync(OUT_PROOF_HTML, proofPage(text));
  if (!(testsGreen && harnessGreen)) {
    throw new Error(`verification not green; refusing to record.\n${text}`);
  }
  return text;
}

function proofPage(text) {
  const body = text.split('\n').map((line) => {
    const cls = line.startsWith('$') ? ' class="cmd"' : /pass|0 violation|PASS/i.test(line) ? ' class="ok"' : '';
    return `<span${cls}>${esc(line) || ' '}</span>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>PadCraft verification</title><style>
*{box-sizing:border-box;margin:0}
body{background:#0b1220;color:#e8eef8;font-family:"Avenir Next","Segoe UI","Helvetica Neue",Arial,sans-serif}
main{max-width:1240px;margin:0 auto;padding:96px 60px}
h1{font-family:Georgia,"Iowan Old Style","Times New Roman",serif;font-size:68px;font-weight:700;letter-spacing:-1px;margin-bottom:46px}
.term{background:#111c2f;border:1px solid #2b3f5c;color:#d7e3f4;border-radius:16px;padding:36px 42px}
.term span{display:block;font:21px/1.62 "SF Mono",ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap}
.term .cmd{color:#4dd0c1;font-weight:700}
.term .ok{color:#a9e8bb}
</style></head><body><main>
<h1>Verification</h1>
<div class="term">${body}</div>
</main></body></html>
`;
}

// ---------- capture --------------------------------------------------------

const CURSOR_JS = `(() => {
  if (document.getElementById('__demo_cursor')) return true;
  const c = document.createElement('div');
  c.id = '__demo_cursor';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '28'); svg.setAttribute('height', '28'); svg.setAttribute('viewBox', '0 0 28 28');
  const pth = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pth.setAttribute('d', 'M5 3l16 10-7 1.6L10.4 22z');
  pth.setAttribute('fill', '#111'); pth.setAttribute('stroke', '#fff');
  pth.setAttribute('stroke-width', '1.6'); pth.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(pth); c.appendChild(svg);
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none',
    transform: 'translate(${W * 0.62}px, ${H * 0.72}px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))',
    transition: 'scale .12s ease' });
  document.documentElement.appendChild(c);
  window.__cursor = { x: ${W * 0.62}, y: ${H * 0.72} };
  return true;
})()`;

async function capture() {
  const steps = JSON.parse(readFileSync(STEPS_JSON, 'utf8'));
  const timing = JSON.parse(readFileSync(TIMING_JSON, 'utf8'));
  const sentStart = (mark) => {
    if (mark === 'end') return timing.wav_seconds;
    const [p, s] = mark.split('.').map(Number);
    const e = timing.sentences.find((x) => x.para === p && x.sent === s);
    if (!e) throw new Error(`no sentence ${mark} in timing.json`);
    return e.start;
  };

  const proof = buildProof();
  console.log(`proof: ${OUT_PROOF}\n${proof}`);

  const { server, port: srvPort } = await createStaticServer(0);
  const url = `http://127.0.0.1:${srvPort}/`;
  const allowedOrigin = new URL(url).origin;
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile = join(work, 'chrome-profile');
  const framesDir = join(work, 'frames');
  mkdirSync(profile, { recursive: true });
  mkdirSync(framesDir, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
    `--window-size=${W},${H}`, '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });

  async function shutdown(code) {
    if (chrome.exitCode === null) {
      const gone = new Promise((r) => chrome.once('exit', r));
      chrome.kill('SIGTERM');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
    server.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(framesDir, { recursive: true, force: true });
    process.exit(code);
  }
  process.on('unhandledRejection', (e) => { console.error(e); shutdown(1); });

  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    const f = join(profile, 'DevToolsActivePort');
    if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0].trim();
  }
  if (!port) { console.error('Chrome did not start'); await shutdown(1); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

  const ws = new WebSocket(webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const listeners = [];
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result);
    } else if (m.method) listeners.forEach((l) => l(m));
  };
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });

  // Belt and suspenders: nothing this drive does may write to ~/Downloads.
  await send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sid);
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page('Emulation.setFocusEmulationEnabled', { enabled: true });

  let offOrigin = null;
  listeners.push((m) => {
    if (m.sessionId !== sid || m.method !== 'Page.frameNavigated' || m.params.frame.parentId) return;
    const u = m.params.frame.url;
    if (u !== 'about:blank' && new URL(u).origin !== allowedOrigin) offOrigin = u;
  });

  await page('Page.navigate', { url });
  await sleep(2500);
  await page('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
  if (offOrigin) { console.error(`page left ${allowedOrigin}: ${offOrigin}`); await shutdown(1); }

  const js = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };

  {
    const ok = await js(CURSOR_JS);
    if (!ok) { console.error('cursor injection failed (CSP?); aborting'); await shutdown(1); }
    const seen = await js(`!!(window.__cursor && document.getElementById('__demo_cursor'))`);
    if (!seen) { console.error('cursor injection failed (CSP?); aborting'); await shutdown(1); }
  }

  const frames = [];
  listeners.push(async (m) => {
    if (m.sessionId !== sid || m.method !== 'Page.screencastFrame') return;
    const n = frames.length;
    const file = join(framesDir, `f${String(n).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(m.params.data, 'base64'));
    frames.push({ file, t: m.params.metadata.timestamp });
    try { await page('Page.screencastFrameAck', { sessionId: m.params.sessionId }); } catch {}
  });
  await page('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now();

  const center = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) throw new Error('no element ${sel.replace(/'/g, '')}');
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; })()`);
  const glide = (x, y, ms) => js(`new Promise((done) => {
    const c = document.getElementById('__demo_cursor'), s = window.__cursor, t0 = performance.now();
    if (!c || !s) { done(); return; }
    const ease = (p) => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    (function f() { const p = Math.min(1, (performance.now() - t0) / ${ms}), e = ease(p);
      const cx = s.x + (${x} - s.x) * e, cy = s.y + (${y} - s.y) * e;
      c.style.transform = 'translate(' + (cx - 5) + 'px,' + (cy - 3) + 'px)';
      if (p < 1) requestAnimationFrame(f); else { window.__cursor = { x: ${x}, y: ${y} }; done(); } })();
  })`);
  const mouse = (type, x, y) => page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });

  for (const st of steps) {
    if (offOrigin) break;
    switch (st.do) {
      case 'at': {
        const target = st.mark !== undefined ? sentStart(st.mark) : st.s;
        const wait = target * 1000 - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
        else if (wait < -400) console.warn(`late by ${(-wait / 1000).toFixed(1)} s at mark ${st.mark ?? st.s}`);
        break;
      }
      case 'wait': await sleep(st.ms); break;
      case 'scroll': {
        const targetY = await js(`(() => { const e = document.querySelector(${JSON.stringify(st.selector)});
          if (!e) throw new Error('no element ${st.selector.replace(/'/g, '')}');
          return e.getBoundingClientRect().top + scrollY - ${st.offset ?? 0}; })()`);
        await js(`new Promise((done) => {
          const from = scrollY, to = Math.max(0, ${targetY}), t0 = performance.now();
          const ease = (p) => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          (function f() { const p = Math.min(1, (performance.now() - t0) / ${st.ms ?? 900});
            scrollTo(0, from + (to - from) * ease(p));
            if (p < 1) requestAnimationFrame(f); else done(); })();
        })`);
        break;
      }
      case 'move': { const p = await center(st.selector); await glide(p.x, p.y, st.ms ?? 700); break; }
      case 'click': {
        const p = await center(st.selector); await glide(p.x, p.y, st.ms ?? 700); await sleep(120);
        await js(`(() => { const c = document.getElementById('__demo_cursor'); if (c) c.style.scale = '.82'; })()`);
        await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
        await sleep(110); await js(`(() => { const c = document.getElementById('__demo_cursor'); if (c) c.style.scale = '1'; })()`); break;
      }
      case 'slide': {
        const p = await center(st.selector); await glide(p.x, p.y, 600);
        await js(`new Promise((done) => {
          const e = document.querySelector(${JSON.stringify(st.selector)}), from = Number(e.value), to = ${Number(st.to)};
          const min = Number(e.min || 0), max = Number(e.max || 100), step = Number(e.step) || 1;
          const b = e.getBoundingClientRect(), c = document.getElementById('__demo_cursor'), t0 = performance.now();
          const ease = (p) => p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
          (function f() { const p = Math.min(1, (performance.now() - t0) / ${st.ms ?? 1800});
            const v = Math.round((from + (to - from) * ease(p)) / step) * step;
            if (String(v) !== e.value) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }
            const x = b.left + (b.width * (Number(e.value) - min)) / (max - min || 1);
            if (c) { c.style.transform = 'translate(' + (x - 5) + 'px,' + (b.top + b.height / 2 - 3) + 'px)';
              window.__cursor = { x, y: b.top + b.height / 2 }; }
            if (p < 1) requestAnimationFrame(f); else { e.dispatchEvent(new Event('change', { bubbles: true })); done(); } })();
        })`); break;
      }
      case 'type': {
        const p = await center(st.selector); await glide(p.x, p.y, 600);
        await js(`document.querySelector(${JSON.stringify(st.selector)}).focus()`);
        for (const ch of st.text) { await page('Input.insertText', { text: ch }); await sleep(1000 / (st.cps ?? 14)); }
        break;
      }
      case 'select': await js(`(() => { const e = document.querySelector(${JSON.stringify(st.selector)});
        e.value = ${JSON.stringify(st.value)}; e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true })); })()`); break;
      case 'key': {
        const KEYCODES = { Enter: 13, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
        const vkc = KEYCODES[st.key] ?? (st.key.length === 1 ? st.key.toUpperCase().charCodeAt(0) : 0);
        const code = /^[a-zA-Z]$/.test(st.key) ? `Key${st.key.toUpperCase()}` : /^[0-9]$/.test(st.key) ? `Digit${st.key}` : st.key;
        const params = { key: st.key, code, windowsVirtualKeyCode: vkc, nativeVirtualKeyCode: vkc };
        await page('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
        await page('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
        break;
      }
      case 'eval': await js(st.js); break;
      default: throw new Error(`unknown step ${st.do}`);
    }
  }
  const tEnd = Date.now();
  await page('Page.stopScreencast');
  await sleep(400);
  ws.close();
  if (offOrigin) { console.error(`ABORTED: the page left ${allowedOrigin} for ${offOrigin}; nothing was written.`); await shutdown(1); }
  if (frames.length < 2) { console.error('no frames captured'); await shutdown(1); }

  // Resample to constant fps on the real clock (same model as the station's
  // make-video.mjs): output frame k shows the newest captured frame at t0 + k/FPS.
  const total = Math.round(((tEnd - t0) / 1000) * FPS);
  let j = 0;
  for (let k = 0; k < total; k++) {
    const at = t0 / 1000 + k / FPS;
    while (j + 1 < frames.length && frames[j + 1].t <= at) j++;
    linkSync(frames[j].file, join(framesDir, `o${String(k).padStart(6, '0')}.jpg`));
  }

  mkdirSync(dirname(OUT_MP4), { recursive: true });
  const ass = CAPTIONS_ASS.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const ff = ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(framesDir, 'o%06d.jpg'), '-i', NARRATION_WAV,
    '-vf', `scale=in_range=pc:out_range=tv,format=yuv420p,tpad=stop_mode=clone:stop_duration=30,subtitles='${ass}'`,
    '-threads', '4', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart',
    '-c:a', 'aac', '-ar', '24000', '-b:a', '192k', '-shortest', OUT_MP4];
  execFileSync('nice', ['-n', '19', 'ffmpeg', ...ff], { stdio: 'inherit' });
  console.log(`capture: frames ${frames.length}, drive ${((tEnd - t0) / 1000).toFixed(1)} s -> ${OUT_MP4}`);
  await shutdown(0);
}

// ---------- check -----------------------------------------------------------

async function check() {
  const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', OUT_MP4]);
  const d = JSON.parse(stdout);
  const v = d.streams.find((s) => s.codec_type === 'video');
  const a = d.streams.find((s) => s.codec_type === 'audio');
  const { stdout: vol } = await run('ffmpeg', ['-i', OUT_MP4, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 120000 })
    .then((r) => ({ stdout: `${r.stdout}${r.stderr}` }), (e) => ({ stdout: `${e.stdout || ''}${e.stderr || ''}` }));
  console.log(`video: ${v.codec_name} ${v.width}x${v.height} ${eval(v.r_frame_rate).toFixed(0)}fps pix=${v.pix_fmt} range=${v.color_range || 'unknown'}`);
  console.log(`audio: ${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch`);
  console.log(`duration: ${d.format.duration}s size: ${(d.format.size / 1e6).toFixed(1)}MB`);
  const mv = (vol.match(/mean_volume:\s*([-\d.]+ dB)/) || [])[1];
  const xv = (vol.match(/max_volume:\s*([-\d.]+ dB)/) || [])[1];
  console.log(`audio level: mean ${mv || 'unknown'} / max ${xv || 'unknown'}`);
}

// ---------- main ------------------------------------------------------------

const cmd = process.argv[2];
try {
  if (cmd === 'synth') await synth();
  else if (cmd === 'capture') await capture();
  else if (cmd === 'check') await check();
  else if (cmd === 'all') { await synth(); await capture(); }
  else {
    console.log('usage: node scripts/record-demo.mjs synth|capture|check|all');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
