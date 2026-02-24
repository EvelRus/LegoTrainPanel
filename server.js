"use strict";
const PoweredUP = require("node-poweredup");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const Logger = require("./lib/logger");
const RampEngine = require("./lib/ramp");
const Scheduler = require("./lib/scheduler");

const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "hub-config.json");
const DATA_DIR = path.join(__dirname, "data");
const LOGS_DIR = path.join(DATA_DIR, "logs");

[DATA_DIR, LOGS_DIR, PUBLIC_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});
app.use(express.json());

const log = new Logger(LOGS_DIR);
const trains = {};
const ramp = new RampEngine(trains, io, log);

log.attach(io);

const sched = new Scheduler(DATA_DIR, ramp, log, io);

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
    for (const train of Object.values(trains)) {
      const cfg = hubConfig[train.uuid] || {};
      if (cfg.name) train.name = cfg.name;
      if (cfg.sounds) train.sounds = cfg.sounds;
      if (cfg.photo !== undefined) train.photo = cfg.photo;
      if (cfg.rampStepSize) train.rampStepSize = cfg.rampStepSize;
      if (cfg.rampStepMs) train.rampStepMs = cfg.rampStepMs;
      if (cfg.presets) train.presets = cfg.presets;
    }
    log.info("Конфиг сохранён из браузера");
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

const poweredUP = new PoweredUP.PoweredUP();

async function connectHub(hub) {
  const uuid = hub.uuid || hub.address || null;
  const defaultName = hub.name || `Train-${Object.keys(trains).length + 1}`;
  hubConfig = loadConfig();

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
    log.info(`Новый хаб добавлен: ${uuid}`);
  }

  const cfg = (uuid && hubConfig[uuid]) || {};
  const friendlyName = cfg.name || defaultName;

  log.info(`Обнаружен: ${friendlyName} [${uuid ?? "—"}]`);

  try {
    await hub.connect();

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

    for (const port of ["A", "B", "C", "D"]) {
      let device;
      try {
        device = await Promise.race([
          hub.waitForDeviceAtPort(port),
          new Promise((_, rej) => setTimeout(() => rej(), 5000)),
        ]);
      } catch (_) {
        continue;
      }

      const typeName = device.constructor?.name || "Device";
      log.info(`${friendlyName} — порт ${port}: ${typeName}`);

      const lc = typeName.toLowerCase();
      if (!motor && lc.includes("motor")) {
        motor = device;
        motorPort = port;
        deviceTypeName = typeName;
      } else if (lc.includes("color") || lc.includes("distance")) {
        sensors[port] = { typeName, device };
        device.on("colorAndDistance", ({ color, distance }) => {
          const trainId = uuid;
          if (!trains[trainId]) return;
          if (!trains[trainId].sensors) trains[trainId].sensors = {};
          trains[trainId].sensors[port] = {
            type: typeName,
            color,
            distance,
            colorName: COLOR_NAMES[color] ?? "?",
          };
          io.emit("sensorUpdate", {
            trainId,
            port,
            color,
            distance,
            colorName: COLOR_NAMES[color] ?? "?",
          });
        });
        device.on("color", ({ color }) => {
          io.emit("sensorUpdate", {
            trainId: uuid,
            port,
            color,
            colorName: COLOR_NAMES[color] ?? "?",
          });
        });
        device.on("distance", ({ distance }) => {
          io.emit("sensorUpdate", { trainId: uuid, port, distance });
        });
        try {
          device.requestUpdate?.();
        } catch (_) {}
      }
    }

    if (!motor) {
      const Consts = require("node-poweredup").Consts;
      const motorTypes = [
        Consts.DeviceType.TRAIN_MOTOR,
        Consts.DeviceType.LARGE_MOTOR,
        Consts.DeviceType.XLARGE_MOTOR,
        Consts.DeviceType.MEDIUM_MOTOR,
        Consts.DeviceType.TECHNIC_LARGE_MOTOR,
        Consts.DeviceType.TECHNIC_XLARGE_MOTOR,
      ];
      for (const mt of motorTypes) {
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
      log.warn(`${friendlyName}: мотор не найден`);
      return;
    }

    try {
      await new Promise((r) => setTimeout(r, 300));
    } catch (_) {}
    try {
      if (typeof motor.setPower === "function") motor.setPower(0);
      else if (typeof motor.setSpeed === "function") motor.setSpeed(0);
    } catch (_) {}

    const trainId = uuid || defaultName.replace(/\s+/g, "-");

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
      keepaliveTimer: null,
    };

    ramp.startKeepalive(trainId);
    ramp._setLED(trains[trainId]);

    hub.on("batteryLevel", ({ batteryLevel: lvl }) => {
      if (trains[trainId]) trains[trainId].batteryLevel = lvl;
      io.emit("hubStatus", {
        id: trainId,
        battery: lvl,
        lowBattery: lvl <= 15,
      });
      if (lvl <= 15) log.warn(`Низкий заряд: ${lvl}%`, trainId);
    });

    hub.on("button", ({ state }) => {
      if (state === 2) io.emit("playHorn", { trainId });
    });

    io.emit("newTrain", trainPayload(trainId));
    log.event(`Готов: "${friendlyName}" [${trainId}]`);

    hub.on("disconnect", () => {
      log.warn(`Отключён: ${friendlyName}`, trainId);
      ramp.clearRamp(trainId);
      ramp.stopKeepalive(trainId);
      sched.stopScenario(trainId);
      if (trains[trainId]) {
        trains[trainId].connected = false;
        trains[trainId].motor = null;
      }
      io.emit("hubStatus", { id: trainId, connected: false });
      setTimeout(() => poweredUP.scan(), 3000);
    });
  } catch (err) {
    log.error(`Ошибка с хабом ${friendlyName}: ${err.message}`);
  }
}

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
  };
}

poweredUP.on("discover", connectHub);
poweredUP.scan();
log.info(
  `🔍 Сканирование Bluetooth...  node-poweredup v${pkgVer.poweredUp}  socket.io v${pkgVer.socketIO}`,
);

const connectedClients = new Set();

io.on("connection", (socket) => {
  connectedClients.add(socket.id);
  log.info(`Браузер ↑ ${socket.id} (активных: ${connectedClients.size})`);

  for (const id of Object.keys(trains)) {
    const p = trainPayload(id);
    if (p) socket.emit("newTrain", p);
  }
  socket.emit("logs", log.getLast(200));
  socket.emit("scenariosUpdate", sched.scenarios);
  socket.emit("schedulesUpdate", sched.schedules);
  socket.emit("consistsUpdate", sched.consists);

  socket.on("setSpeed", ({ trainId, speed }) => {
    const train = trains[trainId];
    if (!train?.connected || !train?.motor) {
      socket.emit("hubStatus", { id: trainId, connected: false });
      return;
    }
    const clamped = Math.max(-100, Math.min(100, Math.round(speed)));

    if (sched.isRecording()) sched.recordStep(trainId, clamped);

    if (clamped === 0) ramp.stopNow(trainId);
    else ramp.rampTo(trainId, clamped);

    sched.onTrainSpeedChange(trainId, clamped);
  });

  socket.on("estop", () => {
    ramp.stopAll("E-STOP (браузер)");
    sched.stopAllScenarios();
  });

  socket.on("saveConsist", ({ id, consist }) => sched.saveConsist(id, consist));
  socket.on("deleteConsist", ({ id }) => sched.deleteConsist(id));
  socket.on("setConsistSpeed", ({ consistId, speed }) =>
    sched.setConsistSpeed(consistId, speed),
  );

  socket.on("startRecording", ({ name }) => sched.startRecording(name));
  socket.on("stopRecording", () => sched.stopRecording());
  socket.on("playScenario", ({ name }) => sched.playScenario(name));
  socket.on("stopScenario", ({ name }) => sched.stopScenario(name));
  socket.on("deleteScenario", ({ name }) => sched.deleteScenario(name));

  socket.on("addSchedule", ({ id, schedule }) =>
    sched.addSchedule(id, schedule),
  );
  socket.on("removeSchedule", ({ id }) => sched.removeSchedule(id));

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
      `Рамп ${trainId.slice(0, 8)}: шаг=${stepSize}% интервал=${stepMs}мс`,
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
    log.info(`Переподключение: ${trainId}`);
    poweredUP.scan();
    io.emit("hubStatus", { id: trainId, reconnecting: true, connected: false });
  });

  socket.on("disconnect", () => {
    connectedClients.delete(socket.id);
    log.info(`Браузер ↓ ${socket.id} (осталось: ${connectedClients.size})`);

    if (connectedClients.size === 0) {
      setTimeout(() => {
        if (connectedClients.size === 0) {
          log.warn("Все браузеры отключились → автостоп");
          ramp.stopAll("автостоп: нет клиентов");
          sched.stopAllScenarios();
        }
      }, 8000);
    }
  });
});

app.use(express.static(PUBLIC_DIR));
server.listen(3000, () => log.info(`🚂 http://localhost:3000`));
