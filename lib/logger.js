"use strict";
const fs = require("fs");
const path = require("path");

const MAX_MEM = 500;

class Logger {
  constructor(logsDir) {
    this.logsDir = logsDir;
    this.mem = [];
    this._io = null;
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  }

  attach(io) {
    this._io = io;
  }

  _write(level, trainId, message) {
    const ts = new Date().toISOString();
    const entry = { ts, level, trainId: trainId || null, message };

    this.mem.push(entry);
    if (this.mem.length > MAX_MEM) this.mem.shift();

    const date = ts.slice(0, 10);
    const line = `[${ts}] [${level}]${trainId ? ` [${trainId}]` : ""} ${message}\n`;
    try {
      fs.appendFileSync(path.join(this.logsDir, `${date}.log`), line);
    } catch (_) {}

    const C = {
      INFO: "\x1b[36m",
      WARN: "\x1b[33m",
      ERROR: "\x1b[31m",
      EVENT: "\x1b[32m",
    };
    process.stdout.write(
      `${C[level] || ""}[${level}]\x1b[0m${trainId ? ` [${trainId}]` : ""} ${message}\n`,
    );

    if (this._io) this._io.emit("log", entry);

    return entry;
  }

  info(msg, tid) {
    return this._write("INFO", tid, msg);
  }
  warn(msg, tid) {
    return this._write("WARN", tid, msg);
  }
  error(msg, tid) {
    return this._write("ERROR", tid, msg);
  }
  event(msg, tid) {
    return this._write("EVENT", tid, msg);
  }

  getLast(n = 200) {
    return this.mem.slice(-n);
  }

  listLogFiles() {
    try {
      return fs
        .readdirSync(this.logsDir)
        .filter((f) => f.endsWith(".log"))
        .sort()
        .reverse();
    } catch (_) {
      return [];
    }
  }

  readLogFile(filename) {
    const safe = path.basename(filename);
    const full = path.join(this.logsDir, safe);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf-8");
  }
}

module.exports = Logger;
