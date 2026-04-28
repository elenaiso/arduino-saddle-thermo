const subline = document.getElementById('subline');
const modePill = document.getElementById('modePill');
const stats = document.getElementById('stats');
const portSelect = document.getElementById('portSelect');
const connectBtn = document.getElementById('connectBtn');
const dimsLine = document.getElementById('dimsLine');
const saveLayoutBtn = document.getElementById('saveLayoutBtn');
const resetLayoutBtn = document.getElementById('resetLayoutBtn');
const uiRateSelect = document.getElementById('uiRateSelect');
const arduinoHzSelect = document.getElementById('arduinoHzSelect');
const heatmapRateSelect = document.getElementById('heatmapRateSelect');

const canvas = document.getElementById('heatmap');
const ctx = canvas.getContext('2d');

const legendBar = document.getElementById('legendBar');
const legendMinEl = document.getElementById('legendMin');
const legendMaxEl = document.getElementById('legendMax');
const rangeAutoEl = document.getElementById('rangeAuto');
const rangeMinEl = document.getElementById('rangeMin');
const rangeMaxEl = document.getElementById('rangeMax');

const sensorGrid = document.getElementById('sensorGrid');

let layout = null;
const DEFAULT_TOTAL = 16;

const state = {
  serial: { status: 'disconnected', path: null, baud: null },
  hello: null,
  sample: null,
  lastRenderAt: 0,
  minC: null,
  maxC: null,
  hzEma: null,
  lastSampleAtMs: null,
  isLegacy: false,
  baselineByIdx: new Map(),
  fixedRange: { auto: true, min: null, max: null },
  assignments: {} // sensorIdx -> slotId
};

function loadUiRateFromStorage(){
  try {
    const raw = localStorage.getItem('saddleThermoUiHz');
    const hz = raw == null ? 10 : Number(raw);
    return Number.isFinite(hz) ? hz : 10;
  } catch {
    return 10;
  }
}

function saveUiRateToStorage(hz){
  try { localStorage.setItem('saddleThermoUiHz', String(hz)); } catch {}
}

function loadHeatmapRateFromStorage(){
  try {
    const raw = localStorage.getItem('saddleThermoHeatmapHz');
    const hz = raw == null ? 2 : Number(raw);
    return Number.isFinite(hz) ? hz : 2;
  } catch {
    return 2;
  }
}
function saveHeatmapRateToStorage(hz){
  try { localStorage.setItem('saddleThermoHeatmapHz', String(hz)); } catch {}
}

state.uiHz = loadUiRateFromStorage();
state.lastUiUpdateAtMs = 0;
state.ws = null;
state.pendingFrame = null;
state.hasNewFrame = false;
state.heatmapHz = loadHeatmapRateFromStorage();
state.lastHeatmapAtMs = 0;
state.portPoll = { timer: null, inFlight: false, lastConnectAttemptMs: 0 };

function loadAssignmentsFromStorage(){
  try {
    const raw = localStorage.getItem('saddleThermoAssignments');
    const next = raw ? JSON.parse(raw) : {};
    const prevStr = state._assignmentsStr || '';
    const nextStr = raw || '';
    state.assignments = next;
    state._assignmentsStr = nextStr;

    // If assignments changed, force a re-render using last sample
    if (prevStr !== nextStr && state.sample && state.pendingFrame) {
      state.hasNewFrame = true;
    } else if (prevStr !== nextStr && state.sample && !state.pendingFrame) {
      state.pendingFrame = { msg: state.sample, values: (state.sample.values || []).map(v => ({ ...v, fieldC: v.calC })) };
      state.hasNewFrame = true;
    }
  } catch {
    state.assignments = {};
  }
}

function saveAssignmentsToStorage(){
  try {
    localStorage.setItem('saddleThermoAssignments', JSON.stringify(state.assignments || {}));
  } catch {}
}

function resetAssignments(){
  state.assignments = {};
  saveAssignmentsToStorage();
}

function assignedSlotForSensor(sensorIdx){
  const v = state.assignments?.[String(sensorIdx)];
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

function sensorIdxForSlot(slotId){
  for (const [k, v] of Object.entries(state.assignments || {})) {
    if (v === slotId) return Number(k);
  }
  return null;
}

function loadFixedRangeFromStorage(){
  try {
    const raw = localStorage.getItem('saddleThermoRange');
    if (!raw) return;
    const j = JSON.parse(raw);
    state.fixedRange.auto = j.auto !== false;
    state.fixedRange.min = (typeof j.min === 'number') ? j.min : null;
    state.fixedRange.max = (typeof j.max === 'number') ? j.max : null;
  } catch {}
}

function saveFixedRangeToStorage(){
  try {
    localStorage.setItem('saddleThermoRange', JSON.stringify(state.fixedRange));
  } catch {}
}

function syncRangeControls(){
  if (!rangeAutoEl || !rangeMinEl || !rangeMaxEl) return;
  rangeAutoEl.checked = !!state.fixedRange.auto;
  if (typeof state.fixedRange.min === 'number') rangeMinEl.value = String(state.fixedRange.min);
  if (typeof state.fixedRange.max === 'number') rangeMaxEl.value = String(state.fixedRange.max);
  rangeMinEl.disabled = !!state.fixedRange.auto;
  rangeMaxEl.disabled = !!state.fixedRange.auto;
}

function readRangeInputsIntoState(){
  if (!rangeMinEl || !rangeMaxEl) return;
  const minV = Number(rangeMinEl.value);
  const maxV = Number(rangeMaxEl.value);
  if (Number.isFinite(minV)) state.fixedRange.min = minV;
  if (Number.isFinite(maxV)) state.fixedRange.max = maxV;
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

// Simple "thermal" gradient: blue -> cyan -> green -> yellow -> red
function thermalColor(t){
  t = clamp01(t);
  const stops = [
    {t:0.00, c:[  0,  80, 190]},
    {t:0.25, c:[  0, 200, 255]},
    {t:0.50, c:[ 40, 220, 120]},
    {t:0.75, c:[255, 210,  60]},
    {t:1.00, c:[255,  70,  50]},
  ];
  let a = stops[0], b = stops[stops.length-1];
  for (let i=0;i<stops.length-1;i++){
    if (t >= stops[i].t && t <= stops[i+1].t){ a=stops[i]; b=stops[i+1]; break; }
  }
  const u = (t - a.t) / Math.max(1e-9, (b.t - a.t));
  const r = Math.round(a.c[0] + (b.c[0]-a.c[0]) * u);
  const g = Math.round(a.c[1] + (b.c[1]-a.c[1]) * u);
  const bl = Math.round(a.c[2] + (b.c[2]-a.c[2]) * u);
  return `rgb(${r},${g},${bl})`;
}

function formatC(x){
  if (typeof x !== 'number' || Number.isNaN(x)) return '—';
  return `${x.toFixed(2)}°C`;
}

function setLegend(minC, maxC){
  if (typeof minC !== 'number' || typeof maxC !== 'number' || minC >= maxC) {
    legendMinEl.textContent = '—';
    legendMaxEl.textContent = '—';
    legendBar.style.background = 'linear-gradient(90deg, #1b2b44, #1b2b44)';
    return;
  }
  legendMinEl.textContent = formatC(minC);
  legendMaxEl.textContent = formatC(maxC);
  const grad = [];
  for (let i=0;i<=10;i++){
    const t = i/10;
    grad.push(`${thermalColor(t)} ${Math.round(t*100)}%`);
  }
  legendBar.style.background = `linear-gradient(90deg, ${grad.join(', ')})`;
}

function setLegendDelta(minD, maxD){
  if (typeof minD !== 'number' || typeof maxD !== 'number' || minD >= maxD) {
    legendMinEl.textContent = '—';
    legendMaxEl.textContent = '—';
    legendBar.style.background = 'linear-gradient(90deg, #1b2b44, #1b2b44)';
    return;
  }
  legendMinEl.textContent = `${minD.toFixed(1)}°C`;
  legendMaxEl.textContent = `${maxD.toFixed(1)}°C`;
  const grad = [];
  for (let i=0;i<=10;i++){
    const t = i/10;
    grad.push(`${thermalColor(t)} ${Math.round(t*100)}%`);
  }
  legendBar.style.background = `linear-gradient(90deg, ${grad.join(', ')})`;
}

function computeMinMax(values){
  let min = Infinity, max = -Infinity;
  for (const v of values){
    if (!v || v.ok !== true) continue;
    const c = v.calC;
    if (typeof c !== 'number' || Number.isNaN(c)) continue;
    min = Math.min(min, c);
    max = Math.max(max, c);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return {min:null, max:null};
  return {min, max};
}

function ensureSensorCards(count){
  const base = layout ? ((layout.left?.sensors?.length || 0) + (layout.right?.sensors?.length || 0)) : DEFAULT_TOTAL;
  const want = Math.max(base, count || 0);
  while (sensorGrid.children.length < want){
    const idx = sensorGrid.children.length;
    const el = document.createElement('div');
    el.className = 'sensor';
    el.dataset.idx = String(idx);
    el.innerHTML = `
      <div class="sensor-top">
        <div>
          <div class="sensor-name">Sensor #${idx}</div>
          <div class="sensor-addr mono" data-role="addr">—</div>
        </div>
        <div class="sensor-val mono" data-role="val">—</div>
      </div>
      <div class="sensor-meta mono">
        <div data-role="raw">raw: —</div>
        <div data-role="ok">ok: —</div>
      </div>
    `;
    sensorGrid.appendChild(el);
  }
}

function updateSensorCards(hello, sample){
  const byIdx = new Map();
  if (sample?.values) {
    for (const v of sample.values) byIdx.set(v.idx, v);
  }

  ensureSensorCards(Math.max(hello?.sensors?.length || 0, sample?.values?.length || 0));

  for (const el of sensorGrid.children){
    const idx = Number(el.dataset.idx);
    const addr = hello?.sensors?.find(s => s.idx === idx)?.addr || byIdx.get(idx)?.addr || '—';
    const v = byIdx.get(idx);
    const val = v ? formatC(v.calC) : '—';
    const raw = v ? formatC(v.rawC) : '—';
    const ok = v ? (v.ok ? 'true' : 'false') : '—';

    el.querySelector('[data-role="addr"]').textContent = addr;
    el.querySelector('[data-role="val"]').textContent = val;
    el.querySelector('[data-role="raw"]').textContent = `raw: ${raw}`;
    el.querySelector('[data-role="ok"]').textContent = `ok: ${ok}`;

    // Color hint on border based on normalized temperature
    if (v && v.ok && typeof state.minC === 'number' && typeof state.maxC === 'number') {
      const t = (v.calC - state.minC) / (state.maxC - state.minC);
      el.style.borderColor = thermalColor(t);
    } else {
      el.style.borderColor = 'var(--border)';
    }
  }
}

function buildPath(points){
  const p = new Path2D();
  if (!points || points.length < 2) return p;
  p.moveTo(points[0][0], points[0][1]);
  for (let i=1;i<points.length;i++) p.lineTo(points[i][0], points[i][1]);
  p.closePath();
  return p;
}

function buildSmoothPath(points){
  // Catmull–Rom to Bezier (closed) for smoother contour
  const pth = new Path2D();
  if (!points || points.length < 4) return buildPath(points);

  const pts = points.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  // drop duplicated closing point if present
  if (first && last && first[0] === last[0] && first[1] === last[1]) pts.pop();
  const n = pts.length;
  if (n < 4) return buildPath(points);

  const tension = 0.5;
  const cr = (i) => pts[(i + n) % n];
  pth.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = cr(i - 1);
    const p1 = cr(i);
    const p2 = cr(i + 1);
    const p3 = cr(i + 2);
    const cp1x = p1[0] + (p2[0] - p0[0]) * tension / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) * tension / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) * tension / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) * tension / 6;
    pth.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
  pth.closePath();
  return pth;
}

function fieldValueAt(x, y, sensors, valuesByIdx, cfg){
  const method = cfg?.method || 'gaussian';
  const radiusPx = cfg?.radiusPx;
  const sigmaPx = cfg?.sigmaPx;
  const r2 = (typeof radiusPx === 'number' && radiusPx > 0) ? radiusPx * radiusPx : null;
  const baselineC = (typeof cfg?.baselineC === 'number' && Number.isFinite(cfg.baselineC)) ? cfg.baselineC : null;
  const baselineWeight = (typeof cfg?.baselineWeight === 'number' && cfg.baselineWeight > 0) ? cfg.baselineWeight : 0;

  let num = 0;
  let den = 0;

  for (const s of sensors){
    const v = valuesByIdx.get(s.idx);
    if (!v || v.ok !== true || typeof v.fieldC !== 'number' || Number.isNaN(v.fieldC)) continue;
    const dx = x - s.xy[0];
    const dy = y - s.xy[1];
    const d2 = dx*dx + dy*dy;
    if (d2 < 1.0) return v.fieldC; // near sensor
    if (r2 != null && d2 > r2) continue;

    let w = 0;
    if (method === 'idw') {
      const p = 2.0;
      const eps = 1e-6;
      w = 1.0 / (Math.pow(d2, p/2) + eps);
    } else {
      // gaussian / RBF
      const sPx = (typeof sigmaPx === 'number' && sigmaPx > 0) ? sigmaPx : 70;
      const denom = 2 * sPx * sPx;
      w = Math.exp(-d2 / denom);
    }

    num += w * v.fieldC;
    den += w;
  }

  // Add a weak background pull towards baseline so a single sensor still creates a gradient.
  if (baselineC != null && baselineWeight > 0) {
    num += baselineWeight * baselineC;
    den += baselineWeight;
  }

  if (den <= 0) return null;
  return num / den;
}

function drawInterpolatedField(path, bbox, sensors, valuesByIdx, minC, maxC, interpCfg){
  if (!(typeof minC === 'number' && typeof maxC === 'number' && maxC > minC)) return;

  const step = (typeof interpCfg?.stepPx === 'number' && interpCfg.stepPx >= 2) ? interpCfg.stepPx : 6;
  ctx.save();
  ctx.clip(path);

  for (let y = bbox.y0; y <= bbox.y1; y += step){
    for (let x = bbox.x0; x <= bbox.x1; x += step){
      const v = fieldValueAt(x, y, sensors, valuesByIdx, interpCfg);
      if (v == null) continue;
      const t = (v - minC) / (maxC - minC);
      ctx.fillStyle = thermalColor(t);
      ctx.fillRect(x, y, step, step);
    }
  }

  ctx.restore();
}

function drawSensors(sensors, valuesByIdx, labelSide /* 'left' | 'right' | 'auto' */){
  for (const s of sensors){
    const v = valuesByIdx.get(s.idx);
    const ok = v && v.ok === true && typeof v.calC === 'number' && Number.isFinite(v.calC);

    ctx.beginPath();
    ctx.arc(s.xy[0], s.xy[1], 8.5, 0, Math.PI*2);
    ctx.fillStyle = ok ? 'rgba(255,60,60,.95)' : 'rgba(0,0,0,.75)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.stroke();

    const text = ok ? `${s.label}: ${v.calC.toFixed(1)}°C` : `${s.label}: —`;
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    const metrics = ctx.measureText(text);
    const pad = 6;
    const h = 18;
    const side = (labelSide === 'auto')
      ? (s.xy[0] < 200 ? 'left' : 'right')
      : labelSide;
    const toRight = (side === 'left'); // left pad: labels to the right; right pad: labels to the left
    const tx = s.xy[0] + (toRight ? 14 : -(14 + metrics.width + pad*2));
    const ty = s.xy[1] - 10;

    // label background (so it doesn't disappear on contour/heat)
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.strokeStyle = 'rgba(255,255,255,.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(tx, ty, metrics.width + pad*2, h, 7);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(232,238,246,.92)';
    ctx.fillText(text, tx + pad, ty + 13);
  }
}

function drawHeatmap(values){
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  // background panel
  ctx.fillStyle = '#0a101b';
  ctx.fillRect(0,0,W,H);

  if (!layout) {
    ctx.fillStyle = 'rgba(138,160,182,.9)';
    ctx.font = '14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText('Loading layout…', 18, 24);
    return;
  }

  // Physical scale: map reference px-range (yTop..yBottom) to 45 cm length.
  const phys = layout.physical;
  let pxPerCm = null;
  if (phys?.lengthCm && phys?.ref?.yTopPx != null && phys?.ref?.yBottomPx != null) {
    const refLenPx = Math.abs(phys.ref.yBottomPx - phys.ref.yTopPx);
    if (refLenPx > 0) pxPerCm = refLenPx / phys.lengthCm;
  }

  if (dimsLine) {
    const l = phys?.lengthCm ?? '—';
    const wt = phys?.widthTopCm ?? '—';
    const wm = phys?.widthMidCm ?? '—';
    const wb = phys?.widthBottomCm ?? '—';
    dimsLine.textContent = `Габариты мата: длина ${l} см • ширина верх ${wt} см • середина ${wm} см • низ ${wb} см`;
  }

  // valuesByIdx for interpolation
  const valuesByIdx = new Map();
  for (const v of values) if (v) valuesByIdx.set(v.idx, v);

  // Reference coordinate system: 400x800 for each pad.
  const pad = 18;
  const srcW = layout.canvas.width;
  const srcH = layout.canvas.height;
  const gapSrc = 90; // spacing between left/right pads (source px)
  const totalSrcW = srcW * 2 + gapSrc;
  const scale = Math.min((W - pad*2) / totalSrcW, (H - pad*2) / srcH);
  const ox = Math.round((W - totalSrcW * scale) / 2);
  const oy = Math.round((H - srcH * scale) / 2);

  function bboxOf(points){
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    for (const [x,y] of points){ x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); }
    return {x0:Math.floor(x0), y0:Math.floor(y0), x1:Math.ceil(x1), y1:Math.ceil(y1)};
  }

  function shiftPoints(points, dx){
    return points.map(([x,y]) => [x + dx, y]);
  }
  function shiftSensors(sensors, dx){
    return sensors.map(s => ({ ...s, xy: [s.xy[0] + dx, s.xy[1]] }));
  }

  function centerDx(points){
    const b = bboxOf(points);
    const cx = (b.x0 + b.x1) / 2;
    return (srcW / 2) - cx;
  }

  const leftContour = layout.left.contour;
  const rightContour = layout.right.contour;

  // Treat layout.*.sensors as SLOT definitions (fixed positions).
  const leftSlots = layout.left.sensors;
  const rightSlots = layout.right.sensors;

  // Build render/interp sensor points from assignments (sensorIdx -> slotId).
  // IMPORTANT: do not fall back to identity mapping, otherwise "ghost" sensors appear.
  const leftSensors = [];
  const rightSensors = [];
  for (const slot of leftSlots) {
    const sensorIdx = sensorIdxForSlot(slot.idx);
    if (sensorIdx != null) leftSensors.push({ idx: sensorIdx, label: slot.label, xy: slot.xy });
  }
  for (const slot of rightSlots) {
    const sensorIdx = sensorIdxForSlot(slot.idx);
    if (sensorIdx != null) rightSensors.push({ idx: sensorIdx, label: slot.label, xy: slot.xy });
  }
  const interpCfg = layout.interpolation || {};

  function drawPad(atXSrc, contour, sensors){
    const dx = centerDx(contour);
    const contour2 = shiftPoints(contour, dx);
    const sensors2 = shiftSensors(sensors, dx);
    const bb = bboxOf(contour2);
    const path = buildSmoothPath(contour2);

    ctx.save();
    ctx.translate(ox + atXSrc*scale, oy);
    ctx.scale(scale, scale);

    // base fill
    ctx.fillStyle = 'rgba(40, 80, 60, .25)';
    ctx.fill(path);

    // field
    drawInterpolatedField(path, bb, sensors2, valuesByIdx, state.minC, state.maxC, interpCfg);

    // outline
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = 'rgba(140, 190, 255, .95)';
    ctx.shadowColor = 'rgba(120, 170, 255, .25)';
    ctx.shadowBlur = 6;
    ctx.stroke(path);
    ctx.shadowBlur = 0;

    // sensors
    // decide label direction: left pad -> rightward labels, right pad -> leftward labels
    const isRightPad = atXSrc > 0;
    drawSensors(sensors2, valuesByIdx, isRightPad ? 'right' : 'left');

    // scale bar (10 cm) in bottom-left of each pad
    if (pxPerCm) {
      const barCm = 10;
      const barPx = barCm * pxPerCm;
      const x0 = 18;
      const y0 = srcH - 26;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + barPx, y0);
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,238,246,.85)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
      ctx.fillText(`${barCm} cm`, x0, y0 - 8);
      ctx.restore();
    }

    ctx.restore();
  }

  drawPad(0, leftContour, leftSensors);
  drawPad(srcW + gapSrc, rightContour, rightSensors);
}

function onMessage(msg){
  if (msg.type === 'serial') {
    state.serial = msg;
    const p = msg.path ? `${msg.path}` : '—';
    const b = msg.baud ? `${msg.baud}` : '—';
    subline.textContent = `Serial: ${msg.status} • ${p} • ${b}`;
    if (msg.status === 'connected') stopPortPolling();
    if (msg.status === 'closed' || msg.status === 'error' || msg.status === 'disconnected') startPortPolling();
    return;
  }
  if (msg.type === 'hello') {
    state.hello = msg;
    state.isLegacy = String(msg?.fw || '').includes('legacy');
    return;
  }
  if (msg.type === 'sample') {
    state.sample = msg;
    const nowMs = Date.now();
    if (state.lastSampleAtMs) {
      const dt = nowMs - state.lastSampleAtMs;
      if (dt > 0) {
        const hz = 1000 / dt;
        state.hzEma = (state.hzEma == null) ? hz : (state.hzEma * 0.85 + hz * 0.15);
      }
    }
    state.lastSampleAtMs = nowMs;

    const hzText =
      (msg.hz != null) ? `${msg.hz} Hz`
      : (state.hzEma != null) ? `${state.hzEma.toFixed(1)} Hz`
      : '— Hz';
    const modeText =
      state.isLegacy ? 'legacy' : (msg.mode || '—');
    modePill.textContent = `${modeText} • ${hzText}`;

    const values = [];
    const displayCfg = layout?.interpolation?.display || {};
    const mode = displayCfg.mode || 'absolute';

    for (const v0 of (msg.values || [])) {
      const v = { ...v0 };
      v.fieldC = v.calC; // interpolate & color by absolute temperature
      values.push(v);
    }

    const fixedMin = (typeof state.fixedRange.min === 'number') ? state.fixedRange.min : null;
    const fixedMax = (typeof state.fixedRange.max === 'number') ? state.fixedRange.max : null;

    if (mode === 'absolute') {
      if (!state.fixedRange.auto && fixedMin != null && fixedMax != null && fixedMax > fixedMin) {
        state.minC = fixedMin;
        state.maxC = fixedMax;
        setLegend(state.minC, state.maxC);
      } else if (typeof displayCfg.absMinC === 'number' && typeof displayCfg.absMaxC === 'number' && displayCfg.absMaxC > displayCfg.absMinC) {
        state.minC = displayCfg.absMinC;
        state.maxC = displayCfg.absMaxC;
        setLegend(state.minC, state.maxC);
      } else {
        const mm = computeMinMax(values);
        state.minC = mm.min;
        state.maxC = mm.max;
        setLegend(mm.min, mm.max);
      }
    } else {
      const mm = computeMinMax(values);
      state.minC = mm.min;
      state.maxC = mm.max;
      setLegend(mm.min, mm.max);
    }

    // Store for the render loop (prevents jitter from variable arrival times)
    state.pendingFrame = { msg, values };
    state.hasNewFrame = true;
  }
}

function renderIfNeeded(force = false) {
  if (!force && !state.hasNewFrame) return;
  if (!state.pendingFrame) return;
  const { msg, values } = state.pendingFrame;
  state.hasNewFrame = false;

  updateSensorCards(state.hello, msg);
  const nowMs = performance.now();
  const minDt = 1000 / Math.max(0.1, Number(state.heatmapHz || 2));
  if (!state.lastHeatmapAtMs || (nowMs - state.lastHeatmapAtMs) >= (minDt - 1)) {
    state.lastHeatmapAtMs = nowMs;
    drawHeatmap(values);
  }

  const now = performance.now();
  const dt = state.lastRenderAt ? (now - state.lastRenderAt) : 0;
  state.lastRenderAt = now;
  stats.textContent = `seq=${msg.seq} • sensors=${msg.values?.length || 0} • Δt=${dt ? dt.toFixed(0) : '—'}ms • Hz≈${state.hzEma ? state.hzEma.toFixed(1) : '—'}`;
}

let renderTimer = null;
function restartRenderLoop() {
  if (renderTimer) clearInterval(renderTimer);
  // uiHz==0 => still cap to 30Hz for smoothness
  const hz = Number(state.uiHz || 0) > 0 ? Number(state.uiHz) : 30;
  const period = Math.max(10, Math.round(1000 / hz));
  renderTimer = setInterval(() => renderIfNeeded(false), period);
}

function connectWs(){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    subline.textContent = `Serial: connecting…`;
  });
  ws.addEventListener('close', () => {
    subline.textContent = `Serial: websocket closed`;
    setTimeout(connectWs, 800);
  });
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      onMessage(msg);
    } catch {}
  });

  document.querySelectorAll('[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      try { ws.send(cmd); } catch {}
    });
  });

  arduinoHzSelect?.addEventListener('change', () => {
    const v = String(arduinoHzSelect.value || '').trim();
    if (!v) return;
    const hz = Number(v);
    if (!Number.isFinite(hz) || hz <= 0) return;
    try { ws.send(`hz=${Math.round(hz)}`); } catch {}
  });

  connectBtn?.addEventListener('click', async () => {
    const path = portSelect?.value || '';
    if (!path) return;
    try {
      // Normalize /dev/tty.* to /dev/cu.* for macOS
      const norm = String(path).replace('/dev/tty.usbserial-', '/dev/cu.usbserial-').replace('/dev/tty.usbmodem-', '/dev/cu.usbmodem-');
      try { localStorage.setItem('saddleThermoLastPort', norm); } catch {}
      connectBtn.disabled = true;
      connectBtn.textContent = 'Подключаю…';
      const r = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: norm })
      });
      await r.json().catch(() => ({}));
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Подключить';
    }
  });
}

async function loadPorts(){
  if (!portSelect) return;
  if (state.portPoll.inFlight) return;
  state.portPoll.inFlight = true;
  const prev = portSelect.value;
  portSelect.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Выберите Serial порт…';
  portSelect.appendChild(opt0);
  try {
    const r = await fetch('/api/ports', { cache: 'no-store' });
    const j = await r.json();
    const ports = j?.ports || [];
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.path;
      const parts = [p.path];
      if (p.manufacturer) parts.push(p.manufacturer);
      if (p.serialNumber) parts.push(p.serialNumber);
      opt.textContent = parts.join(' • ');
      portSelect.appendChild(opt);
    }
    if (prev) portSelect.value = prev;

    // Auto-connect if we have a saved port and we're disconnected
    if (state.serial?.status !== 'connected') {
      let last = '';
      try { last = localStorage.getItem('saddleThermoLastPort') || ''; } catch {}
      if (last && ports.some(p => p.path === last)) {
        portSelect.value = last;
        try {
          const now = Date.now();
          if (now - state.portPoll.lastConnectAttemptMs > 8000) {
            state.portPoll.lastConnectAttemptMs = now;
            await fetch('/api/connect', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: last })
            });
          }
        } catch {}
      }
    }
  } catch {}
  finally { state.portPoll.inFlight = false; }
}

function startPortPolling(){
  if (state.portPoll.timer) return;
  state.portPoll.timer = setInterval(() => {
    if (state.serial?.status === 'connected') return;
    loadPorts();
  }, 3000);
}

function stopPortPolling(){
  if (!state.portPoll.timer) return;
  clearInterval(state.portPoll.timer);
  state.portPoll.timer = null;
}

async function loadLayout(){
  try {
    const r = await fetch('/layout.json', { cache: 'no-store' });
    layout = await r.json();
  } catch {
    layout = null;
  }
}

// initial paint
loadFixedRangeFromStorage();
loadAssignmentsFromStorage();
syncRangeControls();
setLegend(null, null);
ensureSensorCards(DEFAULT_TOTAL);
drawHeatmap([]);
loadPorts();
await loadLayout();
connectWs();
startPortPolling();
setInterval(loadAssignmentsFromStorage, 1500);

saveLayoutBtn?.addEventListener('click', () => {
  saveAssignmentsToStorage();
});
resetLayoutBtn?.addEventListener('click', () => {
  resetAssignments();
});

// UI refresh rate control
if (uiRateSelect) {
  uiRateSelect.value = String(state.uiHz ?? 10);
  uiRateSelect.addEventListener('change', () => {
    const hz = Number(uiRateSelect.value);
    state.uiHz = Number.isFinite(hz) ? hz : 10;
    saveUiRateToStorage(state.uiHz);
    state.lastUiUpdateAtMs = 0;
    restartRenderLoop();
  });
}

// Heatmap recompute rate control
if (heatmapRateSelect) {
  heatmapRateSelect.value = String(state.heatmapHz ?? 2);
  heatmapRateSelect.addEventListener('change', () => {
    const hz = Number(heatmapRateSelect.value);
    state.heatmapHz = Number.isFinite(hz) ? hz : 2;
    saveHeatmapRateToStorage(state.heatmapHz);
    state.lastHeatmapAtMs = 0;
    renderIfNeeded(true);
  });
}

restartRenderLoop();

rangeAutoEl?.addEventListener('change', () => {
  state.fixedRange.auto = !!rangeAutoEl.checked;
  if (!state.fixedRange.auto) {
    readRangeInputsIntoState();
  }
  syncRangeControls();
  saveFixedRangeToStorage();
  state.hasNewFrame = true;
  renderIfNeeded(true);
});
function onRangeValueChange(){
  readRangeInputsIntoState();
  saveFixedRangeToStorage();
  state.hasNewFrame = true;
  renderIfNeeded(true);
}
rangeMinEl?.addEventListener('change', onRangeValueChange);
rangeMaxEl?.addEventListener('change', onRangeValueChange);
rangeMinEl?.addEventListener('input', () => { if (!state.fixedRange.auto) onRangeValueChange(); });
rangeMaxEl?.addEventListener('input', () => { if (!state.fixedRange.auto) onRangeValueChange(); });

