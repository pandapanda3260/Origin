import { constants, existsSync, mkdirSync, readFileSync, statSync, statfsSync, accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb } from './db';
import { getExternalEnvLoadResult, getExternalEnvValue, loadExternalEnv } from './env';
import { envFlagFrom, type ExecutorEnv } from './executor-runtime';
import { describeRuntimeStorage, getDataDir } from './runtime-paths';
import { isPlaceholderSecret, secretByteLength } from './secret-safety';
import { getServiceHeartbeat } from './service-heartbeat';
import { readVevDemoUrlConfig } from './vevdemo-config';

type Check = {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message?: string;
  detail?: any;
};

function readReleaseFile(...parts: string[]) {
  try {
    const value = readFileSync(join(process.cwd(), ...parts), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function readReleaseIdentity() {
  return {
    releaseId: readReleaseFile('RELEASE_ID'),
    revision: readReleaseFile('REVISION'),
    buildId: readReleaseFile('.next', 'BUILD_ID'),
  };
}

function envFlag(name: string, fallback: boolean) {
  return envFlagFrom(process.env, name, fallback);
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
  const adminJwtSecret = readConfigValue('ADMIN_JWT_SECRET');
  const assetUrlSecret = readConfigValue('ASSET_URL_SECRET');
  if (production && (secretByteLength(jwtSecret) < 32 || isPlaceholderSecret(jwtSecret))) {
    addCheck(checks, {
      name: 'secrets.jwt',
      status: 'fail',
      message: isPlaceholderSecret(jwtSecret)
        ? 'production JWT_SECRET must replace the example placeholder'
        : 'production requires JWT_SECRET with at least 32 bytes',
    });
  } else {
    addCheck(checks, {
      name: 'secrets.jwt',
      status: secretByteLength(jwtSecret) >= 32 && !isPlaceholderSecret(jwtSecret) ? 'ok' : 'warn',
      message: secretByteLength(jwtSecret) >= 32 && !isPlaceholderSecret(jwtSecret)
        ? undefined
        : 'dev fallback JWT secret is active',
    });
  }
  if (production && (secretByteLength(adminJwtSecret) < 32 || isPlaceholderSecret(adminJwtSecret))) {
    addCheck(checks, {
      name: 'secrets.adminJwt',
      status: 'fail',
      message: isPlaceholderSecret(adminJwtSecret)
        ? 'production ADMIN_JWT_SECRET must replace the example placeholder'
        : 'production requires ADMIN_JWT_SECRET with at least 32 bytes',
    });
  } else {
    addCheck(checks, {
      name: 'secrets.adminJwt',
      status: secretByteLength(adminJwtSecret) >= 32 && !isPlaceholderSecret(adminJwtSecret) ? 'ok' : 'warn',
      message: secretByteLength(adminJwtSecret) >= 32 && !isPlaceholderSecret(adminJwtSecret)
        ? undefined
        : 'admin auth uses development fallback secret',
    });
  }
  if (production && jwtSecret && adminJwtSecret && jwtSecret === adminJwtSecret) {
    addCheck(checks, {
      name: 'secrets.adminJwtDistinct',
      status: 'fail',
      message: 'ADMIN_JWT_SECRET must be different from JWT_SECRET',
    });
  } else {
    addCheck(checks, {
      name: 'secrets.adminJwtDistinct',
      status: jwtSecret && adminJwtSecret && jwtSecret === adminJwtSecret ? 'warn' : 'ok',
      message: jwtSecret && adminJwtSecret && jwtSecret === adminJwtSecret
        ? 'ADMIN_JWT_SECRET should differ from JWT_SECRET'
        : undefined,
    });
  }
  if (production && (secretByteLength(assetUrlSecret) < 32 || isPlaceholderSecret(assetUrlSecret))) {
    addCheck(checks, {
      name: 'secrets.assetUrl',
      status: 'fail',
      message: isPlaceholderSecret(assetUrlSecret)
        ? 'production ASSET_URL_SECRET must replace the example placeholder'
        : 'production requires ASSET_URL_SECRET with at least 32 bytes',
    });
  } else {
    addCheck(checks, {
      name: 'secrets.assetUrl',
      status: secretByteLength(assetUrlSecret) >= 32 && !isPlaceholderSecret(assetUrlSecret) ? 'ok' : 'warn',
      message: secretByteLength(assetUrlSecret) >= 32 && !isPlaceholderSecret(assetUrlSecret)
        ? undefined
        : 'signed media URLs use a development fallback secret',
    });
  }
  if (
    production
    && assetUrlSecret
    && (assetUrlSecret === jwtSecret || assetUrlSecret === adminJwtSecret)
  ) {
    addCheck(checks, {
      name: 'secrets.assetUrlDistinct',
      status: 'fail',
      message: 'ASSET_URL_SECRET must be different from JWT_SECRET and ADMIN_JWT_SECRET',
    });
  } else {
    addCheck(checks, {
      name: 'secrets.assetUrlDistinct',
      status: assetUrlSecret && (assetUrlSecret === jwtSecret || assetUrlSecret === adminJwtSecret) ? 'warn' : 'ok',
      message: assetUrlSecret && (assetUrlSecret === jwtSecret || assetUrlSecret === adminJwtSecret)
        ? 'ASSET_URL_SECRET should differ from JWT_SECRET and ADMIN_JWT_SECRET'
        : undefined,
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

export function getProductionRuntimeGuardSummary(env: ExecutorEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const role = env.ORIGIN_PROCESS_ROLE || 'web';
  const violations: string[] = [];
  if (!production) {
    return {
      production,
      role,
      violations,
      detail: {
        role,
      },
    };
  }
  if (envFlagFrom(env, 'BILLING_DEV_AUTOPAY', false)) {
    violations.push('BILLING_DEV_AUTOPAY must be off in production');
  }
  if (envFlagFrom(env, 'ALLOW_INSECURE_DOWNLOAD', false)) {
    violations.push('ORIGIN_ALLOW_INSECURE_DOWNLOAD must be off in production');
  }
  if (!envFlagFrom(env, 'EXPECT_WORKER', true)) {
    violations.push('ORIGIN_EXPECT_WORKER must stay on in production');
  }
  if (role === 'web') {
    if (envFlagFrom(env, 'BATCH_INLINE_RUNNER', false)) {
      violations.push('ORIGIN_BATCH_INLINE_RUNNER must be off for production web');
    }
    if (envFlagFrom(env, 'INLINE_ONLINE_EDITOR_DOWNLOAD', false)) {
      violations.push('ORIGIN_INLINE_ONLINE_EDITOR_DOWNLOAD must be off for production web');
    }
    if (envFlagFrom(env, 'REAP_ORPHANS_ON_START', false)) {
      violations.push('ORIGIN_REAP_ORPHANS_ON_START must be off for production web');
    }
    if (envFlagFrom(env, 'BATCH_RECOVERY_ENABLED', false)) {
      violations.push('ORIGIN_BATCH_RECOVERY_ENABLED must be worker-only in production');
    }
  }

  return {
    production,
    role,
    violations,
    detail: {
      role,
      billingDevAutopay: envFlagFrom(env, 'BILLING_DEV_AUTOPAY', false),
      allowInsecureDownload: envFlagFrom(env, 'ALLOW_INSECURE_DOWNLOAD', false),
      expectWorker: envFlagFrom(env, 'EXPECT_WORKER', true),
      batchInlineRunner: envFlagFrom(env, 'BATCH_INLINE_RUNNER', false),
      inlineOnlineEditorDownload: envFlagFrom(env, 'INLINE_ONLINE_EDITOR_DOWNLOAD', false),
      reapOrphansOnStart: envFlagFrom(env, 'REAP_ORPHANS_ON_START', false),
      batchRecoveryEnabled: envFlagFrom(env, 'BATCH_RECOVERY_ENABLED', false),
    },
  };
}

function checkProductionRuntimeGuards(checks: Check[]) {
  const summary = getProductionRuntimeGuardSummary(process.env);
  if (!summary.production) {
    addCheck(checks, { name: 'runtime.productionGuards', status: 'ok', message: 'non-production runtime' });
    return;
  }

  addCheck(checks, {
    name: 'runtime.productionGuards',
    status: summary.violations.length ? 'fail' : 'ok',
    message: summary.violations.length ? summary.violations.join('; ') : undefined,
    detail: summary.detail,
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
  checkProductionRuntimeGuards(checks);

  const hasFail = checks.some((check) => check.status === 'fail');
  const hasWarn = checks.some((check) => check.status === 'warn');
  return {
    ok: !hasFail,
    status: hasFail ? 'fail' : hasWarn ? 'degraded' : 'ok',
    role: process.env.ORIGIN_PROCESS_ROLE || 'web',
    release: readReleaseIdentity(),
    env: {
      nodeEnv: process.env.NODE_ENV || null,
      external: getExternalEnvLoadResult(),
    },
    checks,
  };
}
