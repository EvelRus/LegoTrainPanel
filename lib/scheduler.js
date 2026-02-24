"use strict";
const fs = require("fs");
const path = require("path");

function loadJSON(p, def) {
  if (!fs.existsSync(p)) return def;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {
    return def;
  }
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

class Scheduler {
  /**
   * @param {string}      dataDir
   * @param {RampEngine}  ramp
   * @param {Logger}      log
   * @param {object}      io
   */
  constructor(dataDir, ramp, log, io) {
    this.ramp = ramp;
    this.log = log;
    this.io = io;

    this._paths = {
      scenarios: path.join(dataDir, "scenarios.json"),
      schedules: path.join(dataDir, "schedules.json"),
      consists: path.join(dataDir, "consists.json"),
    };

    this.scenarios = loadJSON(this._paths.scenarios, {});
    this.schedules = loadJSON(this._paths.schedules, {});
    this.consists = loadJSON(this._paths.consists, {});
    this._playing = {};
    this._recording = null;

    this._schedTick = setInterval(() => this._checkSchedules(), 60000);
  }

  saveConsist(id, consist) {
    this.consists[id] = consist;
    saveJSON(this._paths.consists, this.consists);
    this.io.emit("consistsUpdate", this.consists);
  }

  deleteConsist(id) {
    delete this.consists[id];
    saveJSON(this._paths.consists, this.consists);
    this.io.emit("consistsUpdate", this.consists);
  }

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

  onTrainSpeedChange(trainId, speed) {
    for (const c of Object.values(this.consists)) {
      if ((c.trainIds || []).includes(trainId)) {
        c.speed = speed;
      }
    }
    this.io.emit("consistsUpdate", this.consists);
  }

  startRecording(name) {
    this._recording = { name, steps: [], startTs: Date.now() };
    this.log.info(`Запись сценария "${name}" начата`);
    this.io.emit("scenarioRecording", { active: true, name });
  }

  /** Вызывается при каждом setSpeed во время записи */
  recordStep(trainId, speed) {
    if (!this._recording) return;
    this._recording.steps.push({
      trainId,
      speed,
      delay: Date.now() - this._recording.startTs,
    });
  }

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

  isRecording() {
    return !!this._recording;
  }
  recordingName() {
    return this._recording?.name;
  }

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

  playScenario(name) {
    const sc = this.scenarios[name];
    if (!sc?.steps?.length) return;
    this.stopScenario(name);

    this.log.event(`▶ Сценарий "${name}"`);
    const timeouts = [];

    sc.steps.forEach((step) => {
      timeouts.push(
        setTimeout(() => {
          if (!this._playing[name]) return;
          if (step.speed === 0) this.ramp.stopNow(step.trainId);
          else this.ramp.rampTo(step.trainId, step.speed);
        }, step.delay),
      );
    });

    const maxDelay = sc.steps.reduce((m, s) => Math.max(m, s.delay), 0);
    timeouts.push(
      setTimeout(() => {
        delete this._playing[name];
        this.io.emit("scenarioPlayback", { name, active: false });
      }, maxDelay + 1000),
    );

    this._playing[name] = { timeouts };
    this.io.emit("scenarioPlayback", { name, active: true });
  }

  stopScenario(name) {
    const sp = this._playing[name];
    if (!sp) return;
    sp.timeouts.forEach((t) => clearTimeout(t));
    delete this._playing[name];
    this.io.emit("scenarioPlayback", { name, active: false });
    this.log.info(`■ Сценарий "${name}" остановлен`);
  }

  stopAllScenarios() {
    for (const name of Object.keys(this._playing)) this.stopScenario(name);
  }

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
        if (action.consistId !== undefined)
          this.setConsistSpeed(action.consistId, action.speed ?? 0);
        break;
    }
  }

  destroy() {
    clearInterval(this._schedTick);
    this.stopAllScenarios();
  }
}

module.exports = Scheduler;
