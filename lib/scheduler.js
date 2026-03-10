"use strict";

/**
 * @file scheduler.js
 * @description Модуль управления автоматикой: сценариями, расписаниями, составами
 *              и светофорами (реакция на цветовые метки).
 *
 * Основные сущности:
 * - Сценарии (scenarios) — последовательности команд скорости с таймингами и условиями
 * - Запись сценария в реальном времени
 * - Составы (consists) — группы поездов с общей скоростью
 * - Расписания (schedules) — задачи по времени суток и дням недели
 * - Светофоры (trafficLights) — автоматическая реакция поезда на цвет метки
 */

const fs = require("fs");
const path = require("path");

/**
 * Словарь человекочитаемых названий цветов LEGO (совпадает с server.js)
 * @constant
 */
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
 * Минимальный интервал между двумя одинаковыми событиями цвета с одного датчика (мс).
 * Защищает от спама при длительном нахождении над меткой.
 * @constant
 */
const COLOR_COOLDOWN_MS = 800;

/**
 * Безопасно читает JSON-файл. Если файла нет или он битый — возвращает значение по умолчанию.
 * @param {string} path - путь к файлу
 * @param {*} defaultValue - значение, если файл отсутствует или некорректен
 * @returns {*} распарсенные данные или defaultValue
 */
function loadJSON(path, defaultValue) {
  if (!fs.existsSync(path)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (_) {
    return defaultValue;
  }
}

/**
 * Сохраняет объект в JSON-файл с отступами (форматированный)
 * @param {string} path - путь к файлу
 * @param {*} data - данные для сохранения
 */
function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Основной класс-оркестратор автоматики поездов
 */
class Scheduler {
  /**
   * @param {string} dataDir - директория для хранения json-файлов
   * @param {RampEngine} ramp - экземпляр двигателя плавного разгона/торможения
   * @param {Logger} log - объект логгера
   * @param {import("socket.io").Server} io - сервер Socket.IO для вещания клиентам
   */
  constructor(dataDir, ramp, log, io) {
    this.ramp = ramp;
    this.log = log;
    this.io = io;

    // Пути к файлам хранения состояния
    this._paths = {
      scenarios: path.join(dataDir, "scenarios.json"),
      schedules: path.join(dataDir, "schedules.json"),
      consists: path.join(dataDir, "consists.json"),
      trafficLights: path.join(dataDir, "trafficLights.json"),
    };

    // Загружаем текущее состояние из файлов (или пустые объекты)
    this.scenarios = loadJSON(this._paths.scenarios, {});
    this.schedules = loadJSON(this._paths.schedules, {});
    this.consists = loadJSON(this._paths.consists, {});
    this.trafficLights = loadJSON(this._paths.trafficLights, {});

    /**
     * Активные воспроизведения сценариев
     * @private
     * @type {Object.<string, {
     *   timeouts:         NodeJS.Timeout[],
     *   trainIds:         string[],
     *   pendingConditions: Array<{trainId:string, speed:number, condition:object, fallbackTimer:NodeJS.Timeout|null}>
     * }>}
     */
    this._playing = {};

    /**
     * Текущая запись сценария (если идёт)
     * @private
     * @type {{name:string, steps:Array, startTs:number} | null}
     */
    this._recording = null;

    /**
     * Таймеры автоматического возврата скорости после действия светофора (duration > 0)
     * Ключ: `${trafficLightId}:${trainId}`
     * @private
     * @type {Object.<string, NodeJS.Timeout>}
     */
    this._resumeTimers = {};

    /**
     * Кэш последних событий цвета для реализации cooldown
     * Ключ: `${trainId}:${port}`
     * @private
     * @type {Object.<string, {color:number, ts:number}>}
     */
    this._lastColorEvent = {};

    // Периодическая проверка расписаний (каждую минуту)
    this._schedTick = setInterval(() => this._checkSchedules(), 60_000);
  }

  // ──────────────────────────────────────────────── СОСТАВЫ ────────────────────────────────────────────────

  /**
   * Сохраняет или обновляет состав поездов
   * @param {string} id - уникальный идентификатор состава
   * @param {Object} consist - объект состава {name, trainIds: string[], speed?}
   */
  saveConsist(id, consist) {
    this.consists[id] = consist;
    saveJSON(this._paths.consists, this.consists);
    this.io.emit("consistsUpdate", this.consists);
  }

  /**
   * Удаляет состав
   * @param {string} id
   */
  deleteConsist(id) {
    delete this.consists[id];
    saveJSON(this._paths.consists, this.consists);
    this.io.emit("consistsUpdate", this.consists);
  }

  /**
   * Устанавливает общую скорость всему составу
   * @param {string} consistId
   * @param {number} speed - скорость от -100 до +100
   */
  setConsistSpeed(consistId, speed) {
    const c = this.consists[consistId];
    if (!c) return;

    c.speed = speed;
    this.log.event(`Состав "${c.name}" → ${speed}%`);

    for (const tid of c.trainIds || []) {
      if (speed === 0) {
        this.ramp.stopNow(tid, "consist");
      } else {
        this.ramp.rampTo(tid, speed, "consist");
      }
    }

    this.io.emit("consistsUpdate", this.consists);
  }

  /**
   * Реакция на изменение скорости отдельного поезда — синхронизируем составы
   * @param {string} trainId
   * @param {number} speed
   */
  onTrainSpeedChange(trainId, speed) {
    for (const c of Object.values(this.consists)) {
      if ((c.trainIds || []).includes(trainId)) {
        c.speed = speed;
      }
    }
    this.io.emit("consistsUpdate", this.consists);
  }

  // ──────────────────────────────────────────────── ЗАПИСЬ СЦЕНАРИЯ ────────────────────────────────────────────────

  /**
   * Начинает запись сценария в реальном времени
   * @param {string} name - желаемое имя сценария
   */
  startRecording(name) {
    this._recording = { name, steps: [], startTs: Date.now() };
    this.log.info(`⬤ Запись сценария "${name}" начата`);
    this.io.emit("scenarioRecording", { active: true, name });
  }

  /**
   * Добавляет шаг в текущую запись (вызывается при каждом setSpeed)
   * @param {string} trainId
   * @param {number} speed
   */
  recordStep(trainId, speed) {
    if (!this._recording) return;
    this._recording.steps.push({
      trainId,
      speed,
      delay: Date.now() - this._recording.startTs,
    });
  }

  /**
   * Завершает запись и сохраняет сценарий
   */
  stopRecording() {
    if (!this._recording) return;
    const { name, steps } = this._recording;

    this.scenarios[name] = {
      steps,
      created: new Date().toISOString(),
    };

    saveJSON(this._paths.scenarios, this.scenarios);
    this.log.info(`■ Сценарий "${name}" сохранён (${steps.length} шагов)`);

    this.io.emit("scenariosUpdate", this.scenarios);
    this.io.emit("scenarioRecording", { active: false });
    this._recording = null;
  }

  isRecording() {
    return !!this._recording;
  }

  recordingName() {
    return this._recording?.name;
  }

  // ──────────────────────────────────────────────── УПРАВЛЕНИЕ СЦЕНАРИЯМИ ────────────────────────────────────────────────

  saveScenario(name, data) {
    this.scenarios[name] = data;
    saveJSON(this._paths.scenarios, this.scenarios);
    this.io.emit("scenariosUpdate", this.scenarios);
  }

  deleteScenario(name) {
    this.stopScenario(name);
    delete this.scenarios[name];
    saveJSON(this._paths.scenarios, this.scenarios);
    this.io.emit("scenariosUpdate", this.scenarios);
  }

  /**
   * Запускает воспроизведение сценария (с поддержкой зацикливания)
   * @param {string} name - имя сценария
   * @param {number|undefined} loops - 0 = ∞, N = N раз, undefined = брать значение из сценария
   */
  playScenario(name, loops) {
    const sc = this.scenarios[name];
    if (!sc?.steps?.length) {
      this.log.warn(`playScenario: сценарий "${name}" не найден или пуст`);
      return;
    }

    this.stopScenario(name);

    const totalLoops = loops !== undefined ? loops : (sc.loops ?? 1);
    const infinite = totalLoops === 0;
    let remaining = infinite ? Infinity : totalLoops;

    this.log.event(
      `▶ Сценарий "${name}"` +
        (infinite ? " [∞]" : totalLoops > 1 ? ` [×${totalLoops}]` : ""),
    );

    // Длительность одного полного прохода (для зацикливания)
    const maxDelay = sc.steps.reduce((m, s) => Math.max(m, s.delay), 0);
    const cycleDur = maxDelay + 500;

    // Собираем все задействованные поезда (для гарантированной остановки)
    const trainIds = [
      ...new Set(sc.steps.map((s) => s.trainId).filter(Boolean)),
    ];

    /** Выполняет действие шага */
    const execStep = (step) => {
      if (!this._playing[name]) return;

      const colorLabel = step.condition
        ? ` (условие цвет=${COLOR_NAMES[step.condition.color] ?? step.condition.color})`
        : "";

      this.log.info(
        `[сценарий "${name}"] → скорость ${step.speed}%${colorLabel}`,
        step.trainId,
      );

      if (step.speed === 0) {
        this.ramp.stopNow(step.trainId, "scenario");
      } else {
        this.ramp.rampTo(step.trainId, step.speed, "scenario");
      }
    };

    /**
     * Планирует все шаги одного цикла со смещением offset мс
     */
    const scheduleRound = (offset) => {
      sc.steps.forEach((step) => {
        if (step.condition?.type === "colorSensor") {
          // ── Шаг с условием (ждём цвет) ─────────────────────────────
          const regTimer = setTimeout(() => {
            if (!this._playing[name]) return;

            const pending = {
              trainId: step.trainId,
              speed: step.speed,
              condition: step.condition,
              fallbackTimer: null,
            };

            const timeout = step.timeout ?? 0; // 0 = ∞
            if (timeout > 0) {
              pending.fallbackTimer = setTimeout(() => {
                if (!this._playing[name]) return;
                const pc = this._playing[name]?.pendingConditions;
                if (!pc) return;
                const idx = pc.indexOf(pending);
                if (idx !== -1) {
                  pc.splice(idx, 1);
                  this.log.info(
                    `[сценарий "${name}"] таймаут ожидания цвета → принудительно`,
                    step.trainId,
                  );
                  execStep(step);
                }
              }, timeout);
            }

            this._playing[name].pendingConditions.push(pending);

            const colorLabel =
              COLOR_NAMES[step.condition.color] ?? step.condition.color;
            this.log.info(
              `[сценарий "${name}"] ожидание: порт=${step.condition.port} цвет=${colorLabel}` +
                (timeout > 0
                  ? ` (таймаут ${timeout / 1000}с)`
                  : " (без таймаута)"),
              step.trainId,
            );
          }, offset + step.delay);

          this._playing[name].timeouts.push(regTimer);
        } else {
          // ── Обычный шаг по времени ────────────────────────────────
          const t = setTimeout(() => execStep(step), offset + step.delay);
          this._playing[name].timeouts.push(t);
        }
      });
    };

    this._playing[name] = {
      timeouts: [],
      trainIds,
      pendingConditions: [],
    };

    this.io.emit("scenarioPlayback", { name, active: true });

    let round = 0;

    const scheduleNext = () => {
      if (!this._playing[name]) return;

      scheduleRound(round * cycleDur);
      remaining--;
      round++;

      if (remaining > 0) {
        const t = setTimeout(scheduleNext, round * cycleDur);
        this._playing[name].timeouts.push(t);
      } else {
        const t = setTimeout(
          () => {
            if (!this._playing[name]) return;
            delete this._playing[name];
            this.io.emit("scenarioPlayback", { name, active: false });
            this.log.info(`■ Сценарий "${name}" завершён`);
          },
          round * cycleDur + 500,
        );

        this._playing[name].timeouts.push(t);
      }
    };

    scheduleNext();
  }

  /**
   * Останавливает конкретный сценарий (очищает таймеры, сбрасывает поезда)
   * @param {string} name
   */
  stopScenario(name) {
    const sp = this._playing[name];
    if (!sp) return;

    sp.timeouts.forEach((t) => clearTimeout(t));

    // Отменяем fallback-таймеры ожиданий цвета
    for (const pc of sp.pendingConditions || []) {
      if (pc.fallbackTimer) clearTimeout(pc.fallbackTimer);
    }

    delete this._playing[name];
    this.io.emit("scenarioPlayback", { name, active: false });
    this.log.info(`■ Сценарий "${name}" остановлен`);

    // Останавливаем все поезда, которые были задействованы
    for (const tid of sp.trainIds || []) {
      this.ramp.stopNow(tid, "scenario:stop");
    }
  }

  /**
   * Экстренная остановка ВСЕХ активных сценариев
   */
  stopAllScenarios() {
    for (const name of Object.keys(this._playing)) {
      this.stopScenario(name);
    }
  }

  /**
   * Обработчик события от датчика цвета.
   * Проверяет условия сценариев и светофоров.
   *
   * @important Реализован cooldown, чтобы избежать спама при длительном нахождении над меткой.
   *
   * @param {string} trainId
   * @param {string} port
   * @param {number} colorCode
   */
  onSensorColor(trainId, port, colorCode) {
    const key = `${trainId}:${port}`;
    const now = Date.now();
    const last = this._lastColorEvent[key];

    // Cooldown — игнорируем повтор того же цвета слишком быстро
    if (last && last.color === colorCode && now - last.ts < COLOR_COOLDOWN_MS) {
      return;
    }

    this._lastColorEvent[key] = { color: colorCode, ts: now };

    const colorName = COLOR_NAMES[colorCode] ?? `код ${colorCode}`;
    const pendingCount = Object.values(this._playing).reduce(
      (sum, p) => sum + (p.pendingConditions?.length ?? 0),
      0,
    );

    if (pendingCount > 0) {
      this.log.info(
        `🎨 Сенсор [${port}] зафиксировал: ${colorName} — проверяю ${pendingCount} условий`,
        trainId,
      );
    }

    // ── Проверяем ожидающие условия сценариев ───────────────────────────────
    for (const [name, playing] of Object.entries(this._playing)) {
      const pc = playing.pendingConditions;
      if (!pc?.length) continue;

      let matched = 0;
      for (let i = pc.length - 1; i >= 0; i--) {
        const pending = pc[i];
        const cond = pending.condition;

        if (
          cond.type === "colorSensor" &&
          cond.port === port &&
          cond.color === colorCode &&
          pending.trainId === trainId
        ) {
          matched++;
          this.log.info(
            `✅ [сценарий "${name}"] совпадение: порт=${port} цвет=${colorName} → скорость ${pending.speed}%`,
            trainId,
          );

          if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
          pc.splice(i, 1);

          const step = {
            trainId: pending.trainId,
            speed: pending.speed,
            condition: cond,
          };

          // Выполняем шаг сразу (вне очереди таймеров)
          setTimeout(() => {
            if (!this._playing[name]) return;
            if (step.speed === 0) {
              this.ramp.stopNow(step.trainId, "scenario:color");
            } else {
              this.ramp.rampTo(step.trainId, step.speed, "scenario:color");
            }
          }, 0);
        }
      }

      if (matched > 1) {
        this.log.warn(
          `[сценарий "${name}"] Сработало ${matched} условий на один цвет — последнее победит`,
          trainId,
        );
      }
    }

    // ── Проверяем правила светофоров ────────────────────────────────────────
    this._checkTrafficLights(trainId, port, colorCode);
  }

  // ──────────────────────────────────────────────── СВЕТОФОРЫ ────────────────────────────────────────────────

  /**
   * Сохраняет или обновляет светофор
   * @param {string} id
   * @param {Object} tl - объект светофора
   */
  saveTrafficLight(id, tl) {
    this.trafficLights[id] = tl;
    saveJSON(this._paths.trafficLights, this.trafficLights);
    this.log.info(
      `🚦 Светофор "${tl.name}" сохранён (${tl.rules?.length ?? 0} правил)`,
    );
    this.io.emit("trafficLightsUpdate", this.trafficLights);
  }

  deleteTrafficLight(id) {
    const name = this.trafficLights[id]?.name || id;

    // Отменяем все таймеры возобновления скорости для этого светофора
    for (const key of Object.keys(this._resumeTimers)) {
      if (key.startsWith(`${id}:`)) {
        clearTimeout(this._resumeTimers[key]);
        delete this._resumeTimers[key];
      }
    }

    delete this.trafficLights[id];
    saveJSON(this._paths.trafficLights, this.trafficLights);
    this.log.info(`🚦 Светофор "${name}" удалён`);
    this.io.emit("trafficLightsUpdate", this.trafficLights);
  }

  toggleTrafficLight(id, active) {
    const tl = this.trafficLights[id];
    if (!tl) return;

    tl.active = active;
    saveJSON(this._paths.trafficLights, this.trafficLights);

    this.log.event(
      `🚦 Светофор "${tl.name}" → ${active ? "АКТИВЕН" : "ОСТАНОВЛЕН"}`,
    );

    this.io.emit("trafficLightsUpdate", this.trafficLights);
  }

  /**
   * Проверяет правила всех активных светофоров при событии цвета
   * @private
   */
  _checkTrafficLights(trainId, port, colorCode) {
    for (const [id, tl] of Object.entries(this.trafficLights)) {
      if (!tl.active) continue;
      if (tl.trainId !== trainId) continue;
      if (tl.port && tl.port !== port) continue;

      const rule = (tl.rules || []).find((r) => r.color === colorCode);
      if (!rule) continue;

      const colorName = COLOR_NAMES[colorCode] ?? `код ${colorCode}`;

      this.log.event(
        `🚦 "${tl.name}": ${colorName} → ${rule.speed === 0 ? "СТОП" : rule.speed + "%"}` +
          (rule.duration > 0 ? ` на ${rule.duration / 1000} с` : ""),
        trainId,
      );

      const prevSpeed = this.ramp.trains?.[trainId]?.speed ?? 0;

      // Идемпотентность: если уже на этой скорости — ничего не делаем
      if (prevSpeed === rule.speed) {
        this.log.info(
          `🚦 "${tl.name}": уже ${rule.speed === 0 ? "стоит" : `едет ${prevSpeed}%`} — пропуск`,
          trainId,
        );
        continue;
      }

      // Применяем правило
      if (rule.speed === 0) {
        this.ramp.stopNow(trainId, "trafficLight");
      } else {
        this.ramp.rampTo(trainId, rule.speed, "trafficLight");
      }

      // Если задана длительность — планируем возврат к предыдущей скорости
      if (rule.duration > 0) {
        const tlKey = `${id}:${trainId}`;
        if (this._resumeTimers[tlKey]) clearTimeout(this._resumeTimers[tlKey]);

        const resumeSpeed = rule.resumeSpeed ?? prevSpeed;

        this._resumeTimers[tlKey] = setTimeout(() => {
          delete this._resumeTimers[tlKey];
          this.log.info(
            `🚦 "${tl.name}": +${rule.duration / 1000}с — возобновляю ${resumeSpeed}%`,
            trainId,
          );

          if (resumeSpeed === 0) {
            this.ramp.stopNow(trainId, "trafficLight:resume");
          } else {
            this.ramp.rampTo(trainId, resumeSpeed, "trafficLight:resume");
          }
        }, rule.duration);
      }
    }
  }

  // ──────────────────────────────────────────────── РАСПИСАНИЕ ────────────────────────────────────────────────

  addSchedule(id, schedule) {
    this.schedules[id] = schedule;
    saveJSON(this._paths.schedules, this.schedules);
    this.io.emit("schedulesUpdate", this.schedules);
  }

  removeSchedule(id) {
    delete this.schedules[id];
    saveJSON(this._paths.schedules, this.schedules);
    this.io.emit("schedulesUpdate", this.schedules);
  }

  /**
   * Периодическая проверка расписания (вызывается каждую минуту)
   * @private
   */
  _checkSchedules() {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dow = now.getDay();

    for (const sch of Object.values(this.schedules)) {
      if (sch.time !== hhmm) continue;
      if (sch.days?.length && !sch.days.includes(dow)) continue;

      this.log.event(`🕐 Расписание "${sch.name}" (${hhmm})`);
      this._execAction(sch.action);
    }
  }

  /**
   * Выполняет действие из расписания
   * @private
   */
  _execAction(action) {
    if (!action) return;

    switch (action.type) {
      case "setSpeed":
        if (action.trainId) {
          if (action.speed === 0) {
            this.ramp.stopNow(action.trainId, "schedule");
          } else {
            this.ramp.rampTo(action.trainId, action.speed, "schedule");
          }
        }
        break;

      case "estop":
        this.ramp.stopAll("Расписание E-STOP");
        break;

      case "playScenario":
        if (action.name) this.playScenario(action.name);
        break;

      case "setConsist":
        if (action.consistId !== undefined) {
          this.setConsistSpeed(action.consistId, action.speed ?? 0);
        }
        break;
    }
  }

  /**
   * Вызывается при завершении работы сервера
   */
  destroy() {
    clearInterval(this._schedTick);
    this.stopAllScenarios();

    // Очищаем все таймеры возобновления скорости светофоров
    Object.values(this._resumeTimers).forEach(clearTimeout);
    this._resumeTimers = {};
  }
}

module.exports = Scheduler;
