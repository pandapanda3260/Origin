import { getDb } from './db';

type RateLimitDb = {
  exec(sql: string): unknown;
  prepare(sql: string): any;
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
};

type RateLimitEnv = Record<string, string | undefined>;

export type FirstFrameRewriteRateLimitResult = {
  allowed: boolean;
  code?: 'first_frame_rewrite_interval_limited' | 'first_frame_rewrite_daily_limited';
  message?: string;
  retryAfterMs?: number;
  failOpen?: boolean;
};

const DEFAULT_MIN_INTERVAL_MS = 8000;
const DEFAULT_DAILY_LIMIT = 60;
const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ensuredRateLimitDbs = new WeakSet<object>();

function envInt(env: RateLimitEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name] ?? env[`ORIGIN_${name}`];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function firstFrameRewriteRateLimitConfig(env: RateLimitEnv = process.env) {
  return {
    minIntervalMs: envInt(env, 'FIRST_FRAME_REWRITE_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS, 0, 60 * 60 * 1000),
    dailyLimit: envInt(env, 'FIRST_FRAME_REWRITE_DAILY_LIMIT', DEFAULT_DAILY_LIMIT, 1, 10_000),
    retentionDays: envInt(env, 'FIRST_FRAME_REWRITE_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, 1, 365),
  };
}

export function ensureFirstFrameRewriteRateLimitTable(db: RateLimitDb) {
  if (ensuredRateLimitDbs.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS first_frame_rewrite_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      project_id   TEXT NOT NULL,
      group_idx    INTEGER NOT NULL,
      called_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_first_frame_rewrite_calls_user_time
      ON first_frame_rewrite_calls(user_id, called_at DESC);
    CREATE INDEX IF NOT EXISTS idx_first_frame_rewrite_calls_project_time
      ON first_frame_rewrite_calls(user_id, project_id, called_at DESC);
  `);
  ensuredRateLimitDbs.add(db as object);
}

function retryAfterMsFromIso(calledAt: string, nowMs: number, minIntervalMs: number): number {
  const lastMs = Date.parse(calledAt);
  if (!Number.isFinite(lastMs)) return minIntervalMs;
  return Math.max(1000, lastMs + minIntervalMs - nowMs);
}

export function checkAndRecordFirstFrameRewriteCall(
  args: { userId: number; projectId: string; groupIdx: number },
  opts: {
    db?: RateLimitDb;
    env?: RateLimitEnv;
    now?: Date;
    logger?: Pick<Console, 'warn'>;
  } = {},
): FirstFrameRewriteRateLimitResult {
  const logger = opts.logger || console;
  try {
    const db = opts.db || (getDb() as unknown as RateLimitDb);
    const config = firstFrameRewriteRateLimitConfig(opts.env);
    const now = opts.now || new Date();
    const nowMs = now.getTime();
    const calledAt = now.toISOString();
    const intervalSince = new Date(nowMs - config.minIntervalMs).toISOString();
    const daySince = new Date(nowMs - DAY_MS).toISOString();
    const retentionSince = new Date(nowMs - config.retentionDays * DAY_MS).toISOString();

    const run = db.transaction(() => {
      ensureFirstFrameRewriteRateLimitTable(db);
      db.prepare('DELETE FROM first_frame_rewrite_calls WHERE called_at < @retentionSince').run({ retentionSince });

      const last = db.prepare(`
        SELECT called_at
        FROM first_frame_rewrite_calls
        WHERE user_id = @userId
          AND project_id = @projectId
          AND called_at >= @intervalSince
        ORDER BY called_at DESC
        LIMIT 1
      `).get({
        userId: args.userId,
        projectId: args.projectId,
        intervalSince,
      }) as { called_at: string } | undefined;

      if (last) {
        return {
          allowed: false,
          code: 'first_frame_rewrite_interval_limited',
          message: '发送太频繁，请稍后再试。',
          retryAfterMs: retryAfterMsFromIso(last.called_at, nowMs, config.minIntervalMs),
        } satisfies FirstFrameRewriteRateLimitResult;
      }

      const daily = db.prepare(`
        SELECT COUNT(*) AS count
        FROM first_frame_rewrite_calls
        WHERE user_id = @userId
          AND called_at >= @daySince
      `).get({
        userId: args.userId,
        daySince,
      }) as { count: number } | undefined;

      if (Number(daily?.count || 0) >= config.dailyLimit) {
        return {
          allowed: false,
          code: 'first_frame_rewrite_daily_limited',
          message: '今天的首帧 AI 改写次数已达上限，请明天再试。',
          retryAfterMs: DAY_MS,
        } satisfies FirstFrameRewriteRateLimitResult;
      }

      db.prepare(`
        INSERT INTO first_frame_rewrite_calls (user_id, project_id, group_idx, called_at)
        VALUES (@userId, @projectId, @groupIdx, @calledAt)
      `).run({
        userId: args.userId,
        projectId: args.projectId,
        groupIdx: args.groupIdx,
        calledAt,
      });

      return { allowed: true } satisfies FirstFrameRewriteRateLimitResult;
    });

    return run();
  } catch (err) {
    logger.warn('[first-frame-rewrite-rate-limit] fail-open:', err);
    return { allowed: true, failOpen: true };
  }
}
