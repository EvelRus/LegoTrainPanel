"use strict";

// ─────────────────────────────────────────────────────────────────────────────
//  Зависимости и импорты
// ─────────────────────────────────────────────────────────────────────────────

const PoweredUP = require("node-poweredup");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const Logger = require("./lib/logger");
const RampEngine = require("./lib/ramp");
const Scheduler = require("./lib/scheduler");
const {
  PyBricksHub,
  isPyBricksPeripheral,
  getNoble,
} = require("./lib/pybricks");

// ─────────────────────────────────────────────────────────────────────────────
//  Константы путей
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "hub-config.json");
const DATA_DIR = path.join(__dirname, "data");
const LOGS_DIR = path.join(DATA_DIR, "logs");

// Создаём необходимые директории, если их ещё нет
[DATA_DIR, LOGS_DIR, PUBLIC_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Вспомогательные утилиты
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Читает версии зависимостей из package.json
 * @returns {Object} объект с версиями node-poweredup и socket.io
 */
function readPkgVersions() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"),
    );
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const ver = (k) => (deps[k] || "").replace(/[^0-9.]/g, "") || "—";
    return { poweredUp: ver("node-poweredup"), socketIO: ver("socket.io") };
  } catch (_) {
    return { poweredUp: "—", socketIO: "—" };
  }
}

const pkgVer = readPkgVersions();

// ─────────────────────────────────────────────────────────────────────────────
//  Инициализация веб-сервера и Socket.IO
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());

// Глобальные сервисы
const log = new Logger(LOGS_DIR);
const trains = {}; // Хранилище всех обнаруженных и подключённых поездов
const ramp = new RampEngine(trains, io, log, true);
log.attach(io);
const sched = new Scheduler(DATA_DIR, ramp, log, io);

// ─────────────────────────────────────────────────────────────────────────────
//  Работа с конфигурацией хабов
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    log.warn(`hub-config.json parse error: ${e.message}`);
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

let hubConfig = loadConfig();

// Словарь соответствия кодов цветов LEGO → русские названия
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
 * Формирует объект с информацией о занятых портах хаба
 * @param {Object} train - объект поезда
 * @returns {Object} { A: {...}, B: {...}, ... }
 */
function buildPortsInfo(train) {
  const ports = { A: null, B: null, C: null, D: null };
  if (train.motorPort && train.motorPort !== "?") {
    ports[train.motorPort] = {
      type: "motor",
      name: train.deviceTypeName || "Motor",
    };
  }
  for (const [port, info] of Object.entries(train.sensors || {})) {
    if (ports[port] === null) {
      ports[port] = { type: "sensor", name: info.typeName || "Sensor" };
    }
  }
  return ports;
}

/**
 * Формирует payload для отправки клиенту по событию newTrain / обновления
 * @param {string} id - идентификатор поезда (обычно uuid)
 * @returns {Object|null}
 */
function trainPayload(id) {
  const t = trains[id];
  if (!t) return null;
  return {
    id,
    name: t.name,
    speed: t.speed,
    sounds: t.sounds,
    photo: t.photo,
    connected: t.connected,
    battery: t.batteryLevel,
    firmwareVersion: t.firmwareVersion,
    hardwareVersion: t.hardwareVersion,
    hubTypeName: t.hubTypeName,
    deviceTypeName: t.deviceTypeName,
    motorPort: t.motorPort,
    rampStepSize: t.rampStepSize,
    rampStepMs: t.rampStepMs,
    presets: t.presets,
    sensors: t.sensors || {},
    ports: buildPortsInfo(t),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP API
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/info", (_req, res) =>
  res.json({
    ...pkgVer,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
  }),
);

app.get("/api/config", (_req, res) => res.json(loadConfig()));

app.post("/api/config", (req, res) => {
  try {
    hubConfig = req.body;
    saveConfig(hubConfig);

    // Применяем изменённые настройки ко всем уже подключённым поездам
    for (const train of Object.values(trains)) {
      const cfg = hubConfig[train.uuid] || {};
      if (cfg.name) train.name = cfg.name;
      if (cfg.sounds) train.sounds = cfg.sounds;
      if (cfg.photo !== undefined) train.photo = cfg.photo;
      if (cfg.rampStepSize) train.rampStepSize = cfg.rampStepSize;
      if (cfg.rampStepMs) train.rampStepMs = cfg.rampStepMs;
      if (cfg.presets) train.presets = cfg.presets;
    }

    log.info("Config saved from browser");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/logs", (_req, res) =>
  res.json(log.getLast(parseInt(_req?.query?.n) || 200)),
);
app.get("/api/logs/files", (_req, res) => res.json(log.listLogFiles()));
app.get("/api/logs/file", (req, res) => {
  const content = log.readLogFile(req.query.name || "");
  if (!content) return res.status(404).json({ error: "Not found" });
  res.type("text/plain; charset=utf-8").send(content);
});

app.get("/api/scenarios", (_req, res) => res.json(sched.scenarios));
app.get("/api/schedules", (_req, res) => res.json(sched.schedules));
app.get("/api/consists", (_req, res) => res.json(sched.consists));

/**
 * Просмотр содержимого публичной директории (для медиа-файлов)
 */
app.get("/api/browse", (req, res) => {
  const rel = (req.query.path || "").replace(/\.\./g, "");
  const dir = path.join(PUBLIC_DIR, rel);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    return res.json({ dirs: [], files: [] });

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  res.json({
    dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name),
    files: entries
      .filter(
        (e) =>
          e.isFile() &&
          /\.(mp3|wav|ogg|webm|jpg|jpeg|png|webp|gif)$/i.test(e.name),
      )
      .map((e) => e.name),
    current: rel,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Обработка обнаружения и подключения LEGO Powered Up хабов
// ─────────────────────────────────────────────────────────────────────────────

const poweredUP = new PoweredUP.PoweredUP();

/**
 * Основная логика подключения стандартного Powered Up хаба
 * @param {Hub} hub - объект хаба из node-poweredup
 */
async function connectHub(hub) {
  if (hub.peripheral && isPyBricksPeripheral(hub.peripheral)) {
    log.info(`Skipping PyBricks hub in standard flow: ${hub.uuid}`);
    return;
  }

  const uuid = hub.uuid || hub.address || null;

  if (uuid && trains[uuid]?.connected) {
    log.info(`Already connected, skip duplicate: ${uuid.slice(0, 8)}`);
    return;
  }

  const defaultName = hub.name || `Train-${Object.keys(trains).length + 1}`;
  hubConfig = loadConfig();

  // Регистрируем новый хаб в конфиге, если его там ещё нет
  if (uuid && !hubConfig[uuid]) {
    hubConfig[uuid] = {
      name: defaultName,
      photo: "",
      sounds: { start: "", stop: "", horn: "", moving: "" },
      rampStepSize: 10,
      rampStepMs: 100,
      presets: [20, 50, 80],
    };
    saveConfig(hubConfig);
    log.info(`New hub registered: ${uuid}`);
  }

  const cfg = (uuid && hubConfig[uuid]) || {};
  const friendlyName = cfg.name || defaultName;
  log.info(`Discovered: ${friendlyName} [${uuid ?? "—"}]`);

  try {
    await hub.connect();

    // Собираем базовую информацию об устройстве
    const firmwareVersion = hub.firmwareVersion || "—";
    const hardwareVersion = hub.hardwareVersion || "—";
    const hubTypeName = hub.constructor?.name || "Hub";
    const batteryLevel =
      typeof hub.batteryLevel === "number" ? hub.batteryLevel : null;

    log.info(
      `${friendlyName}: fw=${firmwareVersion} hw=${hardwareVersion} bat=${batteryLevel ?? "—"}%`,
    );

    let motor = null,
      motorPort = null,
      deviceTypeName = "—";
    const sensors = {};

    // Пытаемся найти устройства на портах A–D с таймаутом
    const portResults = await Promise.allSettled(
      ["A", "B", "C", "D"].map((port) =>
        Promise.race([
          hub.waitForDeviceAtPort(port),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), 4500),
          ),
        ]).then((device) => ({ port, device })),
      ),
    );

    // Обрабатываем найденные устройства
    for (const result of portResults) {
      if (result.status !== "fulfilled") continue;
      const { port, device } = result.value;
      const typeName = device.constructor?.name || "Device";
      const lc = typeName.toLowerCase();
      log.info(`${friendlyName} — port ${port}: ${typeName}`);

      if (!motor && lc.includes("motor")) {
        motor = device;
        motorPort = port;
        deviceTypeName = typeName;
      } else if (lc.includes("color") || lc.includes("distance")) {
        sensors[port] = { typeName };
        const tid = uuid;

        // Обработка событий от датчиков цвета/расстояния
        device.on("colorAndDistance", ({ color, distance }) => {
          if (!trains[tid]) return;
          const colorName = COLOR_NAMES[color] ?? "?";
          log.info(
            `📡 Сенсор [${port}]: 🎨 ${colorName} (${color}), расст = ${distance} мм`,
            tid,
          );
          io.emit("sensorUpdate", {
            trainId: tid,
            port,
            type: "colorAndDistance",
            color,
            distance,
            colorName,
          });
          sched.onSensorColor(tid, port, color);
        });

        device.on("color", ({ color }) => {
          const colorName = COLOR_NAMES[color] ?? "?";
          io.emit("sensorUpdate", {
            trainId: uuid,
            port,
            type: "color",
            color,
            colorName,
          });
          sched.onSensorColor(uuid, port, color);
        });

        device.on("distance", ({ distance }) =>
          io.emit("sensorUpdate", {
            trainId: uuid,
            port,
            type: "distance",
            distance,
          }),
        );

        // Явная подписка на режим COLOR_AND_DISTANCE (режим 8)
        (async () => {
          try {
            if (typeof device._parse !== "function") {
              log.warn(
                `📡 Сенсор [${port}]: _parse недоступен — только event-fallback`,
                uuid,
              );
            }
            if (typeof device.subscribe === "function") {
              await device.subscribe(8);
              log.info(
                `📡 Сенсор [${port}]: subscribe(8) → COLOR_AND_DISTANCE ✓`,
                uuid,
              );
            } else {
              device.requestUpdate?.();
            }
          } catch (e) {
            log.warn(`📡 Сенсор [${port}]: subscribe err — ${e.message}`, uuid);
            try {
              device.requestUpdate?.();
            } catch (_) {}
          }
        })();
      }
    }

    // Fallback: ищем мотор по типу, если не нашли по портам
    if (!motor) {
      const Consts = require("node-poweredup").Consts;
      for (const mt of [
        Consts.DeviceType.TRAIN_MOTOR,
        Consts.DeviceType.LARGE_MOTOR,
        Consts.DeviceType.XLARGE_MOTOR,
        Consts.DeviceType.MEDIUM_MOTOR,
        Consts.DeviceType.TECHNIC_LARGE_MOTOR,
        Consts.DeviceType.TECHNIC_XLARGE_MOTOR,
      ]) {
        try {
          const devs = hub.getDevicesByType(mt);
          if (devs?.length) {
            motor = devs[0];
            motorPort = "?";
            deviceTypeName = motor.constructor?.name || "Motor";
            break;
          }
        } catch (_) {}
      }
    }

    if (!motor) {
      log.warn(`${friendlyName}: no motor found`);
      return;
    }

    // Небольшая пауза перед управлением мотором (стабилизация соединения)
    await new Promise((r) => setTimeout(r, 300));

    // Диагностика доступных методов мотора
    try {
      const allMethods = new Set();
      let p = motor;
      while (p && p !== Object.prototype) {
        Object.getOwnPropertyNames(p)
          .filter((n) => n !== "constructor" && typeof motor[n] === "function")
          .forEach((n) => allMethods.add(n));
        p = Object.getPrototypeOf(p);
      }
      const hasBrake = allMethods.has("brake");
      const hasPower = allMethods.has("setPower");
      const hasSpeed = allMethods.has("setSpeed");
      log.info(
        `Motor API: brake=${hasBrake} setPower=${hasPower} setSpeed=${hasSpeed}` +
          ` | all=[${[...allMethods].join(", ")}]`,
        uuid,
      );

      // Принудительно останавливаем мотор при старте (лучше brake, чем float)
      if (hasBrake) {
        try {
          motor.brake();
        } catch (_) {}
      } else if (hasPower) {
        try {
          motor.setPower(0);
        } catch (_) {}
      }
    } catch (_) {}

    const trainId = uuid || defaultName.replace(/\s+/g, "-");

    // Очищаем предыдущее состояние ramp при переподключении
    ramp.resetStopState(trainId);
    ramp.stopKeepalive(trainId);
    ramp.clearRamp(trainId);
    const prevSpd = trains[trainId]?.speed ?? 0;

    trains[trainId] = {
      hub,
      motor,
      motorPort,
      deviceTypeName,
      sensors,
      speed: prevSpd,
      name: friendlyName,
      uuid,
      sounds: cfg.sounds || {},
      photo: cfg.photo || null,
      rampStepSize: cfg.rampStepSize || 10,
      rampStepMs: cfg.rampStepMs || 100,
      presets: cfg.presets || [20, 50, 80],
      firmwareVersion,
      hardwareVersion,
      hubTypeName,
      batteryLevel,
      connected: true,
    };

    ramp.startKeepalive(trainId);
    ramp._setLED(trains[trainId]);

    // Обработка изменения уровня заряда
    let _lastBatEmit = -1,
      _lastBatLogTime = 0,
      _lastBatLogLvl = -1;

    hub.on("batteryLevel", ({ batteryLevel: lvl }) => {
      if (trains[trainId]) trains[trainId].batteryLevel = lvl;
      if (lvl !== _lastBatEmit) {
        _lastBatEmit = lvl;
        io.emit("hubStatus", {
          id: trainId,
          battery: lvl,
          lowBattery: lvl <= 15,
        });
      }
      const now = Date.now();
      if (
        now - _lastBatLogTime > 60_000 ||
        Math.abs(lvl - _lastBatLogLvl) >= 5 ||
        lvl <= 15
      ) {
        _lastBatLogTime = now;
        _lastBatLogLvl = lvl;
        log.info(`Battery: ${lvl}%${lvl <= 15 ? " ⚠ LOW" : ""}`, trainId);
      }
    });

    // Кнопка хаба → сигнал гудка
    hub.on("button", (...args) => {
      const second = args[1];
      const first = args[0];
      const state = second ?? first?.state ?? first?.event ?? first;
      if (state === 2 || state === 1 || state === "pressed" || state === true) {
        io.emit("playHorn", { trainId });
      }
    });

    hub.on("error", (err) => {
      log.error(`Hub error: ${err?.message ?? err}`, trainId);
    });

    io.emit("newTrain", trainPayload(trainId));
    log.event(`Ready: "${friendlyName}" [${trainId}]`);

    hub.on("disconnect", () => {
      log.warn(`Disconnected: ${friendlyName}`, trainId);
      ramp.clearRamp(trainId);
      ramp.stopKeepalive(trainId);
      sched.stopAllScenarios();
      if (trains[trainId]) {
        trains[trainId].connected = false;
        trains[trainId].motor = null;
      }
      io.emit("hubStatus", { id: trainId, connected: false });
      setTimeout(() => {
        try {
          poweredUP.scan();
        } catch (_) {}
      }, 3000);
    });
  } catch (err) {
    log.error(`Hub error ${friendlyName}: ${err.message}`);
  }
}

/**
 * Подключение PyBricks-хаба (альтернативная прошивка)
 * @param {Peripheral} peripheral - объект noble peripheral
 */
async function connectPyBricksHub(peripheral) {
  const uuid = peripheral.id;
  if (trains[uuid]?.connected) return;

  hubConfig = loadConfig();
  const defaultName =
    peripheral.advertisement?.localName || `PB-${uuid.slice(0, 6)}`;

  if (!hubConfig[uuid]) {
    hubConfig[uuid] = {
      name: defaultName,
      photo: "",
      sounds: { start: "", stop: "", horn: "", moving: "" },
      rampStepSize: 10,
      rampStepMs: 100,
      presets: [20, 50, 80],
      pybricksMode: true,
    };
    saveConfig(hubConfig);
    log.info(`New PyBricks hub registered: ${uuid}`);
  }

  const cfg = hubConfig[uuid] || {};
  const pb = new PyBricksHub(peripheral, io, log, cfg);
  log.info(`PyBricks hub discovered: ${pb.name} [${uuid}]`);

  try {
    await pb.connect();
    const prevSpd = trains[uuid]?.speed ?? 0;

    ramp.resetStopState(uuid);

    trains[uuid] = {
      hub: pb,
      motor: pb.motor,
      motorPort: pb.motorPort,
      deviceTypeName: pb.deviceTypeName,
      sensors: {},
      speed: prevSpd,
      name: pb.name,
      uuid,
      sounds: cfg.sounds || {},
      photo: cfg.photo || null,
      rampStepSize: cfg.rampStepSize || 10,
      rampStepMs: cfg.rampStepMs || 100,
      presets: cfg.presets || [20, 50, 80],
      firmwareVersion: "PyBricks",
      hardwareVersion: "—",
      hubTypeName: "PyBricks Hub",
      batteryLevel: null,
      connected: true,
    };

    ramp.startKeepalive(uuid);
    io.emit("newTrain", trainPayload(uuid));
    log.event(`PyBricks ready: "${pb.name}" [${uuid}]`);

    peripheral.once("disconnect", () => {
      log.warn(`PyBricks disconnected: ${pb.name}`, uuid);
      ramp.clearRamp(uuid);
      ramp.stopKeepalive(uuid);
      if (trains[uuid]) {
        trains[uuid].connected = false;
        trains[uuid].motor = null;
      }
      io.emit("hubStatus", { id: uuid, connected: false });
      setTimeout(() => {
        try {
          poweredUP.scan();
        } catch (_) {}
      }, 3000);
    });
  } catch (err) {
    log.error(`PyBricks connect error ${pb.name}: ${err.message}`);
  }
}

poweredUP.on("discover", connectHub);
poweredUP.scan();
log.info(
  `🔍 Bluetooth scan started  node-poweredup v${pkgVer.poweredUp}  socket.io v${pkgVer.socketIO}`,
);

/**
 * Запуск отдельного сканера для PyBricks через noble
 */
function attachPyBricksScanner() {
  const noble = getNoble();
  if (!noble) {
    log.warn("PyBricks: @stoprocent/noble не найден");
    return;
  }
  noble.on("discover", (peripheral) => {
    if (isPyBricksPeripheral(peripheral)) {
      log.info(
        `PyBricks detected: ${peripheral.advertisement?.localName || peripheral.id}`,
      );
      connectPyBricksHub(peripheral);
    }
  });
}
attachPyBricksScanner();

// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO — взаимодействие с веб-интерфейсом
// ─────────────────────────────────────────────────────────────────────────────

const connectedClients = new Set();

io.on("connection", (socket) => {
  connectedClients.add(socket.id);
  log.info(`Browser ↑ ${socket.id} (active: ${connectedClients.size})`);

  // Отправляем текущее состояние новому клиенту
  for (const id of Object.keys(trains)) {
    const p = trainPayload(id);
    if (p) socket.emit("newTrain", p);
  }
  socket.emit("logs", log.getLast(200));
  socket.emit("scenariosUpdate", sched.scenarios);
  socket.emit("schedulesUpdate", sched.schedules);
  socket.emit("consistsUpdate", sched.consists);

  socket.on("setSpeed", ({ trainId, speed, source }) => {
    const train = trains[trainId];
    if (!train?.connected || !train?.motor) {
      socket.emit("hubStatus", { id: trainId, connected: false });
      return;
    }
    const clamped = Math.max(-100, Math.min(100, Math.round(speed)));
    const src = source || "user";
    if (clamped === train.speed) return;

    log.info(`[${src}] setSpeed: ${clamped}`, trainId);

    if (sched.isRecording()) sched.recordStep(trainId, clamped);

    if (clamped === 0) ramp.stopNow(trainId, src);
    else ramp.rampTo(trainId, clamped, src);

    sched.onTrainSpeedChange(trainId, clamped);
  });

  socket.on("estop", () => {
    log.info("[user:estop] E-STOP");
    sched.stopAllScenarios();
    for (const id of Object.keys(trains)) ramp.stopNow(id, "user:estop");
  });

  socket.on("saveConsist", ({ id, consist }) => sched.saveConsist(id, consist));
  socket.on("deleteConsist", ({ id }) => sched.deleteConsist(id));
  socket.on("setConsistSpeed", ({ consistId, speed }) =>
    sched.setConsistSpeed(consistId, speed),
  );

  socket.on("startRecording", ({ name }) => sched.startRecording(name));
  socket.on("stopRecording", () => sched.stopRecording());

  socket.on("playScenario", ({ name, loops }) =>
    sched.playScenario(name, loops),
  );
  socket.on("stopScenario", ({ name }) => sched.stopScenario(name));
  socket.on("deleteScenario", ({ name }) => sched.deleteScenario(name));

  socket.on("addSchedule", ({ id, schedule }) =>
    sched.addSchedule(id, schedule),
  );
  socket.on("removeSchedule", ({ id }) => sched.removeSchedule(id));

  socket.on("saveScenario", ({ name, data }) => {
    if (!name || !data) return;
    sched.saveScenario(name, data);
    log.info(`Scenario saved: "${name}" (${data.steps?.length || 0} steps)`);
  });

  socket.on("setRampParams", ({ trainId, stepSize, stepMs }) => {
    const train = trains[trainId];
    if (!train) return;
    train.rampStepSize = stepSize;
    train.rampStepMs = stepMs;
    if (train.uuid && hubConfig[train.uuid]) {
      hubConfig[train.uuid].rampStepSize = stepSize;
      hubConfig[train.uuid].rampStepMs = stepMs;
      saveConfig(hubConfig);
    }
    log.info(
      `Ramp ${trainId.slice(0, 8)}: step=${stepSize}% interval=${stepMs}ms`,
    );
  });

  socket.on("savePresets", ({ trainId, presets }) => {
    const train = trains[trainId];
    if (!train) return;
    train.presets = presets;
    if (train.uuid && hubConfig[train.uuid]) {
      hubConfig[train.uuid].presets = presets;
      saveConfig(hubConfig);
    }
  });

  socket.on("setLED", ({ trainId, color }) =>
    ramp.setLEDManual(trainId, color),
  );

  socket.on("reconnectHub", ({ trainId }) => {
    log.info(`Reconnect requested: ${trainId}`);
    ramp.resetStopState(trainId);
    poweredUP.scan();
    io.emit("hubStatus", { id: trainId, reconnecting: true, connected: false });
  });

  socket.on("disconnect", () => {
    connectedClients.delete(socket.id);
    log.info(`Browser ↓ ${socket.id} (remaining: ${connectedClients.size})`);

    // Автостоп поездов при отсутствии активных клиентов
    if (connectedClients.size === 0) {
      setTimeout(() => {
        if (connectedClients.size === 0) {
          log.warn("All browsers disconnected → auto-stop");
          ramp.stopAll("auto-stop: no clients");
          sched.stopAllScenarios();
        }
      }, 8000);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Статические файлы и запуск сервера
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(PUBLIC_DIR));
server.listen(3000, () => log.info("🚂 http://localhost:3000"));

// ─────────────────────────────────────────────────────────────────────────────
//  Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Корректное завершение работы приложения
 * @param {string} signal - сигнал, вызвавший остановку
 */
function shutdown(signal) {
  log.info(`${signal} received, stopping all trains and shutting down…`);
  ramp.stopAll(`shutdown:${signal}`);
  sched.destroy();
  ramp.destroy();

  try {
    poweredUP.stopScanning();
  } catch (_) {}

  for (const train of Object.values(trains)) {
    try {
      if (train.hub && typeof train.hub.disconnect === "function") {
        train.hub.disconnect();
      }
    } catch (_) {}
  }

  try {
    const noble = getNoble();
    if (noble && typeof noble.stopScanning === "function") noble.stopScanning();
  } catch (_) {}

  setTimeout(() => {
    server.close(() => {
      log.info("HTTP server closed. Bye.");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000);
  }, 1200);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});
