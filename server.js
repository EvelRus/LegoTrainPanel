"use strict";

const PoweredUP = require("node-poweredup"); // v3.0.0+ with noble support
const express = require("express"); // Веб-сервер и API
const http = require("http"); // Встроенный, для создания сервера
const { Server } = require("socket.io"); // WebSocket для реального времени
const fs = require("fs"); // Файловая система для логов и конфигурации
const path = require("path"); // Работа с путями

const Logger = require("./lib/logger"); // Логирование событий и ошибок
const RampEngine = require("./lib/ramp"); // Плавное изменение скорости
const Scheduler = require("./lib/scheduler"); // Планировщик сценариев и расписаний
const {
  PyBricksHub,
  isPyBricksPeripheral,
  getNoble,
} = require("./lib/pybricks"); // Поддержка PyBricks-совместимых хабов

const PUBLIC_DIR = path.join(__dirname, "public"); // Статические файлы для веб-интерфейса
const CONFIG_PATH = path.join(__dirname, "hub-config.json"); // Файл для сохранения конфигурации хабов
const DATA_DIR = path.join(__dirname, "data"); // Директория для данных приложения (логи, сценарии, расписания)
const LOGS_DIR = path.join(DATA_DIR, "logs"); // Директория для логов

// Убедимся, что необходимые директории существуют
[DATA_DIR, LOGS_DIR, PUBLIC_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/**
 * Читает версии пакетов из package.json для отображения в API /info
 *
 * @returns {Object} Объект с версиями node-poweredup и socket.io, или "—" при ошибке
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

const pkgVer = readPkgVersions(); // Версии для отображения в API /info

const app = express(); // Express-приложение для API и статических файлов
const server = http.createServer(app); // HTTP-сервер для Socket.IO
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
}); // Socket.IO сервер для реального времени

// Middleware для парсинга JSON в теле запросов
app.use(express.json());

const log = new Logger(LOGS_DIR); // Логгер для событий и ошибок, сохраняет в файлы и позволяет получать последние записи
const trains = {}; // Словарь для хранения информации о подключенных по PoweredUP хабах (ключ — trainId, значение — объект с данными и состоянием)
const ramp = new RampEngine(trains, io, log, true); // Движок для плавного изменения скорости, управляет всеми хабами и взаимодействует с логом и Socket.IO
log.attach(io); // Подключаем логгер к Socket.IO для отправки логов в браузер в реальном времени
const sched = new Scheduler(DATA_DIR, ramp, log, io); // Планировщик для сценариев и расписаний, сохраняет данные в файлах и взаимодействует с RampEngine и логом

/**
 * Загружает конфигурацию хабов из файла hub-config.json, если он существует. Если файл отсутствует или содержит ошибки, возвращает пустой объект.
 *
 * @returns {Object} Конфигурация хабов, где ключ — uuid хаба, а значение — объект с настройками (имя, звуки, фото и т.д.)
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    log.warn(`hub-config.json parse error: ${e.message}`);
    return {};
  }
}

/**
 * Сохраняет конфигурацию хабов в файл hub-config.json. Конфигурация должна быть объектом, где ключ — uuid хаба, а значение — объект с настройками (имя, звуки, фото и т.д.). Файл сохраняется в читаемом формате с отступами.
 *
 * @param {*} cfg
 */
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// Глобальная переменная для хранения конфигурации хабов в памяти, загружается при старте и обновляется при сохранении
let hubConfig = loadConfig();

// Сопоставление числовых кодов цветов от датчиков с их названиями для удобства отображения в интерфейсе
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
 * Строит информацию о портах для отображения в интерфейсе. Для каждого порта A-D проверяет, есть ли подключён мотор или датчик, и возвращает объект с типом устройства и его названием. Если порт не используется, возвращает null.
 * Порты с мотором имеют тип "motor", а порты с датчиками — "sensor". Название устройства берётся из конфигурации хаба или из типа устройства, если имя не указано.
 * @param {*} train
 * @returns {Object} Объект с информацией о портах A-D, где ключ — порт, а значение — объект с типом устройства (motor/sensor) и его названием, или null если порт не используется
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
      ports[port] = {
        type: "sensor",
        name: info.typeName || "Sensor",
      };
    }
  }
  return ports;
}

/**
 * Возвращает данные о поезде для отправки в клиентское приложение. Достаёт информацию из объекта поезда в памяти и формирует объект с нужными полями для отображения в интерфейсе. Если поезд не найден, возвращает null.
 *
 * @param {*} id
 * @returns {Object|null} Объект с данными поезда для интерфейса, включая id, имя, скорость, звуки, фото, статус подключения, уровень батареи, версии прошивки и аппаратного обеспечения, типы хаба и устройства, информацию о моторе и портах. Или null если поезд не найден.
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
    ports: buildPortsInfo(t), // ← NEW: информация о портах для индикаторов
  };
}

// API для получения информации о сервере, конфигурации, логах, сценариях и расписаниях. Также API для сохранения конфигурации хабов, которая включает имя, звуки, фото и параметры разгона. При сохранении конфигурации обновляем данные в памяти и сохраняем в файл, а также применяем изменения к уже подключённым поездам.
app.get("/api/info", (_req, res) =>
  res.json({
    ...pkgVer,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
  }),
);
// Получение текущей конфигурации хабов для отображения в интерфейсе
app.get("/api/config", (_req, res) => res.json(loadConfig()));

// Сохранение конфигурации хабов, обновление данных в памяти и применение изменений к уже подключённым поездам
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
    log.info("Config saved from browser");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API для получения логов, сценариев, расписаний и информации о файлах логов. Логи можно получать с параметром n для указания количества последних записей. Также есть API для чтения содержимого конкретного файла лога.
app.get("/api/logs", (_req, res) =>
  res.json(log.getLast(parseInt(_req?.query?.n) || 200)),
);

// Получение списка файлов логов для отображения в интерфейсе
app.get("/api/logs/files", (_req, res) => res.json(log.listLogFiles()));

// Получение содержимого конкретного файла лога по имени, с проверкой наличия файла и отправкой его в виде текста. Если файл не найден, возвращаем 404.
app.get("/api/logs/file", (req, res) => {
  const content = log.readLogFile(req.query.name || "");
  if (!content) return res.status(404).json({ error: "Not found" });
  res.type("text/plain; charset=utf-8").send(content);
});

// API для получения данных о сценариях, расписаниях и составах поездов. Эти данные используются в интерфейсе для отображения текущих сценариев и расписаний, а также для управления ими (запуск, остановка, удаление). Сценарии и расписания хранятся в файлах в директории данных, Scheduler отвечает за их загрузку и сохранение.
app.get("/api/scenarios", (_req, res) => res.json(sched.scenarios));

// Получение текущих расписаний для отображения в интерфейсе. Расписания включают информацию о том, какие сценарии запланированы на выполнение и когда.
app.get("/api/schedules", (_req, res) => res.json(sched.schedules));

// Получение информации о составах поездов, которые представляют собой группы поездов, движущихся синхронно. Эта информация используется в интерфейсе для управления составами и отображения их текущей скорости.
app.get("/api/consists", (_req, res) => res.json(sched.consists));

// API для получения списка директорий и файлов в папке public, с возможностью указать поддиректорию через параметр path. Этот API используется для отображения доступных звуков и изображений при настройке хаба. В ответе возвращается список директорий, файлов и текущий путь.
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

// Инициализация PoweredUP и установка обработчика для обнаружения новых хабов. При обнаружении хаба вызывается функция connectHub, которая отвечает за подключение к хабу, получение информации о нём, настройку событий и добавление его в список поездов. Также есть поддержка PyBricks-совместимых хабов через отдельную функцию connectPyBricksHub, которая вызывается при обнаружении соответствующих периферийных устройств.
const poweredUP = new PoweredUP.PoweredUP();

/**
 * Подключение к хабу, обнаруженному через node-poweredup. Функция проверяет, не является ли хаб PyBricks-совместимым (в этом случае он будет обрабатываться отдельно), затем получает его UUID и имя, загружает конфигурацию, сохраняет новую конфигурацию для незнакомых хабов, подключается к хабу, получает информацию о прошивке, батарее и устройствах на портах, настраивает события для обновления данных и отключения, добавляет хаб в список поездов и отправляет информацию в интерфейс. Если возникает ошибка при подключении, она логируется.
 *
 * @param {*} hub
 * @returns
 */
async function connectHub(hub) {
  if (hub.peripheral && isPyBricksPeripheral(hub.peripheral)) {
    log.info(`Skipping PyBricks hub in standard flow: ${hub.uuid}`);
    return;
  }

  const uuid = hub.uuid || hub.address || null;

  // Guard: пропускаем если UUID уже подключён (дубль после scan())
  if (uuid && trains[uuid]?.connected) {
    log.info(`Already connected, skip duplicate discover: ${uuid.slice(0, 8)}`);
    return;
  }
  const defaultName = hub.name || `Train-${Object.keys(trains).length + 1}`; // Формируем имя по умолчанию на основе имени хаба или количества уже подключенных поездов
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
    log.info(`New hub registered: ${uuid}`);
  }

  const cfg = (uuid && hubConfig[uuid]) || {}; // Получаем конфигурацию для этого хаба из файла, если она есть, иначе используем пустой объект
  const friendlyName = cfg.name || defaultName; // Дружественное имя для отображения в логах и интерфейсе, берётся из конфигурации или формируется по умолчанию
  log.info(`Discovered: ${friendlyName} [${uuid ?? "—"}]`); // Логируем обнаружение нового хаба с его именем и UUID (или "—" если UUID недоступен)

  try {
    await hub.connect();

    const firmwareVersion = hub.firmwareVersion || "—"; // Получаем версию прошивки хаба, если она доступна, иначе "—"
    const hardwareVersion = hub.hardwareVersion || "—"; // Получаем версию аппаратного обеспечения хаба, если она доступна, иначе "—"
    const hubTypeName = hub.constructor?.name || "Hub"; // Получаем тип хаба из его конструктора, если доступно, иначе "Hub"
    const batteryLevel =
      typeof hub.batteryLevel === "number" ? hub.batteryLevel : null; // Получаем уровень батареи, если он доступен и является числом, иначе null

    log.info(
      `${friendlyName}: fw=${firmwareVersion} hw=${hardwareVersion} bat=${batteryLevel ?? "—"}%`,
    );

    // Переменные для хранения информации о моторе, его порте и типе устройства, которые будут заполнены при обнаружении устройств на портах
    let motor = null,
      motorPort = null,
      deviceTypeName = "—";
    const sensors = {}; // Объект для хранения информации о датчиках, подключённых к портам, где ключ — порт, а значение — объект с типом датчика и самим устройством

    const portResults = await Promise.allSettled(
      ["A", "B", "C", "D"].map((port) =>
        Promise.race([
          hub.waitForDeviceAtPort(port),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), 4500),
          ),
        ]).then((device) => ({ port, device })),
      ),
    ); // Параллельная проверка портов A-D на наличие устройств с таймаутом 2 секунды для каждого порта, чтобы не задерживать подключение из-за медленных ответов. Результаты сохраняются в массиве portResults, где каждый элемент содержит статус выполнения и данные о порте и устройстве, если оно было обнаружено.

    // Обработка результатов проверки портов. Для каждого успешно обнаруженного устройства определяется его тип по названию класса, и если это мотор, он сохраняется в переменные motor и motorPort. Если это датчик цвета или расстояния, он сохраняется в объект sensors с ключом порта. Также настраиваются события для обновления данных датчиков в интерфейсе при изменении цвета или расстояния.
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
        // Сохраняем только typeName — без device, иначе Socket.IO упадёт на циклических ссылках
        sensors[port] = { typeName };
        const tid = uuid;
        // Навешиваем события на локальную переменную device, а не на sensors[port].device
        device.on("colorAndDistance", ({ color, distance }) => {
          if (!trains[tid]) return;
          io.emit("sensorUpdate", {
            trainId: tid,
            port,
            type: "colorAndDistance",
            color,
            distance,
            colorName: COLOR_NAMES[color] ?? "?",
          });
          // Уведомляем планировщик — может запустить condition-шаг сценария
          sched.onSensorColor(tid, port, color);
        });
        device.on("color", ({ color }) => {
          io.emit("sensorUpdate", {
            trainId: uuid,
            port,
            type: "color",
            color,
            colorName: COLOR_NAMES[color] ?? "?",
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
        try {
          device.requestUpdate?.();
        } catch (_) {}
      }
    }

    // Если мотор не был найден среди устройств на портах, пытаемся найти его среди всех устройств хаба по типу. Это нужно для случаев, когда мотор может быть подключён нестандартным образом или не распознаётся как устройство на порте. Мы проверяем все известные типы моторов и сохраняем первый найденный мотор, если он есть.
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

    // Если мотор не найден, логируем предупреждение и продолжаем, так как хаб может быть полезен и с другими устройствами, например, с датчиками. Однако функции управления скоростью будут недоступны для такого хаба.
    if (!motor) {
      log.warn(`${friendlyName}: no motor found`);
      return;
    }

    // Небольшая задержка перед остановкой мотора, чтобы избежать конфликтов с текущими командами или состояниями хаба при подключении. Это помогает предотвратить неожиданные движения при подключении, особенно если мотор был активен до этого.
    await new Promise((r) => setTimeout(r, 300));
    try {
      if (typeof motor.setPower === "function") motor.setPower(0);
      else if (typeof motor.setSpeed === "function") motor.setSpeed(0);
    } catch (_) {}

    const trainId = uuid || defaultName.replace(/\s+/g, "-"); // Идентификатор поезда для использования в интерфейсе и логах, основанный на UUID хаба или его имени, если UUID недоступен. Пробелы в имени заменяются на дефисы для удобства использования в качестве идентификатора.
    ramp.stopKeepalive(trainId); // Останавливаем любые активные процессы разгона для этого поезда, если они есть, чтобы избежать конфликтов при подключении нового хаба с таким же идентификатором. Это важно для корректной инициализации состояния поезда при подключении.
    ramp.clearRamp(trainId); // Очищаем любые сохранённые состояния разгона для этого поезда, чтобы начать с чистого листа при подключении нового хаба. Это помогает предотвратить нежелательные эффекты от предыдущих команд разгона, которые могли быть активны для другого хаба с таким же идентификатором.
    const prevSpd = trains[trainId]?.speed ?? 0; // Сохраняем предыдущую скорость поезда, если он уже был в списке, чтобы восстановить её после подключения нового хаба. Если поезда с таким идентификатором нет, используем 0 в качестве начальной скорости.

    // Сохраняем информацию о подключённом хабе в глобальном объекте trains, который используется для управления состоянием всех поездов. В объекте сохраняются данные о хабе, моторе, порте, типах устройств, сенсорах, текущей скорости, имени, UUID, звуках, фото, параметрах разгона, версиях прошивки и аппаратного обеспечения, уровне батареи и статусе подключения. Эти данные используются для отображения в интерфейсе и управления поездом.
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

    ramp.startKeepalive(trainId); // Запускаем процесс поддержания разгона для этого поезда, чтобы обеспечить плавное управление скоростью. Это позволяет автоматически корректировать скорость при изменении команд или условий, обеспечивая более стабильное движение поезда.
    ramp._setLED(trains[trainId]); // Устанавливаем начальный цвет LED на хабе в соответствии с его состоянием. Это помогает визуально отличать подключённые хабы и может использоваться для индикации различных состояний, например, при низком уровне батареи или ошибках.

    // Настраиваем события для обновления данных о батарее и реакции на нажатия кнопки на хабе. При изменении уровня батареи отправляем обновлённую информацию в интерфейс, включая предупреждение при низком уровне. При нажатии кнопки, если её состояние соответствует определённому значению, отправляем команду для воспроизведения звука сигнала. Также обрабатываем события ошибок, логируя их для диагностики.
    // Дебаунс: io.emit только при изменении, log раз в 60с или скачок ≥5%.
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

    // Реакция на нажатия кнопки на хабе. В зависимости от состояния кнопки (например, 2 может означать короткое нажатие) отправляем команду для воспроизведения звука сигнала в интерфейсе. Это позволяет использовать кнопку на хабе для управления функциями поезда, например, для подачи сигнала или запуска определённых сценариев.
    hub.on("button", (...args) => {
      const second = args[1];
      const first = args[0];
      const state = second ?? first?.state ?? first?.event ?? first;
      log.info(
        `Hub button: args=${JSON.stringify(args)} → state=${JSON.stringify(state)}`,
        trainId,
      );
      if (state === 2 || state === 1 || state === "pressed" || state === true) {
        io.emit("playHorn", { trainId });
      }
    });

    // Обработка событий ошибок, возникающих на хабе. Логируем сообщение об ошибке вместе с идентификатором поезда для диагностики и устранения проблем. Это важно для отслеживания стабильности подключения и выявления возможных проблем с оборудованием или программным обеспечением.
    hub.on("error", (err) => {
      log.error(`Hub error event: ${err?.message ?? err}`, trainId);
    });

    io.emit("newTrain", trainPayload(trainId)); // Отправляем информацию о новом подключённом поезде в интерфейс, чтобы он мог отобразить его и начать взаимодействие. Это включает все данные о поезде, такие как имя, скорость, звуки, фото, статус подключения и т.д.
    log.event(`Ready: "${friendlyName}" [${trainId}]`); // Логируем событие готовности поезда к работе, указывая его имя и идентификатор для удобства отслеживания в логах.

    // Обработка отключения хаба. Когда хаб отключается, логируем это событие, очищаем состояние разгона для этого поезда, останавливаем процесс поддержания разгона, обновляем статус подключения в объекте поезда и отправляем обновлённую информацию в интерфейс. Также запускаем повторное сканирование Bluetooth через некоторое время, чтобы обнаружить возможные повторные подключения или новые хабы.
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
      setTimeout(() => poweredUP.scan(), 3000);
    });
  } catch (err) {
    log.error(`Hub error ${friendlyName}: ${err.message}`);
  }
}

/**
 * Подключение к PyBricks-совместимому хабу, обнаруженному через сканер noble. Функция проверяет, не подключён ли уже хаб с таким UUID, затем загружает конфигурацию, сохраняет новую конфигурацию для незнакомых хабов, создаёт экземпляр PyBricksHub для управления этим хабом, подключается к нему, получает информацию о прошивке и устройствах, настраивает события для обновления данных и отключения, добавляет его в список поездов и отправляет информацию в интерфейс. Если возникает ошибка при подключении, она логируется.
 * Важно: PyBricks-совместимые хабы обрабатываются отдельно от обычных хабов node-poweredup, так как они используют другой протокол и требуют специальной поддержки. Поэтому для них используется отдельная функция connectPyBricksHub, которая вызывается при обнаружении соответствующих периферийных устройств через noble.
 *
 *
 * @param {*} peripheral
 * @returns
 */
async function connectPyBricksHub(peripheral) {
  const uuid = peripheral.id; // Получаем UUID из идентификатора периферийного устройства, который используется для идентификации хаба в системе. Это важно для управления состоянием хаба и его отображения в интерфейсе.
  if (trains[uuid]?.connected) return;

  hubConfig = loadConfig();
  const defaultName =
    peripheral.advertisement?.localName || `PB-${uuid.slice(0, 6)}`; // Формируем имя по умолчанию для PyBricks хаба на основе его рекламного имени или UUID, если рекламное имя недоступно. Это позволяет легко идентифицировать хаб в интерфейсе и логах, особенно если у пользователя несколько хабов.

  // Если хаб с таким UUID ещё не зарегистрирован в конфигурации, создаём новую запись с настройками по умолчанию и сохраняем её. Это позволяет пользователю позже настроить этот хаб через интерфейс, указав имя, звуки, фото и параметры разгона. Логируем регистрацию нового PyBricks хаба для отслеживания в логах.
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

  const cfg = hubConfig[uuid] || {}; // Получаем конфигурацию для этого хаба из файла, если она есть, иначе используем пустой объект. Конфигурация может включать имя, звуки, фото и параметры разгона, которые будут применены к этому хабу после подключения.
  const pb = new PyBricksHub(peripheral, io, log, cfg); // Создаём экземпляр PyBricksHub для управления этим хабом, передавая ему периферийное устройство, интерфейс Socket.IO для отправки данных в браузер, логгер для записи событий и конфигурацию для настройки. Этот класс отвечает за взаимодействие с PyBricks-совместимыми хабами и обеспечивает поддержку их специфических функций и протоколов.
  log.info(`PyBricks hub discovered: ${pb.name} [${uuid}]`);

  try {
    // Подключаемся к PyBricks хабу, что может занять некоторое время из-за особенностей Bluetooth и протокола PyBricks. После успешного подключения получаем информацию о прошивке, устройствах и других характеристиках хаба, которые будут сохранены в объекте поезда для отображения в интерфейсе и управления. Если подключение не удаётся, ошибка будет поймана и залогирована.
    await pb.connect();
    const prevSpd = trains[uuid]?.speed ?? 0; // Сохраняем предыдущую скорость поезда, если он уже был в списке, чтобы восстановить её после подключения нового хаба. Если поезда с таким идентификатором нет, используем 0 в качестве начальной скорости.

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

    ramp.startKeepalive(uuid); // Запускаем процесс поддержания разгона для этого поезда, чтобы обеспечить плавное управление скоростью. Это позволяет автоматически корректировать скорость при изменении команд или условий, обеспечивая более стабильное движение поезда.
    io.emit("newTrain", trainPayload(uuid)); // Отправляем информацию о новом подключённом поезде в интерфейс, чтобы он мог отобразить его и начать взаимодействие. Это включает все данные о поезде, такие как имя, скорость, звуки, фото, статус подключения и т.д.
    log.event(`PyBricks ready: "${pb.name}" [${uuid}]`);

    // Обработка отключения хаба. Когда хаб отключается, логируем это событие, очищаем состояние разгона для этого поезда, останавливаем процесс поддержания разгона, обновляем статус подключения в объекте поезда и отправляем обновлённую информацию в интерфейс. Также запускаем повторное сканирование Bluetooth через некоторое время, чтобы обнаружить возможные повторные подключения или новые хабы.
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

// Запускаем сканирование Bluetooth для обнаружения хабов. Устанавливаем обработчик для события "discover
poweredUP.on("discover", connectHub);

// Для поддержки PyBricks-совместимых хабов, которые могут не работать корректно через стандартный процесс обнаружения node-poweredup, мы используем отдельный сканер на основе noble. Этот сканер слушает события обнаружения периферийных устройств и проверяет, являются ли они PyBricks-совместимыми. Если да, то вызывается функция connectPyBricksHub для обработки подключения к этому хабу. Это обеспечивает поддержку широкого спектра устройств и позволяет пользователям с PyBricks-совместимыми хабами использовать это приложение без проблем.
poweredUP.scan();

log.info(
  `🔍 Bluetooth scan started  node-poweredup v${pkgVer.poweredUp}  socket.io v${pkgVer.socketIO}`,
);

/**
 * Подключает сканер PyBricks хабов. Слушает события обнаружения периферийных устройств через noble и проверяет, являются ли они PyBricks-совместимыми. Если да, то вызывает функцию connectPyBricksHub для обработки подключения к этому хабу. Это обеспечивает поддержку PyBricks-совместимых устройств, которые могут не работать корректно через стандартный процесс обнаружения node-poweredup.
 *
 * @returns
 */
function attachPyBricksScanner() {
  const noble = getNoble();
  if (!noble) {
    log.warn(
      "PyBricks: @stoprocent/noble не найден — входит в node-poweredup, проверьте npm install",
    );
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

const connectedClients = new Set(); // Множество для отслеживания подключённых клиентов браузера. Используется для управления состоянием приложения, например, для автоматической остановки поездов при отключении всех клиентов.

// Обработка событий подключения клиентов через Socket.IO. Когда клиент подключается, его идентификатор добавляется в множество connectedClients, и отправляется информация о текущих поездах, логах, сценариях и расписаниях. Клиент может отправлять команды для управления скоростью поездов, экстренной остановки, управления сценариями и расписаниями, сохранения конфигурации и других действий. При отключении клиента его идентификатор удаляется из множества, и если нет активных клиентов, запускается таймер для автоматической остановки всех поездов через некоторое время.
io.on("connection", (socket) => {
  connectedClients.add(socket.id);
  log.info(`Browser ↑ ${socket.id} (active: ${connectedClients.size})`);

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
    // Пропускаем дубли: если скорость не изменилась — не идём в рамп.
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

  // ← NEW: сохранение сценария вручную из построителя
  socket.on("saveScenario", ({ name, data }) => {
    if (!name || !data) return;
    sched.saveScenario(name, data);
    log.info(
      `Scenario saved manually: "${name}" (${data.steps?.length || 0} steps)`,
    );
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
    poweredUP.scan();
    io.emit("hubStatus", { id: trainId, reconnecting: true, connected: false });
  });

  socket.on("disconnect", () => {
    connectedClients.delete(socket.id);
    log.info(`Browser ↓ ${socket.id} (remaining: ${connectedClients.size})`);
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

// Запускаем HTTP сервер и обслуживаем статические файлы из директории public. Сервер слушает на порту 3000, и при успешном запуске логирует URL для доступа к интерфейсу. Это позволяет пользователям открывать браузер и взаимодействовать с приложением через удобный веб-интерфейс.
app.use(express.static(PUBLIC_DIR));
// Запуск HTTP сервера на порту 3000 и логирование URL для доступа к интерфейсу после успешного запуска. Это позволяет пользователям открывать браузер и взаимодействовать с приложением через удобный веб-интерфейс, который отображает информацию о поездах, логах, сценариях и расписаниях, а также предоставляет управление поездами и настройками.
server.listen(3000, () => log.info("🚂 http://localhost:3000"));
