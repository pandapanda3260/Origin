import { getDb } from './db';

const CACHE_TTL_MS = 30_000;
export const DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT = 3;
export const DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT = 3;
export const MIN_GLOBAL_CONCURRENCY_LIMIT = 1;
export const MAX_GLOBAL_CONCURRENCY_LIMIT = 8;

type CacheEntry = {
  value: any;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

export function readSystemConfig<T>(key: string, fallback: T): T {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as T;
  const row = getDb()
    .prepare<{ key: string }, { value_json: string }>('SELECT value_json FROM system_config WHERE key = @key')
    .get({ key });
  let value: T = fallback;
  if (row) {
    try {
      value = JSON.parse(row.value_json);
    } catch {
      value = fallback;
    }
  }
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

export function writeSystemConfig(key: string, value: unknown) {
  getDb()
    .prepare(
      `INSERT INTO system_config (key, value_json, updated_at)
       VALUES (@key, @valueJson, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run({ key, valueJson: JSON.stringify(value ?? null) });
  invalidateSystemConfig(key);
}

export function invalidateSystemConfig(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}

export function getGlobalVideoConcurrencyLimit(fallback = DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT): number {
  return readNumericConfig(
    'global_video_concurrency_limit',
    fallback,
    MIN_GLOBAL_CONCURRENCY_LIMIT,
    MAX_GLOBAL_CONCURRENCY_LIMIT,
  );
}

export function getGlobalImageConcurrencyLimit(fallback = DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT): number {
  return readNumericConfig(
    'global_image_concurrency_limit',
    fallback,
    MIN_GLOBAL_CONCURRENCY_LIMIT,
    MAX_GLOBAL_CONCURRENCY_LIMIT,
  );
}

export function isRegistrationEnabled(): boolean {
  return readBooleanConfig('registration_enabled', true);
}

export function isVideoGenerationEnabled(): boolean {
  return readBooleanConfig('video_generation_enabled', true);
}

export function isExportEnabled(): boolean {
  return readBooleanConfig('export_enabled', true);
}

export function isProjectCreatePayloadWhitelistEnabled(): boolean {
  return readBooleanConfig('project_create_payload_whitelist_enabled', true);
}

export function isScriptConsultDbHistoryOnlyEnabled(): boolean {
  return readBooleanConfig('script_consult_db_history_only_enabled', true);
}

function readNumericConfig(key: string, fallback: number, min: number, max: number): number {
  const raw = readSystemConfig<any>(key, fallback);
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'object' && raw
      ? Number(raw.value ?? raw.limit ?? raw.concurrency)
      : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readBooleanConfig(key: string, fallback: boolean): boolean {
  const raw = readSystemConfig<any>(key, fallback);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  }
  if (raw && typeof raw === 'object') {
    if ('enabled' in raw) return !!raw.enabled;
    if ('value' in raw) return !!raw.value;
  }
  return fallback;
}
