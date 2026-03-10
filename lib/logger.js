"use strict";

/**
 * @file logger.js
 * @description Универсальный многоцелевой логгер приложения.
 *
 * Основные особенности:
 *   - Одновременный вывод в три канала:
 *       1. Цветная консоль сервера (process.stdout) с ANSI-цветами
 *       2. Файлы логов в data/logs/YYYY-MM-DD.log (ротация по суткам)
 *       3. Трансляция в реальном времени всем подключённым браузерам через Socket.IO
 *   - Кольцевой буфер последних записей в памяти (для быстрой отдачи новым клиентам)
 *   - Уровни логирования: INFO, WARN, ERROR, EVENT (с разными цветами и стилем)
 *   - Поддержка привязки сообщений к конкретному поезду (trainId)
 *   - Защита от ошибок записи в файл (не прерывает работу сервера)
 *
 * Использование:
 *   log.info("Сообщение", trainId?)          → обычная информация
 *   log.warn("Предупреждение", trainId?)     → некритичные проблемы
 *   log.error("Ошибка", trainId?)            → критичные ошибки
 *   log.event("Важное событие", trainId?)    → старт/стоп, сценарии, E-STOP и т.п.
 */

const fs = require("fs");
const path = require("path");

/** Максимальное количество записей, хранящихся в памяти (кольцевой буфер) */
const MAX_MEM = 500;

class Logger {
  /**
   * Инициализирует логгер и создаёт директорию логов, если её нет.
   *
   * @param {string} logsDir - Абсолютный путь к папке логов (data/logs).
   *                           Создаётся рекурсивно при необходимости.
   */
  constructor(logsDir) {
    /** @type {string} Путь к директории хранения файлов логов */
    this.logsDir = logsDir;

    /**
     * @type {Array<{ts: string, level: string, trainId: string|null, message: string}>}
     * Кольцевой буфер последних MAX_MEM записей (для отдачи новым клиентам)
     */
    this.mem = [];

    /** @type {import("socket.io").Server|null} Socket.IO сервер для трансляции логов */
    this._io = null;

    // Гарантируем существование директории
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }

  /**
   * Привязывает Socket.IO сервер для вещания логов подключённым браузерам.
   * Должно вызываться один раз после создания http-сервера и socket.io.
   *
   * @param {import("socket.io").Server} io - экземпляр Socket.IO Server
   */
  attach(io) {
    this._io = io;
  }

  /**
   * Основной внутренний метод записи лога.
   * Формирует запись, сохраняет её во все каналы и возвращает объект записи.
   *
   * @private
   * @param {"INFO"|"WARN"|"ERROR"|"EVENT"} level - уровень сообщения
   * @param {string|null} trainId - UUID поезда (или null для глобальных событий)
   * @param {string} message - текст сообщения
   * @returns {Object} созданная запись лога
   */
  _write(level, trainId, message) {
    const ts = new Date().toISOString();
    const entry = { ts, level, trainId: trainId || null, message };

    // 1. Добавляем в кольцевой буфер в памяти
    this.mem.push(entry);
    if (this.mem.length > MAX_MEM) this.mem.shift();

    // 2. Формируем строку для файла и консоли
    const fileLine = `[${ts}] [${level}]${trainId ? ` [${trainId}]` : ""} ${message}\n`;

    // 3. Запись в файл (ежедневная ротация: YYYY-MM-DD.log)
    const dateStr = ts.slice(0, 10); // 2026-03-10
    const logPath = path.join(this.logsDir, `${dateStr}.log`);

    try {
      fs.appendFileSync(logPath, fileLine, "utf-8");
    } catch (e) {
      // Ошибка записи в файл не должна ломать сервер — просто молчим
      // (в продакшене можно добавить fallback в stderr)
    }

    // 4. Цветной вывод в консоль сервера
    const colors = {
      INFO: "\x1b[36m", // бирюзовый
      WARN: "\x1b[33m", // жёлтый
      ERROR: "\x1b[31m", // красный
      EVENT: "\x1b[32m", // зелёный
    };

    const color = colors[level] || "";
    process.stdout.write(
      `${color}[${level}]\x1b[0m${trainId ? ` [${trainId.slice(0, 8)}]` : ""} ${message}\n`,
    );

    // 5. Отправляем запись всем подключённым клиентам
    if (this._io) {
      this._io.emit("log", entry);
    }

    return entry;
  }

  // ──────────────────────────────────────────────── Публичные методы логирования ────────────────────────────────────────────────

  /**
   * Информационное сообщение (INFO) — штатные события, состояния, подключения.
   *
   * @param {string} msg - текст сообщения
   * @param {string|null} [tid] - UUID поезда (опционально)
   * @returns {Object} созданная запись
   */
  info(msg, tid = null) {
    return this._write("INFO", tid, msg);
  }

  /**
   * Предупреждение (WARN) — некритичные проблемы, неожиданное поведение,
   * потенциально опасные ситуации.
   *
   * @param {string} msg
   * @param {string|null} [tid]
   * @returns {Object}
   */
  warn(msg, tid = null) {
    return this._write("WARN", tid, msg);
  }

  /**
   * Ошибка (ERROR) — что-то пошло не так, требуется внимание разработчика/оператора.
   *
   * @param {string} msg
   * @param {string|null} [tid]
   * @returns {Object}
   */
  error(msg, tid = null) {
    return this._write("ERROR", tid, msg);
  }

  /**
   * Ключевое событие (EVENT) — важные действия пользователя или системы:
   * старт/стоп поезда, запуск сценария, E-STOP, переподключение и т.п.
   * Выделяется зелёным цветом и часто используется в интерфейсе.
   *
   * @param {string} msg
   * @param {string|null} [tid]
   * @returns {Object}
   */
  event(msg, tid = null) {
    return this._write("EVENT", tid, msg);
  }

  // ──────────────────────────────────────────────── Методы для работы с историей логов ────────────────────────────────────────────────

  /**
   * Возвращает последние N записей из памяти.
   * Используется при подключении нового клиента для начальной синхронизации лога.
   *
   * @param {number} [n=200] - сколько последних записей вернуть
   * @returns {Array<Object>} массив записей (от старых к новым)
   */
  getLast(n = 200) {
    return this.mem.slice(-n);
  }

  /**
   * Возвращает список всех файлов логов в директории, отсортированных
   * от самых новых к старым (по имени файла).
   *
   * Используется в API `/api/logs/files`.
   *
   * @returns {string[]} массив имён файлов, например ["2026-03-10.log", ...]
   */
  listLogFiles() {
    try {
      return fs
        .readdirSync(this.logsDir)
        .filter((f) => f.endsWith(".log"))
        .sort() // лексикографическая сортировка
        .reverse(); // новые файлы — первыми
    } catch (_) {
      return [];
    }
  }

  /**
   * Читает содержимое одного файла лога по имени.
   * Имя файла проходит через path.basename для защиты от path traversal.
   *
   * Используется в API `/api/logs/file?name=...`
   *
   * @param {string} filename - имя файла (например "2026-03-10.log")
   * @returns {string|null} содержимое файла в UTF-8 или null, если файла нет
   */
  readLogFile(filename) {
    const safeName = path.basename(filename); // защита от ../ и т.п.
    const fullPath = path.join(this.logsDir, safeName);

    if (!fs.existsSync(fullPath)) return null;

    try {
      return fs.readFileSync(fullPath, "utf-8");
    } catch (_) {
      return null;
    }
  }
}

module.exports = Logger;
