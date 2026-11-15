/**
 * JARVIS database — one local SQLite file, no server, no cloud, no cost.
 *
 * Lives at <repo>/data/jarvis.db (override with JARVIS_DB_PATH). Built on
 * Node's built-in `node:sqlite`, so there is nothing to install and nothing to
 * configure; a personal desktop assistant should be able to back its whole
 * memory up by copying one file.
 *
 * Everything the assistant is asked to remember lives here:
 *   preferences    explicit "remember that / prefer X" facts
 *   projects       the user's main project work (structured long-term memory)
 *   project_tasks  the open work inside those projects
 *   memory         general remembered facts, categorised
 *   command_history  every command, its intent and how long the route took
 *   notifications  the persisted notification queue
 *   app_shortcuts  named destinations ("open gmail") with aliases
 *   performance_logs  routing/mcp/browser/ai/tts timings, per command
 *   browser_tabs   last-known Chrome tab registry for gesture/tab control
 *
 * Create-if-needed, migrate-forward, never recreate on startup: the tables are
 * shaped by ordered migrations tracked in PRAGMA user_version, so a schema that
 * ships later can be added to the list without touching existing data.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.JARVIS_DB_PATH
  ? resolve(process.env.JARVIS_DB_PATH)
  : join(HERE, '..', 'data', 'jarvis.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

/**
 * Ordered schema steps. Each entry is a function over a fresh connection; the
 * migration number is its index, so never renumber — append only.
 */
const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE preferences (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT    NOT NULL UNIQUE,
        value      TEXT    NOT NULL,
        category   TEXT    NOT NULL DEFAULT 'general',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'active',
        technologies TEXT   NOT NULL DEFAULT '',
        priority    TEXT    NOT NULL DEFAULT 'medium',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE project_tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task         TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'todo',
        priority     TEXT    NOT NULL DEFAULT 'medium',
        notes        TEXT    NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE memory (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        category   TEXT    NOT NULL DEFAULT 'general',
        content    TEXT    NOT NULL,
        importance INTEGER NOT NULL DEFAULT 1,
        source     TEXT    NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE command_history (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_command       TEXT    NOT NULL,
        normalized_command TEXT   NOT NULL DEFAULT '',
        intent            TEXT    NOT NULL DEFAULT '',
        result            TEXT    NOT NULL DEFAULT '',
        success           INTEGER NOT NULL DEFAULT 1,
        execution_time_ms INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL
      );
      CREATE TABLE notifications (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT    NOT NULL DEFAULT '',
        message      TEXT    NOT NULL,
        scheduled_at INTEGER NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'pending',
        created_at   INTEGER NOT NULL
      );
      CREATE TABLE app_shortcuts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        aliases    TEXT    NOT NULL DEFAULT '',
        url        TEXT    NOT NULL DEFAULT '',
        action     TEXT    NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE performance_logs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        command          TEXT    NOT NULL DEFAULT '',
        intent           TEXT    NOT NULL DEFAULT '',
        speech_ms        INTEGER NOT NULL DEFAULT 0,
        routing_ms       INTEGER NOT NULL DEFAULT 0,
        mcp_ms           INTEGER NOT NULL DEFAULT 0,
        browser_ms       INTEGER NOT NULL DEFAULT 0,
        ai_ms            INTEGER NOT NULL DEFAULT 0,
        tts_ms           INTEGER NOT NULL DEFAULT 0,
        total_ms         INTEGER NOT NULL DEFAULT 0,
        success          INTEGER NOT NULL DEFAULT 1,
        created_at       INTEGER NOT NULL
      );
      CREATE TABLE browser_tabs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id  TEXT    NOT NULL,
        title      TEXT    NOT NULL DEFAULT '',
        url        TEXT    NOT NULL DEFAULT '',
        tab_index  INTEGER NOT NULL DEFAULT 0,
        last_seen  INTEGER NOT NULL,
        is_active  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(target_id)
      );
      CREATE INDEX idx_pref_key ON preferences(key);
      CREATE INDEX idx_memory_cat ON memory(category);
      CREATE INDEX idx_tasks_proj ON project_tasks(project_id, status);
      CREATE INDEX idx_notify_at ON notifications(scheduled_at, status);
      CREATE INDEX idx_perf_at   ON performance_logs(created_at);
      CREATE INDEX idx_tabs_act  ON browser_tabs(is_active);
      CREATE INDEX idx_hist_at   ON command_history(created_at);
    `)
  },
  // Performance ledger meets the voice: the frontend reports when he starts
  // listening and when he stops talking (speech_ms / tts_ms). Those arrive as a
  // separate message some seconds after the row is written, so they are keyed
  // back onto their turn by the ask id the browser generated.
  (db) => {
    db.exec(`
      ALTER TABLE performance_logs ADD COLUMN ask_id TEXT;
      CREATE INDEX idx_perf_ask ON performance_logs(ask_id);
    `)
  },
  // Phase 1 observability: one trace per turn and ordered metadata-only steps.
  // Additive by design — no existing table is rewritten and no content is stored.
  (db) => {
    db.exec(`
      CREATE TABLE traces (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id       TEXT    NOT NULL UNIQUE,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        duration_ms    INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'running',
        component      TEXT    NOT NULL DEFAULT 'turn',
        route          TEXT    NOT NULL DEFAULT '',
        model          TEXT    NOT NULL DEFAULT '',
        provider       TEXT    NOT NULL DEFAULT '',
        error_category TEXT    NOT NULL DEFAULT '',
        metadata       TEXT    NOT NULL DEFAULT '{}'
      );
      CREATE TABLE trace_steps (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id       TEXT    NOT NULL,
        step_index     INTEGER NOT NULL,
        component      TEXT    NOT NULL,
        operation      TEXT    NOT NULL,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        duration_ms    INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'running',
        error_category TEXT    NOT NULL DEFAULT '',
        metadata       TEXT    NOT NULL DEFAULT '{}',
        UNIQUE(trace_id, step_index),
        FOREIGN KEY (trace_id) REFERENCES traces(trace_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_traces_started ON traces(started_at);
      CREATE INDEX idx_traces_status  ON traces(status, started_at);
      CREATE INDEX idx_traces_route   ON traces(route, started_at);
      CREATE INDEX idx_steps_trace     ON trace_steps(trace_id, step_index);
      CREATE INDEX idx_steps_component ON trace_steps(component, started_at);
    `)
  },
  // Local aggregate counters. No commands, prompts or tool payloads are stored.
  (db) => {
    db.exec(`
      CREATE TABLE telemetry_counters (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        day            TEXT    NOT NULL,
        component      TEXT    NOT NULL,
        operation      TEXT    NOT NULL,
        route          TEXT    NOT NULL DEFAULT '',
        status         TEXT    NOT NULL DEFAULT 'ok',
        error_category TEXT    NOT NULL DEFAULT '',
        events_count   INTEGER NOT NULL DEFAULT 0,
        total_ms       INTEGER NOT NULL DEFAULT 0,
        min_ms         INTEGER,
        max_ms         INTEGER,
        updated_at     INTEGER NOT NULL,
        UNIQUE(day, component, operation, route, status, error_category)
      );
      CREATE INDEX idx_telemetry_day ON telemetry_counters(day, component);
    `)
  },
]

export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

let version = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0)
if (version > MIGRATIONS.length) {
  throw new Error(
    `jarvis.db is version ${version} but this build knows ${MIGRATIONS.length} — ` +
      'refusing to run a newer database on older code.',
  )
}
for (let i = version; i < MIGRATIONS.length; i++) {
  const migrate = MIGRATIONS[i]
  db.exec('BEGIN')
  try {
    migrate(db)
    db.exec(`PRAGMA user_version = ${i + 1}`)
    db.exec('COMMIT')
    console.log(`[jarvis] db migration ${i + 1}/${MIGRATIONS.length} applied`)
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export const jdb = {
  path: DB_PATH,
  /** Size the backup / copy operations will see. */
  sizeBytes: () => {
    try {
      return statSync(DB_PATH).size
    } catch {
      return 0
    }
  },
}

/** One row -> plain object, null prototype rehydrated like the rest of the app. */
export function plain(row) {
  if (!row) return null
  return { ...row }
}

/** Shorthand insert returning the new rowId. */
export function insert(sql, ...params) {
  return Number(db.prepare(sql).run(...params).lastInsertRowid)
}

/** Convenience query expecting one row. */
export function one(sql, ...params) {
  return plain(db.prepare(sql).get(...params))
}

/** Convenience query expecting many rows. */
export function many(sql, ...params) {
  return db.prepare(sql).all(...params).map(plain)
}

export const nowMs = () => Date.now()