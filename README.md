# Saddle Thermo (prototype)

Прототип измерения температуры “под седлом” на базе **DS18B20 + ESP32** с выводом в **локальное веб‑приложение** (тепловая карта 8L+8R). USB Serial **или** Wi‑Fi (TCP 3333).

## Что внутри

- `arduino/saddle_thermo/saddle_thermo.ino`: опрос DS18B20, авто‑дискавери адресов, калибровка (offset/scale), стрим JSON по Serial
- `web/`: Node.js сервер (Serial → WebSocket → браузер) + UI с тепловой картой

## Частоты по режимам

- **Шаг**: 2 Hz (в диапазоне 1–2 Hz)
- **Рысь**: 5 Hz (в диапазоне 4–5 Hz)
- **Галоп**: 10 Hz (в диапазоне 8–10 Hz)

## Arduino: команды по Serial

- `w` — walk (шаг)
- `t` — trot (рысь)
- `g` — gallop (галоп)
- `r` — rescan (пересканировать датчики)

## Запуск веб‑приложения

1) Установить зависимости:

```bash
cd web
npm install
```

2) Узнать путь к Serial‑порту Arduino и запустить сервер:

```bash
SERIAL_PATH=/dev/tty.usbserial-XXXX npm run dev
```

3) Открыть в браузере:

- `http://localhost:5177`

Если `SERIAL_PATH` не задан, откройте UI и подключитесь через выпадающий список (используется `GET /api/ports` + `POST /api/connect`).

## Удалённо по Wi‑Fi (ESP32 → TCP → этот сервер)

Прошивка `saddle_thermo.ino` дублирует тот же поток **JSON Lines**, что и по USB, в **TCP** (порт по умолчанию **3333**). Поддерживаются два режима, переключается флагом `WIFI_AP_MODE` в начале файла.

### Режим AP (по умолчанию) — открытая сеть, без пароля

ESP32 сама раздаёт Wi‑Fi `SaddleThermo` без пароля. Это удобно «в поле» — никакого роутера не нужно.

1. Прошить плату (`arduino-cli` команды ниже) — параметры по умолчанию: `WIFI_AP_MODE=true`, `WIFI_SSID="SaddleThermo"`.
2. Подключить ноут/телефон к Wi‑Fi `SaddleThermo`.
3. В шапке веб‑UI слева от кнопок управления есть поле **Wi‑Fi** и кнопка — введите `192.168.4.1:3333` и нажмите **Wi‑Fi**.
   Либо без UI: `curl -X POST http://localhost:5177/api/connect-tcp -H 'Content-Type: application/json' -d '{"host":"192.168.4.1","port":3333}'`.
4. На USB Serial при старте появится подтверждение: `WiFi AP "SaddleThermo" (open) TCP JSON bridge 192.168.4.1:3333`.

### Режим STA — подключиться к существующей сети

1. В `.ino` поставить `WIFI_AP_MODE = false` и заполнить `WIFI_SSID` / `WIFI_PASS`.
2. После заливки в USB Serial будет строка вида `WiFi TCP JSON bridge 192.168.x.x:3333`.
3. На компьютере (в той же сети) либо запустить сервер с переменными:

```bash
DEVICE_TCP_HOST=192.168.x.x DEVICE_TCP_PORT=3333 npm run dev
```

либо подключиться из веб‑UI по адресу платы.

Сервер слушает `0.0.0.0`, поэтому к веб‑интерфейсу можно зайти с другого устройства в LAN: `http://<ip-компьютера>:5177`.

**Bluetooth:** в коде есть **BluetoothSerial** (имя задаётся `BT_DEVICE_NAME`). Это классический SPP — пара как с обычным COM‑портом; те же команды `w/t/g/r` и те же JSON‑строки. На **ESP32‑S3 / C3** классического BT нет — оставьте `BT_DEVICE_NAME` пустым (по умолчанию). Для телефона без моста Node удобнее **Wi‑Fi + TCP**.

## Сборка и заливка прошивки

ESP32 DevKit V1 (USB‑UART CH340 → `/dev/cu.usbserial-*`):

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install OneWire DallasTemperature

arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" arduino/saddle_thermo
arduino-cli upload  --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app,UploadSpeed=460800" \
                    -p /dev/cu.usbserial-XX arduino/saddle_thermo
```

Партиция `huge_app` обязательна — стандартная (1.3 МБ под код) тесна из‑за BluetoothSerial. Скорость заливки `460800` стабильнее `921600` на дешёвых CH340 кабелях.

## Справочник слотов в редакторе

На странице `/layout-editor.html` таблица **«Справочник слотов»** показывает **id слота**, **метку позиции (1…8)**, **базовые X/Y** из `web/public/layout.json` и грубую **долю по длине** седла. Отдельно выводится **`interpolation.baselineC`** — это базовая температура для **алгоритма теплокарты**, а не «норма» конкретного физического слота.

## Калибровка

Пока калибровка задана в `CALIB_TABLE` внутри `saddle_thermo.ino` (по ROM‑адресу DS18B20).
Первый запуск выдаст `hello` с адресами — их можно перенести в таблицу и задать `offsetC/scale`.

