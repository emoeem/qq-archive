-- QQ 归档系统数据库 Schema（SQLite，migration 0001）
-- 设计要点：
--  * 消息只存一份（UNIQUE(account_uid, session_key, msg_key)），重复导入不产生重复行。
--  * 多媒体分两部分：media 是内容对象（按 sha256 全局去重），message_media 是消息到媒体的多对多关联。
--  * FTS5 采用 unicode61 + 手工 CJK 二元切分，保证中文子串可搜且不虚增 token。
--  * refresh_token 只存 sha256 摘要，不落库明文。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
);

-- 被归档的 QQ 账号（数据来源身份）
CREATE TABLE IF NOT EXISTS accounts (
  uid           TEXT PRIMARY KEY,
  uin           TEXT,
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 会话：一个账号下的一个私聊/群聊
CREATE TABLE IF NOT EXISTS sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid       TEXT NOT NULL,
  chat_type         TEXT NOT NULL CHECK (chat_type IN ('private','group','temp','other')),
  peer_uid          TEXT NOT NULL,
  peer_uin          TEXT,
  name              TEXT,
  remark            TEXT,
  member_count      INTEGER,
  last_message_at   INTEGER,
  first_message_at  INTEGER,
  message_count     INTEGER NOT NULL DEFAULT 0,
  source            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (account_uid, chat_type, peer_uid)
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_msg ON sessions(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_account  ON sessions(account_uid, chat_type);

-- 发送者（跨会话全局身份；同一 UID 在不同群的群名片分别放 messages 表的 sender_name 快照）
CREATE TABLE IF NOT EXISTS contacts (
  uid           TEXT PRIMARY KEY,
  uin           TEXT,
  nickname      TEXT,
  remark        TEXT,
  avatar_path   TEXT,
  first_seen_at TEXT,
  last_seen_at  TEXT,
  raw           TEXT
);

-- 消息主表
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid   TEXT NOT NULL,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_key   TEXT NOT NULL,
  msg_key       TEXT NOT NULL,
  msg_id        TEXT,
  seq           TEXT,
  ts            INTEGER NOT NULL,
  time_text     TEXT,
  sender_uid    TEXT,
  sender_uin    TEXT,
  sender_name   TEXT,
  is_self       INTEGER NOT NULL DEFAULT 0,
  direction     TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out','system')),
  msg_type      TEXT NOT NULL DEFAULT 'text',
  recalled      INTEGER NOT NULL DEFAULT 0,
  system        INTEGER NOT NULL DEFAULT 0,
  text          TEXT NOT NULL DEFAULT '',
  elements      TEXT,
  mentions      TEXT,
  reply_to_msg_key TEXT,
  reply_to_id   TEXT,
  forward_id    TEXT,
  extra         TEXT,
  raw           TEXT,
  source        TEXT NOT NULL DEFAULT 'import',
  batch_id      INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- 采集过滤标记：命中过滤规则的消息默认**仍然入库**（防丢失优先），只是默认不在
  -- 时间线/搜索里显示；filter_reason 记下命中的规则，便于事后解释。（见 migration 6）
  filtered      INTEGER NOT NULL DEFAULT 0,
  filter_reason TEXT,
  UNIQUE (account_uid, session_key, msg_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ts         ON messages(ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender     ON messages(sender_uid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type       ON messages(msg_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_reply      ON messages(session_key, reply_to_id);
CREATE INDEX IF NOT EXISTS idx_messages_batch      ON messages(batch_id);
CREATE INDEX IF NOT EXISTS idx_messages_filtered   ON messages(filtered, ts DESC);

-- 媒体内容对象：按 sha256 全局去重，一份内容只有一个文件
CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256        TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','audio','file','other')),
  size          INTEGER NOT NULL,
  mime          TEXT,
  ext           TEXT,
  rel_path      TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  duration      REAL,
  status        TEXT NOT NULL DEFAULT 'present'
                CHECK (status IN ('present','missing','corrupt','pending')),
  origin_url    TEXT,
  origin_path   TEXT,
  fail_reason   TEXT,
  ref_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  verified_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_kind   ON media(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_status ON media(status);

-- 消息 <-> 媒体 关联（一条消息可含多个媒体）
CREATE TABLE IF NOT EXISTS message_media (
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id     INTEGER NOT NULL REFERENCES media(id),
  ordinal      INTEGER NOT NULL DEFAULT 0,
  filename     TEXT,
  declared_size INTEGER,
  PRIMARY KEY (message_id, media_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_message_media_media ON message_media(media_id);
CREATE INDEX IF NOT EXISTS idx_message_media_msg   ON message_media(message_id);

-- 导入 / 采集 任务
CREATE TABLE IF NOT EXISTS import_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,           -- import | collect | backup
  format         TEXT,
  account_uid    TEXT,
  source_path    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','failed','cancelled')),
  total_items    INTEGER NOT NULL DEFAULT 0,
  processed      INTEGER NOT NULL DEFAULT 0,
  inserted       INTEGER NOT NULL DEFAULT 0,
  duplicate      INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  media_saved    INTEGER NOT NULL DEFAULT 0,
  media_missing  INTEGER NOT NULL DEFAULT 0,
  progress       REAL NOT NULL DEFAULT 0,
  message        TEXT,
  error          TEXT,
  options        TEXT,
  stats          TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status, created_at DESC);

-- 采集进度（断点续传）：每个采集源的游标
CREATE TABLE IF NOT EXISTS collect_state (
  source        TEXT NOT NULL,             -- 例如 onebot:http://127.0.0.1:3000
  account_uid   TEXT,
  session_key   TEXT NOT NULL DEFAULT '',
  cursor_ts     INTEGER NOT NULL DEFAULT 0,
  cursor_seq    TEXT,
  last_run_at   TEXT,
  last_ok_at    TEXT,
  last_error    TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source, account_uid, session_key)
);

-- 运行日志（结构化，供归档管理页展示）
CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  level    TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  scope    TEXT NOT NULL,
  message  TEXT NOT NULL,
  data     TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts    ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, ts DESC);

-- 备份记录
CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  path           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'full',   -- full | db | media
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','done','failed')),
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  message_count  INTEGER NOT NULL DEFAULT 0,
  media_count    INTEGER NOT NULL DEFAULT 0,
  db_sha256      TEXT,
  verify_result  TEXT,
  error          TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);

-- 全文检索：contentless-delete FTS5，rowid = messages.id
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  sender_name,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 中文二元切分索引（避免依赖 trigram，兼容性更好；子串搜索由 bigram 重建保证）
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_bigram USING fts5(
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 键值设置
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 语音转文字结果：一个媒体最多一条（media_id 主键 ⇒ 同一个音频天然不会重复转写）。
-- 刻意**不**把 transcript 塞进 media 表：STT 是可选后处理，没装 whisper 的用户
-- 不该为此付出任何 schema 代价；空白转写（静音）也会落一行，避免每次重跑。
CREATE TABLE IF NOT EXISTS media_transcripts (
  media_id   INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  language   TEXT,
  engine     TEXT NOT NULL,
  model      TEXT,
  segments   INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_transcripts_engine ON media_transcripts(engine, updated_at DESC);
