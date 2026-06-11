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
import { dirname } from 'node:path';
import { seedSystemCards } from './knowledge/seed-system-cards';
import { dataPath, getDataDir } from './runtime-paths';
import { ensureAdminPreviewUser } from './admin-shadow';

const DATA_DIR = getDataDir();
const DB_PATH = process.env.DB_PATH || dataPath('qd.sqlite');
const DEV_ADMIN_USERNAME = 'origin-admin';
const DEV_ADMIN_PASSWORD = 'origin-admin-dev-2026!';

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
    if (finalPath !== dataPath('qd.sqlite')) {
      console.warn(`[db] DB_PATH "${finalPath}" 目录无法创建（${e?.code || e?.message}），回落到 ${dataPath('qd.sqlite')}`);
      finalPath = dataPath('qd.sqlite');
    }
  }
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  try { mkdirSync(dirname(finalPath), { recursive: true }); } catch (_) {}

  const db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
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
      phone         TEXT,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      disabled_at   TEXT,
      token_revoked_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT UNIQUE NOT NULL,
      password_hash    TEXT NOT NULL,
      disabled_at      TEXT,
      last_login_at    TEXT,
      token_revoked_at TEXT,
      preview_user_id  INTEGER,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (preview_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS admin_actions (
      id                TEXT PRIMARY KEY,
      request_id        TEXT,
      admin_user_id     INTEGER,
      category          TEXT NOT NULL,
      action            TEXT NOT NULL,
      target_type       TEXT,
      target_id         TEXT,
      reason            TEXT,
      dry_run           INTEGER NOT NULL DEFAULT 0,
      idempotency_key   TEXT,
      before_json       TEXT NOT NULL DEFAULT '{}',
      after_json        TEXT NOT NULL DEFAULT '{}',
      result_json       TEXT NOT NULL DEFAULT '{}',
      response_status   INTEGER NOT NULL DEFAULT 200,
      status            TEXT NOT NULL DEFAULT 'completed',
      error_msg         TEXT,
      ip                TEXT,
      user_agent        TEXT,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_admin_time ON admin_actions(admin_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_actions_category_time ON admin_actions(category, created_at DESC);
    DROP INDEX IF EXISTS idx_admin_actions_idempotency;
    CREATE INDEX IF NOT EXISTS idx_admin_actions_idempotency_lookup
      ON admin_actions(action, idempotency_key, created_at DESC)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_actions_idempotency_active
      ON admin_actions(action, idempotency_key)
      WHERE dry_run = 0
        AND idempotency_key IS NOT NULL
        AND status IN ('in_progress', 'completed');

    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER NOT NULL,
      title        TEXT NOT NULL DEFAULT '未命名项目',
      description  TEXT NOT NULL DEFAULT '',
      cover_url    TEXT,
      status       TEXT NOT NULL DEFAULT 'draft',
      data_json    TEXT NOT NULL DEFAULT '{}',
      -- 乐观锁版本号：每次 updateProjectForUser / patchProjectForUser 成功写入时 +1。
      -- 前端 PUT 携带 If-Match: "v<version>" 头，后端在事务内 compare-and-update；
      -- 不匹配返回 409 stale_version，避免 batch executor 等"权威写"被前端 stale PUT 覆盖。
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS style_bible_runs (
      id             TEXT PRIMARY KEY,
      owner_id       INTEGER NOT NULL,
      project_id     TEXT NOT NULL,
      run_id         TEXT UNIQUE NOT NULL,
      status         TEXT NOT NULL DEFAULT 'queued',
      stage          TEXT NOT NULL DEFAULT 'core',
      attempt        INTEGER NOT NULL DEFAULT 0,
      max_attempts   INTEGER NOT NULL DEFAULT 3,
      max_tokens     INTEGER,
      draft_json     TEXT NOT NULL DEFAULT '{}',
      input_json     TEXT NOT NULL DEFAULT '{}',
      meta_json      TEXT NOT NULL DEFAULT '{}',
      error_code     TEXT,
      error_message  TEXT,
      heartbeat_at   TEXT,
      next_retry_at  TEXT,
      started_at     TEXT,
      completed_at   TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_style_bible_runs_project
      ON style_bible_runs(owner_id, project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_style_bible_runs_status_due
      ON style_bible_runs(status, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_style_bible_runs_run_id
      ON style_bible_runs(run_id);
    CREATE INDEX IF NOT EXISTS idx_time_stats_style_bible_runs_created
      ON style_bible_runs(created_at DESC);

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
      metadata_json  TEXT NOT NULL DEFAULT '{}',
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
      error_message TEXT,
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

    CREATE TABLE IF NOT EXISTS first_frame_rewrite_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      project_id   TEXT NOT NULL,
      group_idx    INTEGER NOT NULL,
      called_at    TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_first_frame_rewrite_calls_user_time
      ON first_frame_rewrite_calls(user_id, called_at DESC);
    CREATE INDEX IF NOT EXISTS idx_first_frame_rewrite_calls_project_time
      ON first_frame_rewrite_calls(user_id, project_id, called_at DESC);

    CREATE TABLE IF NOT EXISTS batch_tasks (
      id            TEXT PRIMARY KEY,
      batch_id      TEXT NOT NULL,
      seq           INTEGER NOT NULL,
      task_type     TEXT NOT NULL DEFAULT 'batch',
      priority      INTEGER NOT NULL DEFAULT 0,
      target_json   TEXT NOT NULL DEFAULT '{}',
      status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
	      status_reason TEXT,
	      result_json   TEXT NOT NULL DEFAULT '{}',
	      error_msg     TEXT,
	      error_message TEXT,
	      admin_disposition TEXT,
	      runner_id     TEXT,
      lease_expires_at TEXT,
      heartbeat_at  TEXT,
      idempotency_key TEXT,
      provider      TEXT,
      provider_task_id TEXT,
      parent_task_id TEXT,
      retry_count   INTEGER NOT NULL DEFAULT 0,
	      max_retries   INTEGER NOT NULL DEFAULT 3,
	      cancel_requested_at TEXT,
	      cancelled_local_at TEXT,
	      refund_checked_at TEXT,
	      last_checked_at TEXT,
      next_retry_at TEXT,
      remote_url    TEXT,
      remote_url_expires_at TEXT,
      download_attempts INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch ON batch_tasks(batch_id, seq);
    CREATE INDEX IF NOT EXISTS idx_time_stats_batch_tasks_created
      ON batch_tasks(created_at DESC);

    CREATE TABLE IF NOT EXISTS task_state_history (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      from_state  TEXT,
      to_state    TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      actor       TEXT NOT NULL DEFAULT 'system',
      runner_id   TEXT,
      meta_json   TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES batch_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_state_history_task_time
      ON task_state_history(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_time_stats_task_state_terminal
      ON task_state_history(task_id, to_state, created_at DESC);

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      job_name          TEXT PRIMARY KEY,
      status            TEXT NOT NULL DEFAULT 'idle',
      catch_up_strategy TEXT NOT NULL DEFAULT 'run_once',
      last_run_at       TEXT,
      next_run_at       TEXT,
      runner_id         TEXT,
      lease_expires_at  TEXT,
      heartbeat_at      TEXT,
      meta_json         TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (catch_up_strategy IN ('run_once', 'replay_intervals', 'current_state_only'))
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
      ON scheduled_jobs(status, next_run_at, lease_expires_at);

    -- 阶段四：视频任务（单条片段生成）
	    CREATE TABLE IF NOT EXISTS video_tasks (
	      id            TEXT PRIMARY KEY,
	      owner_id      INTEGER NOT NULL,
	      project_id    TEXT,
	      group_idx     INTEGER,                  -- 关联 storyboards[group_idx]
	      prompt        TEXT NOT NULL DEFAULT '',
	      provider      TEXT NOT NULL DEFAULT 'openai',  -- openai | seedance | keling | fake
	      provider_task TEXT,                      -- 远端任务 id（用于轮询）
	      video_prompt_snapshot_json TEXT NOT NULL DEFAULT '{}',
	      billing_session_id TEXT,
	      billing_context_json TEXT NOT NULL DEFAULT '{}',
	      status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
	      progress      INTEGER NOT NULL DEFAULT 0,      -- 0-100
	      filename      TEXT,                            -- data/videos/<owner>/<filename>
	      duration_sec  REAL,
	      cover_image_id TEXT,                           -- 关联 images.id（视频封面）
	      error_msg     TEXT,
	      error_message TEXT,
	      cancel_requested_at TEXT,
	      cancelled_local_at TEXT,
	      admin_disposition TEXT,
	      refund_checked_at TEXT,
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
      provider      TEXT,
      external_export_id TEXT,
      filename      TEXT,                            -- data/exports/<owner>/<filename>.mp4
      local_download_status TEXT,                    -- pending | downloading | completed | download_failed
      edl_json      TEXT NOT NULL DEFAULT '{}',
      edl_version   INTEGER,
      bgm_id        TEXT,
	      duration_sec  REAL,
	      error_msg     TEXT,
	      error_message TEXT,
	      cancel_requested_at TEXT,
	      cancelled_local_at TEXT,
	      admin_disposition TEXT,
	      refund_checked_at TEXT,
	      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_exports_owner ON exports(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_time_stats_exports_created
      ON exports(created_at DESC);

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

    -- 工具箱历史索引：用户级全局聚合，不绑定项目流水线
    CREATE TABLE IF NOT EXISTS toolbox_items (
      id              TEXT PRIMARY KEY,
      owner_id        INTEGER NOT NULL,
      tool_type       TEXT NOT NULL,         -- image | video
      mode            TEXT NOT NULL,         -- text_to_image | image_to_image | image_to_video | first_last_frame_video | upload
      source_type     TEXT NOT NULL DEFAULT 'generated', -- generated | upload | enhance
      status          TEXT NOT NULL DEFAULT 'completed', -- running | completed | failed
      prompt          TEXT NOT NULL DEFAULT '',
      params_json     TEXT NOT NULL DEFAULT '{}',
      input_refs_json TEXT NOT NULL DEFAULT '[]',
      result_ref_type TEXT NOT NULL,         -- image | video | upload
      result_ref_id   TEXT,
      parent_item_id  TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_item_id) REFERENCES toolbox_items(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_toolbox_items_owner_tool_time
      ON toolbox_items(owner_id, tool_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_toolbox_items_owner_status_tool
      ON toolbox_items(owner_id, status, tool_type);
    CREATE INDEX IF NOT EXISTS idx_toolbox_items_parent
      ON toolbox_items(parent_item_id);

    -- 角色定制：独立于项目资产页的自定义角色与版本历史。
    CREATE TABLE IF NOT EXISTS custom_characters (
      id                 TEXT PRIMARY KEY,
      owner_id           INTEGER NOT NULL,
      project_id         TEXT,
      current_version_id TEXT,
      title              TEXT NOT NULL DEFAULT '未命名角色',
      lifecycle_status   TEXT NOT NULL DEFAULT 'confirmed',
      confirmed_at       TEXT,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_custom_characters_owner_project_time
      ON custom_characters(owner_id, project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS custom_character_versions (
      id              TEXT PRIMARY KEY,
      character_id    TEXT NOT NULL,
      owner_id        INTEGER NOT NULL,
      project_id      TEXT,
      version_no      INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'completed',
      source_type     TEXT NOT NULL DEFAULT 'prompt',
      prompt          TEXT NOT NULL DEFAULT '',
      params_json     TEXT NOT NULL DEFAULT '{}',
      input_refs_json TEXT NOT NULL DEFAULT '[]',
      fields_json     TEXT NOT NULL DEFAULT '{}',
      result_image_id TEXT,
      source_hash     TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (character_id) REFERENCES custom_characters(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_character_versions_number
      ON custom_character_versions(character_id, version_no);
    CREATE INDEX IF NOT EXISTS idx_custom_character_versions_owner_time
      ON custom_character_versions(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_custom_character_versions_character_time
      ON custom_character_versions(character_id, version_no DESC);

    -- 素材库 v1：长期资产索引。真实文件型素材才进入 assets；
    -- 生成中、失败槽位、部分成功记录进入 generation_batches / generation_failures。
    CREATE TABLE IF NOT EXISTS asset_version_groups (
      version_group_id TEXT PRIMARY KEY,
      owner_id         INTEGER NOT NULL,
      project_id       TEXT,
      shot_uid         TEXT,
      stage            TEXT NOT NULL,
      current_asset_id TEXT,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_asset_version_groups_slot
      ON asset_version_groups(owner_id, project_id, shot_uid, stage, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_asset_version_groups_current
      ON asset_version_groups(current_asset_id);

    CREATE TABLE IF NOT EXISTS assets (
      asset_id                TEXT PRIMARY KEY,
      owner_id                INTEGER NOT NULL,
      project_id              TEXT,
      shot_uid                TEXT,
      legacy_shot_id          TEXT,
      version_group_id        TEXT NOT NULL,
      batch_id                TEXT,
      asset_kind              TEXT NOT NULL,
      source                  TEXT NOT NULL,
      stage                   TEXT NOT NULL,
      file_uri                TEXT NOT NULL,
      thumb_uri               TEXT,
      file_hash               TEXT,
      byte_size               INTEGER NOT NULL DEFAULT 0,
      duration_ms             INTEGER,
      width                   INTEGER,
      height                  INTEGER,
      version_index           INTEGER NOT NULL DEFAULT 1,
      predecessor_version_asset_id TEXT,
      lifecycle_status        TEXT NOT NULL DEFAULT 'active',
      storage_tier            TEXT NOT NULL DEFAULT 'hot',
      file_availability       TEXT NOT NULL DEFAULT 'present',
      project_relation_status TEXT NOT NULL DEFAULT 'linked',
      shot_relation_status    TEXT NOT NULL DEFAULT 'unknown',
      purge_eligible_at       TEXT,
      accessed_at             TEXT,
      created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (version_group_id) REFERENCES asset_version_groups(version_group_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_assets_owner_created
      ON assets(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_owner_project
      ON assets(owner_id, project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_version_group
      ON assets(version_group_id, version_index DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_batch
      ON assets(batch_id);
    CREATE INDEX IF NOT EXISTS idx_assets_stage_kind
      ON assets(owner_id, stage, asset_kind, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_file_identity
      ON assets(owner_id, COALESCE(project_id, ''), COALESCE(shot_uid, COALESCE(legacy_shot_id, '')), stage, COALESCE(file_hash, file_uri));

    CREATE TABLE IF NOT EXISTS generation_batches (
      batch_id         TEXT PRIMARY KEY,
      owner_id         INTEGER NOT NULL,
      project_id       TEXT,
      shot_uid         TEXT,
      legacy_shot_id   TEXT,
      stage            TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'running',
      requested_count  INTEGER NOT NULL DEFAULT 1,
      succeeded_count  INTEGER NOT NULL DEFAULT 0,
      failed_count     INTEGER NOT NULL DEFAULT 0,
      context_hash     TEXT,
      context_snapshot TEXT NOT NULL DEFAULT '{}',
      source           TEXT NOT NULL DEFAULT 'project',
      error_message    TEXT,
      started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      heartbeat_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at     TEXT,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_generation_batches_owner_time
      ON generation_batches(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generation_batches_project_slot
      ON generation_batches(owner_id, project_id, shot_uid, stage, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generation_batches_status_heartbeat
      ON generation_batches(status, heartbeat_at);
    DROP INDEX IF EXISTS idx_time_stats_generation_stage_source_created;
    CREATE INDEX IF NOT EXISTS idx_time_stats_generation_stage_created
      ON generation_batches(stage, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_generation_batches_running_project_slot
      ON generation_batches(owner_id, project_id, shot_uid, stage)
      WHERE status = 'running'
        AND project_id IS NOT NULL
        AND shot_uid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS generation_failures (
      failure_id      TEXT PRIMARY KEY,
      batch_id        TEXT NOT NULL,
      owner_id        INTEGER NOT NULL,
      slot_index      INTEGER NOT NULL DEFAULT 0,
      failure_reason  TEXT NOT NULL DEFAULT 'unknown',
      error_message   TEXT,
      retryable       INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (batch_id) REFERENCES generation_batches(batch_id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_generation_failures_batch
      ON generation_failures(batch_id, slot_index);

    CREATE TABLE IF NOT EXISTS asset_dependencies (
      asset_id                  TEXT NOT NULL,
      input_asset_id            TEXT NOT NULL,
      dependency_role           TEXT NOT NULL,
      dependency_order          INTEGER NOT NULL DEFAULT 0,
      required_for_regeneration INTEGER NOT NULL DEFAULT 0,
      created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (asset_id, input_asset_id, dependency_role, dependency_order),
      FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
      FOREIGN KEY (input_asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_asset_dependencies_input
      ON asset_dependencies(input_asset_id, dependency_role);

    CREATE TABLE IF NOT EXISTS edit_projects (
      edit_project_id TEXT PRIMARY KEY,
      owner_id        INTEGER NOT NULL,
      project_id      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'draft',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_edit_projects_owner_project
      ON edit_projects(owner_id, project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS edit_project_clips (
      edit_project_id TEXT NOT NULL,
      asset_id        TEXT NOT NULL,
      position        INTEGER NOT NULL DEFAULT 0,
      in_ms           INTEGER NOT NULL DEFAULT 0,
      out_ms          INTEGER,
      track           INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (edit_project_id, asset_id, position, track),
      FOREIGN KEY (edit_project_id) REFERENCES edit_projects(edit_project_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_edit_project_clips_asset
      ON edit_project_clips(asset_id);

    CREATE TABLE IF NOT EXISTS quota_usage (
      owner_id          INTEGER PRIMARY KEY,
      hot_image_count   INTEGER NOT NULL DEFAULT 0,
      hot_image_bytes   INTEGER NOT NULL DEFAULT 0,
      hot_video_count   INTEGER NOT NULL DEFAULT 0,
      hot_video_bytes   INTEGER NOT NULL DEFAULT 0,
      hot_total_bytes   INTEGER NOT NULL DEFAULT 0,
      is_over_quota     INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS asset_audit_events (
      id          TEXT PRIMARY KEY,
      owner_id    INTEGER NOT NULL,
      asset_id    TEXT,
      event_type  TEXT NOT NULL,
      actor       TEXT NOT NULL DEFAULT 'system',
      meta_json   TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_asset_audit_events_asset
      ON asset_audit_events(asset_id, created_at DESC);

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

    -- 风格模板：独立于世界观模板，描述画面风格 / 镜头 / 色彩 / 剪辑 / 负向约束
    CREATE TABLE IF NOT EXISTS style_templates (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER,
      name         TEXT NOT NULL,
      category     TEXT NOT NULL DEFAULT '',
      summary      TEXT NOT NULL DEFAULT '',
      data_json    TEXT NOT NULL DEFAULT '{}',
      source       TEXT NOT NULL DEFAULT 'user', -- system | user
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_style_templates_owner ON style_templates(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_style_templates_source ON style_templates(source, updated_at DESC);

    -- 知识卡：系统 / 用户可复用规则源。P0 只用于审计，不直接注入 LLM。
    CREATE TABLE IF NOT EXISTS knowledge_cards (
      id              TEXT PRIMARY KEY,
      owner_id        INTEGER,
      scope           TEXT NOT NULL,
      module          TEXT NOT NULL,
      card_type       TEXT NOT NULL,
      title           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      lifecycle       TEXT NOT NULL DEFAULT 'published',
      priority        INTEGER NOT NULL DEFAULT 100,
      tags_json       TEXT NOT NULL DEFAULT '[]',
      data_json       TEXT NOT NULL DEFAULT '{}',
      source_ref_json TEXT NOT NULL DEFAULT '{}',
      schema_version  INTEGER NOT NULL DEFAULT 1,
      version         INTEGER NOT NULL DEFAULT 1,
      published_at    TEXT,
      published_by    INTEGER,
      previous_version_id TEXT,
      seeded_at       TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (published_by) REFERENCES admin_users(id) ON DELETE SET NULL,
      CHECK (scope IN ('system', 'user')),
      CHECK (
        (scope = 'system' AND owner_id IS NULL)
        OR (scope = 'user' AND owner_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_cards_module
      ON knowledge_cards(module, status, priority, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_cards_owner_module
      ON knowledge_cards(owner_id, module, status, priority, updated_at DESC);

    -- 项目级阶段知识上下文审计。P0 不加 FK，项目删除后的孤儿 row 暂时容忍，P1 再评估级联/清理。
    CREATE TABLE IF NOT EXISTS project_knowledge_contexts (
      id                 TEXT PRIMARY KEY,
      owner_id           INTEGER NOT NULL,
      project_id         TEXT NOT NULL,
      stage              TEXT NOT NULL,
      provider           TEXT,
      stage_target_json  TEXT NOT NULL DEFAULT '{}',
      input_hash         TEXT NOT NULL,
      context_hash       TEXT NOT NULL,
      context_json       TEXT NOT NULL,
      prompt_block       TEXT,
      source_hashes_json TEXT NOT NULL DEFAULT '[]',
      rule_card_ids_json TEXT NOT NULL DEFAULT '[]',
      created_by_run_id  TEXT,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_id, project_id, stage, input_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_project_knowledge_contexts_stage
      ON project_knowledge_contexts(owner_id, project_id, stage, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_knowledge_contexts_hash
      ON project_knowledge_contexts(context_hash);
    CREATE INDEX IF NOT EXISTS idx_project_knowledge_contexts_run
      ON project_knowledge_contexts(created_by_run_id);

    -- 世界观 -> 风格模板的全局默认推荐。world_templates 是 (owner_id, id) 复合主键，
    -- 因此这里也用 world_template_owner_id + world_template_id 做复合外键。
    CREATE TABLE IF NOT EXISTS world_style_default_mappings (
      id                      TEXT PRIMARY KEY,
      world_template_owner_id INTEGER NOT NULL,
      world_template_id       TEXT NOT NULL,
      style_template_id       TEXT NOT NULL,
      is_default              INTEGER NOT NULL DEFAULT 0,
      created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (world_template_owner_id, world_template_id)
        REFERENCES world_templates(owner_id, id) ON DELETE CASCADE,
      FOREIGN KEY (style_template_id) REFERENCES style_templates(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_default_per_world
      ON world_style_default_mappings(world_template_owner_id, world_template_id)
      WHERE is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_world_style_default_world
      ON world_style_default_mappings(world_template_owner_id, world_template_id);

    -- 用户最近实际使用的世界观 + 风格模板组合。只在风格圣经生成成功后写入。
    CREATE TABLE IF NOT EXISTS user_world_style_recent_mappings (
      user_id                 INTEGER NOT NULL,
      world_template_owner_id INTEGER NOT NULL,
      world_template_id       TEXT NOT NULL,
      style_template_id       TEXT NOT NULL,
      last_used_at            TEXT NOT NULL,
      PRIMARY KEY (user_id, world_template_owner_id, world_template_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (world_template_owner_id, world_template_id)
        REFERENCES world_templates(owner_id, id) ON DELETE CASCADE,
      FOREIGN KEY (style_template_id) REFERENCES style_templates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_world_style_recent_user
      ON user_world_style_recent_mappings(user_id, last_used_at DESC);

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
	      overdraft_credits    INTEGER NOT NULL DEFAULT 0,
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
      provider    TEXT,
	      model       TEXT,
	      model_role  TEXT,
	      cost_micros INTEGER,
	      cost_currency TEXT,
	      operation_module TEXT,
	      operation_feature TEXT,
	      consumption_type TEXT,
	      quantity REAL,
	      input_tokens INTEGER,
	      output_tokens INTEGER,
	      cached_tokens INTEGER,
	      reasoning_tokens INTEGER,
	      duration_sec REAL,
	      price_catalog_id TEXT,
	      price_snapshot_json TEXT,
	      usage_event_ids_json TEXT,
	      admin_user_id INTEGER,
	      idempotency_key TEXT,
	      charge_ref_id TEXT,
      refund_ref_id TEXT,
      balance_after INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
	    );
	    CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON credit_ledger(user_id, created_at DESC);

	    CREATE TABLE IF NOT EXISTS api_price_catalog (
	      id                         TEXT PRIMARY KEY,
	      provider                   TEXT,
	      model                      TEXT NOT NULL,
	      model_role                 TEXT,
	      consumption_type           TEXT NOT NULL,
	      unit                       TEXT NOT NULL,
	      price_cny_micros_per_unit  INTEGER NOT NULL,
	      price_usd_micros_per_unit  INTEGER,
	      original_currency          TEXT NOT NULL DEFAULT 'CNY',
	      original_price             REAL,
	      exchange_rate              REAL,
	      source_note                TEXT NOT NULL DEFAULT '',
	      status                     TEXT NOT NULL DEFAULT 'active',
	      effective_from             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	      last_updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	      last_updated_by            TEXT,
	      created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	      CHECK (status IN ('active', 'requires_probe', 'disabled'))
	    );
	    CREATE INDEX IF NOT EXISTS idx_api_price_catalog_lookup
	      ON api_price_catalog(model, provider, model_role, consumption_type, status);

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

    CREATE TABLE IF NOT EXISTS content_flags (
      id           TEXT PRIMARY KEY,
      owner_id     INTEGER NOT NULL,
      project_id   TEXT,
      source_type  TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      raw_excerpt  TEXT NOT NULL DEFAULT '',
      scan_reason  TEXT NOT NULL DEFAULT '',
      severity     TEXT NOT NULL DEFAULT 'medium',
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      reviewed_by  INTEGER,
      reviewed_at  TEXT,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES admin_users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_content_flags_status_time ON content_flags(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_flags_owner_project ON content_flags(owner_id, project_id, created_at DESC);

    -- 运行时服务心跳：web / worker / 后续独立服务都可以写这里，健康检查读最近心跳。
    CREATE TABLE IF NOT EXISTS runtime_service_heartbeats (
      service      TEXT PRIMARY KEY,
      pid          INTEGER,
      hostname     TEXT,
      meta_json    TEXT NOT NULL DEFAULT '{}',
      heartbeat_at TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS observability_events (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      slot          TEXT,
      provider      TEXT,
      model         TEXT,
      status        TEXT NOT NULL DEFAULT 'info',
      status_code   INTEGER,
      error_code    TEXT,
      latency_ms    INTEGER,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      message       TEXT NOT NULL DEFAULT '',
      meta_json     TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_observability_events_type_time
      ON observability_events(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_observability_events_slot_time
      ON observability_events(slot, created_at DESC);

    CREATE TABLE IF NOT EXISTS token_usage_events (
      id                     TEXT PRIMARY KEY,
      created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      owner_id               INTEGER,
      username_snapshot      TEXT,
      project_id             TEXT,
      project_title_snapshot TEXT,
      request_path           TEXT,
      route_name             TEXT,
      trace_name             TEXT,
      module_key             TEXT NOT NULL DEFAULT 'other',
      module_label           TEXT NOT NULL DEFAULT '其它',
      feature_key            TEXT NOT NULL DEFAULT 'unknown',
      feature_label          TEXT NOT NULL DEFAULT '未知功能',
      call_item_type         TEXT,
      call_item_id           TEXT,
      call_item_label        TEXT,
      provider               TEXT,
      model                  TEXT,
      model_role             TEXT,
      slot                   TEXT,
      status                 TEXT NOT NULL,
      status_code            INTEGER,
      error_code             TEXT,
      latency_ms             INTEGER,
      input_tokens           INTEGER,
      output_tokens          INTEGER,
      reasoning_tokens       INTEGER,
      cached_tokens          INTEGER,
      total_tokens           INTEGER,
	      billable_tokens        INTEGER,
	      usage_source           TEXT NOT NULL DEFAULT 'missing',
	      billing_session_id     TEXT,
	      billing_scope          TEXT NOT NULL DEFAULT 'unknown',
	      operation_key          TEXT,
	      operation_label        TEXT,
	      consumption_type       TEXT,
	      quantity               REAL,
	      duration_sec           REAL,
	      billing_status         TEXT NOT NULL DEFAULT 'unbilled',
	      ledger_id              TEXT,
	      provider_response_hash TEXT,
	      prompt_hash            TEXT,
	      response_hash          TEXT,
      batch_id               TEXT,
      task_id                TEXT,
      run_id                 TEXT,
      correlation_id         TEXT,
      meta_json              TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_time
      ON token_usage_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_token_usage_owner_time
      ON token_usage_events(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_token_usage_category_time
      ON token_usage_events(module_key, feature_key, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_token_usage_model_time
	      ON token_usage_events(provider, model, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_activity (
      user_id       INTEGER PRIMARY KEY,
      last_seen_at  TEXT NOT NULL,
      path          TEXT,
      user_agent    TEXT,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_activity_last_seen
      ON user_activity(last_seen_at DESC);

    -- 注册/登录/重置密码短信验证码（OTP）
    CREATE TABLE IF NOT EXISTS otp_codes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      phone        TEXT NOT NULL,
      code_hash    TEXT NOT NULL,
      purpose      TEXT NOT NULL DEFAULT 'register',
      ip           TEXT,
      used         INTEGER NOT NULL DEFAULT 0,
      attempts     INTEGER NOT NULL DEFAULT 0,
      expires_at   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_otp_ip ON otp_codes(ip, created_at DESC);
  `);

  seedDefaultUser(db);
  seedDefaultAdminUser(db);
  seedDefaultStyleTemplates(db);
  seedSystemCards(db);
  seedDefaultCredits(db);
  seedDefaultRedeemCodes(db);
  migrateLedgerBuckets(db);
  migrateBatchLeaseColumns(db);
  migrateDurableTaskColumns(db);
	  migrateLedgerIdempotencyColumns(db);
	  migrateUsageBillingColumns(db);
	  migrateImageAuditColumns(db);
  migrateExportEdlVersionColumn(db);
  migrateExportLocalDownloadColumns(db);
  migrateExportProviderColumns(db);
  migrateStoryboardMaterialImageIndex(db);
  migrateAdminFoundationColumns(db);
  migrateAdminGovernanceColumns(db);
  migrateOperationalLinkageColumns(db);
  migrateProjectsVersionColumn(db);
  migrateVideoPromptSnapshotColumn(db);
  migrateCustomCharacterLifecycleColumns(db);
  migratePhoneIdentityColumns(db);
  migrateOtpPhoneIdentityTable(db);
}

// projects.version：乐观锁版本号迁移。老库没有这一列，给所有现存项目兜底成 1。
// 新插入的项目走 schema DEFAULT 1。
// addColumnIfMissing 的 ddl 参数约定要带列名（见其它 callsite），所以这里是 'version INTEGER ...'。
function migrateProjectsVersionColumn(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'projects', 'version', 'version INTEGER NOT NULL DEFAULT 1');
  } catch (e) {
    console.warn('[db] migrateProjectsVersionColumn failed:', e);
  }
}

function migrateVideoPromptSnapshotColumn(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'video_tasks', 'video_prompt_snapshot_json', "video_prompt_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  } catch (e) {
    console.warn('[db] migrateVideoPromptSnapshotColumn failed:', e);
  }
}

function migrateCustomCharacterLifecycleColumns(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'custom_characters', 'lifecycle_status', "lifecycle_status TEXT NOT NULL DEFAULT 'confirmed'");
    addColumnIfMissing(db, 'custom_characters', 'confirmed_at', 'confirmed_at TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_characters_owner_lifecycle_project_time
      ON custom_characters(owner_id, lifecycle_status, project_id, updated_at DESC)`);
  } catch (e) {
    console.warn('[db] migrateCustomCharacterLifecycleColumns failed:', e);
  }
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[db] migrated ${table}: added ${column}`);
  }
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function migratePhoneIdentityColumns(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'users', 'phone', 'phone TEXT');
    const seedPhone = normalizeSeedPhone(process.env.SEED_PHONE || '');
    const seedUser = (process.env.SEED_USER || '').trim();
    if (seedPhone && seedUser) {
      db.prepare(
        `UPDATE users
            SET phone = @phone,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE phone IS NULL
            AND username = @username
            AND NOT EXISTS (SELECT 1 FROM users WHERE phone = @phone)`,
      ).run({ phone: seedPhone, username: seedUser });
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone) WHERE phone IS NOT NULL`);
  } catch (e) {
    console.warn('[db] migratePhoneIdentityColumns failed:', e);
  }
}

function migrateOtpPhoneIdentityTable(db: Database.Database) {
  try {
    const cols = db.prepare("PRAGMA table_info(otp_codes)").all() as Array<{ name: string }>;
    if (cols.length && !cols.some((c) => c.name === 'phone')) {
      db.exec('DROP TABLE IF EXISTS otp_codes');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        phone        TEXT NOT NULL,
        code_hash    TEXT NOT NULL,
        purpose      TEXT NOT NULL DEFAULT 'register',
        ip           TEXT,
        used         INTEGER NOT NULL DEFAULT 0,
        attempts     INTEGER NOT NULL DEFAULT 0,
        expires_at   TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, purpose, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_otp_ip ON otp_codes(ip, created_at DESC);
    `);
  } catch (e) {
    console.warn('[db] migrateOtpPhoneIdentityTable failed:', e);
  }
}

function migrateAdminFoundationColumns(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'users', 'token_revoked_at', 'token_revoked_at TEXT');
    addColumnIfMissing(db, 'users', 'disabled_at', 'disabled_at TEXT');
    migrateDropLegacyUserAdminColumn(db);
    addColumnIfMissing(db, 'admin_users', 'preview_user_id', 'preview_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  } catch (e) {
    console.warn('[db] migrateAdminFoundationColumns:', e);
  }
}

function migrateAdminGovernanceColumns(db: Database.Database) {
  try {
    for (const column of ['provider TEXT', 'model TEXT', 'model_role TEXT', 'cost_micros INTEGER', 'admin_user_id INTEGER', 'idempotency_key TEXT']) {
      const name = column.split(' ')[0];
      addColumnIfMissing(db, 'credit_ledger', name, column);
    }
    for (const column of [
      "lifecycle TEXT NOT NULL DEFAULT 'published'",
      'published_at TEXT',
      'published_by INTEGER',
      'previous_version_id TEXT',
    ]) {
      const name = column.split(' ')[0];
      addColumnIfMissing(db, 'knowledge_cards', name, column);
    }
    for (const table of ['batches', 'batch_tasks', 'video_tasks', 'exports']) {
      addColumnIfMissing(db, table, 'error_message', 'error_message TEXT');
    }
    addColumnIfMissing(db, 'project_knowledge_contexts', 'provider', 'provider TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_knowledge_contexts_provider
      ON project_knowledge_contexts(provider, updated_at DESC)`);
    migrateAdminActionsNullableAdminUser(db);
    addColumnIfMissing(db, 'admin_actions', 'response_status', 'response_status INTEGER NOT NULL DEFAULT 200');
    migrateAdminActionIdempotencyIndex(db);
  } catch (e) {
    console.warn('[db] migrateAdminGovernanceColumns:', e);
  }
}

function migrateOperationalLinkageColumns(db: Database.Database) {
  try {
    for (const table of ['batch_tasks', 'video_tasks', 'exports']) {
      addColumnIfMissing(db, table, 'cancel_requested_at', 'cancel_requested_at TEXT');
      addColumnIfMissing(db, table, 'cancelled_local_at', 'cancelled_local_at TEXT');
      addColumnIfMissing(db, table, 'admin_disposition', 'admin_disposition TEXT');
      addColumnIfMissing(db, table, 'refund_checked_at', 'refund_checked_at TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS observability_events (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        slot          TEXT,
        provider      TEXT,
        model         TEXT,
        status        TEXT NOT NULL DEFAULT 'info',
        status_code   INTEGER,
        error_code    TEXT,
        latency_ms    INTEGER,
        fallback_used INTEGER NOT NULL DEFAULT 0,
        message       TEXT NOT NULL DEFAULT '',
        meta_json     TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_observability_events_type_time
        ON observability_events(type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_observability_events_slot_time
        ON observability_events(slot, created_at DESC);

      CREATE TABLE IF NOT EXISTS token_usage_events (
        id                     TEXT PRIMARY KEY,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        owner_id               INTEGER,
        username_snapshot      TEXT,
        project_id             TEXT,
        project_title_snapshot TEXT,
        request_path           TEXT,
        route_name             TEXT,
        trace_name             TEXT,
        module_key             TEXT NOT NULL DEFAULT 'other',
        module_label           TEXT NOT NULL DEFAULT '其它',
        feature_key            TEXT NOT NULL DEFAULT 'unknown',
        feature_label          TEXT NOT NULL DEFAULT '未知功能',
        call_item_type         TEXT,
        call_item_id           TEXT,
        call_item_label        TEXT,
        provider               TEXT,
        model                  TEXT,
        model_role             TEXT,
        slot                   TEXT,
        status                 TEXT NOT NULL,
        status_code            INTEGER,
        error_code             TEXT,
        latency_ms             INTEGER,
        input_tokens           INTEGER,
        output_tokens          INTEGER,
        reasoning_tokens       INTEGER,
        cached_tokens          INTEGER,
        total_tokens           INTEGER,
        billable_tokens        INTEGER,
        usage_source           TEXT NOT NULL DEFAULT 'missing',
        prompt_hash            TEXT,
        response_hash          TEXT,
        batch_id               TEXT,
        task_id                TEXT,
        run_id                 TEXT,
        correlation_id         TEXT,
        meta_json              TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_time
        ON token_usage_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_usage_owner_time
        ON token_usage_events(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_usage_category_time
        ON token_usage_events(module_key, feature_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_usage_model_time
        ON token_usage_events(provider, model, created_at DESC);

      CREATE TABLE IF NOT EXISTS user_activity (
        user_id       INTEGER PRIMARY KEY,
        last_seen_at  TEXT NOT NULL,
        path          TEXT,
        user_agent    TEXT,
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_user_activity_last_seen
        ON user_activity(last_seen_at DESC);
    `);
  } catch (e) {
    console.warn('[db] migrateOperationalLinkageColumns:', e);
  }
}

function migrateAdminActionsNullableAdminUser(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(admin_actions)").all() as Array<{ name: string; notnull: number }>;
  const adminCol = cols.find((c) => c.name === 'admin_user_id');
  if (!adminCol || adminCol.notnull === 0) return;

  const hasResponseStatus = cols.some((c) => c.name === 'response_status');
  const responseStatusSelect = hasResponseStatus ? 'response_status' : '200 AS response_status';
  console.log('[db] migrating admin_actions: allow null admin_user_id');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE admin_actions_new (
          id                TEXT PRIMARY KEY,
          request_id        TEXT,
          admin_user_id     INTEGER,
          category          TEXT NOT NULL,
          action            TEXT NOT NULL,
          target_type       TEXT,
          target_id         TEXT,
          reason            TEXT,
          dry_run           INTEGER NOT NULL DEFAULT 0,
          idempotency_key   TEXT,
          before_json       TEXT NOT NULL DEFAULT '{}',
          after_json        TEXT NOT NULL DEFAULT '{}',
          result_json       TEXT NOT NULL DEFAULT '{}',
          response_status   INTEGER NOT NULL DEFAULT 200,
          status            TEXT NOT NULL DEFAULT 'completed',
          error_msg         TEXT,
          ip                TEXT,
          user_agent        TEXT,
          created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
        );
        INSERT INTO admin_actions_new
          (id, request_id, admin_user_id, category, action, target_type, target_id, reason,
           dry_run, idempotency_key, before_json, after_json, result_json, response_status,
           status, error_msg, ip, user_agent, created_at)
        SELECT
          id, request_id, admin_user_id, category, action, target_type, target_id, reason,
          dry_run, idempotency_key, before_json, after_json, result_json, ${responseStatusSelect},
          status, error_msg, ip, user_agent, created_at
        FROM admin_actions;
        DROP TABLE admin_actions;
        ALTER TABLE admin_actions_new RENAME TO admin_actions;
        CREATE INDEX IF NOT EXISTS idx_admin_actions_admin_time ON admin_actions(admin_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_admin_actions_category_time ON admin_actions(category, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_admin_actions_idempotency_lookup
          ON admin_actions(action, idempotency_key, created_at DESC)
          WHERE idempotency_key IS NOT NULL;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateAdminActionIdempotencyIndex(db: Database.Database) {
  db.exec(`
    UPDATE admin_actions
       SET status = 'duplicate',
           error_msg = COALESCE(error_msg, 'duplicate idempotency audit row deduped before unique index')
     WHERE rowid IN (
       SELECT rowid FROM (
         SELECT rowid,
                ROW_NUMBER() OVER (
                  PARTITION BY action, idempotency_key
                  ORDER BY created_at DESC, rowid DESC
                ) AS rn
           FROM admin_actions
          WHERE dry_run = 0
            AND idempotency_key IS NOT NULL
            AND status IN ('in_progress', 'completed')
       )
       WHERE rn > 1
     );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_actions_idempotency_active
      ON admin_actions(action, idempotency_key)
      WHERE dry_run = 0
        AND idempotency_key IS NOT NULL
        AND status IN ('in_progress', 'completed');
  `);
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

function migrateDurableTaskColumns(db: Database.Database) {
  try {
    const columns = [
      "task_type TEXT NOT NULL DEFAULT 'batch'",
      'priority INTEGER NOT NULL DEFAULT 0',
      'status_reason TEXT',
      'runner_id TEXT',
      'lease_expires_at TEXT',
      'heartbeat_at TEXT',
      'idempotency_key TEXT',
      'provider TEXT',
      'provider_task_id TEXT',
      'parent_task_id TEXT',
      'retry_count INTEGER NOT NULL DEFAULT 0',
      'max_retries INTEGER NOT NULL DEFAULT 3',
      'cancel_requested_at TEXT',
      'last_checked_at TEXT',
      'next_retry_at TEXT',
      'remote_url TEXT',
      'remote_url_expires_at TEXT',
      'download_attempts INTEGER NOT NULL DEFAULT 0',
    ];
    for (const column of columns) {
      const name = column.split(' ')[0];
      addColumnIfMissing(db, 'batch_tasks', name, column);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_batch_tasks_claim
        ON batch_tasks(status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_batch_tasks_runner
        ON batch_tasks(runner_id, status, lease_expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_tasks_provider_task
        ON batch_tasks(provider, provider_task_id)
        WHERE provider IS NOT NULL
          AND provider_task_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS task_state_history (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        actor       TEXT NOT NULL DEFAULT 'system',
        runner_id   TEXT,
        meta_json   TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES batch_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_state_history_task_time
        ON task_state_history(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        job_name          TEXT PRIMARY KEY,
        status            TEXT NOT NULL DEFAULT 'idle',
        catch_up_strategy TEXT NOT NULL DEFAULT 'run_once',
        last_run_at       TEXT,
        next_run_at       TEXT,
        runner_id         TEXT,
        lease_expires_at  TEXT,
        heartbeat_at      TEXT,
        meta_json         TEXT NOT NULL DEFAULT '{}',
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (catch_up_strategy IN ('run_once', 'replay_intervals', 'current_state_only'))
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
        ON scheduled_jobs(status, next_run_at, lease_expires_at);
    `);
  } catch (e) {
    console.warn('[db] migrateDurableTaskColumns:', e);
  }
}

function migrateLedgerIdempotencyColumns(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'credit_ledger', 'charge_ref_id', 'charge_ref_id TEXT');
    addColumnIfMissing(db, 'credit_ledger', 'refund_ref_id', 'refund_ref_id TEXT');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_charge_ref
        ON credit_ledger(charge_ref_id)
        WHERE charge_ref_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_refund_ref
        ON credit_ledger(refund_ref_id)
        WHERE refund_ref_id IS NOT NULL;
    `);
  } catch (e) {
    console.warn('[db] migrateLedgerIdempotencyColumns:', e);
  }
}

function migrateUsageBillingColumns(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'user_credits', 'overdraft_credits', 'overdraft_credits INTEGER NOT NULL DEFAULT 0');
    db.prepare(
      `UPDATE user_credits
          SET total_credits = subscription_credits + topup_credits + bonus_credits - overdraft_credits`,
    ).run();

    for (const column of [
      'cost_currency TEXT',
      'operation_module TEXT',
      'operation_feature TEXT',
      'consumption_type TEXT',
      'quantity REAL',
      'input_tokens INTEGER',
      'output_tokens INTEGER',
      'cached_tokens INTEGER',
      'reasoning_tokens INTEGER',
      'duration_sec REAL',
      'price_catalog_id TEXT',
      'price_snapshot_json TEXT',
      'usage_event_ids_json TEXT',
    ]) {
      const name = column.split(' ')[0];
      addColumnIfMissing(db, 'credit_ledger', name, column);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ledger_provider_model_time
        ON credit_ledger(provider, model, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ledger_operation_time
        ON credit_ledger(operation_module, operation_feature, created_at DESC);
    `);

    addColumnIfMissing(db, 'video_tasks', 'billing_session_id', 'billing_session_id TEXT');
    addColumnIfMissing(db, 'video_tasks', 'billing_context_json', "billing_context_json TEXT NOT NULL DEFAULT '{}'");

    for (const column of [
      'billing_session_id TEXT',
      "billing_scope TEXT NOT NULL DEFAULT 'unknown'",
      'operation_key TEXT',
      'operation_label TEXT',
      'consumption_type TEXT',
      'quantity REAL',
      'duration_sec REAL',
      "billing_status TEXT NOT NULL DEFAULT 'unbilled'",
      'ledger_id TEXT',
      'provider_response_hash TEXT',
    ]) {
      const name = column.split(' ')[0];
      addColumnIfMissing(db, 'token_usage_events', name, column);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_billing_status
        ON token_usage_events(billing_status, created_at DESC);

      CREATE TABLE IF NOT EXISTS api_price_catalog (
        id                         TEXT PRIMARY KEY,
        provider                   TEXT,
        model                      TEXT NOT NULL,
        model_role                 TEXT,
        consumption_type           TEXT NOT NULL,
        unit                       TEXT NOT NULL,
        price_cny_micros_per_unit  INTEGER NOT NULL,
        price_usd_micros_per_unit  INTEGER,
        original_currency          TEXT NOT NULL DEFAULT 'CNY',
        original_price             REAL,
        exchange_rate              REAL,
        source_note                TEXT NOT NULL DEFAULT '',
        status                     TEXT NOT NULL DEFAULT 'active',
        effective_from             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_updated_by            TEXT,
        created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (status IN ('active', 'requires_probe', 'disabled'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_price_catalog_lookup
        ON api_price_catalog(model, provider, model_role, consumption_type, status);
    `);
    seedUsageBillingPriceCatalog(db);
  } catch (e) {
    console.warn('[db] migrateUsageBillingColumns:', e);
  }
}

function seedUsageBillingPriceCatalog(db: Database.Database) {
  const updatedAt = '2026-06-09T00:00:00.000Z';
  const rows = [
    // price_cny_micros_per_unit is per unit named in `unit`.
    { id: 'v0:claude-opus-4-8:text_input', provider: '', model: 'claude-opus-4-8', role: null, type: 'text_input', unit: '1m_tokens', cny: 34_100_000, usd: 5_000_000, cur: 'USD', raw: 5, status: 'active', note: 'Anthropic official price, converted with USD/CNY 6.82.' },
    { id: 'v0:claude-opus-4-8:text_output', provider: '', model: 'claude-opus-4-8', role: null, type: 'text_output', unit: '1m_tokens', cny: 170_500_000, usd: 25_000_000, cur: 'USD', raw: 25, status: 'active', note: 'Anthropic official price, converted with USD/CNY 6.82.' },
    { id: 'v0:gpt-5.5:text_input', provider: '', model: 'gpt-5.5', role: null, type: 'text_input', unit: '1m_tokens', cny: 34_100_000, usd: 5_000_000, cur: 'USD', raw: 5, status: 'active', note: 'OpenAI official price, converted with USD/CNY 6.82.' },
    { id: 'v0:gpt-5.5:text_output', provider: '', model: 'gpt-5.5', role: null, type: 'text_output', unit: '1m_tokens', cny: 204_600_000, usd: 30_000_000, cur: 'USD', raw: 30, status: 'active', note: 'OpenAI official price, converted with USD/CNY 6.82.' },
    { id: 'v0:gpt-5.5:text_cached', provider: '', model: 'gpt-5.5', role: null, type: 'text_cached', unit: '1m_tokens', cny: 3_410_000, usd: 500_000, cur: 'USD', raw: 0.5, status: 'active', note: 'OpenAI cached-input price, converted with USD/CNY 6.82.' },
    { id: 'v0:gpt-5.4:text_input', provider: '', model: 'gpt-5.4', role: null, type: 'text_input', unit: '1m_tokens', cny: 17_050_000, usd: 2_500_000, cur: 'USD', raw: 2.5, status: 'active', note: 'OpenAI fallback price, converted with USD/CNY 6.82.' },
    { id: 'v0:gpt-5.4:text_output', provider: '', model: 'gpt-5.4', role: null, type: 'text_output', unit: '1m_tokens', cny: 102_300_000, usd: 15_000_000, cur: 'USD', raw: 15, status: 'active', note: 'OpenAI fallback price, converted with USD/CNY 6.82.' },
    { id: 'v0:doubao-seed-2-0-pro-260215:text_input', provider: '', model: 'doubao-seed-2-0-pro-260215', role: null, type: 'text_input', unit: '1m_tokens', cny: 3_200_000, usd: 469_000, cur: 'CNY', raw: 3.2, status: 'active', note: 'Volcengine native CNY price.' },
    { id: 'v0:doubao-seed-2-0-pro-260215:text_output', provider: '', model: 'doubao-seed-2-0-pro-260215', role: null, type: 'text_output', unit: '1m_tokens', cny: 16_000_000, usd: 2_346_000, cur: 'CNY', raw: 16, status: 'active', note: 'Volcengine native CNY price.' },
    { id: 'v0:doubao-seed-2-0-pro-260215:text_cached', provider: '', model: 'doubao-seed-2-0-pro-260215', role: null, type: 'text_cached', unit: '1m_tokens', cny: 640_000, usd: 94_000, cur: 'CNY', raw: 0.64, status: 'active', note: 'Volcengine native CNY cached-input price.' },
    { id: 'v0:gpt-image-2:image_text_input', provider: '', model: 'gpt-image-2', role: null, type: 'image_text_input', unit: '1m_tokens', cny: 34_100_000, usd: 5_000_000, cur: 'USD', raw: 5, status: 'requires_probe', note: 'Requires live provider usage probe before automatic charging.' },
    { id: 'v0:gpt-image-2:image_input', provider: '', model: 'gpt-image-2', role: null, type: 'image_input', unit: '1m_tokens', cny: 54_560_000, usd: 8_000_000, cur: 'USD', raw: 8, status: 'requires_probe', note: 'Requires live provider usage probe before automatic charging.' },
    { id: 'v0:gpt-image-2:image_output', provider: '', model: 'gpt-image-2', role: null, type: 'image_output', unit: '1m_tokens', cny: 204_600_000, usd: 30_000_000, cur: 'USD', raw: 30, status: 'requires_probe', note: 'Requires live provider usage probe before automatic charging.' },
    { id: 'v0:doubao-seedream-4-5-251128:image_count', provider: '', model: 'doubao-seedream-4-5-251128', role: null, type: 'image_count', unit: 'image', cny: 250_000, usd: 37_000, cur: 'CNY', raw: 0.25, status: 'active', note: 'Volcengine Seedream native CNY per-image price.' },
    { id: 'v0:doubao-seedance-2-0-260128:video_second', provider: '', model: 'doubao-seedance-2-0-260128', role: null, type: 'video_second', unit: 'second', cny: 1_000_000, usd: 147_000, cur: 'CNY', raw: 1, status: 'active', note: 'Seedance first version charges by observable duration seconds; update after provider cost probe if raw usage is available.' },
  ];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO api_price_catalog
      (id, provider, model, model_role, consumption_type, unit,
       price_cny_micros_per_unit, price_usd_micros_per_unit,
       original_currency, original_price, exchange_rate, source_note,
       status, effective_from, last_updated_at, last_updated_by)
     VALUES
      (@id, @provider, @model, @role, @type, @unit,
       @cny, @usd, @cur, @raw, 6.82, @note, @status, @updatedAt, @updatedAt, 'seed:v0')`,
  );
  for (const row of rows) stmt.run({ ...row, updatedAt });
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
    if (!auditNames.has('metadata_json')) {
      db.exec("ALTER TABLE image_generation_audits ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
      console.log('[db] migrated image_generation_audits: added metadata_json');
    }
  } catch (e) {
    console.warn('[db] migrateImageAuditColumns:', e);
  }
}

function migrateExportEdlVersionColumn(db: Database.Database) {
  try {
    const cols = db.prepare("PRAGMA table_info(exports)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('edl_version')) {
      db.exec('ALTER TABLE exports ADD COLUMN edl_version INTEGER');
      console.log('[db] migrated exports: added edl_version');
    }
  } catch (e) {
    console.warn('[db] migrateExportEdlVersionColumn:', e);
  }
}

function migrateExportLocalDownloadColumns(db: Database.Database) {
  try {
    const cols = db.prepare("PRAGMA table_info(exports)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('local_download_status')) {
      db.exec('ALTER TABLE exports ADD COLUMN local_download_status TEXT');
      console.log('[db] migrated exports: added local_download_status');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_exports_local_download ON exports(local_download_status, updated_at DESC)');
  } catch (e) {
    console.warn('[db] migrateExportLocalDownloadColumns:', e);
  }
}

function migrateExportProviderColumns(db: Database.Database) {
  try {
    addColumnIfMissing(db, 'exports', 'provider', 'provider TEXT');
    addColumnIfMissing(db, 'exports', 'external_export_id', 'external_export_id TEXT');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_exports_external_export_id
        ON exports(provider, external_export_id)
        WHERE provider IS NOT NULL
          AND external_export_id IS NOT NULL;
    `);
  } catch (e) {
    console.warn('[db] migrateExportProviderColumns:', e);
  }
}

function migrateStoryboardMaterialImageIndex(db: Database.Database) {
  try {
    const duplicates = db
      .prepare(
        `SELECT owner_id, project_id, asset_ref, COUNT(*) AS c
           FROM images
          WHERE style = 'storyboard_material_upload'
            AND asset_ref IS NOT NULL
          GROUP BY owner_id, project_id, asset_ref
         HAVING COUNT(*) > 1
          LIMIT 10`,
      )
      .all() as Array<{ owner_id: number; project_id: string | null; asset_ref: string; c: number }>;
    if (duplicates.length) {
      throw new Error(
        'duplicate storyboard material image asset_ref rows; ' +
          'idx_images_storyboard_material_asset_ref was not created. ' +
          JSON.stringify(duplicates),
      );
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_images_storyboard_material_asset_ref
      ON images(owner_id, project_id, asset_ref)
      WHERE style = 'storyboard_material_upload'
        AND asset_ref IS NOT NULL
    `);
  } catch (e) {
    console.error('[db] migrateStoryboardMaterialImageIndex:', e);
    throw e;
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
    const seedCredits = 100;
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

function seedDefaultStyleTemplates(db: Database.Database) {
  const now = new Date().toISOString();
  const templates = [
    {
      id: 'style_realistic_guofeng',
      name: '电影写实国风',
      category: '写实 / 国风 / 电影感',
      summary: '写实摄影质感结合东方色彩与克制古典构图，适合国风、修仙、权谋和年代质感项目。',
      tags: ['写实', '电影感', '国风'],
      visual_rules: {
        realism_level: 'high',
        color_palette: ['墨青', '鎏金', '暖玉白', '深檀', '雾灰'],
        lighting: '自然光与低饱和暖侧光，强调材质层次和空间纵深',
        camera: '稳定推进、低机位仰拍、克制横移，强调人物气场与环境秩序',
        texture: '真实布料、木石金属与微尘颗粒，避免过度滤镜化',
      },
      edit_rules: { pace: '稳中有压迫感', transition: '硬切与缓慢推入结合', mood: '庄重、克制、暗涌' },
      subtitle_rules: { font_style: '端正宋黑结合', position: '安全区底部', animation: '轻微淡入' },
      music_rules: { music_style: '低频弦乐与古风打击点', sound_effect_density: 'medium' },
      negative_rules: ['塑料质感', '廉价网游光效', '过曝金光', '现代廉价滤镜'],
      prompt_fragment: {
        positive_prompt: 'cinematic realistic Chinese period-inspired visual design, grounded materials, restrained color grading',
        negative_prompt: 'cheap fantasy game look, over-saturated glow, plastic costumes',
      },
    },
    {
      id: 'style_cyber_neon',
      name: '赛博霓虹',
      category: '科幻 / 霓虹 / 都市',
      summary: '高对比霓虹、雨夜反射、冷暖撞色和压迫都市空间，适合赛博、悬疑和都市复仇。',
      tags: ['赛博', '霓虹', '都市'],
      visual_rules: {
        realism_level: 'medium-high',
        color_palette: ['电蓝', '品红', '深紫', '冷黑', '湿银'],
        lighting: '霓虹招牌、雨水反射、局部强背光与轮廓光',
        camera: '手持跟拍、低角度街景、快速切换局部特写',
        texture: '湿漉街面、金属、玻璃、LED 屏幕和烟雾颗粒',
      },
      edit_rules: { pace: '紧凑、有脉冲感', transition: '闪白、故障切、快速硬切', mood: '危险、迷离、压迫' },
      subtitle_rules: { font_style: '窄体无衬线', position: '底部或侧边信息条', animation: '轻微故障闪烁' },
      music_rules: { music_style: 'synth bass 与电子鼓', sound_effect_density: 'high' },
      negative_rules: ['日系可爱霓虹', '过度卡通化', '干净白棚', '暖黄田园感'],
      prompt_fragment: {
        positive_prompt: 'cyberpunk neon city, wet reflections, blue-magenta contrast, cinematic noir lighting',
        negative_prompt: 'cute anime neon, clean white studio, warm pastoral look',
      },
    },
    {
      id: 'style_modern_fresh_drama',
      name: '现代清新短剧',
      category: '现代 / 清新 / 短剧',
      summary: '明亮自然光、干净生活空间和轻快节奏，适合都市情感、成长、职场和轻喜剧。',
      tags: ['现代', '清新', '短剧'],
      visual_rules: {
        realism_level: 'high',
        color_palette: ['奶油白', '浅木', '晴空蓝', '草绿', '暖灰'],
        lighting: '柔和自然光，少量室内暖补光，肤色干净',
        camera: '中近景对话、轻微推拉、稳定生活流构图',
        texture: '真实家居、办公室、咖啡店和街区生活质感',
      },
      edit_rules: { pace: '轻快顺滑', transition: '自然硬切与少量匹配剪辑', mood: '温暖、明亮、松弛' },
      subtitle_rules: { font_style: '圆润黑体', position: '底部居中', animation: '简洁弹入' },
      music_rules: { music_style: '轻快木吉他、钢琴与电子铺底', sound_effect_density: 'low-medium' },
      negative_rules: ['厚重暗黑', '过度电影颗粒', '强烈恐怖光', '脏乱色彩'],
      prompt_fragment: {
        positive_prompt: 'bright modern drama, soft natural light, clean lifestyle color grading',
        negative_prompt: 'dark horror lighting, dirty palette, excessive film grain',
      },
    },
    {
      id: 'style_ink_guofeng',
      name: '水墨国风',
      category: '国风 / 水墨 / 诗意',
      summary: '水墨留白、低饱和东方色和诗意空间调度，适合古风、神话、修仙和抒情叙事。',
      tags: ['水墨', '国风', '诗意'],
      visual_rules: {
        realism_level: 'stylized',
        color_palette: ['宣纸白', '墨黑', '远山青', '朱砂', '淡金'],
        lighting: '柔雾漫射光，强调留白和层次',
        camera: '慢推、横向卷轴式调度、远景与剪影构图',
        texture: '宣纸纹理、墨迹边缘、雾气和山水层叠',
      },
      edit_rules: { pace: '舒缓、有呼吸感', transition: '淡入淡出、墨迹铺展', mood: '空灵、庄重、诗性' },
      subtitle_rules: { font_style: '书法感宋体', position: '画面留白处', animation: '淡显' },
      music_rules: { music_style: '古琴、箫、低频氛围', sound_effect_density: 'low' },
      negative_rules: ['赛博霓虹', '现代塑料材质', '过度写实商业棚拍', '高饱和糖果色'],
      prompt_fragment: {
        positive_prompt: 'Chinese ink wash aesthetic, poetic negative space, misty mountains, restrained color',
        negative_prompt: 'cyber neon, plastic modern material, candy colors',
      },
    },
    {
      id: 'style_mockumentary',
      name: '纪实伪纪录片',
      category: '纪实 / 伪纪录 / 手持',
      summary: '手持纪实、现场收音感和不完美构图，适合荒诞喜剧、职场复盘和真实感短片。',
      tags: ['纪实', '伪纪录', '手持'],
      visual_rules: {
        realism_level: 'high',
        color_palette: ['冷白', '灰蓝', '荧光绿', '水泥灰', '浅棕'],
        lighting: '现场可用光、办公室荧光灯、手机补光和轻微曝光波动',
        camera: '手持跟拍、突然变焦、采访式正反打和反应镜头',
        texture: '真实空间噪点、轻微运动模糊和现场杂乱细节',
      },
      edit_rules: { pace: '反应式剪辑，停顿制造笑点', transition: '硬切、跳切、采访插入', mood: '冷面、荒诞、现场感' },
      subtitle_rules: { font_style: '简洁无衬线', position: '底部说明条', animation: '无或快速淡入' },
      music_rules: { music_style: '少音乐，多现场音与尴尬停顿', sound_effect_density: 'medium' },
      negative_rules: ['过度唯美', '广告大片光', '完美棚拍构图', '史诗配乐'],
      prompt_fragment: {
        positive_prompt: 'mockumentary handheld camera, available light, imperfect framing, realistic on-site texture',
        negative_prompt: 'glossy commercial lighting, perfect studio framing, epic cinematic glamour',
      },
    },
    {
      id: 'style_live_action_realistic',
      name: '真人写实',
      category: '画面风格',
      sort_order: 1,
      thumbnailUrl: '/style-templates/live-action-realistic.webp',
      summary: '真实摄影质感，自然光影，适合人物、生活和剧情画面。',
      tags: ['真人', '写实', '自然光', '剧情'],
      visual_rules: {
        realism_level: 'high',
        color_palette: ['自然肤', '暖灰', '深棕', '冷蓝', '炭黑'],
        lighting: '自然可用光与柔和补光，肤色真实，保留环境阴影、空气层次和真实明暗过渡',
        camera: '真人电影摄影镜头，中近景人物表演、稳定跟拍、克制推拉、真实景深和可信空间关系',
        texture: '真实皮肤、布料、街景、室内材质和轻微胶片颗粒，保持摄影质感',
      },
      edit_rules: { pace: '稳健自然，情绪段落清晰', transition: '真实硬切、匹配剪辑和少量慢推转场', mood: '真实、沉浸、克制' },
      subtitle_rules: { font_style: '干净无衬线', position: '底部安全区', animation: '轻微淡入' },
      music_rules: { music_style: '低调弦乐、钢琴或环境音铺底', sound_effect_density: 'medium' },
      negative_rules: ['卡通化', '塑料皮肤', '过度磨皮', '廉价网剧滤镜', 'CG渲染感', '夸张奇幻光效'],
      prompt_fragment: {
        positive_prompt: 'live-action realistic cinematography；natural skin texture；grounded lighting；credible real-world locations；human performance close-ups；not CG rendering；not cartoon style',
        negative_prompt: 'cartoon look；plastic skin；over-smoothed face；cheap drama filter；CG render look；exaggerated fantasy glow',
      },
    },
    {
      id: 'style_3d_xuanhuan',
      name: '3D玄幻',
      category: '画面风格',
      sort_order: 2,
      thumbnailUrl: '/style-templates/3d-xuanhuan.webp',
      summary: '高质量 3D 东方幻想风格，强调灵气光效、云雾层次和奇观场景。',
      tags: ['3D', '东方玄幻', '奇观', '灵气光效'],
      visual_rules: {
        realism_level: 'stylized-3d',
        color_palette: ['云白', '冰蓝', '鎏金', '玄青', '灵紫'],
        lighting: '体积光、灵气边缘光、云雾漫射和法术点光源，强调东方神性、空间层次和能量流动',
        camera: '高质量 3D 东方玄幻电影镜头，大景别奇观、环绕运镜、低机位英雄构图、法术爆发特写',
        texture: '精致 3D 服饰、玉石金属、云雾粒子、灵气纹理和高质量角色材质，避免粗糙游戏资产感',
      },
      edit_rules: { pace: '史诗铺陈与法术爆发交替', transition: '能量光效转场、云雾转场和大景别切换', mood: '宏大、神秘、燃' },
      subtitle_rules: { font_style: '锐利国风黑体', position: '底部或画面留白处', animation: '光效淡入' },
      music_rules: { music_style: '史诗管弦、古风打击和空灵人声', sound_effect_density: 'high' },
      negative_rules: ['低模手游感', '塑料网游质感', '廉价特效', '现代都市穿帮', '廉价卡通', '平面贴图感'],
      prompt_fragment: {
        positive_prompt: 'premium 3D oriental xuanhuan fantasy；ethereal qi energy；cinematic volumetric light；mist layered wonderland；spell impact close-ups；heroic low-angle composition；not low-poly mobile game style',
        negative_prompt: 'low-poly mobile game look；cheap VFX；plastic game asset；modern city mismatch；flat texture；rough cartoon fantasy',
      },
    },
    {
      id: 'style_live_action_costume',
      name: '真人古装',
      category: '画面风格',
      sort_order: 3,
      thumbnailUrl: '/style-templates/live-action-costume.webp',
      summary: '真人古装剧质感，结合东方服化道、柔和光影和山水氛围。',
      tags: ['真人', '古装', '东方光影', '剧情感'],
      visual_rules: {
        realism_level: 'high',
        color_palette: ['墨青', '暖玉白', '朱砂', '檀木棕', '淡金'],
        lighting: '自然天光、烛火暖光、宫殿侧光和雾气漫射，保留真人古装服化道的真实层次',
        camera: '真人古装影视剧镜头，稳定横移、低机位人物气场、远景山水、礼制空间和特写表演',
        texture: '真实丝绸、皮革、木石、金属饰物和古建筑纹理，强调服化道可信度',
      },
      edit_rules: { pace: '庄重稳健，关键冲突处加速', transition: '硬切、慢推、景别递进', mood: '古典、克制、厚重' },
      subtitle_rules: { font_style: '端正宋黑结合', position: '底部安全区', animation: '淡入' },
      music_rules: { music_style: '古风弦乐、鼓点和低频氛围', sound_effect_density: 'medium' },
      negative_rules: ['现代服装穿帮', '廉价影楼古装', '过曝金光', '塑料道具', '网游UI感', '游戏皮肤感'],
      prompt_fragment: {
        positive_prompt: 'live-action Chinese costume drama；realistic costumes and props；cinematic oriental lighting；grounded period texture；mountain and palace atmosphere；not game skin style；not studio cosplay look',
        negative_prompt: 'cheap studio costume；plastic props；over-saturated golden glow；modern outfit mismatch；game UI look；cosplay studio lighting',
      },
    },
    {
      id: 'style_3d_realistic',
      name: '3D写实',
      category: '画面风格',
      sort_order: 4,
      thumbnailUrl: '/style-templates/3d-realistic.webp',
      summary: '写实级 3D 电影质感，强调真实材质、体积光和空间纵深。',
      tags: ['3D', '写实', '电影感', '真实材质'],
      visual_rules: {
        realism_level: 'realistic-3d',
        color_palette: ['岩灰', '冷蓝', '沙金', '炭黑', '晨光橙'],
        lighting: '电影级体积光、真实反射、环境遮蔽和高动态范围光影，突出 CG 空间纵深',
        camera: '写实 CG 电影运镜，广角空间调度、跟拍、环绕、低机位英雄镜头和细节特写',
        texture: '写实 3D 皮肤、盔甲、岩石、尘土、金属与布料材质，高细节 PBR 渲染',
      },
      edit_rules: { pace: '大场面稳，动作段落强节奏', transition: '电影硬切、运动匹配、冲击点切换', mood: '沉浸、壮阔、真实' },
      subtitle_rules: { font_style: '现代电影无衬线', position: '底部安全区', animation: '简洁淡入' },
      music_rules: { music_style: '电影管弦、低频冲击和环境音', sound_effect_density: 'high' },
      negative_rules: ['低模渲染', '玩具感', '卡通比例', '塑料皮肤', '平面贴图感', '真人摄影感'],
      prompt_fragment: {
        positive_prompt: 'realistic 3D cinematic rendering；physically based materials；volumetric lighting；high-detail CG characters；deep spatial composition；not live-action photography；not flat 2D animation',
        negative_prompt: 'low-poly render；toy-like material；cartoon proportions；plastic skin；flat texture；live-action camera footage look',
      },
    },
    {
      id: 'style_2d_animation',
      name: '2D动画',
      category: '画面风格',
      sort_order: 5,
      thumbnailUrl: '/style-templates/2d-animation.webp',
      summary: '清晰二维线条和明快色彩，适合轻剧情、角色表情和活泼画面。',
      tags: ['2D', '动画', '明快色彩', '角色表达'],
      visual_rules: {
        realism_level: '2d-stylized',
        color_palette: ['晴空蓝', '暖黄', '粉橙', '草绿', '深靛'],
        lighting: '简化但明确的色块光影，强调角色表情、动作可读性和明亮情绪',
        camera: '清新 2D 动画镜头，清晰构图、中近景表演、夸张反应和节奏化分镜',
        texture: '干净线稿、平涂色块、少量手绘纹理和轻快动画质感',
      },
      edit_rules: { pace: '轻快活泼，反应镜头明确', transition: '硬切、推拉、漫画式节奏转场', mood: '明快、可爱、有活力' },
      subtitle_rules: { font_style: '圆润黑体', position: '底部或气泡旁', animation: '弹入' },
      music_rules: { music_style: '轻快电子、木琴、鼓点和拟音', sound_effect_density: 'medium-high' },
      negative_rules: ['写实真人皮肤', '恐怖暗黑', '脏乱低饱和', '3D塑料质感', '照片质感', '动画电影厚重氛围'],
      prompt_fragment: {
        positive_prompt: 'clean 2D animation style；clear line art；expressive character acting；bright readable colors；light comedy timing；not 3D rendering；not photo-realistic live action；lighter than cinematic 2D animated film',
        negative_prompt: 'photo-realistic skin；dark horror lighting；muddy low saturation；plastic 3D look；heavy cinematic melancholy；real camera footage',
      },
    },
    {
      id: 'style_2d_movie',
      name: '2D电影',
      category: '画面风格',
      sort_order: 6,
      thumbnailUrl: '/style-templates/2d-movie.webp',
      summary: '二维动画电影质感，强调光影氛围、长镜头构图和情绪留白。',
      tags: ['2D', '动画电影', '光影氛围', '情绪感'],
      visual_rules: {
        realism_level: '2d-cinematic',
        color_palette: ['云粉', '暮蓝', '金橙', '湖青', '深紫'],
        lighting: '动画电影级环境光、日落逆光、云影、柔和高光和情绪化明暗层次',
        camera: '2D 动画电影构图，大全景环境、人物背影、情绪留白、长镜头和流畅运动镜头',
        texture: '精致手绘背景、柔和笔触、天空云层、场景氛围和电影级色彩设计',
      },
      edit_rules: { pace: '有呼吸感，情绪铺垫充分', transition: '淡入淡出、景别递进、环境空镜过渡', mood: '诗意、治愈、浪漫' },
      subtitle_rules: { font_style: '清爽无衬线或手写感字体', position: '底部安全区', animation: '柔和淡入' },
      music_rules: { music_style: '钢琴、弦乐、轻电子和环境音', sound_effect_density: 'medium' },
      negative_rules: ['粗糙网漫', '廉价TV动画', '低帧率卡顿', '照片拼贴感', '过度写实', '轻快表情包动画'],
      prompt_fragment: {
        positive_prompt: 'cinematic 2D animated film；hand-painted background；poetic lighting；emotional long-shot composition；atmospheric environment storytelling；more cinematic than light 2D animation；not live-action photography',
        negative_prompt: 'cheap TV animation；rough webcomic look；photo collage；low-frame jitter；overly realistic live action；flat sticker animation',
      },
    },
    {
      id: 'style_hollywood_blockbuster',
      name: '好莱坞大片',
      category: '画面风格',
      sort_order: 7,
      thumbnailUrl: '/style-templates/hollywood-blockbuster.webp',
      summary: '商业电影大片质感，强调大场面、低机位、快速运动和强冲击力。',
      tags: ['大片感', '大场面', '英雄式', '动作冲击'],
      visual_rules: {
        realism_level: 'blockbuster',
        color_palette: ['钢蓝', '爆炸橙', '烟灰', '冷白', '黑金'],
        lighting: '强对比电影光、爆炸火光、轮廓光、体积烟雾和高动态范围照明，制造大场面冲击',
        camera: '好莱坞动作大片镜头，广角低机位、快速跟拍、航拍、推轨、运动匹配和冲击点特写',
        texture: '真实烟尘、金属、火焰、玻璃、城市废墟和高预算特效质感',
      },
      edit_rules: { pace: '紧张推进，动作段落高密度', transition: '冲击点硬切、动作匹配、快速交叉剪辑', mood: '宏大、紧张、英雄感' },
      subtitle_rules: { font_style: '粗壮电影无衬线', position: '底部安全区', animation: '干净硬朗' },
      music_rules: { music_style: '史诗管弦、低频鼓点和强冲击音效', sound_effect_density: 'high' },
      negative_rules: ['小成本网剧感', '平淡自然光', '低预算特效', '卡通化爆炸', '塑料道具', '画面松散无冲击'],
      prompt_fragment: {
        positive_prompt: 'Hollywood blockbuster cinematography；epic scale；dramatic contrast lighting；heroic low-angle shots；fast tracking action；impact-point close-ups；high-budget VFX；not small web drama look',
        negative_prompt: 'low-budget web drama look；flat natural light；cheap VFX；cartoon explosion；plastic props；loose action staging',
      },
    },
  ];

  const tx = db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO style_templates
         (id, owner_id, name, category, summary, data_json, source, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'system', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         category = excluded.category,
         summary = excluded.summary,
         data_json = excluded.data_json,
         updated_at = excluded.updated_at
       WHERE style_templates.source = 'system'`,
    );
    for (const tpl of templates) {
      stmt.run(tpl.id, tpl.name, tpl.category, tpl.summary, JSON.stringify(tpl), now, now);
    }
    db.prepare(
      `UPDATE world_style_default_mappings
       SET style_template_id = CASE style_template_id
         WHEN 'style_realistic_guofeng' THEN 'style_live_action_costume'
         WHEN 'style_cyber_neon' THEN 'style_3d_realistic'
         WHEN 'style_modern_fresh_drama' THEN 'style_live_action_realistic'
         WHEN 'style_ink_guofeng' THEN 'style_2d_movie'
         WHEN 'style_mockumentary' THEN 'style_live_action_realistic'
         ELSE style_template_id
       END
       WHERE style_template_id IN (
         'style_realistic_guofeng',
         'style_cyber_neon',
         'style_modern_fresh_drama',
         'style_ink_guofeng',
         'style_mockumentary'
       )`,
    ).run();
  });
  tx();
}

function seedDefaultUser(db: Database.Database) {
  const count = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM users').get();
  if (count && count.c > 0) return;

  const phone = normalizeSeedPhone(process.env.SEED_PHONE || '');
  const password = process.env.SEED_PASSWORD || '';
  const username = phone;
  const email = process.env.SEED_EMAIL || null;
  const displayName = (process.env.SEED_DISPLAY_NAME || '本地测试用户').trim();
  if (!phone || !password) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[db] users is empty but SEED_PHONE / SEED_PASSWORD are not both set; skipping default frontend user seed.');
    }
    return;
  }

  if (columnExists(db, 'users', 'phone')) {
    db.prepare(
      `INSERT INTO users (username, email, phone, display_name, password_hash, email_verified)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(username, email, phone, displayName || phone, hashSync(password, 10));
  } else {
    db.prepare(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(username, email, displayName || phone, hashSync(password, 10));
  }

  console.log(`[db] Seeded frontend user for phone: ${phone}`);
}

function normalizeSeedPhone(raw: string): string | null {
  const normalized = String(raw || '').replace(/[\s-]/g, '').replace(/^\+?86/, '');
  return /^1[3-9]\d{9}$/.test(normalized) ? normalized : null;
}

function seedDefaultAdminUser(db: Database.Database) {
  const count = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM admin_users').get();
  if (count && count.c > 0) return;

  const envUsername = (process.env.ADMIN_BOOTSTRAP_USERNAME || '').trim();
  const envPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
  let username = envUsername;
  let password = envPassword;

  if (!username || !password) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[db] admin_users is empty but ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD are not both set.');
      return;
    }
    username = DEV_ADMIN_USERNAME;
    password = DEV_ADMIN_PASSWORD;
    console.warn(`[db] Seeded development admin user ${DEV_ADMIN_USERNAME} / ${DEV_ADMIN_PASSWORD}. Change it before sharing this environment.`);
  }

  const passwordError = validateBootstrapAdminPassword(password);
  if (passwordError) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`[db] ADMIN_BOOTSTRAP_PASSWORD is not strong enough: ${passwordError}`);
      return;
    }
    console.warn(`[db] Development admin password warning: ${passwordError}`);
  }

  db.prepare(
    `INSERT INTO admin_users (username, password_hash)
     VALUES (?, ?)`,
  ).run(username, hashSync(password, 10));
  const admin = db
    .prepare<{ username: string }, { id: number; username: string; preview_user_id: number | null }>(
      'SELECT id, username, preview_user_id FROM admin_users WHERE username = @username LIMIT 1',
    )
    .get({ username });
  if (admin && adminHasPreviewColumn(db)) {
    ensureAdminPreviewUser(db, admin);
  }
  console.log(`[db] Seeded admin user: ${username}`);
}

function backfillAdminPreviewUsers(db: Database.Database) {
  if (!adminHasPreviewColumn(db)) return;
  const admins = db
    .prepare<[], { id: number; username: string; preview_user_id: number | null }>(
      'SELECT id, username, preview_user_id FROM admin_users WHERE preview_user_id IS NULL',
    )
    .all();
  for (const admin of admins) {
    ensureAdminPreviewUser(db, admin);
  }
  if (admins.length) console.log(`[db] backfilled ${admins.length} admin shadow user(s)`);
}

function adminHasPreviewColumn(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(admin_users)").all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'preview_user_id');
}

function migrateDropLegacyUserAdminColumn(db: Database.Database) {
  const legacyColumn = ['is', 'admin'].join('_');
  const cols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === legacyColumn)) return;
  const hasPhone = cols.some((c) => c.name === 'phone');

  console.log('[db] migrating users: dropping legacy admin marker column');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT UNIQUE NOT NULL,
          email         TEXT UNIQUE,
          phone         TEXT,
          display_name  TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          email_verified INTEGER NOT NULL DEFAULT 0,
          disabled_at   TEXT,
          token_revoked_at TEXT,
          created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO users_new
          (id, username, email, phone, display_name, password_hash, email_verified,
           disabled_at, token_revoked_at, created_at, updated_at)
        SELECT
          id, username, email, ${hasPhone ? 'phone' : 'NULL AS phone'}, display_name, password_hash, email_verified,
          disabled_at, token_revoked_at, created_at, updated_at
        FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function validateBootstrapAdminPassword(password: string): string | null {
  const value = String(password || '');
  if (value.length < 12) return 'minimum length is 12';
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;
  if (classes < 2) return 'requires at least two of lowercase, uppercase, number, symbol';
  return null;
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
  phone: string | null;
  display_name: string;
  password_hash: string;
  email_verified: number;
  disabled_at: string | null;
  token_revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AdminUserRow = {
  id: number;
  username: string;
  password_hash: string;
  disabled_at: string | null;
  last_login_at: string | null;
  token_revoked_at: string | null;
  preview_user_id: number | null;
  created_at: string;
};

export type ProjectRow = {
  id: string;
  owner_id: number;
  title: string;
  description: string;
  cover_url: string | null;
  status: string;
  data_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export function userToPublic(u: UserRow) {
  return {
    id: u.id,
    phone: u.phone || '',
    displayName: u.display_name,
    createdAt: u.created_at,
  };
}
