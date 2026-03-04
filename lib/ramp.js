"use strict";

/**
 * @file ramp.js
 * @description Движок плавного управления скоростью поездов (RampEngine).
 *
 * Основные задачи:
 *   1. **Рамп (ramp)** — линейное изменение скорости шагами с заданным интервалом,
 *      вместо мгновенной смены. Предотвращает механические рывки и «зависание»
 *      TrainMotorLarge при резких командах.
 *   2. **Кикстарт** — кратковременная подача повышенной мощности при старте из 0,
 *      чтобы преодолеть статическое трение и трогаться мягко.
 *   3. **Stop-последовательность** — повторная отправка команды стопа через
 *      STOP_RETRY_MS для надёжной остановки по нестабильному BLE-каналу.
 *   4. **Keepalive** — периодическое повторение текущей скорости для предотвращения
 *      автоматического отключения хаба при длительном движении.
 *   5. **LED-индикация** — автоматическая смена цвета кнопки питания хаба:
 *      🟢 вперёд / 🔵 назад / 🔴 стоп.
 *   6. **Watchdog** — принудительное завершение рампа если он идёт дольше
 *      WATCHDOG_MS (защита от зависших таймеров).
 */

/** Максимальное время выполнения одного рампа (мс). По истечении — принудительная остановка. */
const WATCHDOG_MS = 15_000;

/**
 * Интервал keepalive-повтора скорости (мс).
 * 25 с — компромисс между нагрузкой на BLE и надёжностью соединения.
 * 12 с было слишком часто при активных battery-events.
 */
const KEEPALIVE_MS = 25_000;

/** Минимальная скорость в зоне движения (%). Значения ниже зажимаются до этого порога. */
const MIN_MOVE_POWER = 20;

/** Мощность кикстарта при трогании с нуля (%). */
const KICKSTART_PWR = 45;

/** Длительность кикстарта (мс). */
const KICKSTART_MS = 150;

/**
 * Таймауты ретраев команды стоп (мс).
 * Один ретрай через 800 мс — достаточно для подтверждения по BLE без лишней нагрузки.
 */
const STOP_RETRY_MS = [800];

class RampEngine {
  /**
   * @param {Object}  trains       - Словарь активных поездов `{ [trainId]: TrainObject }`.
   *                                 Ссылка на тот же объект, что и в server.js.
   * @param {import("socket.io").Server} io - Socket.IO сервер для отправки speedUpdate клиентам.
   * @param {object}  logger       - Экземпляр Logger.
   * @param {boolean} [debug=false] - Если true — в лог пишутся подробные BLE-команды.
   */
  constructor(trains, io, logger, debug = false) {
    this.trains = trains;
    this.io = io;
    this.log = logger;
    this.debug = debug;

    /** @private { [trainId]: { target, stepTimer, watchdog } } — активные рампы */
    this._ramp = {};

    /** @private { [trainId]: intervalId } — keepalive-таймеры */
    this._kalive = {};

    /** @private { [trainId]: timeoutId[] } — очередь ретраев команды стоп */
    this._stopQ = {};

    /** @private { [trainId]: true } — флаг активной stop-последовательности */
    this._stopping = {};

    /** @private { [trainId]: number } — токены кикстарта для отмены устаревших */
    this._kickToken = {};
  }

  // ═══════════════════════════════════════════════ ВСПОМОГАТЕЛЬНЫЕ ══

  /**
   * Условная запись в лог отладочных сообщений (только при debug=true).
   *
   * @private
   * @param {string}      msg - Текст сообщения.
   * @param {string|null} tid - trainId или null.
   */
  _dbg(msg, tid) {
    if (this.debug) this.log.info(`[DBG] ${msg}`, tid);
  }

  /**
   * Отменяет таймеры ретраев стопа.
   * НЕ сбрасывает флаг `_stopping` — это намеренно.
   *
   * @private
   * @param {string} trainId
   */
  _cancelStopTimers(trainId) {
    const ts = this._stopQ[trainId];
    if (ts?.length) {
      ts.forEach(clearTimeout);
      this._stopQ[trainId] = null;
    }
  }

  /**
   * Полностью сбрасывает состояние stop-последовательности.
   * Вызывается при получении новой команды движения, чтобы не блокировать старт.
   *
   * @private
   * @param {string} trainId
   */
  _clearStopState(trainId) {
    this._cancelStopTimers(trainId);
    delete this._stopping[trainId];
    this._dbg("stop-state cleared (new move cmd)", trainId);
  }

  // ═══════════════════════════════════════════════ ЗАПИСЬ В МОТОР ══

  /**
   * Единая точка отправки команды скорости мотору.
   *
   * Логика:
   *   - speed === 0: запускает stop-последовательность с ретраями (дедупликация по флагу).
   *   - speed !== 0: сбрасывает stop-состояние, вызывает setPower/setSpeed мотора.
   *
   * После записи обновляет `train.speed` и LED хаба.
   *
   * @private
   * @param {string} trainId
   * @param {number} speed - Скорость, от -100 до 100.
   */
  _write(trainId, speed) {
    const train = this.trains[trainId];
    if (!train) return;

    if (speed === 0) {
      // ── Stop-последовательность с дедупликацией ────────────────────
      // _stopping устанавливается здесь и сбрасывается:
      //   (a) после последнего ретрая, или
      //   (b) при новой команде движения (_clearStopState).
      if (this._stopping[trainId]) {
        this._dbg("stop deduplicated (already in progress)", trainId);
        return;
      }

      this._stopping[trainId] = true;
      this._dbg("stop sequence START", trainId);

      /** Вспомогательная функция отправки нуля с логом */
      const doStop = (label) => {
        const m = this.trains[trainId]?.motor; // Свежая ссылка — мотор мог исчезнуть
        if (!m) {
          this._dbg(`${label}: motor gone`, trainId);
          return;
        }
        this._dbg(`${label}: setPower(0)`, trainId);
        try {
          if (typeof m.setPower === "function") m.setPower(0);
          else if (typeof m.setSpeed === "function") m.setSpeed(0);
        } catch (e) {
          this.log.warn(`stop setPower err: ${e.message}`, trainId);
        }
        // brake() не используем: TrainMotor не поддерживает надёжно, занимает BLE-очередь
      };

      doStop("stop[0]");

      // Планируем ретраи согласно STOP_RETRY_MS
      const timers = STOP_RETRY_MS.map((ms, i) =>
        setTimeout(() => doStop(`stop[${i + 1}] retry+${ms}ms`), ms),
      );
      this._stopQ[trainId] = timers;

      // Снимаем флаг после последнего ретрая
      const last = Math.max(...STOP_RETRY_MS);
      setTimeout(() => {
        delete this._stopping[trainId];
        this._dbg("stop sequence DONE", trainId);
      }, last + 100);
    } else {
      // ── Команда движения — сбрасываем любое stop-состояние ────────
      this._clearStopState(trainId);

      const m = train.motor;
      if (!m) {
        this._dbg(`_write(${speed}): no motor`, trainId);
        return;
      }

      const method = typeof m.setPower === "function" ? "setPower" : "setSpeed";
      this._dbg(`_write: ${method}(${speed})`, trainId);

      try {
        if (typeof m.setPower === "function") m.setPower(speed);
        else if (typeof m.setSpeed === "function") m.setSpeed(speed);
        else this.log.warn("_write: no setPower/setSpeed", trainId);
      } catch (e) {
        this.log.warn(`_write error: ${e.message}`, trainId);
      }
    }

    train.speed = speed;
    this._setLED(train);
  }

  // ═══════════════════════════════════════════════════════ LED ══

  /**
   * Автоматически устанавливает цвет LED хаба по текущей скорости:
   *   🟢 GREEN  — движение вперёд (speed > 0)
   *   🔵 BLUE   — движение назад  (speed < 0)
   *   🔴 RED    — стоп            (speed === 0)
   *
   * @param {object} train - Объект поезда из this.trains.
   */
  _setLED(train) {
    if (!train?.hub) return;
    try {
      const { Consts } = require("node-poweredup");
      const C = Consts.Color;
      train.hub.setLEDColor(
        train.speed > 0 ? C.GREEN : train.speed < 0 ? C.BLUE : C.RED,
      );
    } catch (_) {
      /* Игнорируем — PyBricks хабы управляют LED самостоятельно */
    }
  }

  /**
   * Устанавливает цвет LED вручную по названию цвета.
   * Используется для ручного управления из браузера через событие setLED.
   *
   * @param {string} trainId
   * @param {"red"|"green"|"blue"|"yellow"|"white"|"cyan"|"magenta"|"off"} colorName
   */
  setLEDManual(trainId, colorName) {
    const train = this.trains[trainId];
    if (!train?.hub) return;
    try {
      const { Consts } = require("node-poweredup");
      const C = Consts.Color;
      const map = {
        red: C.RED,
        green: C.GREEN,
        blue: C.BLUE,
        yellow: C.YELLOW,
        white: C.WHITE,
        cyan: C.CYAN,
        magenta: C.MAGENTA,
        off: C.BLACK,
      };
      train.hub.setLEDColor(map[colorName] ?? C.RED);
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════ РАМП ══

  /**
   * Останавливает активный рамп для поезда: очищает stepTimer и watchdog.
   *
   * @param {string} trainId
   */
  clearRamp(trainId) {
    const rs = this._ramp[trainId];
    if (!rs) return;
    if (rs.stepTimer) clearInterval(rs.stepTimer);
    if (rs.watchdog) clearTimeout(rs.watchdog);
    this._ramp[trainId] = null;
    this._dbg("ramp cleared", trainId);
  }

  /**
   * Запускает плавное изменение скорости поезда до targetSpeed.
   *
   * Порядок действий:
   *   1. Проверяет наличие подключённого мотора.
   *   2. Применяет мёртвую зону: |speed| < MIN_MOVE_POWER → зажимается до MIN_MOVE_POWER.
   *   3. Если текущая скорость === targetSpeed — просто уведомляет клиент.
   *   4. Если старт из нуля — кикстарт на KICKSTART_MS, затем рамп.
   *   5. Иначе — сразу запускает рамп.
   *
   * @param {string} trainId
   * @param {number} targetSpeed - Целевая скорость, от -100 до 100.
   * @param {string} [source="auto"] - Источник команды для лога ("user", "scenario" и т.п.).
   */
  rampTo(trainId, targetSpeed, source = "auto") {
    this.clearRamp(trainId);

    const train = this.trains[trainId];
    if (!train?.connected || !train?.motor) {
      this.log.warn(`rampTo(${targetSpeed}): no motor/connection`, trainId);
      return;
    }

    // Применяем мёртвую зону — значения ниже MIN_MOVE_POWER не хватит для трогания
    if (targetSpeed !== 0) {
      const dir = Math.sign(targetSpeed);
      if (Math.abs(targetSpeed) < MIN_MOVE_POWER) {
        this._dbg(
          `rampTo: ${targetSpeed} → clamped to ${dir * MIN_MOVE_POWER} (dead-zone)`,
          trainId,
        );
        targetSpeed = dir * MIN_MOVE_POWER;
      }
    }

    // Скорость уже установлена — достаточно обновить UI
    if (train.speed === targetSpeed) {
      this._dbg(`rampTo: already at ${targetSpeed}`, trainId);
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });
      return;
    }

    this.log.info(
      `[${source}] rampTo: ${train.speed} → ${targetSpeed}`,
      trainId,
    );

    // ── Кикстарт при старте из нуля ──────────────────────────────
    if (train.speed === 0 && targetSpeed !== 0) {
      const dir = Math.sign(targetSpeed);
      const kickSpd = dir * Math.max(KICKSTART_PWR, Math.abs(targetSpeed));
      this._dbg(`kickstart: ${kickSpd} for ${KICKSTART_MS}ms`, trainId);

      // Токен для отмены кикстарта если за 150 мс пришла другая команда
      const kickToken = Date.now();
      this._kickToken[trainId] = kickToken;

      this._write(trainId, kickSpd);
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });

      setTimeout(() => {
        if (this._kickToken?.[trainId] !== kickToken) {
          this._dbg("kickstart cancelled (superseded)", trainId);
          return;
        }
        const t = this.trains[trainId];
        if (!t?.connected || !t?.motor) return;

        // Если кикстарт уже достиг цели — рамп не нужен
        if (t.speed === targetSpeed) {
          this._dbg(
            `kickstart reached target ${targetSpeed}, skip ramp`,
            trainId,
          );
          this.io.emit("speedUpdate", { trainId, speed: targetSpeed });
          return;
        }
        this._startRamp(trainId, targetSpeed);
      }, KICKSTART_MS);

      return;
    }

    this._startRamp(trainId, targetSpeed);
  }

  /**
   * Запускает шаговый рамп до targetSpeed (внутренний метод).
   * Вызывается из rampTo() после завершения кикстарта или напрямую.
   *
   * @private
   * @param {string} trainId
   * @param {number} targetSpeed
   */
  _startRamp(trainId, targetSpeed) {
    this.clearRamp(trainId);

    const train = this.trains[trainId];
    if (!train?.connected || !train?.motor) return;

    // Цель уже достигнута (например, кикстарт точно попал в target)
    if (train.speed === targetSpeed) {
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });
      return;
    }

    const stepSize = train.rampStepSize || 10; // Шаг изменения скорости за итерацию (%)
    const stepMs = train.rampStepMs || 100; // Интервал между шагами (мс)

    this._dbg(`ramp started: step=${stepSize}% every ${stepMs}ms`, trainId);

    let stepN = 0;

    /** Одна итерация рампа */
    const step = () => {
      const t = this.trains[trainId];
      const rs = this._ramp[trainId];

      // Прерываем если рамп отменён или мотор отключился
      if (!rs || !t?.connected || !t?.motor) {
        this.clearRamp(trainId);
        return;
      }

      const diff = rs.target - t.speed;
      const delta = Math.sign(diff) * Math.min(stepSize, Math.abs(diff));
      const next = t.speed + delta;
      stepN++;

      this._dbg(
        `ramp step #${stepN}: ${t.speed} → ${next} (target=${rs.target})`,
        trainId,
      );

      try {
        this._write(trainId, next);
        this.io.emit("speedUpdate", { trainId, speed: next });
      } catch (e) {
        this.log.error(`ramp error: ${e.message}`, trainId);
        this.clearRamp(trainId);
        return;
      }

      // Цель достигнута — останавливаем рамп
      if (next === rs.target) {
        this._dbg(`ramp complete at ${next}`, trainId);
        this.clearRamp(trainId);
      }
    };

    // Watchdog: принудительно прерывает зависший рамп
    const watchdog = setTimeout(() => {
      this.log.warn(`watchdog: ramp aborted (>${WATCHDOG_MS}ms)`, trainId);
      this.clearRamp(trainId);
    }, WATCHDOG_MS);

    this._ramp[trainId] = { target: targetSpeed, stepTimer: null, watchdog };

    // Немедленно выполняем первый шаг, затем запускаем интервал
    step();
    if (this._ramp[trainId]) {
      this._ramp[trainId].stepTimer = setInterval(step, stepMs);
    }
  }

  // ══════════════════════════════════════════════════════ СТОП ══

  /**
   * Немедленно останавливает поезд: отменяет рамп и отправляет команду стопа.
   *
   * Особенности:
   *   - Отменяет кикстарт-токен, если кикстарт ещё не завершился.
   *   - `train.speed` устанавливается в 0 оптимистично (до подтверждения от хаба).
   *   - Дедупликация стоп-спама обеспечивается флагом `_stopping` внутри `_write(0)`.
   *
   * @param {string} trainId
   * @param {string} [source="auto"] - Источник команды для лога.
   */
  stopNow(trainId, source = "auto") {
    // Отменяем токен кикстарта — если кикстарт ещё идёт, он не запустит рамп
    if (this._kickToken) delete this._kickToken[trainId];

    const train = this.trains[trainId];
    this.log.info(
      `[${source}] stopNow (speed was ${train?.speed ?? "?"})`,
      trainId,
    );

    this.clearRamp(trainId);
    if (train) train.speed = 0;

    if (!train?.connected || !train?.motor) {
      this.log.warn("stopNow: no motor/connection", trainId);
      return;
    }

    try {
      this._write(trainId, 0);
      this.io.emit("speedUpdate", { trainId, speed: 0 });
      this.log.event("■ STOP", trainId);
    } catch (e) {
      this.log.warn(`stopNow error: ${e.message}`, trainId);
    }
  }

  /**
   * Экстренная остановка ВСЕХ поездов одновременно (E-STOP).
   * Вызывается по кнопке E-STOP в браузере или при авто-стопе.
   *
   * @param {string} [reason="E-STOP"] - Причина остановки для лога.
   */
  stopAll(reason = "E-STOP") {
    this.log.event(`🛑 ${reason}`);
    for (const id of Object.keys(this.trains)) {
      this.stopNow(id);
    }
  }

  // ══════════════════════════════════════════════ KEEPALIVE ══

  /**
   * Запускает keepalive-таймер для поезда.
   *
   * Каждые KEEPALIVE_MS миллисекунд повторяет текущую скорость мотору.
   * Это предотвращает авто-отключение хаба при длительном движении без новых команд.
   * Keepalive не срабатывает если поезд стоит или рамп активен.
   *
   * @param {string} trainId
   */
  startKeepalive(trainId) {
    this.stopKeepalive(trainId);

    this._kalive[trainId] = setInterval(() => {
      const t = this.trains[trainId];

      // Пропускаем: поезд отключился, стоит или рамп активен
      if (!t?.connected || !t?.motor || this._ramp[trainId] || t.speed === 0) {
        return;
      }

      this._dbg(`[keepalive] setPower(${t.speed})`, trainId);
      try {
        if (typeof t.motor.setPower === "function") t.motor.setPower(t.speed);
        else if (typeof t.motor.setSpeed === "function")
          t.motor.setSpeed(t.speed);
      } catch (e) {
        this.log.warn(`keepalive error: ${e.message}`, trainId);
      }
    }, KEEPALIVE_MS);
  }

  /**
   * Останавливает keepalive-таймер для поезда.
   *
   * @param {string} trainId
   */
  stopKeepalive(trainId) {
    if (this._kalive[trainId]) {
      clearInterval(this._kalive[trainId]);
      delete this._kalive[trainId];
    }
  }

  /**
   * Возвращает true, если для поезда активен рамп.
   *
   * @param {string} trainId
   * @returns {boolean}
   */
  isRamping(trainId) {
    return !!this._ramp[trainId];
  }

  /**
   * Освобождает все ресурсы движка: keepalive, рампы, очереди стопа.
   * Вызывается при штатном завершении приложения (SIGTERM/SIGINT).
   */
  destroy() {
    Object.keys(this._kalive).forEach((id) => this.stopKeepalive(id));
    Object.keys(this._ramp).forEach((id) => this.clearRamp(id));
    Object.keys(this._stopQ).forEach((id) => this._cancelStopTimers(id));
  }
}

module.exports = RampEngine;
