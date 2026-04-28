# Saddle Thermo (prototype)

Прототип измерения температуры “под седлом” на базе **DS18B20 + Arduino Nano** с выводом в **локальное веб‑приложение** (тепловая карта 8L+8R).

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

## Калибровка

Пока калибровка задана в `CALIB_TABLE` внутри `saddle_thermo.ino` (по ROM‑адресу DS18B20).
Первый запуск выдаст `hello` с адресами — их можно перенести в таблицу и задать `offsetC/scale`.

