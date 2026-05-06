import express from 'express';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { SerialPort } from 'serialport';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5177);
const SERIAL_PATH = process.env.SERIAL_PATH || ''; // e.g. /dev/tty.usbserial-XXXX
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || 115200);
const DEVICE_TCP_HOST = String(process.env.DEVICE_TCP_HOST || '').trim();
const DEVICE_TCP_PORT = Number(process.env.DEVICE_TCP_PORT || 3333);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function normalizePortPath(p) {
  const s = String(p || '').trim();
  if (!s) return s;
  // Prefer /dev/cu.* for outbound serial on macOS
  if (s.startsWith('/dev/tty.usbserial-')) return s.replace('/dev/tty.usbserial-', '/dev/cu.usbserial-');
  if (s.startsWith('/dev/tty.usbmodem-')) return s.replace('/dev/tty.usbmodem-', '/dev/cu.usbmodem-');
  return s;
}

app.get('/api/ports', async (_req, res) => {
  try {
    const ports = (await SerialPort.list())
      .filter((p) => !String(p.path || '').includes('Bluetooth-Incoming-Port'))
      .map((p) => ({ ...p, path: normalizePortPath(p.path) }));
    res.json({ ports });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/port-events', (_req, res) => {
  res.json({ events: portEvents });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const state = {
  connected: false,
  serialPath: null,
  baud: null,
  lastHello: null,
  lastSample: null,
  lastLineAtMs: 0
};

let serial = null;
let tcpSocket = null;
let tcpReconnectTimer = null;
/** @type {{ host: string, port: number } | null} */
let tcpReconnectArgs = null;

const portEvents = [];
const LOG_PATH = path.join(__dirname, 'connection.log');

function logPortEvent(evt) {
  portEvents.push(evt);
  if (portEvents.length > 500) portEvents.splice(0, portEvents.length - 500);
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(evt) + '\n');
  } catch {}
  wsBroadcast({ type: 'port_event', ...evt });
}
let legacy = {
  foundCount: null,
  addrsByIdx: new Map(),
  seq: 0,
  idxMap: null
};

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

function maybeEmitLegacyHello() {
  if (legacy.foundCount == null) return;
  if (legacy.addrsByIdx.size < legacy.foundCount) return;

  // Index remap for common partial setups:
  // - 2 sensors: treat as left#1 (idx=0) and right#1 (idx=8)
  // - 8 sensors: left pad only (idx=0..7)
  // - 16 sensors: full (idx=0..15)
  if (!legacy.idxMap) {
    if (legacy.foundCount === 2) legacy.idxMap = [0, 8];
    else if (legacy.foundCount === 8) legacy.idxMap = Array.from({ length: 8 }, (_, i) => i);
    else legacy.idxMap = Array.from({ length: legacy.foundCount }, (_, i) => i);
  }

  const sensors = [];
  for (let i = 0; i < legacy.foundCount; i++) {
    const mappedIdx = legacy.idxMap[i] ?? i;
    sensors.push({
      idx: mappedIdx,
      addr: legacy.addrsByIdx.get(i) || '—',
      offsetC: 0,
      scale: 1
    });
  }
  const hello = {
    type: 'hello',
    fw: 'legacy-bridge',
    maxSensors: 16,
    oneWireBus: null,
    mode: 'unknown',
    hz: null,
    sensors
  };
  state.lastHello = hello;
  wsBroadcast(hello);
}

function handleLegacyTextLine(line) {
  const mFound = /^Found sensors:\s*(\d+)/i.exec(line);
  if (mFound) {
    legacy.foundCount = Number(mFound[1]);
    legacy.addrsByIdx = new Map();
    maybeEmitLegacyHello();
    return true;
  }
  const mSensor = /^Sensor\s+(\d+):\s*([0-9A-Fa-f]{16})/i.exec(line);
  if (mSensor) {
    const idx = Number(mSensor[1]);
    const addr = mSensor[2].toUpperCase();
    legacy.addrsByIdx.set(idx, addr);
    maybeEmitLegacyHello();
    return true;
  }
  return false;
}

function handleLegacyJson(obj) {
  // Format: {"t":[30.19,33.13]}
  if (!obj || !Array.isArray(obj.t)) return null;
  if (!legacy.idxMap) {
    // Best-effort when we didn't get "Found sensors" yet.
    const n = obj.t.length;
    if (n === 2) legacy.idxMap = [0, 8];
    else legacy.idxMap = Array.from({ length: n }, (_, i) => i);
  }
  const values = obj.t.map((c, idx) => ({
    idx: legacy.idxMap[idx] ?? idx,
    addr: legacy.addrsByIdx.get(idx) || '—',
    rawC: Number(c),
    calC: Number(c),
    ok: Number.isFinite(Number(c))
  }));
  const sample = {
    type: 'sample',
    seq: legacy.seq++,
    ms: Date.now(),
    mode: 'unknown',
    hz: null,
    values
  };
  state.lastSample = sample;
  return sample;
}

function ingestDeviceLine(trimmed) {
  if (!trimmed) return;
  state.lastLineAtMs = Date.now();

  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    if (!handleLegacyTextLine(trimmed)) {
      wsBroadcast({ type: 'raw', line: trimmed });
    }
    return;
  }

  const legacySample = handleLegacyJson(obj);
  if (legacySample) {
    wsBroadcast(legacySample);
    return;
  }

  if (obj?.type === 'hello') state.lastHello = obj;
  if (obj?.type === 'sample') state.lastSample = obj;
  wsBroadcast(obj);
}

function ingestDeviceBuffer(bufRef, chunk) {
  bufRef.buf += chunk.toString('utf8');
  while (true) {
    const idx = bufRef.buf.indexOf('\n');
    if (idx === -1) break;
    const line = bufRef.buf.slice(0, idx);
    bufRef.buf = bufRef.buf.slice(idx + 1);
    ingestDeviceLine(String(line).trim());
  }
}

function detachTcp(clearReconnect) {
  if (tcpReconnectTimer) {
    clearTimeout(tcpReconnectTimer);
    tcpReconnectTimer = null;
  }
  if (clearReconnect) tcpReconnectArgs = null;
  if (tcpSocket) {
    try {
      tcpSocket.removeAllListeners();
      tcpSocket.destroy();
    } catch {}
    tcpSocket = null;
  }
}

/**
 * @param {string} host
 * @param {number} port
 * @param {{ reconnect?: boolean }} opts
 */
function attachTcp(host, port, opts = {}) {
  const reconnect = opts.reconnect !== false;

  if (tcpReconnectTimer) {
    clearTimeout(tcpReconnectTimer);
    tcpReconnectTimer = null;
  }
  if (tcpSocket) {
    try {
      tcpSocket.removeAllListeners();
      tcpSocket.destroy();
    } catch {}
    tcpSocket = null;
  }

  if (serial) {
    try { serial.close(); } catch {}
    serial = null;
  }

  legacy = { foundCount: null, addrsByIdx: new Map(), seq: 0, idxMap: null };
  tcpReconnectArgs = reconnect ? { host, port } : null;

  const bufRef = { buf: '' };
  const sock = net.connect({ host, port }, () => {
    state.connected = true;
    state.serialPath = `tcp://${host}:${port}`;
    state.baud = null;
    wsBroadcast({ type: 'serial', status: 'connected', path: state.serialPath, baud: null });
    logPortEvent({ ts: new Date().toISOString(), kind: 'tcp_open', host, port });
  });

  sock.on('data', (chunk) => ingestDeviceBuffer(bufRef, chunk));

  sock.on('error', (err) => {
    wsBroadcast({ type: 'serial', status: 'error', error: String(err?.message || err) });
    logPortEvent({ ts: new Date().toISOString(), kind: 'tcp_error', host, port, error: String(err?.message || err) });
  });

  sock.on('close', () => {
    state.connected = false;
    state.serialPath = null;
    state.baud = null;
    tcpSocket = null;
    wsBroadcast({ type: 'serial', status: 'closed' });
    logPortEvent({ ts: new Date().toISOString(), kind: 'tcp_close', host, port });
    if (tcpReconnectArgs) {
      tcpReconnectTimer = setTimeout(() => {
        tcpReconnectTimer = null;
        attachTcp(tcpReconnectArgs.host, tcpReconnectArgs.port, { reconnect: true });
      }, 2000);
    }
  });

  tcpSocket = sock;
}

function attachSerial(portPath) {
  detachTcp(true);
  tcpReconnectArgs = null;

  if (serial) {
    try { serial.close(); } catch {}
    serial = null;
  }
  legacy = { foundCount: null, addrsByIdx: new Map(), seq: 0, idxMap: null };

  const sp = new SerialPort({ path: portPath, baudRate: SERIAL_BAUD, autoOpen: true });
  const bufRef = { buf: '' };

  state.connected = true;
  state.serialPath = portPath;
  state.baud = SERIAL_BAUD;
  wsBroadcast({ type: 'serial', status: 'connected', path: portPath, baud: SERIAL_BAUD });
  logPortEvent({ ts: new Date().toISOString(), kind: 'serial_open', path: portPath, baud: SERIAL_BAUD });

  sp.on('data', (chunk) => ingestDeviceBuffer(bufRef, chunk));

  sp.on('error', (err) => {
    state.connected = false;
    state.baud = null;
    wsBroadcast({ type: 'serial', status: 'error', error: String(err?.message || err) });
    logPortEvent({ ts: new Date().toISOString(), kind: 'serial_error', path: portPath, error: String(err?.message || err) });
  });

  sp.on('close', () => {
    state.connected = false;
    state.baud = null;
    wsBroadcast({ type: 'serial', status: 'closed' });
    logPortEvent({ ts: new Date().toISOString(), kind: 'serial_close', path: portPath });
  });

  serial = sp;
  return serial;
}

function tryWriteDevice(cmd) {
  if (serial) {
    try {
      serial.write(cmd);
      return true;
    } catch {
      return false;
    }
  }
  if (tcpSocket && !tcpSocket.destroyed) {
    try {
      return tcpSocket.write(cmd);
    } catch {
      return false;
    }
  }
  return false;
}

app.post('/api/connect', async (req, res) => {
  const portPath = normalizePortPath(req?.body?.path);
  if (!portPath) return res.status(400).json({ error: 'Missing "path"' });
  if (String(portPath).includes('Bluetooth-Incoming-Port')) {
    return res.status(400).json({ error: 'Bluetooth port is not supported' });
  }

  try {
    if (state.serialPath === portPath && state.connected && serial) {
      return res.json({ ok: true, path: portPath, baud: SERIAL_BAUD, alreadyConnected: true });
    }
    attachSerial(portPath);
    res.json({ ok: true, path: portPath, baud: SERIAL_BAUD });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/connect-tcp', (req, res) => {
  const host = String(req?.body?.host || '').trim();
  const port = Number(req?.body?.port || DEVICE_TCP_PORT || 3333);
  if (!host) return res.status(400).json({ error: 'Missing "host"' });
  try {
    attachTcp(host, port, { reconnect: true });
    res.json({ ok: true, path: `tcp://${host}:${port}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'serial',
    status: state.connected ? 'connected' : 'disconnected',
    path: state.serialPath,
    baud: state.baud
  }));
  if (state.lastHello) ws.send(JSON.stringify(state.lastHello));
  if (state.lastSample) ws.send(JSON.stringify(state.lastSample));

  ws.on('message', (data) => {
    const msg = String(data || '').trim();
    // Forward control commands to Arduino.
    // - single-char: w/t/g/r
    // - set hz: "hz=7"
    if (!msg) return;
    if (msg === 'w' || msg === 't' || msg === 'g' || msg === 'r') {
      tryWriteDevice(msg);
      return;
    }
    if (/^hz=\d{1,2}$/i.test(msg)) {
      tryWriteDevice(`${msg}\n`);
      return;
    }
  });
});

async function main() {
  // Watch for board plug/unplug by polling SerialPort.list()
  let prev = new Set();
  setInterval(async () => {
    try {
      const ports = await SerialPort.list();
      const now = new Set(ports.map((p) => p.path));
      for (const p of now) if (!prev.has(p)) logPortEvent({ ts: new Date().toISOString(), kind: 'port_added', path: p });
      for (const p of prev) if (!now.has(p)) logPortEvent({ ts: new Date().toISOString(), kind: 'port_removed', path: p });
      prev = now;
    } catch {}
  }, 1000);

  if (SERIAL_PATH) {
    attachSerial(normalizePortPath(SERIAL_PATH));
  } else if (DEVICE_TCP_HOST) {
    attachTcp(DEVICE_TCP_HOST, DEVICE_TCP_PORT, { reconnect: true });
  } else {
    console.log('No SERIAL_PATH or DEVICE_TCP_HOST. Use UI serial picker (/api/connect) or POST /api/connect-tcp, or set env vars.');
  }

  server.listen(PORT, '0.0.0.0', () => {
    const hostHint = PORT === 80 || PORT === 443 ? '' : `:${PORT}`;
    console.log(`Web UI: http://127.0.0.1${hostHint} (LAN: http://<this-machine-ip>${hostHint})`);
    if (SERIAL_PATH) console.log(`Serial: ${normalizePortPath(SERIAL_PATH)} @ ${SERIAL_BAUD}`);
    else if (DEVICE_TCP_HOST) console.log(`Device TCP: ${DEVICE_TCP_HOST}:${DEVICE_TCP_PORT} (JSON Lines, reconnect every 2s if down)`);
    else console.log('Serial: (not set)');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
