"use strict";

const WATCHDOG_MS = 15000;
const KEEPALIVE_MS = 12000;

class RampEngine {
  /**
   * @param {object} trains
   * @param {object} io
   * @param {Logger} logger
   */
  constructor(trains, io, logger) {
    this.trains = trains;
    this.io = io;
    this.log = logger;
    this._ramp = {};
    this._kalive = {};
  }

  _write(train, speed) {
    if (!train.motor) return;
    const motor = train.motor;

    if (speed === 0) {
      const sendStop = (m) => {
        if (!m) return;
        try {
          if (typeof m.brake === "function") m.brake();
        } catch (_) {}
        try {
          if (typeof m.setPower === "function") m.setPower(0);
          else if (typeof m.setSpeed === "function") m.setSpeed(0);
        } catch (_) {}
      };

      sendStop(motor);
      setTimeout(() => sendStop(train.motor), 80);
      setTimeout(() => sendStop(train.motor), 250);
      setTimeout(() => sendStop(train.motor), 500);
    } else {
      try {
        if (typeof motor.setPower === "function") motor.setPower(speed);
        else if (typeof motor.setSpeed === "function") motor.setSpeed(speed);
        else
          this.log.warn(`_write: мотор не имеет setPower/setSpeed`, train.name);
      } catch (e) {
        this.log.warn(`_write error: ${e.message}`, train.name);
      }
    }
    train.speed = speed;
    this._setLED(train);
  }

  _setLED(train) {
    if (!train.hub) return;
    try {
      const PoweredUP = require("node-poweredup");
      const C = PoweredUP.Consts.Color;
      const color =
        train.speed > 0 ? C.GREEN : train.speed < 0 ? C.BLUE : C.RED;
      train.hub.setLEDColor(color);
    } catch (_) {}
  }

  setLEDManual(trainId, colorName) {
    const train = this.trains[trainId];
    if (!train?.hub) return;
    try {
      const PoweredUP = require("node-poweredup");
      const C = PoweredUP.Consts.Color;
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

  clearRamp(trainId) {
    const rs = this._ramp[trainId];
    if (!rs) return;
    if (rs.stepTimer) clearInterval(rs.stepTimer);
    if (rs.watchdog) clearTimeout(rs.watchdog);
    this._ramp[trainId] = null;
  }

  rampTo(trainId, targetSpeed) {
    this.clearRamp(trainId);
    const train = this.trains[trainId];
    if (!train?.connected || !train?.motor) return;

    if (train.speed === targetSpeed) {
      this.io.emit("speedUpdate", { trainId, speed: targetSpeed });
      return;
    }

    const stepSize = train.rampStepSize || 10;
    const stepMs = train.rampStepMs || 100;

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

      try {
        this._write(t, next);
        this.io.emit("speedUpdate", { trainId, speed: next });
      } catch (e) {
        this.log.error(`Рамп ошибка: ${e.message}`, trainId);
        this.clearRamp(trainId);
        return;
      }
      if (next === rs.target) this.clearRamp(trainId);
    };

    const watchdog = setTimeout(() => {
      this.log.warn(`Watchdog: рамп прерван (>${WATCHDOG_MS}мс)`, trainId);
      this.clearRamp(trainId);
    }, WATCHDOG_MS);

    this._ramp[trainId] = { target: targetSpeed, stepTimer: null, watchdog };

    step();

    if (this._ramp[trainId]) {
      this._ramp[trainId].stepTimer = setInterval(step, stepMs);
    }
  }

  stopNow(trainId) {
    this.clearRamp(trainId);
    const train = this.trains[trainId];
    if (!train?.connected || !train?.motor) return;
    try {
      this._write(train, 0);
      this.io.emit("speedUpdate", { trainId, speed: 0 });
      this.log.event("■ СТОП", trainId);
    } catch (e) {
      this.log.warn(`Стоп ошибка: ${e.message}`, trainId);
    }
  }

  stopAll(reason = "E-STOP") {
    this.log.event(`🛑 ${reason}: остановка всех поездов`);
    for (const id of Object.keys(this.trains)) this.stopNow(id);
  }

  startKeepalive(trainId) {
    this.stopKeepalive(trainId);
    this._kalive[trainId] = setInterval(() => {
      const t = this.trains[trainId];
      if (!t?.connected || !t?.motor) return;
      if (this._ramp[trainId]) return;
      try {
        t.motor.setPower(t.speed);
      } catch (_) {}
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
}

module.exports = RampEngine;
