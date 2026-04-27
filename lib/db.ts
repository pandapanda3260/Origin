/**
 * SQLite 数据库连接层（阶段一：用户/项目/设置/创作偏好）
 *
 * 设计原则：
 *   - 单文件数据库 data/qd.sqlite，零运维
 *   - 模块加载时自动建表（首次启动即可用）
 *   - 进程内单例：避免 Next.js dev 热重载导致重复打开
 */

import Database from 'better-sqlite3';
import { hashSync } from 'bcryptjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'qd.sqlite');

mkdirSync(DATA_DIR, { recursive: true });

declare global {
  // eslint-disable-next-line no-var
  var __qd_db: Database.Database | undefined;
}

function open(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  return db;
}

function bootstrap(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT UNIQUE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER NOT NULL,
      title        TEXT NOT NULL DEFAULT '未命名项目',
      description  TEXT NOT NULL DEFAULT '',
      cover_url    TEXT,
      status       TEXT NOT NULL DEFAULT 'draft',
      data_json    TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id     INTEGER PRIMARY KEY,
      data_json   TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id     INTEGER PRIMARY KEY,
      data_json   TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token        TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_active  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- 阶段三：图像存储
    CREATE TABLE IF NOT EXISTS images (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER NOT NULL,
      project_id   TEXT,
      kind         TEXT NOT NULL,        -- character | scene | prop | storyboard | other
      asset_ref    TEXT,                  -- 关联到 project.data_json 里的资产路径，例如 characters[0]
      filename     TEXT NOT NULL,         -- 在 data/images/<owner>/ 下的文件名
      mime         TEXT NOT NULL DEFAULT 'image/png',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      width        INTEGER,
      height       INTEGER,
      prompt       TEXT NOT NULL DEFAULT '',
      style        TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_images_owner_project ON images(owner_id, project_id, created_at DESC);

    -- 阶段三：批量任务
    CREATE TABLE IF NOT EXISTS batches (
      id            TEXT PRIMARY KEY,
      owner_id      INTEGER NOT NULL,
      project_id    TEXT,
      batch_type    TEXT NOT NULL,        -- asset_images | storyboard_prompts | storyboard_images
      status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed | cancelled
      total         INTEGER NOT NULL DEFAULT 0,
      succeeded     INTEGER NOT NULL DEFAULT 0,
      failed        INTEGER NOT NULL DEFAULT 0,
      options_json  TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_batches_owner ON batches(owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS batch_tasks (
      id            TEXT PRIMARY KEY,
      batch_id      TEXT NOT NULL,
      seq           INTEGER NOT NULL,
      target_json   TEXT NOT NULL DEFAULT '{}',
      status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
      result_json   TEXT NOT NULL DEFAULT '{}',
      error_msg     TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch ON batch_tasks(batch_id, seq);

    -- 阶段四：视频任务（单条片段生成）
    CREATE TABLE IF NOT EXISTS video_tasks (
      id            TEXT PRIMARY KEY,
      owner_id      INTEGER NOT NULL,
      project_id    TEXT,
      group_idx     INTEGER,                  -- 关联 storyboards[group_idx]
      prompt        TEXT NOT NULL DEFAULT '',
      provider      TEXT NOT NULL DEFAULT 'openai',  -- openai | seedance | keling | fake
      provider_task TEXT,                      -- 远端任务 id（用于轮询）
      status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
      progress      INTEGER NOT NULL DEFAULT 0,      -- 0-100
      filename      TEXT,                            -- data/videos/<owner>/<filename>
      duration_sec  REAL,
      cover_image_id TEXT,                           -- 关联 images.id（视频封面）
      error_msg     TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_video_tasks_owner ON video_tasks(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_tasks_project ON video_tasks(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_tasks_status ON video_tasks(status, owner_id);

    -- 阶段四：剪辑导出任务
    CREATE TABLE IF NOT EXISTS exports (
      id            TEXT PRIMARY KEY,
      owner_id      INTEGER NOT NULL,
      project_id    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
      progress      INTEGER NOT NULL DEFAULT 0,
      filename      TEXT,                            -- data/exports/<owner>/<filename>.mp4
      edl_json      TEXT NOT NULL DEFAULT '{}',
      bgm_id        TEXT,
      duration_sec  REAL,
      error_msg     TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_exports_owner ON exports(owner_id, created_at DESC);

    -- 阶段四：用户上传素材（剪辑工作台导入）
    CREATE TABLE IF NOT EXISTS uploads (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER NOT NULL,
      project_id   TEXT,
      kind         TEXT NOT NULL,            -- video | image | audio
      filename     TEXT NOT NULL,
      mime         TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_owner_project ON uploads(owner_id, project_id, created_at DESC);
  `);

  seedDefaultUser(db);
}

function seedDefaultUser(db: Database.Database) {
  const count = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM users').get();
  if (count && count.c > 0) return;

  const username = process.env.SEED_USER || 'pokerman';
  const password = process.env.SEED_PASSWORD || 'joker0606';
  const email = process.env.SEED_EMAIL || 'demo@local.dev';

  db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, is_admin, email_verified)
     VALUES (?, ?, ?, ?, 1, 1)`,
  ).run(username, email, username, hashSync(password, 10));

  console.log(`[db] Seeded default user: ${username} / ${password} (admin, email: ${email})`);
}

export function getDb(): Database.Database {
  if (!global.__qd_db) {
    global.__qd_db = open();
  }
  return global.__qd_db;
}

export type UserRow = {
  id: number;
  username: string;
  email: string | null;
  display_name: string;
  password_hash: string;
  is_admin: number;
  email_verified: number;
  created_at: string;
  updated_at: string;
};

export type ProjectRow = {
  id: string;
  owner_id: number;
  title: string;
  description: string;
  cover_url: string | null;
  status: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

export function userToPublic(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email || '',
    emailVerified: !!u.email_verified,
    isAdmin: !!u.is_admin,
    createdAt: u.created_at,
  };
}
