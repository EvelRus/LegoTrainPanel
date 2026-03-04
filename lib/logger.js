"use strict";

/**
 * @file logger.js
 * @description Универсальный логгер приложения.
 *
 * Обеспечивает три канала вывода одновременно:
 *   1. Цветной вывод в process.stdout (консоль сервера)
 *   2. Запись в файл data/logs/YYYY-MM-DD.log (ротация по суткам)
 *   3. Трансляция записей подключённым браузерам через Socket.IO
 *
 * Хранит последние MAX_MEM записей в памяти для отдачи новым клиентам.
 *
 * Поддерживаемые уровни:
 *   INFO  — штатные события и информация
 *   WARN  — предупреждения, некритичные ситуации
 *   ERROR — ошибки, требующие внимания
 *   EVENT — ключевые пользовательские события (старт, стоп, сценарий)
 */

const fs = require("fs");
const path = require("path");

/** Максимальное количество записей, хранящихся в оперативной памяти */
const MAX_MEM = 500;

class Logger {
  /**
   * Создаёт логгер и гарантирует существование директории логов.
   *
   * @param {string} logsDir - Абсолютный путь к директории для файлов логов.
   *                           Директория создаётся рекурсивно, если не существует.
   */
  constructor(logsDir) {
    /** @type {string} Путь к директории логов */
    this.logsDir = logsDir;

    /** @type {Array<{ts:string, level:string, trainId:string|null, message:string}>}
     *  Кольцевой буфер последних MAX_MEM записей */
    this.mem = [];

    /** @type {import("socket.io").Server|null} Экземпляр Socket.IO, если подключён */
    this._io = null;

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }

  /**
   * Привязывает Socket.IO-сервер для трансляции логов в браузер.
   * Вызывается один раз после инициализации сервера.
   *
   * @param {import("socket.io").Server} io - Экземпляр Socket.IO Server.
   */
  attach(io) {
    this._io = io;
  }

  /**
   * Внутренний метод записи. Формирует запись лога и направляет её
   * во все три канала вывода.
   *
   * @private
   * @param {"INFO"|"WARN"|"ERROR"|"EVENT"} level  - Уровень лога.
   * @param {string|null}                   trainId - UUID хаба (или null для глобальных сообщений).
   * @param {string}                        message - Текст сообщения.
   * @returns {{ts:string, level:string, trainId:string|null, message:string}} Созданная запись.
   */
  _write(level, trainId, message) {
    const ts = new Date().toISOString();
    const entry = { ts, level, trainId: trainId || null, message };

    // ── 1. Кольцевой буфер в памяти ────────────────────────────────
    this.mem.push(entry);
    if (this.mem.length > MAX_MEM) this.mem.shift();

    // ── 2. Запись в файл (один файл на сутки: YYYY-MM-DD.log) ──────
    const date = ts.slice(0, 10);
    const line = `[${ts}] [${level}]${trainId ? ` [${trainId}]` : ""} ${message}\n`;
    try {
      fs.appendFileSync(path.join(this.logsDir, `${date}.log`), line);
    } catch (_) {
      /* Ошибки записи в файл игнорируем — не критично */
    }

    // ── 3. Цветной вывод в консоль сервера ─────────────────────────
    /** ANSI-коды цветов для каждого уровня */
    const C = {
      INFO: "\x1b[36m", // Бирюзовый
      WARN: "\x1b[33m", // Жёлтый
      ERROR: "\x1b[31m", // Красный
      EVENT: "\x1b[32m", // Зелёный
    };
    process.stdout.write(
      `${C[level] || ""}[${level}]\x1b[0m${trainId ? ` [${trainId}]` : ""} ${message}\n`,
    );

    // ── 4. Трансляция клиентам через Socket.IO ─────────────────────
    if (this._io) this._io.emit("log", entry);

    return entry;
  }

  // ─── Публичные методы записи ────────────────────────────────────

  /**
   * Записывает информационное сообщение (уровень INFO).
   * @param {string}      msg - Текст сообщения.
   * @param {string|null} [tid] - UUID хаба (опционально).
   */
  info(msg, tid) {
    return this._write("INFO", tid, msg);
  }

  /**
   * Записывает предупреждение (уровень WARN).
   * @param {string}      msg - Текст сообщения.
   * @param {string|null} [tid] - UUID хаба (опционально).
   */
  warn(msg, tid) {
    return this._write("WARN", tid, msg);
  }

  /**
   * Записывает сообщение об ошибке (уровень ERROR).
   * @param {string}      msg - Текст сообщения.
   * @param {string|null} [tid] - UUID хаба (опционально).
   */
  error(msg, tid) {
    return this._write("ERROR", tid, msg);
  }

  /**
   * Записывает ключевое событие (уровень EVENT).
   * Используется для старта/стопа поезда, запуска сценариев и т.п.
   * @param {string}      msg - Текст сообщения.
   * @param {string|null} [tid] - UUID хаба (опционально).
   */
  event(msg, tid) {
    return this._write("EVENT", tid, msg);
  }

  // ─── Методы для работы с историей ──────────────────────────────

  /**
   * Возвращает последние N записей из буфера в памяти.
   * Используется при подключении нового браузера для синхронизации лога.
   *
   * @param {number} [n=200] - Количество последних записей.
   * @returns {Array<object>} Срез буфера.
   */
  getLast(n = 200) {
    return this.mem.slice(-n);
  }

  /**
   * Возвращает список файлов логов, отсортированных по убыванию даты
   * (самые свежие — первыми). Используется в API `/api/logs/files`.
   *
   * @returns {string[]} Массив имён файлов вида `["2026-03-04.log", ...]`.
   */
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

  /**
   * Читает содержимое файла лога по имени.
   * Имя файла санируется через `path.basename` для защиты от path-traversal.
   *
   * @param {string} filename - Имя файла (например, `"2026-03-04.log"`).
   * @returns {string|null} Содержимое файла в UTF-8, или null если файл не найден.
   */
  readLogFile(filename) {
    const safe = path.basename(filename);
    const full = path.join(this.logsDir, safe);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf-8");
  }
}

module.exports = Logger;
