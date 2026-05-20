process.env.ORIGIN_PROCESS_ROLE = process.env.ORIGIN_PROCESS_ROLE || 'worker';
process.env.ORIGIN_REAP_ORPHANS_ON_START = process.env.ORIGIN_REAP_ORPHANS_ON_START || '0';
process.env.ORIGIN_BATCH_RECOVERY_ENABLED = process.env.ORIGIN_BATCH_RECOVERY_ENABLED || '1';
process.env.ORIGIN_INLINE_ONLINE_EDITOR_DOWNLOAD = process.env.ORIGIN_INLINE_ONLINE_EDITOR_DOWNLOAD || '1';

async function main() {
  const { loadExternalEnv } = await import('../lib/env');
  const envLoad = loadExternalEnv();

  await import('../lib/init-executors');
  const { startServiceHeartbeat } = await import('../lib/service-heartbeat');

  startServiceHeartbeat('origin-worker', {
    batchRecovery: process.env.ORIGIN_BATCH_RECOVERY_ENABLED || '1',
    onlineEditorDownload: process.env.ORIGIN_INLINE_ONLINE_EDITOR_DOWNLOAD || '1',
  });

  console.log(
    `[origin-worker] started role=${process.env.ORIGIN_PROCESS_ROLE} ` +
      `envLoaded=${envLoad.loaded} envFiles=${envLoad.paths.join(',') || '(none)'}`,
  );
}

const keepAlive = setInterval(() => {
  // The real work is scheduled by lib/init-executors. This interval keeps the
  // worker process alive under PM2/systemd while those timers use unref().
}, 60_000);

function shutdown(signal: string) {
  console.log(`[origin-worker] received ${signal}, shutting down`);
  clearInterval(keepAlive);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  console.error('[origin-worker] failed to start:', e);
  process.exit(1);
});

export {};
