// OpenType 后端数据库层。
//
// 用 Node 22 内置的 node:sqlite，零外部依赖——服务器上 npm 不可用，
// 且这台机器资源紧张（1 核 2GB），不引入依赖树是实际约束下的最优解。
//
// 表设计：字段与同步语义保持一致，客户端无需改动即可同步。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DbOptions {
  path: string
}

let db: DatabaseSync | null = null

/** 建表语句。用 IF NOT EXISTS 保证可重复执行。 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 账号
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT,
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 刷新令牌。每次刷新轮换（旧令牌作废），泄露的旧令牌无法复用。
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  session_id  TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id, revoked_at);

-- 一次性授权码（PKCE 兑换用）
CREATE TABLE IF NOT EXISTS auth_codes (
  code          TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  state         TEXT NOT NULL,
  redirect_uri  TEXT,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

-- 邮件验证码（邮箱登录用）
CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  PRIMARY KEY (email, code)
);

-- 密码重置验证码。结构与 email_codes 一致，但校验成功不自动建号——
-- 重置场景的用户必须已存在，所以两张表分开，避免误用登录码流程。
CREATE TABLE IF NOT EXISTS password_reset_codes (
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  PRIMARY KEY (email, code)
);

-- 用户词典。term 唯一约束按用户隔离；auto=1 表示听写中自动学到的词。
CREATE TABLE IF NOT EXISTS dictionary_words (
  user_dictionary_id TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  term      TEXT NOT NULL,
  auto      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, term)
);
CREATE INDEX IF NOT EXISTS idx_dictionary_user
  ON dictionary_words (user_id, created_at DESC);

-- Revisioned dictionary, independent of history sync. Deleted rows retain only an opaque key.
CREATE TABLE IF NOT EXISTS dictionary_sync_meta (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  migrated INTEGER NOT NULL DEFAULT 0,
  legacy_ids_migrated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dictionary_sync_words (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  word_key TEXT NOT NULL,
  term TEXT,
  pronunciation TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  legacy_id TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,word_key),
  UNIQUE(user_id,revision)
);
CREATE TABLE IF NOT EXISTS dictionary_sync_receipts (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  PRIMARY KEY(user_id,mutation_id)
);
-- Stable legacy API identities are independent of content-derived sync keys.
-- A null key reserves a deleted identity so it cannot target a recreated word.
CREATE TABLE IF NOT EXISTS dictionary_legacy_ids (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  legacy_id TEXT NOT NULL,
  word_key TEXT,
  PRIMARY KEY(user_id,legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_dictionary_legacy_key ON dictionary_legacy_ids(user_id,word_key);

-- 用户设置（translation/dictation/locale 等），JSON 整体存储。
-- 渲染层用点路径（translation_settings.target_languages）写入，
-- 服务端合并后原样回读，不逐字段建模。
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  settings   TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- 历史记录。
-- 字段与同步语义保持一致，确保客户端无需改动即可同步。
CREATE TABLE IF NOT EXISTS history (
  id                TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  status            TEXT,
  mode              TEXT DEFAULT 'voice_transcript',
  refined_text      TEXT,
  duration          REAL,
  created_at        TEXT,
  updated_at        TEXT,
  -- 服务端权威时间戳（毫秒），用于增量拉取与冲突判定
  server_updated_at INTEGER NOT NULL,
  cloud_received_at INTEGER,
  audio_local_path  TEXT,
  audio_metadata    TEXT,
  app_version       TEXT DEFAULT '0.0.0',
  mic_device        TEXT,
  mic_device_info   BLOB,
  client_metadata   BLOB,
  mode_meta         BLOB,
  debug_info        TEXT,
  audio_context     TEXT,
  -- 幂等：同一 id 重复推送视为更新而非插入
  PRIMARY KEY (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_history_user_server
  ON history (user_id, server_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_user_created
  ON history (user_id, created_at DESC);

-- Content-free, permanent deletion markers prevent stale clients from restoring a record.
CREATE TABLE IF NOT EXISTS history_deletions (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  server_updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_history_deletions_cursor
  ON history_deletions (user_id, server_updated_at);

-- Cloud eviction retains device copies; an explicit all-device deletion is separate.
CREATE TABLE IF NOT EXISTS history_cloud_evictions (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  server_updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_evictions_cursor ON history_cloud_evictions (user_id, server_updated_at);
CREATE TABLE IF NOT EXISTS history_cloud_wipes (
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  cloud_epoch INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  PRIMARY KEY (request_id, user_id)
);

-- 用户同步设置（云端保留期等）
CREATE TABLE IF NOT EXISTS sync_settings (
  user_id          TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  cloud_retention  INTEGER NOT NULL DEFAULT -1,
  sync_enabled     INTEGER NOT NULL DEFAULT 0,
  purge_before_at  INTEGER,
  cloud_epoch      INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

-- 服务端下发的域名黑名单（客户端在敏感页面禁用上下文采集）
CREATE TABLE IF NOT EXISTS domain_blacklist (
  domain     TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 服务端配置（RSA 公钥等）
CREATE TABLE IF NOT EXISTS server_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export function initDb(options: DbOptions): DatabaseSync {
  mkdirSync(dirname(options.path), { recursive: true })
  db = new DatabaseSync(options.path)
  db.exec(SCHEMA)
  const columns = (table: string) => new Set((db!.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
  if (!columns('refresh_tokens').has('session_id')) db.exec('ALTER TABLE refresh_tokens ADD COLUMN session_id TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_session ON refresh_tokens(session_id)')
  if (!columns('dictionary_sync_meta').has('legacy_ids_migrated')) db.exec('ALTER TABLE dictionary_sync_meta ADD COLUMN legacy_ids_migrated INTEGER NOT NULL DEFAULT 0')
  if (!columns('history').has('cloud_received_at')) {
    // Old releases did not retain first upload time. Use their last known
    // server timestamp as the migration baseline, never a client clock.
    db.exec('ALTER TABLE history ADD COLUMN cloud_received_at INTEGER; UPDATE history SET cloud_received_at = server_updated_at')
  }
  if (!columns('sync_settings').has('cloud_epoch')) db.exec('ALTER TABLE sync_settings ADD COLUMN cloud_epoch INTEGER NOT NULL DEFAULT 0')
  db.exec('CREATE INDEX IF NOT EXISTS idx_history_cloud_age ON history(user_id, cloud_received_at)')
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('database not initialized')
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

/** 事务包装。node:sqlite 不提供 transaction 辅助，手工实现。 */
export function transaction<T>(fn: () => T): T {
  const d = getDb()
  d.exec('BEGIN')
  try {
    const result = fn()
    d.exec('COMMIT')
    return result
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}
