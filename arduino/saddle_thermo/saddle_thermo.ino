/**
 * DS18B20 multi-sensor reader for horse-saddle thermal mat prototype.
 *
 * - Auto-discovers sensor ROM addresses on startup (and can rescan on command)
 * - Applies per-sensor calibration (offset + scale)
 * - Streams readings over Serial as JSON Lines (one line per sample)
 *
 * Wiring (typical):
 *  - DS18B20 DQ -> D2 (change ONE_WIRE_BUS if needed)
 *  - 4.7k pull-up from DQ to +5V
 *  - GND/GND, VDD/+5V (or parasitic power if you know what you're doing)
 */
 
#include <OneWire.h>
#include <DallasTemperature.h>

// ===== Hardware config =====
static const uint8_t ONE_WIRE_BUS = 2;   // Arduino Nano D2
static const uint32_t SERIAL_BAUD = 115200;

// ===== Sampling modes =====
enum GaitMode : uint8_t {
  MODE_WALK = 0,   // 1–2 Hz
  MODE_TROT = 1,   // 4–5 Hz
  MODE_GALLOP = 2  // 8–10 Hz
};

struct ModeCfg {
  uint8_t hz;               // target sample rate
  uint16_t periodMs() const { return (uint16_t)(1000U / (uint16_t)hz); }
};

static ModeCfg MODE_CFGS[] = {
  {2},   // walk: use 2 Hz as default within 1–2 Hz
  {5},   // trot: 5 Hz within 4–5 Hz
  {10}   // gallop: 10 Hz within 8–10 Hz
};

// ===== DS18B20 handling =====
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

static const uint8_t MAX_SENSORS = 16; // target later: 8 left + 8 right

struct SensorSlot {
  DeviceAddress addr;
  bool present = false;
  float offsetC = 0.0f;     // calibration: add after scaling
  float scale = 1.0f;       // calibration: multiply raw value
};

static SensorSlot slots[MAX_SENSORS];
static uint8_t sensorCount = 0;

// Simple address->calibration mapping.
// If you later want persistent calibration, store it in EEPROM and provide a command to set it.
struct CalibEntry {
  DeviceAddress addr;
  float offsetC;
  float scale;
};

// Example placeholder calibration table (empty by default).
// You can fill this with known addresses after first discovery.
static const CalibEntry CALIB_TABLE[] = {
  // {{0x28, 0xFF, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01}, 0.20f, 1.00f},
};
static const uint8_t CALIB_TABLE_LEN = sizeof(CALIB_TABLE) / sizeof(CALIB_TABLE[0]);

static GaitMode gaitMode = MODE_WALK;
static uint8_t customHz = 0; // 0 => use gait default
static uint32_t nextSampleAtMs = 0;
static uint32_t seqNo = 0;

static char cmdBuf[24];
static uint8_t cmdLen = 0;

static bool conversionInFlight = false;
static uint32_t conversionReadyAtMs = 0;
static uint8_t dsResolutionBits = 10;
static uint32_t lastAutoRescanAtMs = 0;

static uint8_t currentHz() {
  return customHz ? customHz : MODE_CFGS[(uint8_t)gaitMode].hz;
}

static uint8_t resolutionForHz(uint8_t hz) {
  // DS18B20 typical conversion time:
  // 12-bit: 750ms, 11-bit: 375ms, 10-bit: 188ms, 9-bit: 94ms
  // Choose lower resolution for higher sample rates.
  if (hz >= 9) return 9;   // enables ~10Hz+
  if (hz >= 5) return 10;  // ~5Hz
  return 11;
}

static uint16_t conversionMsForResolution(uint8_t resBits) {
  switch (resBits) {
    case 9: return 95;
    case 10: return 190;
    case 11: return 380;
    default: return 760; // 12
  }
}

static void updateDsResolution() {
  const uint8_t want = resolutionForHz(currentHz());
  if (want == dsResolutionBits) return;
  dsResolutionBits = want;
  sensors.setResolution(dsResolutionBits);
}

static void printAddressHex(const DeviceAddress addr) {
  for (uint8_t i = 0; i < 8; i++) {
    if (addr[i] < 16) Serial.print('0');
    Serial.print(addr[i], HEX);
  }
}

static void copyAddress(DeviceAddress dst, const DeviceAddress src) {
  for (uint8_t i = 0; i < 8; i++) dst[i] = src[i];
}

static bool addressEquals(const DeviceAddress a, const DeviceAddress b) {
  for (uint8_t i = 0; i < 8; i++) if (a[i] != b[i]) return false;
  return true;
}

static void applyCalibrationForSlot(SensorSlot &slot) {
  slot.offsetC = 0.0f;
  slot.scale = 1.0f;
  for (uint8_t i = 0; i < CALIB_TABLE_LEN; i++) {
    if (addressEquals(slot.addr, CALIB_TABLE[i].addr)) {
      slot.offsetC = CALIB_TABLE[i].offsetC;
      slot.scale = CALIB_TABLE[i].scale;
      return;
    }
  }
}

static void clearSlots() {
  sensorCount = 0;
  for (uint8_t i = 0; i < MAX_SENSORS; i++) {
    slots[i].present = false;
    slots[i].offsetC = 0.0f;
    slots[i].scale = 1.0f;
  }
}

static uint8_t discoverSensors() {
  clearSlots();

  const uint8_t found = sensors.getDeviceCount();
  uint8_t added = 0;
  DeviceAddress addr;
  for (uint8_t i = 0; i < found && added < MAX_SENSORS; i++) {
    if (!sensors.getAddress(addr, i)) continue;
    copyAddress(slots[added].addr, addr);
    slots[added].present = true;
    applyCalibrationForSlot(slots[added]);
    added++;
  }
  sensorCount = added;
  return added;
}

static void emitHello() {
  Serial.print("{\"type\":\"hello\",\"fw\":\"saddle_thermo\",\"maxSensors\":");
  Serial.print(MAX_SENSORS);
  Serial.print(",\"oneWireBus\":");
  Serial.print(ONE_WIRE_BUS);
  Serial.print(",\"mode\":\"");
  Serial.print((gaitMode == MODE_WALK) ? "walk" : (gaitMode == MODE_TROT) ? "trot" : "gallop");
  Serial.print("\",\"hz\":");
  Serial.print(customHz ? customHz : MODE_CFGS[(uint8_t)gaitMode].hz);
  Serial.print(",\"sensors\":[");
  for (uint8_t i = 0; i < sensorCount; i++) {
    if (i) Serial.print(',');
    Serial.print("{\"idx\":");
    Serial.print(i);
    Serial.print(",\"addr\":\"");
    printAddressHex(slots[i].addr);
    Serial.print("\",\"offsetC\":");
    Serial.print(slots[i].offsetC, 3);
    Serial.print(",\"scale\":");
    Serial.print(slots[i].scale, 6);
    Serial.print('}');
  }
  Serial.println("]}");
}

static void setModeByChar(char c) {
  if (c == 'w') gaitMode = MODE_WALK;
  else if (c == 't') gaitMode = MODE_TROT;
  else if (c == 'g') gaitMode = MODE_GALLOP;
  customHz = 0; // switching gait resets custom hz
  conversionInFlight = false;
  nextSampleAtMs = 0; // reschedule immediately
}

static void setCustomHz(uint8_t hz) {
  if (hz < 1) hz = 1;
  if (hz > 25) hz = 25;
  customHz = hz;
  conversionInFlight = false;
  nextSampleAtMs = 0;
}

static void handleCommandLine(const char *s) {
  if (!s || !s[0]) return;
  // support: hz=7
  if ((s[0] == 'h' || s[0] == 'H') && (s[1] == 'z' || s[1] == 'Z') && s[2] == '=') {
    int v = atoi(s + 3);
    if (v > 0) {
      setCustomHz((uint8_t)v);
      emitHello();
    }
    return;
  }
}

static void handleSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      cmdBuf[cmdLen] = 0;
      handleCommandLine(cmdBuf);
      cmdLen = 0;
      continue;
    }

    if (c == 'r') { // rescan
      discoverSensors();
      emitHello();
    } else if (c == 'w' || c == 't' || c == 'g') {
      setModeByChar(c);
      emitHello();
    } else {
      // accumulate into line buffer for multi-char commands
      if (cmdLen < sizeof(cmdBuf) - 1) {
        cmdBuf[cmdLen++] = c;
      }
    }
  }
}

static void sampleOnce() {
  // Read values after a completed conversion (conversion is requested in loop()).

  Serial.print("{\"type\":\"sample\",\"seq\":");
  Serial.print(seqNo++);
  Serial.print(",\"ms\":");
  Serial.print(millis());
  Serial.print(",\"mode\":\"");
  Serial.print((gaitMode == MODE_WALK) ? "walk" : (gaitMode == MODE_TROT) ? "trot" : "gallop");
  Serial.print("\",\"hz\":");
  Serial.print(currentHz());
  Serial.print(",\"values\":[");

  uint8_t disconnected = 0;
  for (uint8_t i = 0; i < sensorCount; i++) {
    if (i) Serial.print(',');
    float raw = sensors.getTempC(slots[i].addr);
    // DallasTemperature returns DEVICE_DISCONNECTED_C (-127) when missing
    bool ok = (raw > -100.0f && raw < 150.0f);
    if (!ok) disconnected++;
    float cal = ok ? (raw * slots[i].scale + slots[i].offsetC) : raw;

    Serial.print("{\"idx\":");
    Serial.print(i);
    Serial.print(",\"addr\":\"");
    printAddressHex(slots[i].addr);
    Serial.print("\",\"rawC\":");
    Serial.print(raw, 3);
    Serial.print(",\"calC\":");
    Serial.print(cal, 3);
    Serial.print(",\"ok\":");
    Serial.print(ok ? "true" : "false");
    Serial.print('}');
  }

  Serial.println("]}");

  // If sensors were unplugged/replugged, refresh the address list automatically.
  const uint32_t now = millis();
  if (disconnected > 0 && (now - lastAutoRescanAtMs) > 2000) {
    lastAutoRescanAtMs = now;
    discoverSensors();
    emitHello();
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  // Small delay to allow serial monitor to attach on some hosts
  delay(300);

  sensors.begin();
  sensors.setResolution(dsResolutionBits);
  sensors.setWaitForConversion(false); // async conversions

  discoverSensors();
  emitHello();
}

void loop() {
  handleSerialCommands();

  const uint32_t now = millis();

  updateDsResolution();
  const uint16_t convMs = conversionMsForResolution(dsResolutionBits);

  if (!conversionInFlight) {
    sensors.requestTemperatures();
    conversionInFlight = true;
    conversionReadyAtMs = now + convMs;
  }

  if (conversionInFlight && (int32_t)(now - conversionReadyAtMs) >= 0) {
    sampleOnce();
    conversionInFlight = false; // next loop will request next conversion
  }
}

