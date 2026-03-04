"use strict";

/**
 * @file pybricks.js
 * @description Поддержка хабов LEGO под управлением прошивки PyBricks.
 *
 * PyBricks-хабы используют собственный BLE-профиль и не совместимы со
 * стандартным протоколом node-poweredup. Этот модуль реализует:
 *   — автоматическое обнаружение PyBricks-хабов по UUID рекламируемого сервиса;
 *   — подключение и управление скоростью через запись в stdin-характеристику;
 *   — интерфейс, совместимый с объектами поезда в RampEngine / server.js.
 *
 * Протокол: команда `S<speed>\n` отправляется как stdin-ввод через характеристику
 * CMD_CHAR_UUID с префиксом CMD_WRITE_STDIN (0x06). Программа на хабе
 * должна читать stdin и устанавливать мощность мотора соответственно.
 *
 * Noble-инстанс получается через module cache — node-poweredup уже загрузил
 * @stoprocent/noble, поэтому конфликта двух BLE-стеков не возникает.
 */

/** UUID сервиса PyBricks (без дефисов, lowercase) */
const PYBRICKS_SVC_UUID = "c5f50001828046da89f46d8051e4aeef";

/** UUID характеристики для отправки команд (stdin) */
const CMD_CHAR_UUID = "c5f50003828046da89f46d8051e4aeef";

/** UUID характеристики для получения событий (stdout/stderr) */
const EVT_CHAR_UUID = "c5f50002828046da89f46d8051e4aeef";

/** Код операции записи в stdin (первый байт пакета) */
const CMD_WRITE_STDIN = 0x06;

/**
 * Возвращает экземпляр noble из module cache.
 *
 * node-poweredup v10+ использует @stoprocent/noble. Поскольку Node.js
 * кэширует модули, мы получаем тот же объект — без второго BLE-стека.
 * Перебираются несколько вариантов установки на случай разных версий
 * и вложенных node_modules.
 *
 * @returns {object|null} Экземпляр noble, или null если не найден.
 */
function getNoble() {
  const candidates = [
    "@stoprocent/noble", // node-poweredup v10+
    "node-poweredup/node_modules/@stoprocent/noble", // вложенная установка
    "@abandonware/noble", // node-poweredup v9 и ниже
    "node-poweredup/node_modules/@abandonware/noble",
  ];

  for (const pkg of candidates) {
    try {
      return require(pkg);
    } catch (_) {
      /* Пробуем следующий вариант */
    }
  }

  return null;
}

/**
 * Проверяет, является ли BLE-периферия хабом под управлением PyBricks.
 *
 * Проверка выполняется без подключения — только по UUID рекламируемых
 * сервисов. Это позволяет быстро фильтровать посторонние устройства.
 *
 * @param {object} peripheral - Noble peripheral object.
 * @returns {boolean} true, если устройство рекламирует PyBricks-сервис.
 */
function isPyBricksPeripheral(peripheral) {
  const uuids = (peripheral?.advertisement?.serviceUuids ?? []).map((u) =>
    u.replace(/-/g, "").toLowerCase(),
  );
  return uuids.includes(PYBRICKS_SVC_UUID);
}

/**
 * Обёртка над noble-peripheral для управления PyBricks-хабом.
 *
 * Реализует тот же интерфейс, что и хабы node-poweredup, используемые
 * в server.js и RampEngine:
 *   - поля: uuid, name, speed, connected, motor, hub
 *   - методы: connect(), setLEDColor(), disconnect()
 *
 * Управление скоростью: через `motor.setPower(speed)` / `motor.setSpeed(speed)`,
 * которые внутри вызывают `_sendSpeed()`.
 */
class PyBricksHub {
  /**
   * @param {object} peripheral - Noble peripheral, обнаруженный BLE-сканером.
   * @param {import("socket.io").Server} io - Socket.IO Server для трансляции событий.
   * @param {object} log - Экземпляр Logger.
   * @param {object} [cfg={}] - Запись из hub-config.json для этого хаба.
   * @param {string} [cfg.name]          - Отображаемое имя.
   * @param {number} [cfg.rampStepSize]  - Шаг рампа в % (по умолчанию 10).
   * @param {number} [cfg.rampStepMs]    - Интервал рампа в мс (по умолчанию 100).
   * @param {object} [cfg.sounds]        - Объект звуков {start, stop, horn, moving}.
   * @param {string} [cfg.photo]         - Путь к фото поезда.
   * @param {number[]} [cfg.presets]     - Пресеты скорости (по умолчанию [20, 50, 80]).
   */
  constructor(peripheral, io, log, cfg = {}) {
    this.peripheral = peripheral;
    this.io = io;
    this.log = log;

    // ── Поля, ожидаемые RampEngine и server.js ──────────────────────
    this.uuid = peripheral.id;
    this.name =
      cfg.name ||
      peripheral.advertisement?.localName ||
      `PB-${peripheral.id.slice(0, 6)}`;
    this.speed = 0;
    this.connected = false;
    this.motor = null; // Создаётся в connect() после подключения
    this.hub = this; // Self-reference для вызовов _setLED в RampEngine

    this.rampStepSize = cfg.rampStepSize || 10;
    this.rampStepMs = cfg.rampStepMs || 100;
    this.sounds = cfg.sounds || { start: "", stop: "", horn: "", moving: "" };
    this.photo = cfg.photo || null;
    this.presets = cfg.presets || [20, 50, 80];
    this.batteryLevel = null; // PyBricks не передаёт уровень батареи стандартно
    this.firmwareVersion = "PyBricks";
    this.hardwareVersion = "—";
    this.hubTypeName = "PyBricks Hub";
    this.deviceTypeName = "DCMotor";
    this.motorPort = "A";
    this.sensors = {};

    /** @private BLE-характеристика для отправки команд (устанавливается в connect) */
    this._cmdChar = null;
  }

  /**
   * Подключается к PyBricks-хабу по BLE.
   *
   * После подключения:
   *   1. Обнаруживаются все сервисы и характеристики.
   *   2. Находятся CMD (для отправки) и EVT (для получения событий) характеристики.
   *   3. Подписывается на EVT-характеристику для получения данных от хаба.
   *   4. Создаётся объект `motor` с методами setPower/setSpeed/brake.
   *
   * @throws {Error} Если CMD-характеристика не найдена (программа не запущена на хабе).
   */
  async connect() {
    // Подключаемся к BLE-устройству
    await new Promise((res, rej) =>
      this.peripheral.connect((e) => (e ? rej(e) : res())),
    );

    // Обнаруживаем все характеристики (сервисы нам не нужны напрямую)
    const chars = await new Promise((res, rej) =>
      this.peripheral.discoverAllServicesAndCharacteristics((e, _svcs, cs) =>
        e ? rej(e) : res(cs ?? []),
      ),
    );

    // Нормализуем UUID для сравнения (убираем дефисы, приводим к нижнему регистру)
    const norm = (u) => u.replace(/-/g, "").toLowerCase();

    this._cmdChar = chars.find((c) => norm(c.uuid) === CMD_CHAR_UUID);
    const evtChar = chars.find((c) => norm(c.uuid) === EVT_CHAR_UUID);

    if (!this._cmdChar) {
      throw new Error(
        "PyBricks command characteristic not found — убедитесь, что программа запущена на хабе",
      );
    }

    // Подписываемся на события от хаба (stdout/stderr PyBricks-программы)
    if (evtChar) {
      evtChar.subscribe();
      evtChar.on("data", (buf) => this._onEvent(buf));
    }

    // Создаём объект motor с унифицированным интерфейсом для RampEngine
    this.motor = {
      setPower: (spd) => this._sendSpeed(spd),
      setSpeed: (spd) => this._sendSpeed(spd),
      brake: () => this._sendSpeed(0),
    };

    this.connected = true;

    // Обрабатываем неожиданное отключение
    this.peripheral.once("disconnect", () => {
      this.log.warn(`PyBricks disconnected: ${this.name}`);
      this.connected = false;
      this.motor = null;
      this._cmdChar = null;
    });
  }

  /**
   * Отправляет команду скорости на хаб через BLE stdin-характеристику.
   *
   * Формат пакета: `[CMD_WRITE_STDIN] + ASCII("S{speed}\n")`
   * Скорость зажимается в диапазон [-100, 100].
   *
   * @private
   * @param {number} speed - Целевая скорость, от -100 до 100.
   */
  _sendSpeed(speed) {
    if (!this._cmdChar) return;

    const s = Math.max(-100, Math.min(100, Math.round(speed)));
    const data = Buffer.from(`S${s}\n`, "ascii");
    const msg = Buffer.concat([Buffer.from([CMD_WRITE_STDIN]), data]);

    this._cmdChar.write(msg, true, (err) => {
      if (err) this.log.warn(`PyBricks write error: ${err}`, this.uuid);
    });
  }

  /**
   * Заглушка для совместимости с интерфейсом node-poweredup хабов.
   * LED управляется программой PyBricks на самом хабе.
   *
   * @param {*} _color - Игнорируется.
   */
  setLEDColor(_color) {
    /* Управление LED выполняется кодом на хабе */
  }

  /**
   * Обрабатывает входящие данные от хаба (stdout/stderr PyBricks).
   * В данный момент просто логирует raw hex для диагностики.
   *
   * @private
   * @param {Buffer} buf - Входящий буфер данных.
   */
  _onEvent(buf) {
    this.log.info(`PyBricks event: ${buf.toString("hex")}`, this.uuid);
  }

  /**
   * Инициирует отключение от BLE-устройства.
   * Ошибки отключения игнорируются.
   */
  disconnect() {
    try {
      this.peripheral.disconnect();
    } catch (_) {
      /* Игнорируем ошибки при отключении */
    }
  }
}

module.exports = { PyBricksHub, isPyBricksPeripheral, getNoble };
