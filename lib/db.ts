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
import { dirname, join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'qd.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __qd_db: Database.Database | undefined;
}

function open(): Database.Database {
  // 先尝试 env 指定的 DB_PATH；如果它的父目录不存在且无法创建（典型：.env.local 残留
  // 了别的机器的绝对路径），自动回落到项目本地 data/qd.sqlite，避免整个 dev server 全 500。
  let finalPath = DB_PATH;
  try { mkdirSync(dirname(finalPath), { recursive: true }); }
  catch (e: any) {
    if (finalPath !== join(DATA_DIR, 'qd.sqlite')) {
      console.warn(`[db] DB_PATH "${finalPath}" 目录无法创建（${e?.code || e?.message}），回落到 ${join(DATA_DIR, 'qd.sqlite')}`);
      finalPath = join(DATA_DIR, 'qd.sqlite');
    }
  }
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  try { mkdirSync(dirname(finalPath), { recursive: true }); } catch (_) {}

  const db = new Database(finalPath);
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
      correlation_id TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_images_owner_project ON images(owner_id, project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS image_generation_audits (
      correlation_id TEXT PRIMARY KEY,
      owner_id       INTEGER NOT NULL,
      project_id     TEXT,
      asset_ref      TEXT,
      kind           TEXT,
      generated_image_id TEXT,
      moderation_recovered INTEGER NOT NULL DEFAULT 0,
      original_prompt TEXT NOT NULL DEFAULT '',
      final_submitted_prompt TEXT NOT NULL DEFAULT '',
      final_composed_prompt TEXT NOT NULL DEFAULT '',
      attempts_json  TEXT NOT NULL DEFAULT '[]',
      safety_violations_json TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_image_generation_audits_owner_project ON image_generation_audits(owner_id, project_id, created_at DESC);

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
      runner_id     TEXT,
      runner_heartbeat_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_batches_owner ON batches(owner_id, created_at DESC);

    -- 相邻镜头连续性检查缓存：按输入 hash 缓存每一对镜头的检查结果，避免重复 LLM 调用
    CREATE TABLE IF NOT EXISTS continuity_cache (
      id            TEXT PRIMARY KEY,
      owner_id      INTEGER NOT NULL,
      project_id    TEXT NOT NULL DEFAULT '',
      pair_key      TEXT NOT NULL,
      input_hash    TEXT NOT NULL,
      result_json   TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(owner_id, project_id, pair_key, input_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_continuity_cache_owner_project ON continuity_cache(owner_id, project_id, updated_at DESC);

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

    -- 用户世界观模板：风格圣经 + 角色/场景/道具等可复用设定
    CREATE TABLE IF NOT EXISTS world_templates (
      id                TEXT NOT NULL,
      owner_id          INTEGER NOT NULL,
      name              TEXT NOT NULL,
      source_project_id TEXT,
      cover_image_id    TEXT,
      schema_version    INTEGER NOT NULL DEFAULT 1,
      source            TEXT NOT NULL DEFAULT 'user',
      data_json         TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (owner_id, id),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (cover_image_id) REFERENCES images(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_world_templates_owner ON world_templates(owner_id, updated_at DESC);

    -- 用户项目剧本库：上传/生成/归档剧本的可复用记录
    CREATE TABLE IF NOT EXISTS script_library_items (
      id             TEXT NOT NULL,
      owner_id       INTEGER NOT NULL,
      project_id     TEXT NOT NULL,
      name           TEXT NOT NULL,
      content        TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      source         TEXT NOT NULL DEFAULT 'generated',
      schema_version INTEGER NOT NULL DEFAULT 1,
      meta_json      TEXT NOT NULL DEFAULT '{}',
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (owner_id, id),
      UNIQUE (owner_id, project_id, content_hash),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_script_library_project ON script_library_items(owner_id, project_id, updated_at DESC);

    -- 阶段五：用户积分余额（按用户单行）
    CREATE TABLE IF NOT EXISTS user_credits (
      user_id              INTEGER PRIMARY KEY,
      total_credits        INTEGER NOT NULL DEFAULT 0,
      subscription_credits INTEGER NOT NULL DEFAULT 0,
      topup_credits        INTEGER NOT NULL DEFAULT 0,
      bonus_credits        INTEGER NOT NULL DEFAULT 0,
      plan_code            TEXT NOT NULL DEFAULT 'free',
      plan_status          TEXT NOT NULL DEFAULT 'active',
      period_end           TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 阶段五：积分明细（每条扣费/入账都有一行）
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      amount      INTEGER NOT NULL,           -- 正数=入账，负数=扣减
      kind        TEXT NOT NULL,              -- script | image | video | export | topup | redeem | refund | gift | adjust
      reason      TEXT NOT NULL DEFAULT '',
      ref_id      TEXT,                        -- 关联的 task_id / order_id / batch_id 等
      balance_after INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON credit_ledger(user_id, created_at DESC);

    -- 阶段五：订单（兑换码 / Stripe / 微信支付都进这一张表）
    CREATE TABLE IF NOT EXISTS billing_orders (
      id              TEXT PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      kind            TEXT NOT NULL,         -- subscription | topup
      plan_code       TEXT,                   -- 套餐订阅时填 plan code，积分包填 pack code
      provider        TEXT NOT NULL,          -- redeem | stripe | wechat | alipay | manual
      provider_ref    TEXT,                   -- 远端订单 id
      amount_cents    INTEGER NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL DEFAULT 'CNY',
      credits_added   INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed | cancelled
      meta_json       TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user_time ON billing_orders(user_id, created_at DESC);

    -- 阶段五：兑换码（管理员预生成，用户输入即入账）
    CREATE TABLE IF NOT EXISTS redeem_codes (
      code         TEXT PRIMARY KEY,
      credits      INTEGER NOT NULL,
      plan_code    TEXT,                      -- 兑换的套餐（可空，仅积分时为空）
      max_uses     INTEGER NOT NULL DEFAULT 1,
      used_count   INTEGER NOT NULL DEFAULT 0,
      expires_at   TEXT,
      memo         TEXT,
      created_by   INTEGER,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- 阶段五：系统配置（key-value，单例字段）
    CREATE TABLE IF NOT EXISTS system_config (
      key         TEXT PRIMARY KEY,
      value_json  TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- 注册邮箱验证码（OTP）
    CREATE TABLE IF NOT EXISTS otp_codes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT NOT NULL,
      code_hash    TEXT NOT NULL,
      purpose      TEXT NOT NULL DEFAULT 'register',
      ip           TEXT,
      used         INTEGER NOT NULL DEFAULT 0,
      attempts     INTEGER NOT NULL DEFAULT 0,
      expires_at   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email, purpose, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_otp_ip ON otp_codes(ip, created_at DESC);
  `);

  seedDefaultUser(db);
  seedDefaultCredits(db);
  seedDefaultRedeemCodes(db);
  migrateLedgerBuckets(db);
  migrateBatchLeaseColumns(db);
  migrateImageAuditColumns(db);
}

/**
 * 迁移：给 credit_ledger 加 buckets_json 字段。
 * 这个字段用来在 chargeCredits 时存"本次扣款从各桶各扣了多少"（{bonus, topup, subscription}），
 * 后续 refundCredits 可以按 refId 找回原始桶分布，精准退回原桶。
 * 不带这个字段时 refund 统一退到 bonus 桶（会把 subscription 额度永久化）。
 */
function migrateLedgerBuckets(db: Database.Database) {
  try {
    const cols = db.prepare("PRAGMA table_info(credit_ledger)").all() as Array<{ name: string }>;
    const has = cols.some((c) => c.name === 'buckets_json');
    if (!has) {
      db.exec('ALTER TABLE credit_ledger ADD COLUMN buckets_json TEXT');
      console.log('[db] migrated credit_ledger: added buckets_json');
    }
  } catch (e) {
    console.warn('[db] migrateLedgerBuckets:', e);
  }
}

/**
 * 迁移：给 batches 加执行租约字段。
 * runner_id 标记当前执行进程；runner_heartbeat_at 是 orphan reap 的权威依据。
 * 旧库缺字段时补列，新库则由 CREATE TABLE 直接创建。
 */
function migrateBatchLeaseColumns(db: Database.Database) {
  try {
    const cols = db.prepare("PRAGMA table_info(batches)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('runner_id')) {
      db.exec('ALTER TABLE batches ADD COLUMN runner_id TEXT');
      console.log('[db] migrated batches: added runner_id');
    }
    if (!names.has('runner_heartbeat_at')) {
      db.exec('ALTER TABLE batches ADD COLUMN runner_heartbeat_at TEXT');
      console.log('[db] migrated batches: added runner_heartbeat_at');
    }
  } catch (e) {
    console.warn('[db] migrateBatchLeaseColumns:', e);
  }
}

function migrateImageAuditColumns(db: Database.Database) {
  try {
    const cols = db.prepare("PRAGMA table_info(images)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('correlation_id')) {
      db.exec('ALTER TABLE images ADD COLUMN correlation_id TEXT');
      console.log('[db] migrated images: added correlation_id');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_images_correlation ON images(correlation_id)');
    const auditCols = db.prepare("PRAGMA table_info(image_generation_audits)").all() as Array<{ name: string }>;
    const auditNames = new Set(auditCols.map((c) => c.name));
    if (!auditNames.has('final_composed_prompt')) {
      db.exec("ALTER TABLE image_generation_audits ADD COLUMN final_composed_prompt TEXT NOT NULL DEFAULT ''");
      console.log('[db] migrated image_generation_audits: added final_composed_prompt');
    }
  } catch (e) {
    console.warn('[db] migrateImageAuditColumns:', e);
  }
}

function seedDefaultCredits(db: Database.Database) {
  // 给所有还没积分记录的用户开户
  const rows = db
    .prepare<[], { id: number }>(
      `SELECT u.id FROM users u
       LEFT JOIN user_credits c ON c.user_id = u.id
       WHERE c.user_id IS NULL`,
    )
    .all();
  for (const u of rows) {
    // 默认账号 pokerman（id=1）给 5000 积分方便测试，其他人给 100
    const seedCredits = u.id === 1 ? 5000 : 100;
    db.prepare(
      `INSERT INTO user_credits (user_id, total_credits, subscription_credits, plan_code)
       VALUES (?, ?, ?, 'free')`,
    ).run(u.id, seedCredits, seedCredits);
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, balance_after)
       VALUES (?, ?, ?, 'gift', '账号初始化赠送', ?)`,
    ).run(`seed-${u.id}-${Date.now()}`, u.id, seedCredits, seedCredits);
  }
}

function seedDefaultRedeemCodes(db: Database.Database) {
  const count = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM redeem_codes').get();
  if (count && count.c > 0) return;
  // 预置几个测试兑换码
  const codes: Array<[string, number, string]> = [
    ['QDDEMO-1000', 1000, '示例兑换码 1000 积分'],
    ['QDDEMO-5000', 5000, '示例兑换码 5000 积分'],
    ['QDDEMO-10000', 10000, '示例兑换码 10000 积分'],
  ];
  // 示例码默认每个码每用户只能用一次（max_uses=1），避免被脚本撸光
  const stmt = db.prepare(
    `INSERT INTO redeem_codes (code, credits, max_uses, used_count, memo) VALUES (?, ?, 1, 0, ?)`,
  );
  for (const [c, n, m] of codes) stmt.run(c, n, m);
  console.log('[db] Seeded redeem codes:', codes.map((c) => c[0]).join(', '));
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
