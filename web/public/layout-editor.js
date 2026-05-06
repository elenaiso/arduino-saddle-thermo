const subline = document.getElementById('subline');
const statsEl = document.getElementById('stats');
const canvas = document.getElementById('editor');
const ctx = canvas.getContext('2d');

// Make drag work reliably on touchpads/touchscreens
canvas.style.touchAction = 'none';
canvas.style.cursor = 'grab';

const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const exportBtn = document.getElementById('exportBtn');
const importFile = document.getElementById('importFile');
const modeSensorsBtn = document.getElementById('modeSensorsBtn');
const modeContourBtn = document.getElementById('modeContourBtn');
const resetContourBtn = document.getElementById('resetContourBtn');
const sensorTableBody = document.getElementById('sensorTableBody');
const sensorTablePill = document.getElementById('sensorTablePill');
const slotsRefBody = document.getElementById('slotsRefBody');
const layoutBaselineEl = document.getElementById('layoutBaselineC');

let layout = null;
let hello = null;
let lastSample = null;
let editorMode = 'sensors'; // 'sensors' | 'contour'

// assignments: { [sensorIdx: string]: slotId }
let assignments = loadAssignments();
const dragPreview = { idx: null, clientX: null, clientY: null };

// contour overrides: { left: [[x,y]...], right: [[x,y]...] } in original (unshifted) source coords
let contourOverrides = loadContourOverrides();
// slot overrides: { left: { [slotId]: [x,y] }, right: { [slotId]: [x,y] } } in original (unshifted) source coords
let slotOverrides = loadSlotOverrides();

function loadAssignments() {
  try {
    const raw = localStorage.getItem('saddleThermoAssignments');
    return normalizeAssignmentsObject(raw ? JSON.parse(raw) : {});
  } catch {
    return {};
  }
}

function normalizeAssignmentsObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const sensorIdx = Number(k);
    const slotId = Number(v);
    if (!Number.isFinite(sensorIdx)) continue;
    if (!Number.isFinite(slotId)) continue;
    out[String(sensorIdx)] = slotId;
  }
  return out;
}

function saveAssignments() {
  assignments = normalizeAssignmentsObject(assignments);
  localStorage.setItem('saddleThermoAssignments', JSON.stringify(assignments));
  refreshSensorTableFull();
}

/** @param {number} sensorIdx @param {number|null} newSlotId */
function assignSensorToSlot(sensorIdx, newSlotId) {
  const idx = Number(sensorIdx);
  if (!Number.isFinite(idx)) return;
  const prevSlot = slotIdForSensor(idx);
  let target = newSlotId == null ? null : Number(newSlotId);
  if (target != null && !Number.isFinite(target)) target = null;

  if (target == null) {
    if (assignments[String(idx)] != null) delete assignments[String(idx)];
    saveAssignments();
    draw();
    return;
  }

  if (prevSlot === target) return;

  const occupiedBy = sensorIdxForSlot(target);
  assignments[String(idx)] = target;
  if (occupiedBy != null && occupiedBy !== idx) {
    if (prevSlot != null) assignments[String(occupiedBy)] = prevSlot;
    else delete assignments[String(occupiedBy)];
  }
  saveAssignments();
  draw();
}

function loadContourOverrides() {
  try {
    const raw = localStorage.getItem('saddleThermoContour');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveContourOverrides() {
  if (!contourOverrides) return;
  localStorage.setItem('saddleThermoContour', JSON.stringify(contourOverrides));
}

function resetContourOverrides() {
  contourOverrides = null;
  try { localStorage.removeItem('saddleThermoContour'); } catch {}
}

function loadSlotOverrides() {
  try {
    const raw = localStorage.getItem('saddleThermoSlots');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSlotOverrides() {
  if (!slotOverrides) return;
  localStorage.setItem('saddleThermoSlots', JSON.stringify(slotOverrides));
}

function resetSlotOverrides() {
  slotOverrides = null;
  try { localStorage.removeItem('saddleThermoSlots'); } catch {}
}

function clonePoints(points) {
  return (points || []).map(([x, y]) => [x, y]);
}

function mirrorPointsX(points) {
  if (!layout) return clonePoints(points);
  const W = layout.canvas.width;
  return (points || []).map(([x, y]) => [W - x, y]);
}

function ensureMirroredContourOverrides(preferSide /* 'left' | 'right' */) {
  if (!layout) return;
  if (!contourOverrides || typeof contourOverrides !== 'object') contourOverrides = { left: null, right: null };

  const baseLeft = Array.isArray(contourOverrides.left) && contourOverrides.left.length >= 4
    ? contourOverrides.left
    : layout.left.contour;
  const baseRight = Array.isArray(contourOverrides.right) && contourOverrides.right.length >= 4
    ? contourOverrides.right
    : layout.right.contour;

  if (preferSide === 'right') {
    contourOverrides.right = clonePoints(baseRight);
    contourOverrides.left = mirrorPointsX(contourOverrides.right);
  } else {
    contourOverrides.left = clonePoints(baseLeft);
    contourOverrides.right = mirrorPointsX(contourOverrides.left);
  }
}

function slotXYWithOverrides(side, slot /* { idx, xy } */) {
  const o = slotOverrides?.[side]?.[String(slot.idx)];
  if (Array.isArray(o) && o.length === 2 && Number.isFinite(o[0]) && Number.isFinite(o[1])) return [o[0], o[1]];
  return slot.xy;
}

function shiftSlotListWithOverrides(side, slots, dx) {
  return (slots || []).map(s => ({ ...s, xy: [slotXYWithOverrides(side, s)[0] + dx, slotXYWithOverrides(side, s)[1]] }));
}

function allSlotIds() {
  const ids = [];
  for (const s of (layout?.left?.sensors || [])) ids.push(s.idx);
  for (const s of (layout?.right?.sensors || [])) ids.push(s.idx);
  return ids;
}

function ensureDefaultAssignments() {
  // If user hasn't saved anything yet, create a sensible default mapping:
  // sensorIdx -> slotId with the same number (when exists).
  if (!layout) return;
  // If everything was pruned (e.g. switched MCU and old idx no longer exist), rebuild.
  if (assignments && Object.keys(assignments).length > 0) return;

  const slots = new Set(allSlotIds());
  const sensorIdxs = (hello?.sensors || []).map(s => s.idx);
  // Don't auto-fill with "stub sensors" — keep slots free until we know real sensors.
  if (!sensorIdxs.length) return;

  const used = new Set();
  for (const idx of sensorIdxs) {
    if (slots.has(idx) && !used.has(idx)) {
      assignments[String(idx)] = idx;
      used.add(idx);
    }
  }

  // If some sensors didn't find same-id slot, assign to first free slot
  const free = Array.from(slots).filter(id => !used.has(id)).sort((a,b) => a-b);
  for (const idx of sensorIdxs) {
    if (assignments[String(idx)] != null) continue;
    const slotId = free.shift();
    if (slotId == null) break;
    assignments[String(idx)] = slotId;
  }
}

function pruneAssignmentsToConnectedSensors() {
  // Remove assignments for sensors that are not currently connected/visible in hello.
  const sensorIdxs = new Set((hello?.sensors || []).map(s => s.idx));
  for (const k of Object.keys(assignments || {})) {
    const idx = Number(k);
    if (!sensorIdxs.has(idx)) delete assignments[k];
  }
}

function pruneAssignmentsToValidSlots() {
  // Remove assignments pointing at slot ids that don't exist in the current layout.
  if (!layout) return;
  const slots = new Set(allSlotIds());
  let changed = false;
  for (const [k, slotId] of Object.entries(assignments || {})) {
    const sid = Number(slotId);
    if (!Number.isFinite(sid) || !slots.has(sid)) {
      delete assignments[k];
      changed = true;
    }
  }
  if (changed) saveAssignments();
}

function helloSensorSet(h) {
  const out = new Set();
  for (const s of (h?.sensors || [])) out.add(s.idx);
  return out;
}

function ensureHelloFromSample(sample) {
  if (!sample || !Array.isArray(sample.values)) return;

  const idxs = [];
  for (const v of sample.values) {
    if (v && typeof v.idx === 'number' && Number.isFinite(v.idx)) idxs.push(v.idx);
  }
  if (!idxs.length) return;

  const uniq = Array.from(new Set(idxs)).sort((a, b) => a - b);
  const prev = helloSensorSet(hello);
  const next = new Set(uniq);
  let same = prev.size === next.size;
  if (same) {
    for (const x of next) {
      if (!prev.has(x)) { same = false; break; }
    }
  }
  if (hello && same) return;

  const addrByIdx = new Map();
  for (const s of (hello?.sensors || [])) addrByIdx.set(s.idx, s.addr);

  hello = {
    type: 'hello',
    proto: 1,
    fw: 'derived-from-sample',
    sensors: uniq.map((idx) => ({ idx, addr: addrByIdx.get(idx) || '—' })),
  };

  pruneAssignmentsToConnectedSensors();
  pruneAssignmentsToValidSlots();
  ensureDefaultAssignments();
  saveAssignments();
}

let editorWs = null;
function requestDeviceRescan() {
  try {
    if (!editorWs || editorWs.readyState !== WebSocket.OPEN) return;
    editorWs.send('r');
  } catch {}
}

function exportAssignments() {
  const blob = new Blob([JSON.stringify(assignments, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sensor-assignments.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadLayout() {
  const r = await fetch('/layout.json', { cache: 'no-store' });
  layout = await r.json();
}

function refreshSlotsReferenceTable() {
  if (!slotsRefBody || !layout) return;
  slotsRefBody.replaceChildren();

  const ref = layout.physical?.ref;
  const yTop = Number(ref?.yTopPx);
  const yBottom = Number(ref?.yBottomPx);
  const span = Number.isFinite(yTop) && Number.isFinite(yBottom) && yBottom > yTop ? yBottom - yTop : null;

  if (layoutBaselineEl) {
    const bc = layout.interpolation?.baselineC;
    layoutBaselineEl.textContent = Number.isFinite(Number(bc)) ? String(Number(bc)) : '—';
  }

  function appendSlotRow(sideLabel, slot) {
    const [x, y] = Array.isArray(slot.xy) ? slot.xy : [NaN, NaN];
    let frac = '—';
    if (span != null && Number.isFinite(x) && Number.isFinite(y)) {
      const t = ((y - yTop) / span) * 100;
      frac = `${Math.max(0, Math.min(100, Math.round(t)))}%`;
    }
    const tr = document.createElement('tr');
    const tdSide = document.createElement('td');
    tdSide.textContent = sideLabel;
    const tdId = document.createElement('td');
    tdId.className = 'mono';
    tdId.textContent = String(slot.idx);
    const tdLab = document.createElement('td');
    tdLab.className = 'mono';
    tdLab.textContent = slot.label != null ? String(slot.label) : '—';
    const tdX = document.createElement('td');
    tdX.className = 'num';
    tdX.textContent = Number.isFinite(x) ? String(Math.round(x)) : '—';
    const tdY = document.createElement('td');
    tdY.className = 'num';
    tdY.textContent = Number.isFinite(y) ? String(Math.round(y)) : '—';
    const tdF = document.createElement('td');
    tdF.className = 'num';
    tdF.textContent = frac;
    tr.append(tdSide, tdId, tdLab, tdX, tdY, tdF);
    slotsRefBody.appendChild(tr);
  }

  const left = (layout.left?.sensors || []).slice().sort((a, b) => a.idx - b.idx);
  const right = (layout.right?.sensors || []).slice().sort((a, b) => a.idx - b.idx);
  for (const s of left) appendSlotRow('Лево', s);
  for (const s of right) appendSlotRow('Право', s);
}

function wsConnect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  editorWs = ws;
  ws.addEventListener('open', () => {
    subline.textContent = 'Serial: websocket connected';
  });
  ws.addEventListener('close', () => {
    subline.textContent = 'Serial: websocket closed';
    editorWs = null;
    setTimeout(wsConnect, 800);
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'serial') {
      const p = msg.path ? `${msg.path}` : '—';
      const b = msg.baud ? `${msg.baud}` : '—';
      subline.textContent = `Serial: ${msg.status} • ${p} • ${b}`;
      if (msg.status === 'connected') requestDeviceRescan();
    }
    if (msg.type === 'hello') {
      hello = msg;
      pruneAssignmentsToConnectedSensors();
      pruneAssignmentsToValidSlots();
      ensureDefaultAssignments();
      saveAssignments();
      draw();
    }
    if (msg.type === 'sample') {
      lastSample = msg;
      ensureHelloFromSample(msg);
      draw();
      refreshSensorTableTempsOnly();
    }
  });
}

function bboxOf(points){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for (const [x,y] of points){ x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); }
  return {x0, y0, x1, y1};
}

function centerDx(points, srcW){
  const b = bboxOf(points);
  const cx = (b.x0 + b.x1) / 2;
  return (srcW / 2) - cx;
}

function shiftPoints(points, dx){
  return points.map(([x,y]) => [x + dx, y]);
}

function shiftSensors(sensors, dx){
  return sensors.map(s => ({ ...s, xy: [s.xy[0] + dx, s.xy[1]] }));
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
  const pth = new Path2D();
  if (!points || points.length < 4) return buildPath(points);

  const pts = points.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
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

function slotIdForSensor(sensorIdx) {
  const v = assignments?.[String(sensorIdx)];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sensorIdxForSlot(slotId) {
  const want = Number(slotId);
  if (!Number.isFinite(want)) return null;
  for (const [k, v] of Object.entries(assignments || {})) {
    if (Number(v) === want) return Number(k);
  }
  return null;
}

function slotMetaById(slotId) {
  if (!layout || slotId == null || !Number.isFinite(Number(slotId))) return null;
  const id = Number(slotId);
  const left = layout.left?.sensors || [];
  const right = layout.right?.sensors || [];
  for (const s of left) if (s.idx === id) return { sideLabel: 'Лево', pos: String(s.label), slotId: id };
  for (const s of right) if (s.idx === id) return { sideLabel: 'Право', pos: String(s.label), slotId: id };
  return null;
}

function tempCellTextForSensorIdx(idx) {
  const byIdx = new Map();
  for (const v of (lastSample?.values || [])) {
    if (v && typeof v.idx === 'number') byIdx.set(v.idx, v);
  }
  const v = byIdx.get(idx);
  const ok = v && v.ok === true && typeof v.calC === 'number' && Number.isFinite(v.calC);
  return ok ? `${v.calC.toFixed(2)}°C` : '—';
}

function refreshSensorTableTempsOnly() {
  if (!sensorTableBody || !layout) return;
  const sensors = (hello?.sensors || []).slice().sort((a, b) => a.idx - b.idx);
  if (!sensors.length) return;
  for (const s of sensors) {
    const tr = sensorTableBody.querySelector(`tr[data-sensor-idx="${s.idx}"]`);
    if (!tr) return refreshSensorTableFull();
    const el = tr.querySelector('.js-sensor-temp');
    if (!el) return refreshSensorTableFull();
    el.textContent = tempCellTextForSensorIdx(s.idx);
  }
}

function buildSlotSelectForRow(currentSlotId) {
  const sel = document.createElement('select');
  sel.className = 'mono';

  const un = document.createElement('option');
  un.value = '';
  un.textContent = '— не назначен';
  sel.appendChild(un);

  const left = layout?.left?.sensors || [];
  const right = layout?.right?.sensors || [];
  if (left.length) {
    const og = document.createElement('optgroup');
    og.label = 'Лево';
    for (const s of left) {
      const o = document.createElement('option');
      o.value = String(s.idx);
      o.textContent = `${s.label != null ? s.label : s.idx} (id ${s.idx})`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  if (right.length) {
    const og = document.createElement('optgroup');
    og.label = 'Право';
    for (const s of right) {
      const o = document.createElement('option');
      o.value = String(s.idx);
      o.textContent = `${s.label != null ? s.label : s.idx} (id ${s.idx})`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }

  if (currentSlotId != null && Number.isFinite(Number(currentSlotId))) {
    sel.value = String(Number(currentSlotId));
  } else {
    sel.value = '';
  }
  return sel;
}

function refreshSensorTableFull() {
  if (!sensorTableBody) return;

  const sensors = (hello?.sensors || []).slice().sort((a, b) => a.idx - b.idx);
  if (sensorTablePill) {
    sensorTablePill.textContent = sensors.length ? `n=${sensors.length}` : 'нет данных';
  }

  sensorTableBody.replaceChildren();

  if (!sensors.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'muted';
    td.innerHTML = 'Нет списка датчиков (<span class="mono">hello</span>). Нажми <span class="mono">Рескан (r)</span> на теплокарте или переподключи Serial.';
    tr.appendChild(td);
    sensorTableBody.appendChild(tr);
    return;
  }

  for (const s of sensors) {
    const idx = s.idx;
    const addr = s.addr != null ? s.addr : '—';
    const slotId = slotIdForSensor(idx);
    const meta = slotMetaById(slotId);
    const sideLabel = meta ? meta.sideLabel : '—';

    const tr = document.createElement('tr');
    tr.dataset.sensorIdx = String(idx);

    const tdI = document.createElement('td');
    tdI.className = 'mono';
    tdI.textContent = `#${idx}`;

    const tdA = document.createElement('td');
    tdA.className = 'mono';
    tdA.textContent = addr;

    const tdT = document.createElement('td');
    tdT.className = 'num js-sensor-temp';
    tdT.textContent = tempCellTextForSensorIdx(idx);

    const tdSlot = document.createElement('td');
    const sel = buildSlotSelectForRow(slotId);
    sel.addEventListener('change', () => {
      const v = sel.value.trim();
      if (!v) assignSensorToSlot(idx, null);
      else assignSensorToSlot(idx, Number(v));
    });
    tdSlot.appendChild(sel);

    const tdSide = document.createElement('td');
    tdSide.className = 'js-sensor-side';
    tdSide.textContent = sideLabel;

    tr.append(tdI, tdA, tdT, tdSlot, tdSide);
    sensorTableBody.appendChild(tr);
  }
}

function draw() {
  if (!layout) return;
  ensureDefaultAssignments();
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0a101b';
  ctx.fillRect(0,0,W,H);

  const srcW = layout.canvas.width;
  const srcH = layout.canvas.height;
  const gapSrc = 90;
  const pad = 18;
  const totalSrcW = srcW * 2 + gapSrc;
  const scale = Math.min((W - pad*2) / totalSrcW, (H - pad*2) / srcH);
  const ox = Math.round((W - totalSrcW * scale) / 2);
  const oy = Math.round((H - srcH * scale) / 2);

  function resolvedContour(side /* 'left' | 'right' */) {
    const base = side === 'left' ? layout.left.contour : layout.right.contour;
    const o = contourOverrides?.[side];
    return Array.isArray(o) && o.length >= 4 ? o : base;
  }

  function drawPad(atXSrc, side, slots, labelSide){
    const contour = resolvedContour(side);
    const dx = centerDx(contour, srcW);
    const contour2 = shiftPoints(contour, dx);
    const slots2 = shiftSlotListWithOverrides(side, slots, dx);

    ctx.save();
    ctx.translate(ox + atXSrc*scale, oy);
    ctx.scale(scale, scale);

    const path = buildSmoothPath(contour2);
    ctx.fillStyle = 'rgba(40,80,60,.18)';
    ctx.fill(path);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = 'rgba(140,190,255,.95)';
    ctx.stroke(path);

    // contour edit handles
    if (editorMode === 'contour') {
      const pts = contour2.slice();
      const f = pts[0];
      const l = pts[pts.length - 1];
      if (f && l && f[0] === l[0] && f[1] === l[1]) pts.pop();
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        ctx.beginPath();
        ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 170, 255, .95)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.stroke();
      }
    }

    // draw fixed slots (allowed positions) — draggable even when empty
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (const s of slots2) {
      ctx.beginPath();
      ctx.arc(s.xy[0], s.xy[1], 10, 0, Math.PI*2);
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();

    if (editorMode === 'sensors') {
      // draw sensors at assigned slots
      for (const slot of slots2) {
        const sensorIdx = sensorIdxForSlot(slot.idx);
        if (sensorIdx == null) continue;
        ctx.beginPath();
        ctx.arc(slot.xy[0], slot.xy[1], 9, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(255,60,60,.92)';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.stroke();

        const addr = hello?.sensors?.find(x => x.idx === sensorIdx)?.addr;
        const text = addr ? `#${sensorIdx} • ${addr}` : `#${sensorIdx}`;
        ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
        const m = ctx.measureText(text);
        const padT = 6;
        const h = 18;
        const toRight = labelSide === 'left';
        const tx = slot.xy[0] + (toRight ? 14 : -(14 + m.width + padT*2));
        const ty = slot.xy[1] - 10;
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.strokeStyle = 'rgba(255,255,255,.20)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx, ty, m.width + padT*2, h, 7);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(232,238,246,.92)';
        ctx.fillText(text, tx + padT, ty + 13);
      }
    }

    ctx.restore();
    return { dx, slots2, ox, oy, scale, atXSrc, contour, side };
  }

  const left = drawPad(0, 'left', layout.left.sensors, 'left');
  const right = drawPad(srcW + gapSrc, 'right', layout.right.sensors, 'right');

  // draw dragged preview in device coords (can cross sides)
  if (dragPreview.idx != null && dragPreview.clientX != null && dragPreview.clientY != null) {
    const rect = canvas.getBoundingClientRect();
    const x = dragPreview.clientX - rect.left;
    const y = dragPreview.clientY - rect.top;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,60,60,.35)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.stroke();
  }

  const connected = (hello?.sensors || []).length;
  statsEl.textContent = `connected=${connected} • assigned=${Object.keys(assignments).length} • slots=${(layout.left.sensors.length + layout.right.sensors.length)}`;
  dragState.left = left;
  dragState.right = right;
}

// Drag handling in device coords → convert to source coords and store override
const dragState = {
  active: null, // { idx, side, hitRadiusPx }
  left: null,
  right: null,
};

function nearestSlot(sideInfo, sx, sy) {
  if (!layout || !sideInfo) return null;
  const srcW = layout.canvas.width;

  // Determine which slot set applies (left or right) by atXSrc
  const side = sideInfo.side;
  const baseSlots = side === 'right' ? layout.right.sensors : layout.left.sensors;
  const contour = side === 'right' ? resolvedContour('right') : resolvedContour('left');
  const dx = centerDx(contour, srcW);
  const slots = shiftSlotListWithOverrides(side, baseSlots, dx);

  let best = null;
  let bestD2 = Infinity;
  for (const s of slots) {
    const dx2 = sx - s.xy[0];
    const dy2 = sy - s.xy[1];
    const d2 = dx2*dx2 + dy2*dy2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  return best ? { x: best.xy[0], y: best.xy[1], d2: bestD2 } : null;
}

function nearestSlotAny(clientX, clientY) {
  // Find nearest slot across BOTH pads (left/right)
  const candidates = [];
  for (const sideInfo of [dragState.left, dragState.right]) {
    if (!sideInfo) continue;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const sx = (x - (sideInfo.ox + sideInfo.atXSrc * sideInfo.scale)) / sideInfo.scale;
    const sy = (y - sideInfo.oy) / sideInfo.scale;
    const slot = nearestSlot(sideInfo, sx, sy);
    if (slot) candidates.push({ sideInfo, ...slot });
  }
  candidates.sort((a, b) => a.d2 - b.d2);
  return candidates[0] || null;
}

function hitTest(sideInfo, clientX, clientY) {
  if (!sideInfo) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  // Convert to source coords inside that pad transform
  const sx = (x - (sideInfo.ox + sideInfo.atXSrc * sideInfo.scale)) / sideInfo.scale;
  const sy = (y - sideInfo.oy) / sideInfo.scale;

  if (editorMode === 'contour') {
    const hitR = 14;
    const hitR2 = hitR * hitR;
    const side = sideInfo.side;
    const contour = (side === 'left') ? (contourOverrides?.left ?? layout.left.contour) : (contourOverrides?.right ?? layout.right.contour);
    const dx = centerDx(contour, layout.canvas.width);
    const pts = shiftPoints(contour, dx);
    const f = pts[0];
    const l = pts[pts.length - 1];
    if (f && l && f[0] === l[0] && f[1] === l[1]) pts.pop();

    let bestI = null;
    let bestD2 = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i][0];
      const py = pts[i][1];
      const ddx = sx - px;
      const ddy = sy - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 <= hitR2 && d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
      }
    }

    if (bestI != null) return { type: 'contour', side, i: bestI, sx, sy, sideInfo };
    return null;
  }

  // Hit-test slot circles (even empty) OR assigned sensor markers.
  // Prefer sensor hit (inside smaller radius) when user clicks a filled marker,
  // but allow dragging empty slots to build a custom map.
  const slotHitR = 14;
  const slotHitR2 = slotHitR * slotHitR;
  let bestSlotId = null;
  let bestSlotD2 = Infinity;
  for (const slot of sideInfo.slots2) {
    const dx = sx - slot.xy[0];
    const dy = sy - slot.xy[1];
    const d2 = dx*dx + dy*dy;
    if (d2 <= slotHitR2 && d2 < bestSlotD2) {
      bestSlotD2 = d2;
      bestSlotId = slot.idx;
    }
  }

  // Hit-test assigned sensor markers (may overlap); pick closest.
  const hitR = 18;
  const hitR2 = hitR * hitR;
  let bestIdx = null;
  let bestD2 = Infinity;
  for (const slot of sideInfo.slots2) {
    const sensorIdx = sensorIdxForSlot(slot.idx);
    if (sensorIdx == null) continue;
    const dx = sx - slot.xy[0];
    const dy = sy - slot.xy[1];
    const d2 = dx*dx + dy*dy;
    if (d2 <= hitR2 && d2 < bestD2) {
      bestD2 = d2;
      bestIdx = sensorIdx;
    }
  }
  if (bestIdx != null) return { type: 'sensor', idx: bestIdx, sx, sy, sideInfo };
  if (bestSlotId != null) return { type: 'slot', side: sideInfo.side, slotId: bestSlotId, sx, sy, sideInfo };
  return null;
}

function onPointerDown(e) {
  e.preventDefault?.();
  const hit = hitTest(dragState.left, e.clientX, e.clientY) || hitTest(dragState.right, e.clientX, e.clientY);
  if (!hit) return;
  dragState.active = hit;
  canvas.style.cursor = 'grabbing';
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  e.preventDefault?.();
  if (!dragState.active || !layout) return;
  if (dragState.active.type === 'sensor') {
    dragPreview.idx = dragState.active.idx;
    dragPreview.clientX = e.clientX;
    dragPreview.clientY = e.clientY;
  }
  if (dragState.active.type === 'contour') {
    // Keep left/right strictly mirrored.
    ensureMirroredContourOverrides(dragState.active.side);

    const sideInfo = dragState.active.sideInfo;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const sx = (x - (sideInfo.ox + sideInfo.atXSrc * sideInfo.scale)) / sideInfo.scale;
    const sy = (y - sideInfo.oy) / sideInfo.scale;

    const side = dragState.active.side;
    const baseContour = resolvedContour(side);
    const dx = centerDx(baseContour, layout.canvas.width);
    const i = dragState.active.i;
    const nx = sx - dx;
    const ny = sy;

    if (contourOverrides?.[side]?.[i]) {
      contourOverrides[side][i][0] = nx;
      contourOverrides[side][i][1] = ny;
    }

    const other = side === 'left' ? 'right' : 'left';
    const mx = layout.canvas.width - nx;
    if (contourOverrides?.[other]?.[i]) {
      contourOverrides[other][i][0] = mx;
      contourOverrides[other][i][1] = ny;
    }
  }
  if (dragState.active.type === 'slot') {
    const sideInfo = dragState.active.sideInfo;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const sx = (x - (sideInfo.ox + sideInfo.atXSrc * sideInfo.scale)) / sideInfo.scale;
    const sy = (y - sideInfo.oy) / sideInfo.scale;

    const side = dragState.active.side;
    const contour = resolvedContour(side);
    const dx = centerDx(contour, layout.canvas.width);
    const nx = sx - dx;
    const ny = sy;

    if (!slotOverrides || typeof slotOverrides !== 'object') slotOverrides = { left: {}, right: {} };
    if (!slotOverrides.left) slotOverrides.left = {};
    if (!slotOverrides.right) slotOverrides.right = {};

    const slotId = String(dragState.active.slotId);
    slotOverrides[side][slotId] = [nx, ny];
    // mirror to other side by same slotId
    const other = side === 'left' ? 'right' : 'left';
    slotOverrides[other][slotId] = [layout.canvas.width - nx, ny];
  }
  draw();
}

function onPointerUp(e) {
  e.preventDefault?.();
  if (!dragState.active) return;
  const active = dragState.active;
  dragState.active = null;

  if (active.type === 'contour') {
    dragPreview.idx = null; dragPreview.clientX = null; dragPreview.clientY = null;
    canvas.style.cursor = 'grab';
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    saveContourOverrides();
    draw();
    return;
  }
  if (active.type === 'slot') {
    dragPreview.idx = null; dragPreview.clientX = null; dragPreview.clientY = null;
    canvas.style.cursor = 'grab';
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    saveSlotOverrides();
    draw();
    return;
  }

  const idx = active.idx;
  const prevSlot = slotIdForSensor(idx);

  // commit with snapping
  const best = nearestSlotAny(e.clientX, e.clientY);
  let changed = false;
  if (best) {
    const snapR = 45;
    if (best.d2 <= snapR * snapR) {
      const targetSlotId = (() => {
        // Determine actual slotId within that side by nearest match to shifted base slots
        const baseSlots = best.sideInfo.atXSrc > 0 ? layout.right.sensors : layout.left.sensors;
        const contour = best.sideInfo.atXSrc > 0 ? layout.right.contour : layout.left.contour;
        const dx2 = centerDx(contour, layout.canvas.width);
        let bestSlot = null, bestD2 = Infinity;
        for (const s of shiftSensors(baseSlots, dx2)) {
          const ddx = best.x - s.xy[0];
          const ddy = best.y - s.xy[1];
          const d2 = ddx*ddx + ddy*ddy;
          if (d2 < bestD2) { bestD2 = d2; bestSlot = s; }
        }
        return bestSlot ? bestSlot.idx : null;
      })();

      if (targetSlotId != null) {
        const occupiedBy = sensorIdxForSlot(targetSlotId);
        if (assignments[String(idx)] !== targetSlotId) changed = true;
        assignments[String(idx)] = targetSlotId;
        if (occupiedBy != null && occupiedBy !== idx) {
          if (prevSlot != null) {
            // swap
            if (assignments[String(occupiedBy)] !== prevSlot) changed = true;
            assignments[String(occupiedBy)] = prevSlot;
          } else {
            // moved an unassigned sensor onto an occupied slot -> free the displaced one
            changed = true;
            delete assignments[String(occupiedBy)];
          }
        }
      }
    }
  }

  dragPreview.idx = null; dragPreview.clientX = null; dragPreview.clientY = null;
  canvas.style.cursor = 'grab';
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  if (changed) saveAssignments(); // auto-persist on drag/drop
  draw();
}

// Mouse fallback (some environments disable PointerEvents)
let mouseDown = false;
function onMouseDown(e) {
  mouseDown = true;
  onPointerDown({ ...e, pointerId: 1, preventDefault: () => e.preventDefault() });
}
function onMouseMove(e) {
  if (!mouseDown) return;
  onPointerMove({ ...e, preventDefault: () => e.preventDefault() });
}
function onMouseUp(e) {
  mouseDown = false;
  onPointerUp({ ...e, pointerId: 1, preventDefault: () => e.preventDefault() });
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('mousedown', onMouseDown);
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);

saveBtn.addEventListener('click', () => {
  saveAssignments();
  if (contourOverrides) saveContourOverrides();
  if (slotOverrides) saveSlotOverrides();
  statsEl.textContent = `saved • assigned=${Object.keys(assignments).length} • contour=${contourOverrides ? 'custom' : 'default'}`;
});
resetBtn.addEventListener('click', () => {
  assignments = {};
  saveAssignments();
  try { localStorage.removeItem('saddleThermoSensorPositions'); } catch {}
  draw();
});
resetContourBtn.addEventListener('click', () => {
  resetContourOverrides();
  draw();
});

// Reuse "Сброс" для слотов тоже (чтобы быстро вернуться к дефолту)
resetBtn.addEventListener('dblclick', () => {
  resetSlotOverrides();
  draw();
});
exportBtn.addEventListener('click', exportAssignments);
importFile.addEventListener('change', async () => {
  const f = importFile.files?.[0];
  if (!f) return;
  const text = await f.text();
  try {
    const j = JSON.parse(text);
    assignments = normalizeAssignmentsObject(j && typeof j === 'object' ? j : {});
    saveAssignments();
    draw();
  } catch {}
  importFile.value = '';
});

function updateModeButtons() {
  const on = 'btn';
  const off = 'btn btn-secondary';
  modeSensorsBtn.className = (editorMode === 'sensors') ? on : off;
  modeContourBtn.className = (editorMode === 'contour') ? on : off;
  canvas.style.cursor = (editorMode === 'contour') ? 'default' : 'grab';
}

modeSensorsBtn.addEventListener('click', () => {
  editorMode = 'sensors';
  updateModeButtons();
  draw();
});
modeContourBtn.addEventListener('click', () => {
  editorMode = 'contour';
  // Initialize mirrored overrides so editing is symmetric from the start.
  ensureMirroredContourOverrides('left');
  saveContourOverrides();
  updateModeButtons();
  draw();
});

await loadLayout();
refreshSlotsReferenceTable();
refreshSensorTableFull();
wsConnect();
ensureDefaultAssignments();
updateModeButtons();
draw();

