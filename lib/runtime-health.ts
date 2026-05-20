import { constants, existsSync, mkdirSync, statSync, statfsSync, accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb } from './db';
import { getExternalEnvLoadResult, getExternalEnvValue, loadExternalEnv } from './env';
import { describeRuntimeStorage, getDataDir } from './runtime-paths';
import { getServiceHeartbeat } from './service-heartbeat';
import { readVevDemoUrlConfig } from './vevdemo-config';

type Check = {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message?: string;
  detail?: any;
};

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return 'unknown';
  const gib = value / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(1)}GiB`;
  const mib = value / (1024 ** 2);
  return `${mib.toFixed(0)}MiB`;
}

function readConfigValue(key: string) {
  return (getExternalEnvValue(key) || process.env[key] || '').trim();
}

function requiredEnvPresent(key: string) {
  return Boolean(readConfigValue(key));
}

function addCheck(checks: Check[], check: Check) {
  checks.push(check);
}

function checkWritableDataDir(checks: Check[]) {
  const dataDir = getDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    const stat = statSync(dataDir);
    addCheck(checks, {
      name: 'storage.localDataDir',
      status: stat.isDirectory() ? 'ok' : 'fail',
      detail: { dataDir },
      message: stat.isDirectory() ? undefined : 'ORIGIN_DATA_DIR is not a directory',
    });
  } catch (e: any) {
    addCheck(checks, {
      name: 'storage.localDataDir',
      status: 'fail',
      message: e?.message || String(e),
      detail: { dataDir, parent: dirname(dataDir) },
    });
  }
}

function checkDiskFree(checks: Check[]) {
  const dataDir = getDataDir();
  try {
    mkdirSync(dataDir, { recursive: true });
    const fsStat = statfsSync(dataDir);
    const blockSize = Number(fsStat.bsize || 0);
    const totalBytes = blockSize * Number(fsStat.blocks || 0);
    const freeBytes = blockSize * Number(fsStat.bavail || 0);
    const freePct = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    const warnPct = envNumber('DISK_WARN_FREE_PCT', 20, 1, 90);
    const failPct = envNumber('DISK_FAIL_FREE_PCT', 10, 1, 90);
    const warnBytes = envNumber('DISK_WARN_FREE_BYTES', 10 * 1024 ** 3, 100 * 1024 ** 2, 10 * 1024 ** 4);
    const failBytes = envNumber('DISK_FAIL_FREE_BYTES', 5 * 1024 ** 3, 100 * 1024 ** 2, 10 * 1024 ** 4);
    const warnThreshold = Math.min((totalBytes * warnPct) / 100, warnBytes);
    const failThreshold = Math.min((totalBytes * failPct) / 100, failBytes);
    const status = freeBytes < failThreshold ? 'fail' : freeBytes < warnThreshold ? 'warn' : 'ok';
    addCheck(checks, {
      name: 'storage.diskFree',
      status,
      message: status === 'ok'
        ? undefined
        : `free disk ${formatBytes(freeBytes)} (${freePct.toFixed(1)}%) below ${status === 'fail' ? 'fail' : 'warn'} threshold`,
      detail: {
        dataDir,
        totalBytes,
        freeBytes,
        freePct,
        warnThresholdBytes: Math.floor(warnThreshold),
        failThresholdBytes: Math.floor(failThreshold),
      },
    });
  } catch (e: any) {
    addCheck(checks, { name: 'storage.diskFree', status: 'fail', message: e?.message || String(e), detail: { dataDir } });
  }
}

function checkDb(checks: Check[]) {
  try {
    const db = getDb();
    db.prepare('SELECT 1 AS ok').get();
    const queues = db
      .prepare<[], any>(
        `SELECT
           (SELECT COUNT(*) FROM batches WHERE status IN ('queued','running')) AS activeBatches,
           (SELECT COUNT(*) FROM batch_tasks WHERE status='queued') AS queuedBatchTasks,
           (SELECT COUNT(*) FROM video_tasks WHERE status IN ('queued','running')) AS activeVideoTasks,
           (SELECT COUNT(*) FROM exports WHERE local_download_status='pending') AS pendingOnlineEditorDownloads`,
      )
      .get();
    addCheck(checks, { name: 'database.sqlite', status: 'ok', detail: queues });
  } catch (e: any) {
    addCheck(checks, { name: 'database.sqlite', status: 'fail', message: e?.message || String(e) });
  }
}

function checkNeedsReviewBacklog(checks: Check[]) {
  const threshold = envInt('HEALTH_NEEDS_REVIEW_THRESHOLD', 20, 0, 100_000);
  try {
    const row = getDb()
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM batch_tasks WHERE status = 'needs_review'")
      .get();
    const count = Number(row?.count || 0);
    addCheck(checks, {
      name: 'tasks.needsReview',
      status: count > threshold ? 'warn' : 'ok',
      message: count > threshold ? `needs_review backlog ${count} exceeds threshold ${threshold}` : undefined,
      detail: { count, threshold },
    });
  } catch (e: any) {
    addCheck(checks, { name: 'tasks.needsReview', status: 'fail', message: e?.message || String(e) });
  }
}

function checkSecrets(checks: Check[]) {
  const production = process.env.NODE_ENV === 'production';
  const jwtSecret = readConfigValue('JWT_SECRET');
  if (production && jwtSecret.length < 32) {
    addCheck(checks, {
      name: 'secrets.jwt',
      status: 'fail',
      message: 'production requires JWT_SECRET with at least 32 bytes',
    });
  } else {
    addCheck(checks, {
      name: 'secrets.jwt',
      status: jwtSecret.length >= 32 ? 'ok' : 'warn',
      message: jwtSecret.length >= 32 ? undefined : 'dev fallback JWT secret is active',
    });
  }
}

function checkOnlineEditor(checks: Check[]) {
  const enabledRaw = readConfigValue('ONLINE_EDITOR_ENABLED');
  const enabled = ['1', 'true', 'yes', 'on'].includes(enabledRaw.toLowerCase());
  if (!enabled) {
    addCheck(checks, { name: 'vevdemo.config', status: 'warn', message: 'ONLINE_EDITOR_ENABLED is off or missing' });
    return;
  }
  const vevDemoConfig = readVevDemoUrlConfig();
  const missing = [
    ...(!requiredEnvPresent('ONLINE_EDITOR_OPEN_MODE') ? ['ONLINE_EDITOR_OPEN_MODE'] : []),
    ...vevDemoConfig.missingKeys,
  ];
  console.info(
    `[runtime-health] vevdemo.config status=${missing.length ? 'fail' : 'ok'} openMode=${readConfigValue('ONLINE_EDITOR_OPEN_MODE') || '(missing)'} editorUrlConfigured=${Boolean(vevDemoConfig.editorUrl)} apiUrlConfigured=${Boolean(vevDemoConfig.apiUrl)} legacyKeysUsed=${vevDemoConfig.legacyKeysUsed.join(',') || '(none)'}`,
  );
  addCheck(checks, {
    name: 'vevdemo.config',
    status: missing.length ? 'fail' : 'ok',
    message: missing.length ? `missing ${missing.join(', ')}` : undefined,
    detail: {
      openMode: readConfigValue('ONLINE_EDITOR_OPEN_MODE') || null,
      frontendUrlConfigured: Boolean(vevDemoConfig.editorUrl),
      backendUrlConfigured: Boolean(vevDemoConfig.apiUrl),
      legacyKeysUsed: vevDemoConfig.legacyKeysUsed,
    },
  });
}

function checkOnlineEditorMaterialRegistration(checks: Check[]) {
  const enabledRaw = readConfigValue('ONLINE_EDITOR_ENABLED');
  const enabled = ['1', 'true', 'yes', 'on'].includes(enabledRaw.toLowerCase());
  if (!enabled) return;

  const required = [
    'VOLC_ACCESS_KEY',
    'VOLC_SECRET_KEY',
    'VITE_VEV_PROJECT_ID',
    'VITE_VEV_GROUP_ID',
    'VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID',
  ];
  const missing = required.filter((key) => !requiredEnvPresent(key));
  const openapiPath = join(process.cwd(), 'vevdemo-1.0.6', 'nodejs', 'node_modules', '@volcengine', 'openapi');
  const openapiInstalled = existsSync(openapiPath);
  const status = missing.length || !openapiInstalled ? 'fail' : 'ok';
  addCheck(checks, {
    name: 'vevdemo.materialRegistration',
    status,
    message: status === 'ok'
      ? undefined
      : [
          missing.length ? `missing ${missing.join(', ')}` : '',
          !openapiInstalled ? 'missing VevDemo @volcengine/openapi dependency' : '',
        ].filter(Boolean).join('; '),
    detail: {
      volcAccessKeyConfigured: requiredEnvPresent('VOLC_ACCESS_KEY'),
      volcSecretKeyConfigured: requiredEnvPresent('VOLC_SECRET_KEY'),
      projectIdConfigured: requiredEnvPresent('VITE_VEV_PROJECT_ID'),
      groupIdConfigured: requiredEnvPresent('VITE_VEV_GROUP_ID'),
      uploadWorkflowTemplateConfigured: requiredEnvPresent('VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID'),
      openapiInstalled,
    },
  });
}

function checkWorkerHeartbeat(checks: Check[]) {
  const expectWorker = envFlag('EXPECT_WORKER', process.env.NODE_ENV === 'production');
  if (!expectWorker) {
    addCheck(checks, { name: 'worker.heartbeat', status: 'warn', message: 'worker expectation disabled' });
    return;
  }
  let heartbeat: ReturnType<typeof getServiceHeartbeat>;
  try {
    heartbeat = getServiceHeartbeat('origin-worker');
  } catch (e: any) {
    addCheck(checks, { name: 'worker.heartbeat', status: 'fail', message: e?.message || String(e) });
    return;
  }
  if (!heartbeat) {
    addCheck(checks, { name: 'worker.heartbeat', status: 'fail', message: 'origin-worker heartbeat not found' });
    return;
  }
  const fresh = Number.isFinite(heartbeat.ageMs) && heartbeat.ageMs < 90_000;
  addCheck(checks, {
    name: 'worker.heartbeat',
    status: fresh ? 'ok' : 'fail',
    message: fresh ? undefined : 'origin-worker heartbeat is stale',
    detail: heartbeat,
  });
}

function checkStorageMode(checks: Check[]) {
  const storage = describeRuntimeStorage();
  const production = process.env.NODE_ENV === 'production';
  if (storage.driver !== 'local') {
    addCheck(checks, {
      name: 'storage.driver',
      status: 'warn',
      message: 'non-local object storage is configured but current runtime still serves files through Origin proxy routes',
      detail: storage,
    });
    return;
  }
  addCheck(checks, {
    name: 'storage.driver',
    status: production && !storage.durableLocalVolume ? 'warn' : 'ok',
    message: production && !storage.durableLocalVolume
      ? 'set ORIGIN_DATA_DIR to a mounted persistent volume before production traffic'
      : undefined,
    detail: storage,
  });
}

export function getRuntimeHealth() {
  loadExternalEnv();
  const checks: Check[] = [];
  checkDb(checks);
  checkNeedsReviewBacklog(checks);
  checkWritableDataDir(checks);
  checkDiskFree(checks);
  checkStorageMode(checks);
  checkSecrets(checks);
  checkOnlineEditor(checks);
  checkOnlineEditorMaterialRegistration(checks);
  checkWorkerHeartbeat(checks);

  const hasFail = checks.some((check) => check.status === 'fail');
  const hasWarn = checks.some((check) => check.status === 'warn');
  return {
    ok: !hasFail,
    status: hasFail ? 'fail' : hasWarn ? 'degraded' : 'ok',
    role: process.env.ORIGIN_PROCESS_ROLE || 'web',
    env: {
      nodeEnv: process.env.NODE_ENV || null,
      external: getExternalEnvLoadResult(),
    },
    checks,
  };
}
