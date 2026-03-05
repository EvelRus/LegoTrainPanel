"use strict";

/**
 * @file scheduler.js
 * @description Управление сценариями, расписаниями и составами поездов.
 *
 * Модуль отвечает за три подсистемы:
 *
 * 1. **Составы (Consists)** — группы хабов, движущихся синхронно.
 *    Один ползунок в браузере управляет всеми локомотивами состава.
 *
 * 2. **Сценарии (Scenarios)** — записанные или вручную собранные
 *    последовательности команд скорости с реальными временными метками.
 *    Поддерживают однократное, многократное и бесконечное воспроизведение.
 *
 * 3. **Расписание (Schedules)** — автоматический запуск действий
 *    по времени (ЧЧ:ММ) с фильтром по дням недели.
 *    Проверка выполняется каждую минуту через setInterval.
 *
 * Все данные сохраняются в JSON-файлах в директории `data/`.
 */

const fs = require("fs");
const path = require("path");

/**
 * Читает JSON-файл с диска. Возвращает значение по умолчанию при отсутствии или ошибке.
 *
 * @param {string} p   - Абсолютный путь к файлу.
 * @param {*}      def - Значение по умолчанию.
 * @returns {*} Распарсенный объект или def.
 */
function loadJSON(p, def) {
  if (!fs.existsSync(p)) return def;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {
    return def;
  }
}

/**
 * Сохраняет объект в JSON-файл с отступами (human-readable).
 *
 * @param {string} p    - Абсолютный путь к файлу.
 * @param {*}      data - Данные для сериализации.
 */
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

class Scheduler {
  /**
   * @param {string}     dataDir - Директория для хранения JSON-файлов.
   * @param {RampEngine} ramp    - Движок плавного изменения скорости.
   * @param {object}     log     - Экземпляр Logger.
   * @param {import("socket.io").Server} io - Socket.IO сервер для уведомлений браузера.
   */
  constructor(dataDir, ramp, log, io) {
    this.ramp = ramp;
    this.log = log;
    this.io = io;

    /** @private Пути к файлам данных */
    this._paths = {
      scenarios: path.join(dataDir, "scenarios.json"),
      schedules: path.join(dataDir, "schedules.json"),
      consists: path.join(dataDir, "consists.json"),
    };

    /** Сценарии: { [name]: { steps: [{trainId, speed, delay}], created, loops } } */
    this.scenarios = loadJSON(this._paths.scenarios, {});

    /** Расписания: { [id]: { name, time, days, action } } */
    this.schedules = loadJSON(this._paths.schedules, {});

    /** Составы: { [id]: { name, trainIds, speed } } */
    this.consists = loadJSON(this._paths.consists, {});

    /**
     * Активные воспроизведения.
     * { [name]: { timeouts: [], trainIds: string[], pendingConditions: [] } }
     * pendingConditions — шаги ожидающие срабатывания условия (colorSensor и т.п.)
     * @private
     */
    this._playing = {};

    /** @private { name, steps, startTs } | null — активная запись */
    this._recording = null;

    /** @private Таймер проверки расписания (каждую минуту) */
    this._schedTick = setInterval(() => this._checkSchedules(), 60_000);
  }

  // ═══════════════════════════════════════════════════ СОСТАВЫ ══

  /**
   * Сохраняет состав и уведомляет браузер об обновлении.
   *
   * @param {string} id     - Идентификатор состава.
   * @param {object} consist - { name: string, trainIds: string[] }
   */
  saveConsist(id, consist) {
    this.consists[id] = consist;
    saveJSON(this._paths.consists, this.consists);
    this.io.emit("consistsUpdate", this.consists);
  }

  /**
   * Удаляет состав по идентификатору и уведомляет браузер.
   *
   * @param {string} id - Идентификатор состава.
   */
  deleteConsist(id) {
    delete this.consists[id];
    saveJSON(this._paths.consists, this.consists);
    this.io.emit("consistsUpdate", this.consists);
  }

  /**
   * Устанавливает скорость всем поездам состава синхронно.
   * Обновляет поле `speed` в объекте состава и уведомляет браузер.
   *
   * @param {string} consistId - Идентификатор состава.
   * @param {number} speed     - Скорость от -100 до 100, 0 — стоп.
   */
  setConsistSpeed(consistId, speed) {
    const c = this.consists[consistId];
    if (!c) return;

    c.speed = speed;
    this.log.event(`Состав "${c.name}" → ${speed}%`);

    for (const tid of c.trainIds || []) {
      if (speed === 0) this.ramp.stopNow(tid);
      else this.ramp.rampTo(tid, speed);
    }

    this.io.emit("consistsUpdate", this.consists);
  }

  /**
   * Обновляет кешированную скорость состава при изменении скорости отдельного поезда.
   * Вызывается из server.js при каждом setSpeed, чтобы UI состава оставался актуальным.
   *
   * @param {string} trainId - UUID поезда, скорость которого изменилась.
   * @param {number} speed   - Новая скорость.
   */
  onTrainSpeedChange(trainId, speed) {
    for (const c of Object.values(this.consists)) {
      if ((c.trainIds || []).includes(trainId)) {
        c.speed = speed;
      }
    }
    this.io.emit("consistsUpdate", this.consists);
  }

  // ══════════════════════════════════════════════ ЗАПИСЬ СЦЕНАРИЯ ══

  /**
   * Начинает запись сценария в реальном времени.
   * Все последующие вызовы `recordStep()` добавляются к текущей записи.
   *
   * @param {string} name - Имя нового сценария.
   */
  startRecording(name) {
    this._recording = { name, steps: [], startTs: Date.now() };
    this.log.info(`Запись сценария "${name}" начата`);
    this.io.emit("scenarioRecording", { active: true, name });
  }

  /**
   * Добавляет шаг к активной записи сценария.
   * Временная метка вычисляется относительно начала записи.
   *
   * @param {string} trainId - UUID поезда.
   * @param {number} speed   - Скорость на этом шаге.
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
   * Завершает запись и сохраняет сценарий.
   * Уведомляет браузер об обновлении списка сценариев.
   */
  stopRecording() {
    if (!this._recording) return;
    const { name, steps } = this._recording;
    this.scenarios[name] = { steps, created: new Date().toISOString() };
    saveJSON(this._paths.scenarios, this.scenarios);
    this.log.info(`Сценарий "${name}" сохранён (${steps.length} шагов)`);
    this.io.emit("scenariosUpdate", this.scenarios);
    this.io.emit("scenarioRecording", { active: false });
    this._recording = null;
  }

  /**
   * Возвращает true, если запись сценария активна.
   * @returns {boolean}
   */
  isRecording() {
    return !!this._recording;
  }

  /**
   * Возвращает имя активной записи сценария, или undefined.
   * @returns {string|undefined}
   */
  recordingName() {
    return this._recording?.name;
  }

  // ═══════════════════════════════════════════ УПРАВЛЕНИЕ СЦЕНАРИЯМИ ══

  /**
   * Сохраняет сценарий (создаёт или перезаписывает). Используется построителем сценариев.
   *
   * @param {string} name - Имя сценария.
   * @param {object} data - { steps: [{trainId, speed, delay}], loops?: number }
   */
  saveScenario(name, data) {
    this.scenarios[name] = data;
    saveJSON(this._paths.scenarios, this.scenarios);
    this.io.emit("scenariosUpdate", this.scenarios);
  }

  /**
   * Удаляет сценарий по имени. Если сценарий воспроизводится — останавливает его.
   *
   * @param {string} name - Имя сценария.
   */
  deleteScenario(name) {
    this.stopScenario(name);
    delete this.scenarios[name];
    saveJSON(this._paths.scenarios, this.scenarios);
    this.io.emit("scenariosUpdate", this.scenarios);
  }

  /**
   * Воспроизводит сценарий с поддержкой зацикливания.
   *
   * @param {string}          name             - Имя сценария.
   * @param {number|undefined} [loops]         - Количество повторений:
   *   - undefined / 1 — один раз
   *   - 0            — бесконечно (до ручной остановки)
   *   - N            — N раз
   */
  playScenario(name, loops) {
    const sc = this.scenarios[name];
    if (!sc?.steps?.length) return;

    this.stopScenario(name); // Останавливаем предыдущее воспроизведение этого сценария

    // Определяем режим воспроизведения
    const totalLoops = loops !== undefined ? loops : (sc.loops ?? 1);
    const infinite = totalLoops === 0;
    let remaining = infinite ? Infinity : totalLoops;

    this.log.event(
      `▶ Сценарий "${name}"` +
        (infinite ? " [∞]" : totalLoops > 1 ? ` [×${totalLoops}]` : ""),
    );

    // Длительность одного цикла = максимальная задержка + 500 мс паузы
    const maxDelay = sc.steps.reduce((m, s) => Math.max(m, s.delay), 0);
    const cycleDur = maxDelay + 500;

    /**
     * Планирует все шаги одного прохода сценария со сдвигом offset мс.
     * @param {number} offset - Смещение от текущего момента (мс).
     */
    // Извлекаем trainIds в момент старта для надёжного стопа
    const trainIds = [
      ...new Set(sc.steps.map((s) => s.trainId).filter(Boolean)),
    ];

    /** Выполняет действие шага. Вызывается по таймеру или по условию. */
    const execStep = (step) => {
      if (!this._playing[name]) return;
      this.log.info(
        `[scenario] step speed=${step.speed}${step.condition ? " (condition)" : ""}`,
        step.trainId,
      );
      if (step.speed === 0) this.ramp.stopNow(step.trainId, "scenario");
      else this.ramp.rampTo(step.trainId, step.speed, "scenario");
    };

    /**
     * Планирует шаги одного прохода со сдвигом offset мс.
     * Шаги с condition.type="colorSensor" — ждут сенсора, delay = таймаут.
     * Остальные шаги — обычный setTimeout.
     */
    const scheduleRound = (offset) => {
      sc.steps.forEach((step) => {
        if (step.condition?.type === "colorSensor") {
          const pending = {
            trainId: step.trainId,
            speed: step.speed,
            condition: step.condition,
            fallbackTimer: null,
          };
          if (step.delay > 0) {
            pending.fallbackTimer = setTimeout(() => {
              if (!this._playing[name]) return;
              const pc = this._playing[name]?.pendingConditions;
              if (pc) {
                const idx = pc.indexOf(pending);
                if (idx !== -1) {
                  pc.splice(idx, 1);
                  this.log.info(
                    `[scenario] condition timeout → executing`,
                    step.trainId,
                  );
                  execStep(step);
                }
              }
            }, offset + step.delay);
            this._playing[name].timeouts.push(pending.fallbackTimer);
          }
          this._playing[name].pendingConditions.push(pending);
        } else {
          const t = setTimeout(() => execStep(step), offset + step.delay);
          this._playing[name].timeouts.push(t);
        }
      });
    };

    this._playing[name] = { timeouts: [], trainIds, pendingConditions: [] };
    this.io.emit("scenarioPlayback", { name, active: true });

    // Рекурсивная планировка циклов
    let round = 0;
    const scheduleNext = () => {
      if (!this._playing[name]) return;
      scheduleRound(round * cycleDur);
      remaining--;
      round++;

      if (remaining > 0) {
        // Планируем следующий цикл
        const t = setTimeout(scheduleNext, round * cycleDur);
        this._playing[name].timeouts.push(t);
      } else {
        // Финальный таймер завершения
        const t = setTimeout(
          () => {
            if (!this._playing[name]) return;
            delete this._playing[name];
            this.io.emit("scenarioPlayback", { name, active: false });
          },
          round * cycleDur + 500,
        );
        this._playing[name].timeouts.push(t);
      }
    };

    scheduleNext();
  }

  /**
   * Останавливает воспроизведение сценария, отменяя все запланированные таймеры.
   *
   * @param {string} name - Имя сценария.
   */
  stopScenario(name) {
    const sp = this._playing[name];
    if (!sp) return;

    // Отменяем все таймеры (включая fallback-таймеры условных шагов)
    sp.timeouts.forEach((t) => clearTimeout(t));

    // Отменяем fallback-таймеры pendingConditions на случай если они не в timeouts
    for (const pc of sp.pendingConditions || []) {
      if (pc.fallbackTimer) clearTimeout(pc.fallbackTimer);
    }

    // trainIds берём из playing-state (сохранены при старте) — надёжнее чем из scenarios
    const trainIds = sp.trainIds || [];

    delete this._playing[name];
    this.io.emit("scenarioPlayback", { name, active: false });
    this.log.info(`■ Сценарий "${name}" остановлен`);

    for (const tid of trainIds) {
      this.ramp.stopNow(tid, "scenario:stop");
    }
  }

  /**
   * Останавливает все активные воспроизведения сценариев.
   * Вызывается при E-STOP и отключении хаба.
   */
  stopAllScenarios() {
    for (const name of Object.keys(this._playing)) {
      this.stopScenario(name);
    }
  }

  /**
   * Вызывается из server.js при каждом событии цветового датчика.
   * Ищет среди активных сценариев pendingConditions, которые ждут
   * именно этот цвет на этом порту от этого поезда.
   * При совпадении — немедленно выполняет шаг и убирает из очереди.
   *
   * @param {string} trainId  - UUID поезда, на котором сработал датчик.
   * @param {string} port     - Порт датчика ("B", "C" и т.п.).
   * @param {number} colorCode - Числовой код цвета (0–10).
   */
  onSensorColor(trainId, port, colorCode) {
    for (const [name, playing] of Object.entries(this._playing)) {
      const pc = playing.pendingConditions;
      if (!pc?.length) continue;

      for (let i = pc.length - 1; i >= 0; i--) {
        const pending = pc[i];
        const cond = pending.condition;
        if (
          cond.type === "colorSensor" &&
          cond.port === port &&
          cond.color === colorCode &&
          pending.trainId === trainId
        ) {
          this.log.info(
            `[scenario "${name}"] colorSensor matched port=${port} color=${colorCode}`,
            trainId,
          );
          // Отменяем таймаут (план Б) и выполняем шаг немедленно
          if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
          pc.splice(i, 1);
          // Локальная копия для замыкания
          const step = {
            trainId: pending.trainId,
            speed: pending.speed,
            condition: cond,
          };
          // Небольшая задержка 0мс чтобы не прерывать текущий BLE-кадр
          setTimeout(() => {
            if (!this._playing[name]) return;
            this.log.info(
              `[scenario] step speed=${step.speed} (condition fired)`,
              step.trainId,
            );
            if (step.speed === 0)
              this.ramp.stopNow(step.trainId, "scenario:color");
            else this.ramp.rampTo(step.trainId, step.speed, "scenario:color");
          }, 0);
        }
      }
    }
  }

  // ══════════════════════════════════════════════ РАСПИСАНИЕ ══

  /**
   * Добавляет или обновляет задачу расписания.
   *
   * @param {string} id       - Уникальный идентификатор задачи.
   * @param {object} schedule - Объект расписания:
   *   @param {string}   schedule.name    - Отображаемое имя.
   *   @param {string}   schedule.time    - Время срабатывания "ЧЧ:ММ".
   *   @param {number[]} schedule.days    - Дни недели [0-6], 0=вс. Пусто = каждый день.
   *   @param {object}   schedule.action  - Действие (см. _execAction).
   */
  addSchedule(id, schedule) {
    this.schedules[id] = schedule;
    saveJSON(this._paths.schedules, this.schedules);
    this.io.emit("schedulesUpdate", this.schedules);
  }

  /**
   * Удаляет задачу расписания по идентификатору.
   *
   * @param {string} id - Идентификатор задачи.
   */
  removeSchedule(id) {
    delete this.schedules[id];
    saveJSON(this._paths.schedules, this.schedules);
    this.io.emit("schedulesUpdate", this.schedules);
  }

  /**
   * Проверяет расписания и выполняет задачи, время которых совпадает с текущим.
   * Вызывается автоматически каждую минуту через setInterval.
   *
   * @private
   */
  _checkSchedules() {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dow = now.getDay(); // 0 = воскресенье

    for (const sch of Object.values(this.schedules)) {
      if (sch.time !== hhmm) continue;
      if (sch.days?.length && !sch.days.includes(dow)) continue;

      this.log.event(`🕐 Расписание "${sch.name}" (${hhmm})`);
      this._execAction(sch.action);
    }
  }

  /**
   * Выполняет действие из расписания или другого источника.
   *
   * Поддерживаемые типы действий:
   *   - `setSpeed`     — установить скорость поезда.
   *   - `estop`        — экстренная остановка всех поездов.
   *   - `playScenario` — запустить сценарий.
   *   - `setConsist`   — установить скорость состава.
   *
   * @private
   * @param {{ type: string, trainId?: string, speed?: number, name?: string, consistId?: string }} action
   */
  _execAction(action) {
    if (!action) return;

    switch (action.type) {
      case "setSpeed":
        if (action.trainId) {
          if (action.speed === 0) this.ramp.stopNow(action.trainId);
          else this.ramp.rampTo(action.trainId, action.speed);
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
   * Освобождает ресурсы: останавливает проверку расписания и все активные сценарии.
   * Вызывается при штатном завершении приложения (SIGTERM/SIGINT).
   */
  destroy() {
    clearInterval(this._schedTick);
    this.stopAllScenarios();
  }
}

module.exports = Scheduler;
