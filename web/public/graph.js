const subline = document.getElementById('subline');
const modePill = document.getElementById('modePill');
const statsEl = document.getElementById('stats');
const sensorSelect = document.getElementById('sensorSelect');
const windowSelect = document.getElementById('windowSelect');
const uiRateSelect = document.getElementById('uiRateSelect');

const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');

const state = {
  serial: { status: 'disconnected', path: null, baud: null },
  hello: null,
  lastSample: null,
  hzEma: null,
  lastSampleAtMs: null,
  seriesByIdx: new Map(), // idx -> [{tMs, c}]
  uiHz: 10,
  lastUiUpdateAtMs: 0,
  pendingDraw: false,
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

function niceNum(x) {
  const exp = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, exp);
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function setSerialLine() {
  const p = state.serial.path ? `${state.serial.path}` : '—';
  const b = state.serial.baud ? `${state.serial.baud}` : '—';
  subline.textContent = `Serial: ${state.serial.status} • ${p} • ${b}`;
}

function ensureSensorOptions() {
  const opts = [];
  const fromHello = state.hello?.sensors || [];
  if (fromHello.length) {
    for (const s of fromHello) opts.push({ idx: s.idx, label: `#${s.idx} • ${s.addr}` });
  } else {
    // fallback: use any seen indices
    for (const idx of state.seriesByIdx.keys()) opts.push({ idx, label: `#${idx}` });
  }
  opts.sort((a, b) => a.idx - b.idx);

  const prev = sensorSelect.value;
  sensorSelect.innerHTML = '';
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = String(o.idx);
    opt.textContent = o.label;
    sensorSelect.appendChild(opt);
  }
  if (prev) sensorSelect.value = prev;
}

function pushPoint(idx, tMs, c) {
  if (!state.seriesByIdx.has(idx)) state.seriesByIdx.set(idx, []);
  const arr = state.seriesByIdx.get(idx);
  arr.push({ tMs, c });
  // cap to ~10 minutes at 20Hz (safe upper bound)
  if (arr.length > 12000) arr.splice(0, arr.length - 12000);
}

function draw() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a101b';
  ctx.fillRect(0, 0, W, H);

  const idx = Number(sensorSelect.value || '0');
  const windowS = Number(windowSelect.value || '60');
  const now = Date.now();
  const t0 = now - windowS * 1000;
  const series = (state.seriesByIdx.get(idx) || []).filter(p => p.tMs >= t0);

  // axes layout
  const padL = 60;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, plotW, plotH);

  if (series.length < 2) {
    ctx.fillStyle = 'rgba(138,160,182,.9)';
    ctx.font = '14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText('Нет данных для выбранного датчика…', padL + 10, padT + 24);
    return;
  }

  let minC = Infinity, maxC = -Infinity;
  for (const p of series) { minC = Math.min(minC, p.c); maxC = Math.max(maxC, p.c); }
  if (minC === maxC) { minC -= 0.5; maxC += 0.5; }
  const range = maxC - minC;
  const tick = niceNum(range / 4);
  const yMin = Math.floor(minC / tick) * tick;
  const yMax = Math.ceil(maxC / tick) * tick;

  const xScale = (t) => padL + ((t - t0) / (windowS * 1000)) * plotW;
  const yScale = (c) => padT + (1 - (c - yMin) / (yMax - yMin)) * plotH;

  // grid + y labels
  ctx.fillStyle = 'rgba(138,160,182,.9)';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let y = yMin; y <= yMax + 1e-9; y += tick) {
    const yy = yScale(y);
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(padL + plotW, yy);
    ctx.stroke();
    ctx.fillText(`${y.toFixed(1)}°C`, padL - 8, yy);
  }

  // line
  ctx.strokeStyle = 'rgba(77,163,255,.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xScale(series[0].tMs), yScale(series[0].c));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(xScale(series[i].tMs), yScale(series[i].c));
  }
  ctx.stroke();

  // last point
  const last = series[series.length - 1];
  ctx.fillStyle = 'rgba(255,60,60,.95)';
  ctx.beginPath();
  ctx.arc(xScale(last.tMs), yScale(last.c), 4.5, 0, Math.PI * 2);
  ctx.fill();

  // x label
  ctx.fillStyle = 'rgba(138,160,182,.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${windowS}s window`, padL, padT + plotH + 28);

  statsEl.textContent = `датчик #${idx} • точек=${series.length} • ${last.c.toFixed(2)}°C`;
}

function onMessage(msg) {
  if (msg.type === 'serial') {
    state.serial = msg;
    setSerialLine();
    return;
  }
  if (msg.type === 'hello') {
    state.hello = msg;
    ensureSensorOptions();
    return;
  }
  if (msg.type === 'sample') {
    state.lastSample = msg;
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
    modePill.textContent = `${msg.mode || '—'} • ${hzText}`;

    for (const v of (msg.values || [])) {
      if (!v || v.ok !== true) continue;
      if (typeof v.calC !== 'number' || !Number.isFinite(v.calC)) continue;
      pushPoint(v.idx, Date.now(), v.calC);
    }
    ensureSensorOptions();
    state.pendingDraw = true;
  }
}

let drawTimer = null;
function restartDrawLoop() {
  if (drawTimer) clearInterval(drawTimer);
  const hz = Number(state.uiHz || 0) > 0 ? Number(state.uiHz) : 30;
  const period = Math.max(25, Math.round(1000 / hz));
  drawTimer = setInterval(() => {
    if (!state.pendingDraw) return;
    state.pendingDraw = false;
    draw();
  }, period);
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => {
    subline.textContent = 'Serial: connecting…';
  });
  ws.addEventListener('close', () => {
    subline.textContent = 'Serial: websocket closed';
    setTimeout(connectWs, 800);
  });
  ws.addEventListener('message', (ev) => {
    try { onMessage(JSON.parse(ev.data)); } catch {}
  });
}

sensorSelect.addEventListener('change', draw);
windowSelect.addEventListener('change', draw);

state.uiHz = loadUiRateFromStorage();
if (uiRateSelect) {
  uiRateSelect.value = String(state.uiHz ?? 10);
  uiRateSelect.addEventListener('change', () => {
    const hz = Number(uiRateSelect.value);
    state.uiHz = Number.isFinite(hz) ? hz : 10;
    saveUiRateToStorage(state.uiHz);
    state.lastUiUpdateAtMs = 0;
    restartDrawLoop();
  });
}

setSerialLine();
draw();
restartDrawLoop();
connectWs();

