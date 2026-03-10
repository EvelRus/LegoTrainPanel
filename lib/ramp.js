"use strict";

/**
 * @file ramp.js
 * @description Движок плавного разгона/торможения поездов (RampEngine).
 *
 * Основные принципы:
 *   1. Плавный разгон/торможение ступенями (rampStepSize %, каждые rampStepMs мс)
 *   2. Кикстарт при старте из нуля (короткий импульс большей мощности)
 *   3. Надёжное торможение: повторяющаяся команда brake() до полной остановки
 *   4. Keepalive — периодическая подстраховка команды скорости
 *   5. Защита от спама BLE: дедупликация, watchdog, идемпотентность
 *
 * Важные константы LEGO Powered Up:
 *   - setPower(0)   → FLOAT   (мотор отпущен, поезд катится по инерции)
 *   - brake()       → BRAKE   (байт 0x7F, электромагнитное торможение)
 *   - setPower(n)   → мощность от -100 до +100 (рекомендуется для движения)
 *
 * Реальная физика поезда:
 *   - При 50% скорости торможение занимает 3–5 секунд
 *   - Одна команда brake() часто недостаточна — нужен повтор
 */

const WATCHDOG_MS = 15_000; // Максимальное время разгона (защита от зависания)
const KEEPALIVE_MS = 25_000; // Интервал подстраховки команды скорости
const MIN_MOVE_POWER = 15; // Минимальная мощность, при которой мотор начинает крутиться
const KICKSTART_PWR = 40; // Мощность кикстарта (импульс при старте из 0)
const KICKSTART_MS = 150; // Длительность кикстарта

/**
 * Интервал повторной команды торможения во время braking loop.
 *
 * ВАЖНО: при 200 мс × 20 импульсов BLE-буфер хаба переполняется →
 * хаб отключается (наблюдается на TechnicLargeLinearMotor и TrainMotor).
 * 500 мс даёт 3 команды за 1.5 с — достаточно для физической остановки
 * и не нагружает BLE-очередь.
 */
const BRAKE_PULSE_MS = 500;
/** Сколько времени держим тормоз после команды stop (полная остановка) */
const BRAKE_HOLD_MS = 1_500;

class RampEngine {
  /**
   * @param {Object} trains - глобальный объект поездов { trainId: {motor, speed, ...} }
   * @param {SocketIO.Server} io - для отправки speedUpdate клиентам
   * @param {Logger} logger - объект логгера
   * @param {boolean} debug - включить отладочные сообщения
   */
  constructor(trains, io, logger, debug = false) {
    this.trains = trains;
    this.io = io;
    this.log = logger;
    this.debug = debug;

    // Активные процессы разгона
    this._ramp = {}; // { trainId: { target, stepTimer, watchdog } }

    // Keepalive — периодическая подстраховка ненулевой скорости
    this._kalive = {}; // { trainId: interval }

    // Устаревшее поле (оставлено для совместимости, не используется)
    this._stopQ = {};

    // Флаг активного торможения (braking loop)
    this._stopping = {}; // { trainId: true }

    // Токен кикстарта — предотвращает наложение нескольких кикстартов
    this._kickToken = {};

    // Braking loop (повтор brake() до BRAKE_HOLD_MS)
    this._bloop = {}; // { trainId: { iv: interval, timeout: timeout } }
  }

  // ──────────────────────────────────────────────── ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ────────────────────────────────────────────────

  _dbg(msg, tid) {
    if (this.debug) this.log.info(`[DBG] ${msg}`, tid);
  }

  /**
   * Очищает все таймеры stop-retry (устаревшее поле _stopQ)
   * @private
   */
  _cancelStopTimers(trainId) {
    const timers = this._stopQ[trainId];
    if (timers?.length) {
      timers.forEach(clearTimeout);
      this._stopQ[trainId] = null;
    }
  }

  /**
   * Останавливает braking loop (повторяющиеся brake())
   * @private
   */
  _stopBloop(trainId) {
    const b = this._bloop[trainId];
    if (!b) return;

    clearInterval(b.iv);
    clearTimeout(b.timeout);
    delete this._bloop[trainId];
    this._dbg("bloop stopped", trainId);
  }

  /**
   * Полная очистка состояния торможения поезда
   * @private
   */
  _clearStopState(trainId) {
    this._cancelStopTimers(trainId);
    this._stopBloop(trainId);
    delete this._stopping[trainId];
    this._dbg("stop-state cleared", trainId);
  }

  // ──────────────────────────────────────────────── ЗАПИСЬ КОМАНДЫ В МОТОР ────────────────────────────────────────────────

  /**
   * Унифицированный безопасный вызов метода мотора с обработкой ошибок
   * @private
   * @param {Motor} motor - объект мотора из node-poweredup
   * @param {number} speed - целевая скорость (-100..100) или 0
   * @param {string} label - метка для лога (например "bloop[3]")
   * @param {string} trainId
   */
  _motorSet(motor, speed, label, trainId) {
    const safeCall = (fn, arg) => {
      let result;
      try {
        result = fn.call(motor, arg);
      } catch (e) {
        this.log.warn(`${label} sync err: ${e.message}`, trainId);
        return;
      }
      // Асинхронные ошибки (промисы)
      if (result?.catch) {
        result.catch((e) =>
          this.log.warn(`${label} async err: ${e.message}`, trainId),
        );
      }
    };

    if (speed !== 0) {
      // Движение: выбор метода зависит от типа мотора.
      //
      // TachoMotor (TechnicLargeLinearMotor и др.) — определяем по наличию
      // rotateByDegrees: у этих моторов setSpeed() активирует встроенный
      // замкнутый регулятор скорости (ПИД). setPower() обходит его и даёт
      // рывки + неточное управление.
      //
      // TrainMotor / BasicMotor — нет rotateByDegrees, нет нативного setSpeed;
      // используем setPower().
      const isTacho = typeof motor.rotateByDegrees === "function";

      if (isTacho && typeof motor.setSpeed === "function") {
        safeCall(motor.setSpeed, speed);
      } else if (typeof motor.setPower === "function") {
        safeCall(motor.setPower, speed);
      } else if (typeof motor.setSpeed === "function") {
        // Крайний fallback (не должен срабатывать в норме)
        safeCall(motor.setSpeed, speed);
      } else {
        this.log.warn(`${label}: нет setPower/setSpeed`, trainId);
      }
    } else {
      // Остановка: brake() — байт 0x7F, электромагнитное торможение.
      // setPower(0) — байт 0x00, FLOAT (мотор отпускается), не тормозит!
      // Лог пишется вызывающим кодом (bloop[N]), здесь дублировать не нужно.
      if (typeof motor.brake === "function") {
        safeCall(motor.brake);
      } else if (typeof motor.setPower === "function") {
        this.log.warn(
          `${label}: нет brake(), fallback → setPower(0) [FLOAT]`,
          trainId,
        );
        safeCall(motor.setPower, 0);
      }
    }
  }

  /**
   * Основной метод отправки команды мотору.
   * Обновляет train.speed, управляет LED, запускает braking loop при 0.
   * @private
   */
  _write(trainId, speed) {
    const train = this.trains[trainId];
    if (!train) return;

    // Важно: обновляем train.speed ДО любой другой логики!
    train.speed = speed;
    this._setLED(train);

    if (speed !== 0) {
      // Движение → отменяем торможение, посылаем команду
      this._clearStopState(trainId);
      const m = train.motor;
      if (!m) {
        this._dbg(`_write(${speed}): no motor`, trainId);
        return;
      }
      this._dbg(`_write: setPower(${speed})`, trainId);
      this._motorSet(m, speed, `_write(${speed})`, trainId);
      return;
    }

    // speed === 0 → запускаем braking loop (повтор brake())

    // Дедупликация: если уже тормозим — не перезапускаем
    if (this._stopping[trainId]) {
      this._dbg("bloop already active → deduplicated", trainId);
      return;
    }

    this._stopping[trainId] = true;
    this._dbg("bloop START", trainId);

    const m = train.motor;
    if (!m) {
      this._dbg("bloop: no motor", trainId);
      return;
    }

    // Первый импульс торможения сразу
    this._dbg("bloop[0]: brake()", trainId);
    this._motorSet(m, 0, "bloop[0]", trainId);

    let pulseCount = 1;

    const interval = setInterval(() => {
      const t = this.trains[trainId];
      // Прерываем, если скорость уже не 0 (кто-то дал ход)
      if (!t || t.speed !== 0) {
        this._dbg(`bloop[${pulseCount}]: speed changed → stopping`, trainId);
        this._stopBloop(trainId);
        return;
      }
      if (!t.motor) {
        this._stopBloop(trainId);
        return;
      }

      this._dbg(`bloop[${pulseCount}]: brake()`, trainId);
      this._motorSet(t.motor, 0, `bloop[${pulseCount}]`, trainId);
      pulseCount++;
    }, BRAKE_PULSE_MS);

    // Автоматическая остановка цикла через BRAKE_HOLD_MS
    const holdTimeout = setTimeout(() => {
      this._dbg("bloop DONE (hold time expired)", trainId);
      this._stopBloop(trainId);
      delete this._stopping[trainId];
    }, BRAKE_HOLD_MS);

    this._bloop[trainId] = { iv: interval, timeout: holdTimeout };
  }

  // ──────────────────────────────────────────────── УПРАВЛЕНИЕ LED ────────────────────────────────────────────────

  /**
   * Устанавливает цвет LED хаба в зависимости от текущей скорости
   * @private
   */
  _setLED(train) {
    if (!train?.hub) return;
    try {
      const { Consts } = require("node-poweredup");
      const C = Consts.Color;
      train.hub.setLEDColor(
        train.speed > 0 ? C.GREEN : train.speed < 0 ? C.BLUE : /* 0 */ C.RED,
      );
    } catch (_) {
      // silent fail — LED не критичен
    }
  }

  /**
   * Ручная установка цвета LED (через клиент)
   * @param {string} trainId
   * @param {string} colorName - red, green, blue, yellow, white, cyan, magenta, off
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

  // ──────────────────────────────────────────────── ПЛАВНЫЙ РАЗГОН / ТОРМОЖЕНИЕ ────────────────────────────────────────────────

  /**
   * Очищает текущий процесс рампы (разгона/торможения)
   * @param {string} trainId
   */
  clearRamp(trainId) {
    const r = this._ramp[trainId];
    if (!r) return;

    if (r.stepTimer) clearInterval(r.stepTimer);
    if (r.watchdog) clearTimeout(r.watchdog);
    delete this._ramp[trainId];
    this._dbg("ramp cleared", trainId);
  }

  /**
   * Запускает плавный переход к целевой скорости
   * @param {string} trainId
   * @param {number} targetSpeed - целевая скорость (-100..100)
   * @param {string} [source="auto"] - источник команды (для лога)
   */
  rampTo(trainId, targetSpeed, source = "auto") {
    this.clearRamp(trainId);

    const train = this.trains[trainId];
    if (!train?.connected || !train?.motor) {
      this.log.warn(
        `rampTo(${targetSpeed}): no motor or disconnected`,
        trainId,
      );
      return;
    }

    // Зажимаем в мёртвую зону (меньше MIN_MOVE_POWER → не поедет)
    if (targetSpeed !== 0) {
      const dir = Math.sign(targetSpeed);
      if (Math.abs(targetSpeed) < MIN_MOVE_POWER) {
        this._dbg(
          `rampTo: ${targetSpeed} → clamped to ${dir * MIN_MOVE_POWER}`,
          trainId,
        );
        targetSpeed = dir * MIN_MOVE_POWER;
      }
    }

    if (train.speed === targetSpeed) {
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });
      return;
    }

    this.log.info(
      `[${source}] rampTo: ${train.speed} → ${targetSpeed}`,
      trainId,
    );

    // Кикстарт: короткий импульс большей мощности при старте из 0
    if (train.speed === 0 && targetSpeed !== 0) {
      const dir = Math.sign(targetSpeed);
      const kickSpeed = dir * Math.max(KICKSTART_PWR, Math.abs(targetSpeed));
      const token = Date.now();
      this._kickToken[trainId] = token;

      this._dbg(`kickstart: ${kickSpeed} на ${KICKSTART_MS} мс`, trainId);
      this._write(trainId, kickSpeed);
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });

      setTimeout(() => {
        // Проверяем, что токен не изменился (не было новой команды)
        if (this._kickToken?.[trainId] !== token) return;

        const t = this.trains[trainId];
        if (!t?.connected || !t?.motor) return;

        if (t.speed === targetSpeed) {
          this.io.emit("speedUpdate", { trainId, speed: targetSpeed });
          return;
        }

        this._startRamp(trainId, targetSpeed);
      }, KICKSTART_MS);

      return;
    }

    // Обычный рамп (без кикстарта)
    this._startRamp(trainId, targetSpeed);
  }

  /**
   * Запускает ступенчатый рамп (разгон/торможение)
   * @private
   */
  _startRamp(trainId, targetSpeed) {
    this.clearRamp(trainId);

    const train = this.trains[trainId];
    if (!train?.connected || !train?.motor) return;

    if (train.speed === targetSpeed) {
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });
      return;
    }

    const stepSize = train.rampStepSize || 10;
    const stepMs = train.rampStepMs || 100;
    this._dbg(`ramp: шаг ${stepSize}% каждые ${stepMs} мс`, trainId);

    let stepCount = 0;

    const performStep = () => {
      const t = this.trains[trainId];
      const r = this._ramp[trainId];

      if (!r || !t?.connected || !t?.motor) {
        this.clearRamp(trainId);
        return;
      }

      const diff = r.target - t.speed;
      const delta = Math.sign(diff) * Math.min(stepSize, Math.abs(diff));
      const nextSpeed = t.speed + delta;
      stepCount++;

      this._dbg(
        `step #${stepCount}: ${t.speed} → ${nextSpeed} (цель ${r.target})`,
        trainId,
      );

      try {
        this._write(trainId, nextSpeed);
        this.io.emit("speedUpdate", { trainId, speed: nextSpeed });
      } catch (e) {
        this.log.error(`ramp step error: ${e.message}`, trainId);
        this.clearRamp(trainId);
        return;
      }

      if (nextSpeed === r.target) {
        this._dbg(`ramp завершён на ${nextSpeed}`, trainId);
        this.clearRamp(trainId);
      }
    };

    // Watchdog — защита от зависания рампа
    const watchdog = setTimeout(() => {
      this.log.warn(`ramp watchdog: прерван (>${WATCHDOG_MS} мс)`, trainId);
      this.clearRamp(trainId);
    }, WATCHDOG_MS);

    this._ramp[trainId] = {
      target: targetSpeed,
      stepTimer: null,
      watchdog,
    };

    performStep(); // первый шаг сразу

    if (this._ramp[trainId]) {
      this._ramp[trainId].stepTimer = setInterval(performStep, stepMs);
    }
  }

  // ──────────────────────────────────────────────── МГНОВЕННАЯ ОСТАНОВКА ────────────────────────────────────────────────

  /**
   * Мгновенная остановка поезда с запуском braking loop
   * @param {string} trainId
   * @param {string} [source="auto"]
   */
  stopNow(trainId, source = "auto") {
    if (this._kickToken) delete this._kickToken[trainId];

    const train = this.trains[trainId];
    const prevSpeed = train?.speed ?? "?";

    this.log.info(`[${source}] stopNow (было ${prevSpeed})`, trainId);

    this.clearRamp(trainId);
    this.io.emit("speedUpdate", { trainId, speed: 0 });

    if (!train?.connected || !train?.motor) {
      this.log.warn("stopNow: нет мотора или связи", trainId);
      if (train) train.speed = 0;
      return;
    }

    // Оптимизация: если уже стоим и bloop работает — не перезапускаем
    if (train.speed === 0 && this._bloop[trainId]) {
      this._dbg("stopNow: уже стоит + bloop активен → один brake()", trainId);
      this._motorSet(train.motor, 0, "stopNow:extra", trainId);
      return;
    }

    this._clearStopState(trainId);
    if (train) train.speed = 0;

    try {
      this._write(trainId, 0);
      this.log.event("■ STOP", trainId);
    } catch (e) {
      this.log.warn(`stopNow ошибка: ${e.message}`, trainId);
    }
  }

  /**
   * Экстренная остановка всех поездов
   * @param {string} reason
   */
  stopAll(reason = "E-STOP") {
    this.log.event(`🛑 ${reason}`);
    for (const id of Object.keys(this.trains)) {
      this.stopNow(id, reason);
    }
  }

  // ──────────────────────────────────────────────── KEEPALIVE ────────────────────────────────────────────────

  /**
   * Запускает периодическую подстраховку команды скорости
   * (на случай потери пакета по BLE)
   */
  startKeepalive(trainId) {
    this.stopKeepalive(trainId);

    this._kalive[trainId] = setInterval(() => {
      const t = this.trains[trainId];
      if (!t?.connected || !t?.motor || this._ramp[trainId] || t.speed === 0) {
        return;
      }
      this._dbg(`[keepalive] setPower(${t.speed})`, trainId);
      this._motorSet(t.motor, t.speed, "keepalive", trainId);
    }, KEEPALIVE_MS);
  }

  stopKeepalive(trainId) {
    if (this._kalive[trainId]) {
      clearInterval(this._kalive[trainId]);
      delete this._kalive[trainId];
    }
  }

  isRamping(trainId) {
    return !!this._ramp[trainId];
  }

  /**
   * Сбрасывает состояние торможения (вызывается при реконнекте)
   */
  resetStopState(trainId) {
    this._cancelStopTimers(trainId);
    delete this._stopping[trainId];
    this._dbg("stop-state сброшен (реконнект)", trainId);
  }

  /**
   * Очистка при завершении работы сервера
   */
  destroy() {
    Object.keys(this._kalive).forEach((id) => this.stopKeepalive(id));
    Object.keys(this._ramp).forEach((id) => this.clearRamp(id));
    Object.keys(this._stopQ).forEach((id) => this._cancelStopTimers(id));
    Object.keys(this._bloop).forEach((id) => this._stopBloop(id));
  }
}

module.exports = RampEngine;
