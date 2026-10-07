'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cuerail.db');
const SEED_ON_EMPTY = (process.env.SEED_ON_EMPTY || 'true').toLowerCase() !== 'false';

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  migrate(_db);
  if (SEED_ON_EMPTY && isEmpty(_db)) seed(_db);
  return _db;
}

function migrate(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS shows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Draft cue list (mutable). Publishing snapshots these into version_items.
  CREATE TABLE IF NOT EXISTS cues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,          -- 1-based order in the draft
    cue_type    TEXT NOT NULL,             -- light | sound | scene
    title       TEXT NOT NULL,
    wait_secs   INTEGER NOT NULL DEFAULT 0,-- wait relative to the previous cue
    instruction TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_cues_show ON cues(show_id, seq);

  -- Immutable published versions
  CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    version_no  INTEGER NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    total_secs  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(show_id, version_no)
  );

  CREATE TABLE IF NOT EXISTS version_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id    INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    cue_type      TEXT NOT NULL,
    title         TEXT NOT NULL,
    wait_secs     INTEGER NOT NULL DEFAULT 0,
    instruction   TEXT NOT NULL DEFAULT '',
    planned_secs  INTEGER NOT NULL DEFAULT 0 -- cumulative seconds from show start
  );
  CREATE INDEX IF NOT EXISTS idx_vitems_ver ON version_items(version_id, seq);

  CREATE TABLE IF NOT EXISTS performances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id  INTEGER NOT NULL REFERENCES versions(id),
    operator    TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'running', -- running | ended
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_perf_ver ON performances(version_id);

  -- Per-performance working state of every cue in the chosen version
  CREATE TABLE IF NOT EXISTS performance_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    performance_id  INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    cue_type        TEXT NOT NULL,
    title           TEXT NOT NULL,
    wait_secs       INTEGER NOT NULL DEFAULT 0,
    instruction     TEXT NOT NULL DEFAULT '',
    planned_secs    INTEGER NOT NULL DEFAULT 0,
    state           TEXT NOT NULL DEFAULT 'pending', -- pending | executed | skipped
    processed_seq   INTEGER, -- processing order (1..n), NULL when pending
    UNIQUE(performance_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_pitems_perf ON performance_items(performance_id, seq);

  -- Idempotency table: one row per (performance, request_no) for applied ops
  CREATE TABLE IF NOT EXISTS op_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    performance_id  INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
    request_no      TEXT NOT NULL,
    action          TEXT NOT NULL,
    cue_seq         INTEGER,
    payload_hash    TEXT NOT NULL,
    result          TEXT NOT NULL, -- executed | skipped | undone | ended
    applied_progress INTEGER NOT NULL,
    applied_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(performance_id, request_no)
  );

  -- Audit log: every operation attempt is recorded (success and illegal/stale)
  CREATE TABLE IF NOT EXISTS op_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    performance_id  INTEGER REFERENCES performances(id) ON DELETE CASCADE,
    version_id      INTEGER,
    operator        TEXT NOT NULL DEFAULT '',
    request_no      TEXT,
    action          TEXT NOT NULL,
    cue_seq         INTEGER,
    client_progress INTEGER,
    outcome         TEXT NOT NULL, -- executed | skipped | undone | ended | rejected | conflict | idempotent
    reason          TEXT NOT NULL DEFAULT '',
    detail          TEXT NOT NULL DEFAULT '', -- e.g. original result on idempotent replay
    server_progress INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_logs_perf ON op_logs(performance_id, created_at);
  `);
}

function isEmpty(d) {
  return d.prepare('SELECT COUNT(*) AS c FROM shows').get().c === 0;
}

function seed(d) {
  const insertShow = d.prepare('INSERT INTO shows (name) VALUES (?)');
  const insertCue = d.prepare(
    'INSERT INTO cues (show_id, seq, cue_type, title, wait_secs, instruction) VALUES (?,?,?,?,?,?)'
  );
  const insVer = d.prepare(
    "INSERT INTO versions (show_id, version_no, label, created_by, total_secs) VALUES (?,?,?,?,?)"
  );
  const insItem = d.prepare(
    'INSERT INTO version_items (version_id, seq, cue_type, title, wait_secs, instruction, planned_secs) VALUES (?,?,?,?,?,?,?)'
  );

  const tx = d.transaction(() => {
    // Show A: published v1 + a new draft cue not yet published
    const a = insertShow.run('雷雨 · 第三幕').lastInsertRowid;
    const cuesA = [
      ['light', '开场暗场', 0, '观众入场完毕，场灯渐暗至全黑'],
      ['sound', '雷声远响', 3, '低频雷声由远及近，音量 30%'],
      ['light', '台灯亮起', 8, '桌前台灯暖光，侧光收至 40%'],
      ['scene', '沙发移台', 5, '黑场换景，二人将沙发推至上场口'],
      ['sound', '雨声加强', 12, '雨声音效推至 70%，持续'],
      ['light', '闪电频闪', 6, '【草稿新增，尚未发布】频闪器 3 次白光'],
    ];
    cuesA.forEach((c, i) => insertCue.run(a, i + 1, c[0], c[1], c[2], c[3]));

    const va = insVer.run(a, 1, '首演发布版', '舞台监督', 28).lastInsertRowid;
    let acc = 0;
    cuesA.slice(0, 5).forEach((c, i) => {
      acc += c[2];
      insItem.run(va, i + 1, c[0], c[1], c[2], c[3], acc);
    });

    // Show B: draft only, not yet published
    const b = insertShow.run('茶馆 · 排练场记').lastInsertRowid;
    const cuesB = [
      ['light', '清晨光', 0, '冷色调面光 50%'],
      ['scene', '桌椅布置', 10, '上场门抬入方桌一张、板凳两条'],
      ['sound', '街声铺底', 5, '街市叫卖环境声，音量 25%'],
    ];
    cuesB.forEach((c, i) => insertCue.run(b, i + 1, c[0], c[1], c[2], c[3]));
  });
  tx();
  console.log('[seed] demo data inserted');
}

module.exports = { db, DB_PATH };
