/**
 * DS18B20 multi-sensor reader for horse-saddle thermal mat prototype (ESP32).
 *
 * Streams JSON Lines over USB Serial @ 115200:
 *   {"type":"hello","proto":1,"fw":"esp32","sensors":[{"idx":0,"addr":"28..."}, ...]}
 *   {"type":"sample","ms":12345,"mode":"walk","hz":2,"values":[{"idx":0,"ok":true,"rawC":23.1,"calC":23.1}, ...]}
 *
 * Commands (single line, newline-terminated; also accepted from the web UI):
 *   w  -> walk  (~2 Hz)
 *   t  -> trot  (~5 Hz)
 *   g  -> gallop (~10 Hz)
 *   hz=<N> -> custom Hz (0.2..30)
 *   r  -> rescan sensors
 *
 * Wiring:
 *   - DS18B20 DQ -> ONE_WIRE_GPIO (default GPIO4)
 *   - 4.7k pull-up from DQ to 3.3V
 *   - VDD -> 3.3V, GND -> GND (common with ESP32)
 *
 * Remote (optional, same JSON Lines as USB Serial):
 *   - AP mode (default): ESP32 hosts its own open Wi‑Fi `WIFI_SSID` (no password).
 *       Connect your phone/laptop to it; bridge target is tcp://192.168.4.1:SADDLE_REMOTE_TCP_PORT.
 *   - STA mode: set WIFI_AP_MODE=false and fill WIFI_SSID/WIFI_PASS with your home Wi‑Fi.
 *       Point the Node bridge at the IP printed on USB Serial (DEVICE_TCP_HOST=<IP> npm run dev,
 *       or POST /api/connect-tcp from the web UI).
 *   - BT_DEVICE_NAME: BluetoothSerial (classic) SPP — pair phone/PC, open as a serial port;
 *       commands + JSON work like USB. Empty on S3/C3 (no classic BT).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <BluetoothSerial.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ===== Hardware config =====
#ifndef ONE_WIRE_GPIO
#define ONE_WIRE_GPIO 4
#endif

#ifndef SADDLE_REMOTE_TCP_PORT
#define SADDLE_REMOTE_TCP_PORT 3333
#endif

static const uint32_t SERIAL_BAUD = 115200;

// ===== Wi‑Fi =====
// AP mode (default): board broadcasts an OPEN Wi‑Fi `WIFI_SSID` (no password).
//   Connect your phone/laptop to it, then point the bridge at tcp://192.168.4.1:SADDLE_REMOTE_TCP_PORT.
// STA mode: set WIFI_AP_MODE = false and fill WIFI_SSID / WIFI_PASS.
// Empty WIFI_SSID => Wi‑Fi disabled (USB / BT only).
static const bool WIFI_AP_MODE = true;
static const char *WIFI_SSID = "SaddleThermo";
static const char *WIFI_PASS = ""; // ignored in AP mode (open network)
// Empty => BluetoothSerial disabled (ESP32‑S3/C3 have no classic BT)
static const char *BT_DEVICE_NAME = "";

static const size_t MAX_REMOTE_TCP_CLIENTS = 3;
static WiFiServer wifiTcpServer(SADDLE_REMOTE_TCP_PORT);
static WiFiClient wifiTcpClients[MAX_REMOTE_TCP_CLIENTS];
BluetoothSerial SerialBT;
static bool btSppActive = false;
static bool wifiListenStarted = false;

struct CmdRx {
  char buf[48];
  uint8_t len;
};
static CmdRx rxSerial;
static CmdRx rxBt;
static CmdRx rxWifiTcp[MAX_REMOTE_TCP_CLIENTS];

static void handleImmediateByte(char c);
static void handleLine(const String &line);

// ===== Protocol / sampling =====
static const uint8_t MAX_SENSORS = 32;

enum class Gait : uint8_t { Walk = 0, Trot = 1, Gallop = 2 };

struct GaitCfg {
  const char *name;
  uint8_t hz;
};

static const GaitCfg GAITS[] = {
  {"walk", 2},
  {"trot", 5},
  {"gallop", 10},
};

OneWire oneWire(ONE_WIRE_GPIO);
DallasTemperature sensors(&oneWire);

DeviceAddress addrs[MAX_SENSORS];
uint8_t sensorCount = 0;

Gait gait = Gait::Walk;
uint8_t customHz = 0; // 0 => use gait default

bool conversionInFlight = false;
uint32_t convStartMs = 0;
uint32_t nextKickMs = 0;

// Never interleave JSON lines: defer scans/hello emission until we're idle.
volatile bool pendingRescan = false;

// Optional calibration table (fill with your ROM addresses after discovery).
struct CalibEntry {
  DeviceAddress addr;
  float offsetC;
  float scale;
};

static const CalibEntry CALIB_TABLE[] = {
  // {{0x28, 0xFF, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01}, 0.20f, 1.00f},
};
static const uint8_t CALIB_TABLE_LEN = sizeof(CALIB_TABLE) / sizeof(CALIB_TABLE[0]);

static void copyAddr(DeviceAddress dst, const DeviceAddress src) {
  for (uint8_t i = 0; i < 8; i++) dst[i] = src[i];
}

static bool addrEq(const DeviceAddress a, const DeviceAddress b) {
  for (uint8_t i = 0; i < 8; i++) if (a[i] != b[i]) return false;
  return true;
}

static void applyCalibForAddr(const DeviceAddress addr, float rawC, float &outCalC) {
  outCalC = rawC;
  for (uint8_t i = 0; i < CALIB_TABLE_LEN; i++) {
    if (addrEq(addr, CALIB_TABLE[i].addr)) {
      outCalC = rawC * CALIB_TABLE[i].scale + CALIB_TABLE[i].offsetC;
      return;
    }
  }
}

static uint8_t targetHz() {
  if (customHz) return customHz;
  return GAITS[(uint8_t)gait].hz;
}

static const char *modeName() {
  return GAITS[(uint8_t)gait].name;
}

static uint8_t resolutionBitsForHz(uint8_t hz) {
  // DS18B20 typical conversion time:
  // 12-bit: ~750ms, 11-bit: ~375ms, 10-bit: ~188ms, 9-bit: ~94ms
  if (hz >= 9) return 9;
  if (hz >= 5) return 10;
  return 11;
}

static uint16_t conversionMsForBits(uint8_t bits) {
  switch (bits) {
    case 9: return 95;
    case 10: return 190;
    case 11: return 380;
    default: return 760; // 12
  }
}

static void bridgePrintLine(const String &line) {
  for (size_t i = 0; i < MAX_REMOTE_TCP_CLIENTS; i++) {
    if (wifiTcpClients[i] && wifiTcpClients[i].connected()) {
      wifiTcpClients[i].println(line);
    }
  }
  if (btSppActive) SerialBT.println(line);
}

static void emitHello() {
  String line;
  line.reserve(sensorCount * 30 + 80);
  line = "{\"type\":\"hello\",\"proto\":1,\"fw\":\"esp32\",\"sensors\":[";
  for (uint8_t i = 0; i < sensorCount; i++) {
    if (i) line += ',';
    line += "{\"idx\":";
    line += (int)i;
    line += ",\"addr\":\"";
    for (uint8_t b = 0; b < 8; b++) {
      if (addrs[i][b] < 16) line += '0';
      line += String(addrs[i][b], HEX);
    }
    line += "\"}";
  }
  line += "]}";
  Serial.println(line);
  bridgePrintLine(line);
}

static void emitSampleLine(uint32_t nowMs, uint8_t hz) {
  String line;
  line.reserve(520);
  line = "{\"type\":\"sample\",\"ms\":";
  line += (uint32_t)nowMs;
  line += ",\"mode\":\"";
  line += modeName();
  line += "\",\"hz\":";
  line += (int)hz;
  line += ",\"values\":[";
  for (uint8_t i = 0; i < sensorCount; i++) {
    float rawC = sensors.getTempC(addrs[i]);
    bool ok = !isnan(rawC) && rawC > -55.0f && rawC < 125.0f;
    float calC = rawC;
    if (ok) applyCalibForAddr(addrs[i], rawC, calC);
    if (i) line += ',';
    line += "{\"idx\":";
    line += (int)i;
    line += ",\"ok\":";
    line += ok ? "true" : "false";
    line += ",\"rawC\":";
    if (ok) line += String(rawC, 3); else line += "null";
    line += ",\"calC\":";
    if (ok) line += String(calC, 3); else line += "null";
    line += "}";
  }
  line += "]}";
  Serial.println(line);
  bridgePrintLine(line);
}

static void drainCmdRx(Stream &in, CmdRx &rx) {
  while (in.available()) {
    char ch = (char)in.read();
    if (ch == '\r') continue;

    if (ch == '\n') {
      rx.buf[rx.len] = 0;
      rx.len = 0;
      handleLine(String(rx.buf));
      continue;
    }

    if (rx.len == 0 && (ch == 'w' || ch == 't' || ch == 'g' || ch == 'r')) {
      handleImmediateByte(ch);
      continue;
    }

    if (rx.len < sizeof(rx.buf) - 1) rx.buf[rx.len++] = ch;
    else rx.len = 0;
  }
}

static void serviceWifiLink() {
  if (!WIFI_SSID || !WIFI_SSID[0]) return;

  if (WIFI_AP_MODE) {
    if (!wifiListenStarted) {
      WiFi.mode(WIFI_AP);
      // NULL password => open network.
      bool ok = WiFi.softAP(WIFI_SSID,
                            (WIFI_PASS && WIFI_PASS[0]) ? WIFI_PASS : (const char *)NULL);
      if (!ok) {
        static uint32_t lastFail = 0;
        if (millis() - lastFail > 5000) {
          lastFail = millis();
          Serial.println(F("WiFi softAP() failed; retrying"));
        }
        return;
      }
      wifiListenStarted = true;
      wifiTcpServer.begin();
      Serial.print(F("WiFi AP \""));
      Serial.print(WIFI_SSID);
      Serial.print(F("\" (open) TCP JSON bridge "));
      Serial.print(WiFi.softAPIP());
      Serial.print(F(":"));
      Serial.println((unsigned)SADDLE_REMOTE_TCP_PORT);
    }
  } else {
    if (WiFi.status() != WL_CONNECTED) {
      if (wifiListenStarted) {
        wifiListenStarted = false;
        for (size_t i = 0; i < MAX_REMOTE_TCP_CLIENTS; i++) {
          if (wifiTcpClients[i]) wifiTcpClients[i].stop();
        }
        wifiTcpServer.end();
      }
      static uint32_t lastTry = 0;
      if (millis() - lastTry > 8000) {
        lastTry = millis();
        WiFi.mode(WIFI_STA);
        WiFi.begin(WIFI_SSID, WIFI_PASS);
      }
      return;
    }

    if (!wifiListenStarted) {
      wifiListenStarted = true;
      wifiTcpServer.begin();
      Serial.print(F("WiFi TCP JSON bridge "));
      Serial.print(WiFi.localIP());
      Serial.print(F(":"));
      Serial.println((unsigned)SADDLE_REMOTE_TCP_PORT);
    }
  }

  WiFiClient inc = wifiTcpServer.available();
  if (inc) {
    for (size_t i = 0; i < MAX_REMOTE_TCP_CLIENTS; i++) {
      if (!wifiTcpClients[i] || !wifiTcpClients[i].connected()) {
        if (wifiTcpClients[i]) wifiTcpClients[i].stop();
        wifiTcpClients[i] = inc;
        break;
      }
    }
  }

  for (size_t i = 0; i < MAX_REMOTE_TCP_CLIENTS; i++) {
    if (wifiTcpClients[i] && wifiTcpClients[i].connected()) {
      drainCmdRx(wifiTcpClients[i], rxWifiTcp[i]);
    } else if (wifiTcpClients[i]) {
      wifiTcpClients[i].stop();
    }
  }
}

static void scanSensors() {
  sensors.begin();
  uint8_t n = sensors.getDeviceCount();
  if (n > MAX_SENSORS) n = MAX_SENSORS;
  sensorCount = n;
  for (uint8_t i = 0; i < sensorCount; i++) {
    sensors.getAddress(addrs[i], i);
  }
  conversionInFlight = false;
  nextKickMs = millis() + 50;
}

static void scheduleRescan() { pendingRescan = true; }

static void maybeEmitDeferred() {
  if (conversionInFlight) return;
  if (!pendingRescan) return;

  pendingRescan = false;

  scanSensors();
  emitHello();
}

static void handleImmediateByte(char c) {
  // Single-char commands are intentionally handled without requiring '\n'.
  // This prevents "r" typed in serial monitors from being injected mid-JSON output.
  switch (c) {
    case 'w':
      customHz = 0;
      gait = Gait::Walk;
      break;
    case 't':
      customHz = 0;
      gait = Gait::Trot;
      break;
    case 'g':
      customHz = 0;
      gait = Gait::Gallop;
      break;
    case 'r':
      scheduleRescan();
      break;
    default:
      break;
  }
}

static void handleLine(const String &line) {
  if (line.length() == 0) return;
  if (line == "w") {
    handleImmediateByte('w');
    return;
  }
  if (line == "t") {
    handleImmediateByte('t');
    return;
  }
  if (line == "g") {
    handleImmediateByte('g');
    return;
  }
  if (line == "r") {
    handleImmediateByte('r');
    return;
  }
  if (line.startsWith("hz=")) {
    float v = line.substring(3).toFloat();
    if (v >= 0.2f && v <= 30.0f) customHz = (uint8_t)(v + 0.5f);
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(150);

  if (WIFI_SSID && WIFI_SSID[0]) {
    if (WIFI_AP_MODE) {
      WiFi.mode(WIFI_AP);
    } else {
      WiFi.mode(WIFI_STA);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }
  if (BT_DEVICE_NAME && BT_DEVICE_NAME[0]) {
    SerialBT.begin(BT_DEVICE_NAME);
    btSppActive = true;
  }

  sensors.setWaitForConversion(false);
  scanSensors();
  emitHello();
}

void loop() {
  serviceWifiLink();
  drainCmdRx(Serial, rxSerial);
  if (btSppActive) drainCmdRx(SerialBT, rxBt);

  const uint32_t now = millis();
  const uint8_t hz = targetHz();
  const uint32_t periodMs = (uint32_t)(1000UL / (uint32_t)hz);

  if (sensorCount == 0) {
    // Signed subtraction guards against millis() wraparound and the initial
    // case where nextKickMs > now (which would otherwise underflow to MAX_UINT32
    // and trigger a rescan flood every loop iteration).
    if ((int32_t)(now - nextKickMs) > 1500) {
      nextKickMs = now + 1500;
      scheduleRescan();
    }
    maybeEmitDeferred();
    delay(2);
    return;
  }

  const uint8_t bits = resolutionBitsForHz(hz);
  sensors.setResolution(bits);

  if (!conversionInFlight) {
    if (now >= nextKickMs) {
      nextKickMs = now + periodMs;
      sensors.requestTemperatures();
      conversionInFlight = true;
      convStartMs = now;
    }
    maybeEmitDeferred();
    delay(1);
    return;
  }

  const uint16_t need = conversionMsForBits(bits);
  if ((uint32_t)(now - convStartMs) < need) {
    maybeEmitDeferred();
    delay(1);
    return;
  }

  conversionInFlight = false;

  emitSampleLine(now, hz);

  maybeEmitDeferred();
}
