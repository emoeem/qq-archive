/**
 * 数据库迁移。
 *
 * 约定：
 *  - 每个迁移是 `{version, name, up(db)}`，按 version 升序执行，事务内完成。
 *  - 已执行的版本记录在 schema_migrations，重复启动不会重复执行。
 *  - **只允许向后兼容的新增**（加表、加索引、加可空列）；删列/改语义必须新开一个版本并写数据迁移。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(readFileSync(resolve(HERE, 'schema.sql'), 'utf8'));
    },
  },
  {
    version: 2,
    name: 'message-fts-content-column',
    up(db) {
      // 预留：为将来的 FTS 扩展（例如把 sender 也纳入 bigram 索引）留位置。
      // 目前只确保 bigram 表存在（老库升级路径）。
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts_bigram'`)
        .all() as Array<{ name: string }>;
      if (rows.length === 0) {
        db.exec(`CREATE VIRTUAL TABLE messages_fts_bigram USING fts5(text, tokenize='unicode61 remove_diacritics 2')`);
      }
    },
  },
  {
    version: 3,
    name: 'messages-extra-indexes',
    up(db) {
      if (!columnExists(db, 'media', 'thumb_path')) {
        db.exec(`ALTER TABLE media ADD COLUMN thumb_path TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_key_ts ON messages(session_key, ts DESC)`);
    },
  },
  {
    version: 4,
    name: 'sessions-and-collect-fields',
    up(db) {
      if (!columnExists(db, 'sessions', 'peer_uin')) {
        db.exec(`ALTER TABLE sessions ADD COLUMN peer_uin TEXT`);
      }
      if (!columnExists(db, 'collect_state', 'cursor_seq')) {
        db.exec(`ALTER TABLE collect_state ADD COLUMN cursor_seq TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(msg_id)`);
    },
  },
  {
    version: 5,
    name: 'media-transcripts',
    up(db) {
      // 语音转文字结果表（详见 schema.sql 里的注释）。对老库而言这是唯一入口，
      // 对新库 migration 1 已经建过 → 这里必须 IF NOT EXISTS 保持幂等。
      db.exec(`CREATE TABLE IF NOT EXISTS media_transcripts (
        media_id   INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        language   TEXT,
        engine     TEXT NOT NULL,
        model      TEXT,
        segments   INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_media_transcripts_engine ON media_transcripts(engine, updated_at DESC)`,
      );
    },
  },
  {
    version: 6,
    name: 'message-filters',
    up(db) {
      // 采集过滤标记。命中规则的消息**默认仍然入库**（防丢失优先），只是打上标记、
      // 默认不在时间线/搜索里显示；`filter_reason` 记下命中的是哪条规则，便于事后解释。
      // 老库补列用「先查一下列在不在」的方式，和 migration 4 保持一致。
      const cols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has('filtered')) {
        db.exec(`ALTER TABLE messages ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0`);
      }
      if (!has('filter_reason')) {
        db.exec(`ALTER TABLE messages ADD COLUMN filter_reason TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_filtered ON messages(filtered, ts DESC)`);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
}

/** 执行迁移。返回本次实际应用的迁移。 */
export function migrate(db: DatabaseSync, log?: (msg: string) => void): MigrateResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const before = currentVersion(db);
  const applied: string[] = [];
  const pending = MIGRATIONS.filter((m) => m.version > before).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(`${m.version}-${m.name}`);
      log?.(`migration applied: ${m.version} ${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.version} (${m.name}) 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { from: before, to: currentVersion(db), applied };
}

export function currentVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
