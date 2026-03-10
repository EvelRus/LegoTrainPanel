"use strict";

/**
 * @file pybricks.js
 * @description Поддержка хабов LEGO с прошивкой Pybricks (альтернативная прошивка).
 *
 * Pybricks-хабы используют собственный BLE-профиль и НЕ совместимы со стандартным
 * протоколом LEGO Powered Up (node-poweredup их не видит).
 *
 * Этот модуль реализует:
 *   - обнаружение Pybricks-хабов по UUID сервиса
 *   - подключение и отправку команд через характеристику stdin
 *   - получение событий (цвет, расстояние, логи) через stdout-подобную характеристику
 *   - совместимый интерфейс с объектами поезда в RampEngine и server.js
 *
 * Протокол связи:
 *   - Команда скорости:   запись в CMD_CHAR → [0x06] + "S{speed}\n" (ASCII)
 *   - Ответы хаба:        уведомления от EVT_CHAR → [тип] + UTF-8 текст
 *     Поддерживаемые строки:
 *       COLOR:<0-10>
 *       DIST:<мм>
 *       SPEED:<значение>
 *       LOG:<текст>
 *
 * Зависимости:
 *   Используется тот же noble, что и в node-poweredup (через module cache).
 */

const noble = require("@stoprocent/noble"); // или @abandonware/noble (зависит от версии)

/** UUID сервиса Pybricks (Pybricks Service) — без дефисов, lowercase */
const PYBRICKS_SVC_UUID = "c5f50001828046da89f46d8051e4aeef";

/** UUID характеристики для отправки команд (stdin) */
const CMD_CHAR_UUID = "c5f50003828046da89f46d8051e4aeef";

/** UUID характеристики для получения событий (stdout/stderr) */
const EVT_CHAR_UUID = "c5f50002828046da89f46d8051e4aeef";

/** Первый байт пакета при записи в stdin */
const CMD_WRITE_STDIN = 0x06;

/** Типы событий в уведомлениях EVT_CHAR */
const EVT_TYPE_STDOUT = 0x01;
const EVT_TYPE_STDERR = 0x02;
// const EVT_TYPE_STATUS = 0x03; // пока не используется

/** Словарь человекочитаемых названий цветов (совпадает с server.js) */
const COLOR_NAMES = {
  0: "Чёрный",
  1: "Розовый",
  2: "Фиолетовый",
  3: "Синий",
  4: "Голубой",
  5: "Бирюзовый",
  6: "Зелёный",
  7: "Жёлтый",
  8: "Оранжевый",
  9: "Красный",
  10: "Белый",
};

/**
 * Получает экземпляр noble из кэша модулей.
 *
 * node-poweredup уже импортирует @stoprocent/noble (или @abandonware/noble),
 * поэтому мы используем тот же экземпляр, чтобы не создавать второй BLE-стек.
 *
 * @returns {object|null} noble или null, если не удалось найти
 */
function getNoble() {
  const candidates = [
    "@stoprocent/noble",
    "node-poweredup/node_modules/@stoprocent/noble",
    "@abandonware/noble",
    "node-poweredup/node_modules/@abandonware/noble",
  ];

  for (const pkg of candidates) {
    try {
      return require(pkg);
    } catch (_) {}
  }

  return null;
}

/**
 * Проверяет, является ли периферийное устройство хабом под управлением Pybricks.
 * Смотрим на список рекламируемых сервисов (advertisement.serviceUuids).
 *
 * @param {Peripheral} peripheral - объект noble Peripheral
 * @returns {boolean}
 */
function isPyBricksPeripheral(peripheral) {
  const uuids = (peripheral?.advertisement?.serviceUuids ?? []).map((u) =>
    u.replace(/-/g, "").toLowerCase(),
  );
  return uuids.includes(PYBRICKS_SVC_UUID);
}

/**
 * Класс-обёртка над Pybricks-хабом.
 * Реализует интерфейс, совместимый с хабами node-poweredup:
 *   - поля: uuid, name, speed, connected, motor, hub, ...
 *   - методы: connect(), disconnect(), setLEDColor() (заглушка)
 *
 * Управление скоростью идёт через motor.setPower() / setSpeed() → _sendSpeed()
 */
class PyBricksHub {
  /**
   * @param {Peripheral} peripheral - объект noble
   * @param {SocketIO.Server} io - для отправки sensorUpdate, hubStatus и т.п.
   * @param {Logger} log - объект логгера
   * @param {Object} [cfg={}] - конфигурация из hub-config.json
   */
  constructor(peripheral, io, log, cfg = {}) {
    this.peripheral = peripheral;
    this.io = io;
    this.log = log;

    this.uuid = peripheral.id;
    this.name =
      cfg.name ||
      peripheral.advertisement?.localName ||
      `PB-${peripheral.id.slice(0, 6)}`;

    this.speed = 0;
    this.connected = false;
    this.motor = null; // будет создан после connect()
    this.hub = this; // для совместимости с train.hub

    // Переносим настройки из конфига (как у обычных хабов)
    this.rampStepSize = cfg.rampStepSize || 10;
    this.rampStepMs = cfg.rampStepMs || 100;
    this.sounds = cfg.sounds || { start: "", stop: "", horn: "", moving: "" };
    this.photo = cfg.photo || null;
    this.presets = cfg.presets || [20, 50, 80];

    this.batteryLevel = null;
    this.firmwareVersion = "PyBricks";
    this.hardwareVersion = "—";
    this.hubTypeName = "PyBricks Hub";
    this.deviceTypeName = "DCMotor"; // условно, т.к. Pybricks не сообщает тип
    this.motorPort = "A"; // жёстко, т.к. Pybricks-программа обычно использует A
    this.sensors = {}; // пока пусто (можно расширить)

    /** Характеристика для отправки команд */
    this._cmdChar = null;

    /** Буфер для неполных строк stdout от хаба */
    this._stdoutBuf = "";
  }

  /**
   * Подключается к Pybricks-хабу и настраивает характеристики.
   *
   * Шаги:
   *   1. peripheral.connect()
   *   2. discoverAllServicesAndCharacteristics()
   *   3. Находим CMD (write) и EVT (notify) характеристики
   *   4. Подписываемся на EVT для получения stdout/stderr
   *   5. Создаём совместимый объект motor
   *
   * @throws {Error} если не найдена характеристика команд
   */
  async connect() {
    // 1. Подключение к устройству
    await new Promise((resolve, reject) =>
      this.peripheral.connect((err) => (err ? reject(err) : resolve())),
    );

    // 2. Обнаружение всех сервисов и характеристик
    const characteristics = await new Promise((resolve, reject) =>
      this.peripheral.discoverAllServicesAndCharacteristics(
        (err, services, chars) => (err ? reject(err) : resolve(chars ?? [])),
      ),
    );

    const normalize = (uuid) => uuid.replace(/-/g, "").toLowerCase();

    this._cmdChar = characteristics.find(
      (c) => normalize(c.uuid) === CMD_CHAR_UUID,
    );
    const evtChar = characteristics.find(
      (c) => normalize(c.uuid) === EVT_CHAR_UUID,
    );

    if (!this._cmdChar) {
      throw new Error(
        "PyBricks command characteristic (stdin) not found. " +
          "Убедитесь, что программа на хабе запущена и использует Pybricks BLE.",
      );
    }

    // 3. Подписка на уведомления от хаба (stdout/stderr)
    if (evtChar) {
      evtChar.subscribe();
      evtChar.on("data", (buf) => this._onEvent(buf));
      this.log.info(
        `PyBricks EVT-характеристика подключена (${this.name})`,
        this.uuid,
      );
    } else {
      this.log.warn(
        `PyBricks: EVT-характеристика (stdout) не найдена`,
        this.uuid,
      );
    }

    // 4. Создаём совместимый объект motor
    this.motor = {
      setPower: (spd) => this._sendSpeed(spd),
      setSpeed: (spd) => this._sendSpeed(spd),
      brake: () => this._sendSpeed(0),
    };

    this.connected = true;

    // 5. Обработка отключения
    this.peripheral.once("disconnect", () => {
      this.log.warn(`PyBricks disconnected: ${this.name}`, this.uuid);
      this.connected = false;
      this.motor = null;
      this._cmdChar = null;
    });
  }

  /**
   * Отправляет команду скорости на хаб.
   * Формат: [0x06] + ASCII("S{speed}\n")
   *
   * @private
   * @param {number} speed - -100..+100
   */
  _sendSpeed(speed) {
    if (!this._cmdChar || !this.connected) return;

    const clamped = Math.max(-100, Math.min(100, Math.round(speed)));
    const payload = Buffer.from(`S${clamped}\n`, "ascii");
    const packet = Buffer.concat([Buffer.from([CMD_WRITE_STDIN]), payload]);

    this.log.info(`PyBricks → S${clamped}`, this.uuid);

    this._cmdChar.write(packet, true, (err) => {
      if (err) {
        this.log.warn(
          `PyBricks write error (S${clamped}): ${err.message}`,
          this.uuid,
        );
      }
    });
  }

  /**
   * Заглушка для LED — управление цветом LED хаба обычно реализовано
   * непосредственно в программе Pybricks на самом хабе.
   */
  setLEDColor(_color) {
    // LED управляется кодом на хабе
  }

  /**
   * Обрабатывает входящее уведомление от характеристики EVT_CHAR.
   * Первый байт — тип события (0x01=stdout, 0x02=stderr).
   * Остаток — UTF-8 текст. Буферизируем до \n.
   *
   * @private
   * @param {Buffer} buf - сырые данные уведомления
   */
  _onEvent(buf) {
    if (!buf || buf.length < 2) return;

    const evtType = buf[0];
    const text = buf.slice(1).toString("utf-8");

    if (evtType === EVT_TYPE_STDERR) {
      this.log.warn(`PyBricks stderr: ${text.trim()}`, this.uuid);
      return;
    }

    // stdout — накапливаем строки до \n
    this._stdoutBuf += text;
    const lines = this._stdoutBuf.split("\n");
    this._stdoutBuf = lines.pop() || ""; // остаток — неполная строка

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this._handleStdoutLine(trimmed);
    }
  }

  /**
   * Парсит и обрабатывает одну полную строку от Pybricks (stdout).
   *
   * Поддерживаемые форматы:
   *   COLOR:<0-10>
   *   DIST:<мм>
   *   SPEED:<значение>
   *   LOG:<произвольный текст>
   *
   * @private
   * @param {string} line - строка без \n
   */
  _handleStdoutLine(line) {
    const colonPos = line.indexOf(":");
    if (colonPos <= 0) {
      // Просто текст — логируем
      this.log.info(`PyBricks: ${line}`, this.uuid);
      return;
    }

    const key = line.slice(0, colonPos).toUpperCase();
    const value = line.slice(colonPos + 1).trim();

    switch (key) {
      case "COLOR": {
        const code = parseInt(value, 10);
        if (isNaN(code) || code < 0 || code > 10) return;

        const name = COLOR_NAMES[code] ?? `код ${code}`;
        this.log.info(
          `📡 PyBricks сенсор: цвет = ${name} (${code})`,
          this.uuid,
        );

        this.io.emit("sensorUpdate", {
          trainId: this.uuid,
          port: "B", // жёстко — стандартный порт в большинстве Pybricks-программ
          type: "color",
          color: code,
          colorName: name,
        });
        break;
      }

      case "DIST": {
        const mm = parseInt(value, 10);
        if (isNaN(mm)) return;

        this.log.info(`📡 PyBricks сенсор: расстояние = ${mm} мм`, this.uuid);

        this.io.emit("sensorUpdate", {
          trainId: this.uuid,
          port: "B",
          type: "distance",
          distance: mm,
        });
        break;
      }

      case "SPEED": {
        const spd = parseInt(value, 10);
        if (isNaN(spd)) return;
        this.log.info(
          `PyBricks мотор: фактическая скорость = ${spd}%`,
          this.uuid,
        );
        // Можно обновить this.speed, если программа возвращает реальное значение
        break;
      }

      case "LOG":
        this.log.info(`PyBricks log: ${value}`, this.uuid);
        break;

      default:
        this.log.info(
          `PyBricks неизвестный ключ "${key}": ${value}`,
          this.uuid,
        );
    }
  }

  /**
   * Инициирует отключение от устройства.
   */
  disconnect() {
    try {
      this.peripheral.disconnect();
    } catch (_) {
      // silent fail
    }
  }
}

module.exports = {
  PyBricksHub,
  isPyBricksPeripheral,
  getNoble,
};
