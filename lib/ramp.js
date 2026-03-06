"use strict";

/**
 * @file ramp.js
 * @description Движок плавного управления скоростью поездов (RampEngine).
 *
 * ИСПРАВЛЕНИЯ v2:
 *   - FIX: doStop retry проверяет train.speed === 0 перед отправкой.
 *     Устранено «зависание» при смене направления: рамп проходил через 0,
 *     stop-retry через 800 мс догонял уже разогнавшийся поезд.
 *   - FIX: stopNow сбрасывает _stopping ПЕРЕД вызовом _write, чтобы
 *     явный стоп (кнопка / E-STOP) всегда доходил до мотора.
 *   - FIX: MIN_MOVE_POWER снижена 20→15: шаг ±10 теперь работает.
 *   - FIX: если поезд отключился во время рампа — stopNow всё равно
 *     отправляет speedUpdate клиенту (UI синхронизируется).
 */

const WATCHDOG_MS = 15_000;
const KEEPALIVE_MS = 25_000;
const MIN_MOVE_POWER = 15; // ← было 20; снижено чтобы шаги ±10% работали
const KICKSTART_PWR = 40;
const KICKSTART_MS = 150;
const STOP_RETRY_MS = [800]; // один ретрай через 800 мс

class RampEngine {
  constructor(trains, io, logger, debug = false) {
    this.trains = trains;
    this.io = io;
    this.log = logger;
    this.debug = debug;

    this._ramp = {};
    this._kalive = {};
    this._stopQ = {};
    this._stopping = {};
    this._kickToken = {};
  }

  // ═══════════════════════════════ ВСПОМОГАТЕЛЬНЫЕ ══

  _dbg(msg, tid) {
    if (this.debug) this.log.info(`[DBG] ${msg}`, tid);
  }

  _cancelStopTimers(trainId) {
    const ts = this._stopQ[trainId];
    if (ts && ts.length) {
      ts.forEach(clearTimeout);
      this._stopQ[trainId] = null;
    }
  }

  _clearStopState(trainId) {
    this._cancelStopTimers(trainId);
    delete this._stopping[trainId];
    this._dbg("stop-state cleared", trainId);
  }

  // ═══════════════════════════════ ЗАПИСЬ В МОТОР ══

  _write(trainId, speed) {
    const train = this.trains[trainId];
    if (!train) return;

    if (speed === 0) {
      if (this._stopping[trainId]) {
        this._dbg("stop deduplicated", trainId);
        return;
      }
      this._stopping[trainId] = true;
      this._dbg("stop sequence START", trainId);

      /**
       * FIX: перед каждым ретраем проверяем train.speed.
       * Если рамп уже перешёл через 0 и поехал в обратную сторону,
       * ретрай НЕ должен снова тормозить поезд.
       */
      const doStop = (label) => {
        const t = this.trains[trainId];
        if (!t) return;
        // ← ГЛАВНОЕ ИСПРАВЛЕНИЕ ЗАВИСАНИЙ
        if (t.speed !== 0) {
          this._dbg(`${label}: speed is now ${t.speed}, skip retry`, trainId);
          return;
        }
        const m = t.motor;
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
      };

      doStop("stop[0]");

      const timers = STOP_RETRY_MS.map((ms, i) =>
        setTimeout(() => doStop(`stop[${i + 1}] retry+${ms}ms`), ms),
      );
      this._stopQ[trainId] = timers;

      const last = Math.max(...STOP_RETRY_MS);
      setTimeout(() => {
        delete this._stopping[trainId];
        this._dbg("stop sequence DONE", trainId);
      }, last + 100);
    } else {
      this._clearStopState(trainId);

      const m = train.motor;
      if (!m) {
        this._dbg(`_write(${speed}): no motor`, trainId);
        return;
      }
      this._dbg(`_write: setPower(${speed})`, trainId);
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

  // ══════════════════════════════════════════ LED ══

  _setLED(train) {
    if (!train?.hub) return;
    try {
      const { Consts } = require("node-poweredup");
      const C = Consts.Color;
      train.hub.setLEDColor(
        train.speed > 0 ? C.GREEN : train.speed < 0 ? C.BLUE : C.RED,
      );
    } catch (_) {}
  }

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

  // ══════════════════════════════════════════ РАМП ══

  clearRamp(trainId) {
    const rs = this._ramp[trainId];
    if (!rs) return;
    if (rs.stepTimer) clearInterval(rs.stepTimer);
    if (rs.watchdog) clearTimeout(rs.watchdog);
    this._ramp[trainId] = null;
    this._dbg("ramp cleared", trainId);
  }

  rampTo(trainId, targetSpeed, source = "auto") {
    this.clearRamp(trainId);

    const train = this.trains[trainId];
    if (!train?.connected || !train?.motor) {
      this.log.warn(`rampTo(${targetSpeed}): no motor/connection`, trainId);
      return;
    }

    // Мёртвая зона — значения ниже MIN_MOVE_POWER зажимаются
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

    // Кикстарт при старте из нуля
    if (train.speed === 0 && targetSpeed !== 0) {
      const dir = Math.sign(targetSpeed);
      const kickSpd = dir * Math.max(KICKSTART_PWR, Math.abs(targetSpeed));
      const kickToken = Date.now();
      this._kickToken[trainId] = kickToken;

      this._dbg(`kickstart: ${kickSpd} for ${KICKSTART_MS}ms`, trainId);
      this._write(trainId, kickSpd);
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });

      setTimeout(() => {
        if (this._kickToken?.[trainId] !== kickToken) return;
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

    this._startRamp(trainId, targetSpeed);
  }

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
    this._dbg(`ramp: step=${stepSize}% every ${stepMs}ms`, trainId);

    let stepN = 0;

    const step = () => {
      const t = this.trains[trainId];
      const rs = this._ramp[trainId];
      if (!rs || !t?.connected || !t?.motor) {
        this.clearRamp(trainId);
        return;
      }

      const diff = rs.target - t.speed;
      const delta = Math.sign(diff) * Math.min(stepSize, Math.abs(diff));
      const next = t.speed + delta;
      stepN++;

      this._dbg(
        `step #${stepN}: ${t.speed}→${next} (target=${rs.target})`,
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

      if (next === rs.target) {
        this._dbg(`ramp complete at ${next}`, trainId);
        this.clearRamp(trainId);
      }
    };

    const watchdog = setTimeout(() => {
      this.log.warn(`watchdog: ramp aborted (>${WATCHDOG_MS}ms)`, trainId);
      this.clearRamp(trainId);
    }, WATCHDOG_MS);

    this._ramp[trainId] = { target: targetSpeed, stepTimer: null, watchdog };

    step();
    if (this._ramp[trainId]) {
      this._ramp[trainId].stepTimer = setInterval(step, stepMs);
    }
  }

  // ══════════════════════════════════════════ СТОП ══

  stopNow(trainId, source = "auto") {
    if (this._kickToken) delete this._kickToken[trainId];

    const train = this.trains[trainId];
    this.log.info(
      `[${source}] stopNow (speed was ${train?.speed ?? "?"})`,
      trainId,
    );

    this.clearRamp(trainId);

    /**
     * FIX: сбрасываем _stopping ДО установки train.speed = 0.
     * Если предыдущий стоп «завис» в дедупликации, явный stopNow
     * (кнопка СТОП, E-STOP) должен гарантированно пройти.
     */
    this._clearStopState(trainId);

    if (train) train.speed = 0;

    // Всегда уведомляем UI (даже если мотор недоступен)
    this.io.emit("speedUpdate", { trainId, speed: 0 });

    if (!train?.connected || !train?.motor) {
      this.log.warn("stopNow: no motor/connection", trainId);
      return;
    }

    try {
      this._write(trainId, 0);
      this.log.event("■ STOP", trainId);
    } catch (e) {
      this.log.warn(`stopNow error: ${e.message}`, trainId);
    }
  }

  stopAll(reason = "E-STOP") {
    this.log.event(`🛑 ${reason}`);
    for (const id of Object.keys(this.trains)) {
      this.stopNow(id, reason);
    }
  }

  // ══════════════════════════════════════ KEEPALIVE ══

  startKeepalive(trainId) {
    this.stopKeepalive(trainId);
    this._kalive[trainId] = setInterval(() => {
      const t = this.trains[trainId];
      if (!t?.connected || !t?.motor || this._ramp[trainId] || t.speed === 0)
        return;
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

  stopKeepalive(trainId) {
    if (this._kalive[trainId]) {
      clearInterval(this._kalive[trainId]);
      delete this._kalive[trainId];
    }
  }

  isRamping(trainId) {
    return !!this._ramp[trainId];
  }

  resetStopState(trainId) {
    this._cancelStopTimers(trainId);
    delete this._stopping[trainId];
    this._dbg("stop-state reset (reconnect)", trainId);
  }

  destroy() {
    Object.keys(this._kalive).forEach((id) => this.stopKeepalive(id));
    Object.keys(this._ramp).forEach((id) => this.clearRamp(id));
    Object.keys(this._stopQ).forEach((id) => this._cancelStopTimers(id));
  }
}

module.exports = RampEngine;
