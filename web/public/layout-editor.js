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

let layout = null;
let hello = null;

// assignments: { [sensorIdx: string]: slotId }
let assignments = loadAssignments();
const dragPreview = { idx: null, clientX: null, clientY: null };

function loadAssignments() {
  try {
    const raw = localStorage.getItem('saddleThermoAssignments');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAssignments() {
  localStorage.setItem('saddleThermoAssignments', JSON.stringify(assignments));
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

function wsConnect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => {
    subline.textContent = 'Serial: websocket connected';
  });
  ws.addEventListener('close', () => {
    subline.textContent = 'Serial: websocket closed';
    setTimeout(wsConnect, 800);
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'serial') {
      const p = msg.path ? `${msg.path}` : '—';
      const b = msg.baud ? `${msg.baud}` : '—';
      subline.textContent = `Serial: ${msg.status} • ${p} • ${b}`;
    }
    if (msg.type === 'hello') {
      hello = msg;
      pruneAssignmentsToConnectedSensors();
      ensureDefaultAssignments();
      draw();
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

function slotIdForSensor(sensorIdx) {
  const v = assignments?.[String(sensorIdx)];
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

function sensorIdxForSlot(slotId) {
  for (const [k, v] of Object.entries(assignments || {})) {
    if (v === slotId) return Number(k);
  }
  return null;
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

  function drawPad(atXSrc, contour, slots, labelSide){
    const dx = centerDx(contour, srcW);
    const contour2 = shiftPoints(contour, dx);
    const slots2 = shiftSensors(slots, dx);

    ctx.save();
    ctx.translate(ox + atXSrc*scale, oy);
    ctx.scale(scale, scale);

    const path = buildPath(contour2);
    ctx.fillStyle = 'rgba(40,80,60,.18)';
    ctx.fill(path);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = 'rgba(140,190,255,.95)';
    ctx.stroke(path);

    // draw fixed slots (allowed positions)
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

    ctx.restore();
    return { dx, slots2, ox, oy, scale, atXSrc, contour };
  }

  const left = drawPad(0, layout.left.contour, layout.left.sensors, 'left');
  const right = drawPad(srcW + gapSrc, layout.right.contour, layout.right.sensors, 'right');

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
  const baseSlots = sideInfo.atXSrc > 0 ? layout.right.sensors : layout.left.sensors;
  const contour = sideInfo.atXSrc > 0 ? layout.right.contour : layout.left.contour;
  const dx = centerDx(contour, srcW);
  const slots = shiftSensors(baseSlots, dx);

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
  return bestIdx != null ? { idx: bestIdx, sx, sy, sideInfo } : null;
}

function onPointerDown(e) {
  e.preventDefault?.();
  const hit = hitTest(dragState.left, e.clientX, e.clientY) || hitTest(dragState.right, e.clientX, e.clientY);
  if (!hit) return;
  dragState.active = { idx: hit.idx, sideInfo: hit.sideInfo };
  canvas.style.cursor = 'grabbing';
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  e.preventDefault?.();
  if (!dragState.active || !layout) return;
  dragPreview.idx = dragState.active.idx;
  dragPreview.clientX = e.clientX;
  dragPreview.clientY = e.clientY;
  draw();
}

function onPointerUp(e) {
  e.preventDefault?.();
  if (!dragState.active) return;
  const idx = dragState.active.idx;
  const prevSlot = slotIdForSensor(idx);
  dragState.active = null;

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
  statsEl.textContent = `saved • assigned=${Object.keys(assignments).length}`;
});
resetBtn.addEventListener('click', () => {
  assignments = {};
  saveAssignments();
  try { localStorage.removeItem('saddleThermoSensorPositions'); } catch {}
  draw();
});
exportBtn.addEventListener('click', exportAssignments);
importFile.addEventListener('change', async () => {
  const f = importFile.files?.[0];
  if (!f) return;
  const text = await f.text();
  try {
    const j = JSON.parse(text);
    assignments = j && typeof j === 'object' ? j : {};
    saveAssignments();
    draw();
  } catch {}
  importFile.value = '';
});

await loadLayout();
wsConnect();
ensureDefaultAssignments();
draw();

