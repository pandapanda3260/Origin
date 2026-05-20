import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { once } from 'node:events';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getDb } from './db';
import { dataPath } from './runtime-paths';
import { claimDueScheduledJob, completeScheduledJob, ensureScheduledJob, failScheduledJob } from './scheduled-jobs';

const EXPORTS_DIR = dataPath('exports');
const ORPHAN_RECOVERY_KEY = '__qd_oe_downloads_reaped__';
const PENDING_REQUEUE_KEY = '__qd_oe_downloads_pending_requeued__';
const DOWNLOAD_WORKER_KEY = '__qd_oe_download_worker_timer__';
const DOWNLOAD_SCAN_JOB = 'online_editor_download_scan';
const DOWNLOAD_SCAN_RUNNER_ID = `online-editor-download:${process.pid || 'pid'}`;
export const ONLINE_EDITOR_REEXPORT_REASON = 'url_expired_need_reexport';

type ExportRow = {
  id: string;
  owner_id: number;
  status: string;
  filename: string | null;
  local_download_status?: string | null;
  edl_json: string | null;
  error_msg?: string | null;
};

type RetryResult =
  | { ok: true; status: 'pending' | 'completed' }
  | { ok: false; code: number; detail: string };

function nowIso() {
  return new Date().toISOString();
}

function parseExportMeta(value: unknown): Record<string, any> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeEpochLike(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isFinite(raw) && raw > 0) {
    const millis = raw > 1_000_000_000_000 ? raw : raw * 1000;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function getSearchParamCaseInsensitive(url: URL, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of url.searchParams.entries()) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function parseAmzDate(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  const millis = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Number.isFinite(millis) ? millis : null;
}

export function deriveRemoteUrlExpiresAt(remoteUrl: string): string | null {
  try {
    const url = new URL(remoteUrl);
    const expires = normalizeEpochLike(
      getSearchParamCaseInsensitive(url, 'Expires') ||
        getSearchParamCaseInsensitive(url, 'x-tos-signature-expires') ||
        getSearchParamCaseInsensitive(url, 'x-tos-expires'),
    );
    if (expires) return expires;

    const amzExpires = Number(getSearchParamCaseInsensitive(url, 'X-Amz-Expires'));
    const amzDate = parseAmzDate(getSearchParamCaseInsensitive(url, 'X-Amz-Date'));
    if (Number.isFinite(amzExpires) && amzExpires > 0 && amzDate !== null) {
      return new Date(amzDate + amzExpires * 1000).toISOString();
    }
  } catch {
    return null;
  }
  return null;
}

function resolveExpiresAt(value: unknown): string | null {
  if (typeof value === 'number') return normalizeEpochLike(value);
  if (typeof value === 'string') return normalizeEpochLike(value);
  return null;
}

function isExpired(expiresAt: string | null) {
  if (!expiresAt) return false;
  const time = new Date(expiresAt).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

function isNearExpiry(expiresAt: string | null, thresholdMs: number) {
  if (!expiresAt) return false;
  const time = new Date(expiresAt).getTime();
  return Number.isFinite(time) && time > Date.now() && time - Date.now() <= thresholdMs;
}

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function maxDownloadAttempts() {
  return envInt('ONLINE_EDITOR_DOWNLOAD_MAX_ATTEMPTS', 5, 1, 50);
}

function downloadRetryBaseMs() {
  return envInt('ONLINE_EDITOR_DOWNLOAD_RETRY_BASE_MS', 30_000, 1_000, 60 * 60_000);
}

function maxDownloadBytes() {
  return envInt('ONLINE_EDITOR_DOWNLOAD_MAX_BYTES', 2 * 1024 * 1024 * 1024, 1024 * 1024, 10 * 1024 * 1024 * 1024);
}

function downloadTimeoutMs() {
  return envInt('ONLINE_EDITOR_DOWNLOAD_TIMEOUT_MS', 5 * 60_000, 5_000, 60 * 60_000);
}

function allowInsecureDownload() {
  return process.env.NODE_ENV !== 'production' && envFlag('ALLOW_INSECURE_DOWNLOAD', false);
}

function stripIpv6Brackets(address: string) {
  const raw = String(address || '').trim().toLowerCase();
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
}

function ipv4ToNumber(address: string): number | null {
  const parts = String(address || '').split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function ipv4FromMappedIpv6(address: string): string | null {
  const normalized = stripIpv6Brackets(address);
  if (!normalized.startsWith('::ffff:')) return null;
  const rest = normalized.slice('::ffff:'.length);
  if (rest.includes('.')) return rest;
  const parts = rest.split(':');
  if (parts.length !== 2) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function isForbiddenIpv4(address: string) {
  const n = ipv4ToNumber(address);
  if (n === null) return false;
  const first = (n >>> 24) & 255;
  const second = (n >>> 16) & 255;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function firstIpv6Hextet(address: string): number | null {
  const first = stripIpv6Brackets(address).split(':')[0];
  if (!first) return null;
  const n = Number.parseInt(first, 16);
  return Number.isFinite(n) ? n : null;
}

export function isForbiddenOnlineEditorDownloadAddress(address: string) {
  const normalized = stripIpv6Brackets(address);
  const mapped = ipv4FromMappedIpv6(normalized);
  if (mapped) return isForbiddenIpv4(mapped);
  if (isIP(normalized) === 4) return isForbiddenIpv4(normalized);
  if (isIP(normalized) !== 6) return false;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const first = firstIpv6Hextet(normalized);
  if (first === null) return false;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  return false;
}

type DownloadLookup = (hostname: string) => Promise<string[]>;

async function defaultDownloadLookup(hostname: string) {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function assertOnlineEditorDownloadUrlAllowed(rawUrl: string, opts: {
  allowInsecure?: boolean;
  lookup?: DownloadLookup;
} = {}) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid_remote_url');
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'https:' && !(protocol === 'http:' && opts.allowInsecure === true)) {
    throw new Error('forbidden_scheme');
  }
  const hostname = stripIpv6Brackets(url.hostname);
  if (!hostname) throw new Error('forbidden_host');
  if (isIP(hostname)) {
    if (isForbiddenOnlineEditorDownloadAddress(hostname)) throw new Error('forbidden_host');
    return url;
  }
  let addresses: string[];
  try {
    addresses = await (opts.lookup || defaultDownloadLookup)(hostname);
  } catch (e: any) {
    throw new Error(`remote_dns_failed:${e?.message || String(e)}`);
  }
  if (!addresses.length || addresses.some((address) => isForbiddenOnlineEditorDownloadAddress(address))) {
    throw new Error('forbidden_host');
  }
  return url;
}

export async function assertOnlineEditorRedirectAllowed(currentUrl: string, location: string, opts: {
  allowInsecure?: boolean;
  lookup?: DownloadLookup;
} = {}) {
  const next = new URL(location, currentUrl).toString();
  try {
    return await assertOnlineEditorDownloadUrlAllowed(next, opts);
  } catch (e: any) {
    throw new Error(`forbidden_redirect:${e?.message || String(e)}`);
  }
}

function assertDownloadContentType(contentType: string | null) {
  if (!contentType) return;
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (!normalized) return;
  if (normalized.startsWith('video/') || normalized === 'application/octet-stream' || normalized === 'binary/octet-stream') return;
  throw new Error(`remote_content_type:${normalized}`);
}

async function fetchOnlineEditorDownloadResponse(remoteUrl: string) {
  let currentUrl = remoteUrl;
  const allowInsecure = allowInsecureDownload();
  for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
    await assertOnlineEditorDownloadUrlAllowed(currentUrl, { allowInsecure });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), downloadTimeoutMs());
    try {
      const response = await fetch(currentUrl, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('remote_redirect_missing_location');
        const next = await assertOnlineEditorRedirectAllowed(currentUrl, location, { allowInsecure });
        currentUrl = next.toString();
        continue;
      }
      assertDownloadContentType(response.headers.get('content-type'));
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('remote_redirect_loop');
}

async function writeResponseBodyWithLimit(body: ReadableStream<Uint8Array>, tempPath: string, limitBytes: number) {
  const input = Readable.fromWeb(body as any);
  const output = createWriteStream(tempPath);
  let written = 0;
  try {
    for await (const chunk of input) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buf.length;
      if (written > limitBytes) {
        throw new Error('remote_size_exceeded');
      }
      if (!output.write(buf)) {
        await once(output, 'drain');
      }
    }
    output.end();
    await once(output, 'finish');
  } catch (e) {
    input.destroy();
    output.destroy();
    throw e;
  }
  return written;
}

function mergeVevDemoMeta(row: ExportRow, patch: Record<string, any>) {
  const meta = parseExportMeta(row.edl_json);
  const vevDemo = meta.vevDemo && typeof meta.vevDemo === 'object' && !Array.isArray(meta.vevDemo)
    ? meta.vevDemo
    : {};
  return JSON.stringify({
    ...meta,
    vevDemo: {
      ...vevDemo,
      ...patch,
    },
  });
}

function getExportRow(exportId: string, ownerId: number): ExportRow | undefined {
  return getDb()
    .prepare<{ id: string; uid: number }, ExportRow>(
      'SELECT * FROM exports WHERE id = @id AND owner_id = @uid',
    )
    .get({ id: exportId, uid: ownerId });
}

function updateDownloadMeta(
  row: ExportRow,
  patch: Record<string, any>,
  fields: {
    localDownloadStatus?: string | null;
    filename?: string | null;
    errorMsg?: string | null;
  } = {},
) {
  const localStatus =
    Object.prototype.hasOwnProperty.call(fields, 'localDownloadStatus')
      ? fields.localDownloadStatus
      : row.local_download_status || null;
  const filename =
    Object.prototype.hasOwnProperty.call(fields, 'filename') ? fields.filename : row.filename || null;
  const errorMsg =
    Object.prototype.hasOwnProperty.call(fields, 'errorMsg') ? fields.errorMsg : row.error_msg || null;

  getDb()
    .prepare(
      `UPDATE exports
          SET local_download_status = @local_download_status,
              filename = @filename,
              error_msg = @error_msg,
              edl_json = @edl_json,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id AND owner_id = @owner_id`,
    )
    .run({
      id: row.id,
      owner_id: row.owner_id,
      local_download_status: localStatus,
      filename,
      error_msg: errorMsg,
      edl_json: mergeVevDemoMeta(row, patch),
    });
}

function markDownloadFailed(row: ExportRow, reason: string, extra: Record<string, any> = {}) {
  updateDownloadMeta(
    row,
    {
      localDownloadStatus: 'download_failed',
      downloadError: reason,
      downloadFailedAt: nowIso(),
      ...extra,
    },
    {
      localDownloadStatus: 'download_failed',
      filename: null,
      errorMsg: reason,
    },
  );
}

function downloadAttemptsFromMeta(meta: Record<string, any>) {
  const vevDemo = meta.vevDemo && typeof meta.vevDemo === 'object' && !Array.isArray(meta.vevDemo)
    ? meta.vevDemo
    : {};
  const n = Number(vevDemo.downloadAttempts || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function scanOnlineEditorDownloadExpiry(opts: { nearExpiryMs?: number; limit?: number } = {}) {
  const nearExpiryMs = opts.nearExpiryMs ?? envInt('ONLINE_EDITOR_DOWNLOAD_NEAR_EXPIRY_MS', 30 * 60_000, 60_000, 24 * 60 * 60_000);
  const rows = getDb()
    .prepare<{ limit: number }, ExportRow>(
      `SELECT * FROM exports
       WHERE status = 'completed'
         AND local_download_status IN ('pending', 'downloading', 'download_failed')
       ORDER BY updated_at ASC
       LIMIT @limit`,
    )
    .all({ limit: Math.max(1, Math.min(1000, Math.floor(opts.limit || 200))) });

  let expired = 0;
  let nearExpiry = 0;
  for (const row of rows) {
    const meta = parseExportMeta(row.edl_json);
    const vevDemo = meta.vevDemo && typeof meta.vevDemo === 'object' && !Array.isArray(meta.vevDemo)
      ? meta.vevDemo
      : {};
    const remoteUrl = String(vevDemo.remoteUrl || vevDemo.outputUrl || '').trim();
    const remoteUrlExpiresAt =
      resolveExpiresAt(vevDemo.remoteUrlExpiresAt) || deriveRemoteUrlExpiresAt(remoteUrl);
    if (!remoteUrlExpiresAt) continue;

    if (isExpired(remoteUrlExpiresAt)) {
      markDownloadFailed(row, ONLINE_EDITOR_REEXPORT_REASON, {
        remoteUrlExpiresAt,
        needsReviewReason: ONLINE_EDITOR_REEXPORT_REASON,
        reexportRequired: true,
      });
      expired++;
      continue;
    }
    if (isNearExpiry(remoteUrlExpiresAt, nearExpiryMs)) {
      updateDownloadMeta(row, {
        remoteUrlExpiresAt,
        downloadUrlNearExpiryAt: nowIso(),
        nearExpiryWarning: true,
      });
      console.warn(JSON.stringify({
        severity: 'warn',
        event: 'online_editor_download_near_expiry',
        task_id: row.id,
        expires_at: remoteUrlExpiresAt,
        remaining_ms: new Date(remoteUrlExpiresAt).getTime() - Date.now(),
      }));
      nearExpiry++;
    }
  }
  return { scanned: rows.length, expired, nearExpiry };
}

export function recoverOrphanedOnlineEditorDownloads() {
  if ((globalThis as any)[ORPHAN_RECOVERY_KEY]) return;
  (globalThis as any)[ORPHAN_RECOVERY_KEY] = true;

  const db = getDb();
  const rows = db
    .prepare<[], ExportRow>(
      "SELECT * FROM exports WHERE local_download_status = 'downloading'",
    )
    .all();
  if (!rows.length) return;

  console.warn(`[online-editor] download reap: 发现 ${rows.length} 个孤儿下载，标记 download_failed`);
  for (const row of rows) {
    markDownloadFailed(row, 'orphaned by server restart');
  }
}

export function requeuePendingOnlineEditorDownloads(opts: { once?: boolean } = {}) {
  const once = opts.once !== false;
  if (once) {
    if ((globalThis as any)[PENDING_REQUEUE_KEY]) return 0;
    (globalThis as any)[PENDING_REQUEUE_KEY] = true;
  }

  const rows = getDb()
    .prepare<[], ExportRow>(
      "SELECT * FROM exports WHERE local_download_status = 'pending' AND status = 'completed' ORDER BY updated_at ASC",
    )
    .all();
  if (!rows.length) return 0;

  console.warn(`[online-editor] download resume: 发现 ${rows.length} 个 pending 下载，重新入队`);
  for (const row of rows) {
    setImmediate(() => {
      downloadOnlineEditorExport({ exportId: row.id, ownerId: Number(row.owner_id) }).catch((err) => {
        console.error('[online-editor] pending download resume failed:', row.id, err);
      });
    });
  }
  return rows.length;
}

export function enqueueOnlineEditorDownload(args: { exportId: string; ownerId: number }) {
  recoverOrphanedOnlineEditorDownloads();
  if (!envFlag('INLINE_ONLINE_EDITOR_DOWNLOAD', true)) return;
  setImmediate(() => {
    downloadOnlineEditorExport(args).catch((err) => {
      console.error('[online-editor] download worker failed:', args.exportId, err);
    });
  });
}

export function startOnlineEditorDownloadWorker() {
  const globalScope = globalThis as any;
  if (globalScope[DOWNLOAD_WORKER_KEY]) return globalScope[DOWNLOAD_WORKER_KEY] as NodeJS.Timeout;

  const intervalMs = envInt('ONLINE_EDITOR_DOWNLOAD_WORKER_INTERVAL_MS', 10_000, 2_000, 10 * 60_000);
  ensureScheduledJob({
    jobName: DOWNLOAD_SCAN_JOB,
    catchUpStrategy: 'current_state_only',
    nextRunAt: nowIso(),
    meta: { intervalMs },
  });
  try {
    recoverOrphanedOnlineEditorDownloads();
    runOnlineEditorDownloadScheduledPass(intervalMs);
  } catch (e) {
    console.error('[online-editor] initial download worker pass failed:', e);
  }

  const timer = setInterval(() => {
    try {
      runOnlineEditorDownloadScheduledPass(intervalMs);
    } catch (e) {
      console.error('[online-editor] periodic download worker pass failed:', e);
    }
  }, intervalMs);
  timer.unref?.();
  globalScope[DOWNLOAD_WORKER_KEY] = timer;
  console.log(`[online-editor] download worker started interval=${intervalMs}ms`);
  return timer;
}

export function runOnlineEditorDownloadScheduledPass(intervalMs = 10_000) {
  const claimed = claimDueScheduledJob({
    jobName: DOWNLOAD_SCAN_JOB,
    runnerId: DOWNLOAD_SCAN_RUNNER_ID,
  });
  if (!claimed) return { claimed: false, requeued: 0, expiry: { scanned: 0, expired: 0, nearExpiry: 0 } };
  const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  try {
    const expiry = scanOnlineEditorDownloadExpiry();
    const requeued = requeuePendingOnlineEditorDownloads({ once: false });
    completeScheduledJob({
      jobName: DOWNLOAD_SCAN_JOB,
      runnerId: DOWNLOAD_SCAN_RUNNER_ID,
      nextRunAt,
      meta: { requeued, expiry },
    });
    return { claimed: true, requeued, expiry };
  } catch (e: any) {
    failScheduledJob({
      jobName: DOWNLOAD_SCAN_JOB,
      runnerId: DOWNLOAD_SCAN_RUNNER_ID,
      nextRunAt,
      error: e?.message || String(e),
    });
    throw e;
  }
}

export async function downloadOnlineEditorExport(args: { exportId: string; ownerId: number }) {
  recoverOrphanedOnlineEditorDownloads();
  const db = getDb();
  const claim = db
    .prepare(
      `UPDATE exports
          SET local_download_status = 'downloading',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id
          AND owner_id = @owner_id
          AND local_download_status = 'pending'`,
    )
    .run({ id: args.exportId, owner_id: args.ownerId });
  if (claim.changes !== 1) {
    return { ok: false, reason: 'not_pending' };
  }

  let row = getExportRow(args.exportId, args.ownerId);
  if (!row) return { ok: false, reason: 'not_found' };

  const meta = parseExportMeta(row.edl_json);
  const vevDemo = meta.vevDemo && typeof meta.vevDemo === 'object' && !Array.isArray(meta.vevDemo)
    ? meta.vevDemo
    : {};
  const downloadAttempts = downloadAttemptsFromMeta(meta);
  const nextAttempt = downloadAttempts + 1;
  const remoteUrl = String(vevDemo.remoteUrl || vevDemo.outputUrl || '').trim();
  const remoteUrlExpiresAt =
    resolveExpiresAt(vevDemo.remoteUrlExpiresAt) || deriveRemoteUrlExpiresAt(remoteUrl);

  updateDownloadMeta(
    row,
    {
      localDownloadStatus: 'downloading',
      remoteUrlExpiresAt,
      downloadStartedAt: nowIso(),
      downloadAttempts: nextAttempt,
    },
    { localDownloadStatus: 'downloading', filename: null, errorMsg: null },
  );

  row = getExportRow(args.exportId, args.ownerId);
  if (!row) return { ok: false, reason: 'not_found' };

  if (!remoteUrl) {
    markDownloadFailed(row, 'missing remote url');
    return { ok: false, reason: 'missing_remote_url' };
  }

  if (isExpired(remoteUrlExpiresAt)) {
    markDownloadFailed(row, ONLINE_EDITOR_REEXPORT_REASON, {
      remoteUrlExpiresAt,
      needsReviewReason: ONLINE_EDITOR_REEXPORT_REASON,
      reexportRequired: true,
    });
    return { ok: false, reason: ONLINE_EDITOR_REEXPORT_REASON };
  }

  const ownerDir = join(EXPORTS_DIR, String(args.ownerId));
  const filename = `${args.exportId}.mp4`;
  const finalPath = join(ownerDir, filename);
  const tempPath = `${finalPath}.download`;

  try {
    await mkdir(ownerDir, { recursive: true });
    const response = await fetchOnlineEditorDownloadResponse(remoteUrl);
    if (!response.ok) {
      throw new Error(`remote_http_${response.status}`);
    }
    if (!response.body) {
      throw new Error('remote_empty_body');
    }

    await writeResponseBodyWithLimit(response.body as any, tempPath, maxDownloadBytes());
    await rename(tempPath, finalPath);

    const latest = getExportRow(args.exportId, args.ownerId);
    if (latest) {
      updateDownloadMeta(
        latest,
        {
          localDownloadStatus: 'completed',
          localFilename: filename,
          downloadedAt: nowIso(),
          remoteUrlExpiresAt,
        },
        { localDownloadStatus: 'completed', filename, errorMsg: null },
      );
    }
    return { ok: true, filename };
  } catch (err: any) {
    await unlink(tempPath).catch(() => {});
    const latest = getExportRow(args.exportId, args.ownerId);
    if (latest) {
      const retryDelay = Math.min(downloadRetryBaseMs() * Math.pow(2, Math.max(0, nextAttempt - 1)), 30 * 60_000);
      markDownloadFailed(latest, err?.message || 'download_failed', {
        remoteUrlExpiresAt,
        downloadAttempts: nextAttempt,
        nextDownloadRetryAt: new Date(Date.now() + retryDelay).toISOString(),
      });
    }
    return { ok: false, reason: err?.message || 'download_failed' };
  }
}

export function retryOnlineEditorDownload(args: { exportId: string; ownerId: number }): RetryResult {
  recoverOrphanedOnlineEditorDownloads();
  const row = getExportRow(args.exportId, args.ownerId);
  if (!row) return { ok: false, code: 404, detail: '导出任务不存在' };

  const filenameRaw = String(row.filename || '');
  const hasLocalFile = Boolean(filenameRaw) && !/^https?:\/\//i.test(filenameRaw);
  if (row.local_download_status === 'completed' && hasLocalFile) {
    return { ok: true, status: 'completed' };
  }
  if (row.local_download_status !== 'download_failed') {
    return { ok: false, code: 409, detail: '当前导出不处于可重试状态' };
  }

  const meta = parseExportMeta(row.edl_json);
  const vevDemo = meta.vevDemo && typeof meta.vevDemo === 'object' && !Array.isArray(meta.vevDemo)
    ? meta.vevDemo
    : {};
  const attempts = downloadAttemptsFromMeta(meta);
  if (attempts >= maxDownloadAttempts()) {
    return { ok: false, code: 429, detail: '本地下载重试次数已达上限，请重新导出' };
  }
  const nextRetryAt = typeof vevDemo.nextDownloadRetryAt === 'string' ? Date.parse(vevDemo.nextDownloadRetryAt) : 0;
  if (Number.isFinite(nextRetryAt) && nextRetryAt > Date.now()) {
    return { ok: false, code: 429, detail: '下载重试退避中，请稍后再试' };
  }
  const remoteUrl = String(vevDemo.remoteUrl || vevDemo.outputUrl || '').trim();
  if (!remoteUrl) return { ok: false, code: 400, detail: '缺少远程下载 URL，无法重试' };

  const remoteUrlExpiresAt =
    resolveExpiresAt(vevDemo.remoteUrlExpiresAt) || deriveRemoteUrlExpiresAt(remoteUrl);
  if (isExpired(remoteUrlExpiresAt)) {
    markDownloadFailed(row, ONLINE_EDITOR_REEXPORT_REASON, {
      remoteUrlExpiresAt,
      needsReviewReason: ONLINE_EDITOR_REEXPORT_REASON,
      reexportRequired: true,
    });
    return { ok: false, code: 409, detail: '远程 URL 已过期，请重新触发 VevDemo 导出' };
  }

  updateDownloadMeta(
    row,
    {
      localDownloadStatus: 'pending',
      retryAt: nowIso(),
      remoteUrlExpiresAt,
      downloadError: null,
    },
    { localDownloadStatus: 'pending', filename: null, errorMsg: null },
  );
  enqueueOnlineEditorDownload(args);
  return { ok: true, status: 'pending' };
}
