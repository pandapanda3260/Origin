import { pollDueBatchProviderTasks } from './provider-recovery';
import { createSeedanceVideoProviderAdapter } from './video-gen';

const PROVIDER_POLLING_LOOP_KEY = '__origin_provider_polling_loop__';

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function runProviderPollingPass(opts: { limit?: number; nowMs?: number } = {}) {
  const adapter = createSeedanceVideoProviderAdapter();
  return pollDueBatchProviderTasks({
    provider: 'volcengine_seedance_video',
    adapter,
    limit: opts.limit,
    nowMs: opts.nowMs,
  });
}

export function startProviderPollingLoop() {
  const globalScope = globalThis as any;
  if (globalScope[PROVIDER_POLLING_LOOP_KEY]) return globalScope[PROVIDER_POLLING_LOOP_KEY] as NodeJS.Timeout;

  const intervalMs = envInt('PROVIDER_POLLING_INTERVAL_MS', 10_000, 2_000, 10 * 60_000);
  const limit = envInt('PROVIDER_POLLING_LIMIT', 10, 1, 100);
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runProviderPollingPass({ limit })
      .then((result) => {
        if (result.scanned > 0) {
          console.warn(`[provider-poll] scanned=${result.scanned}`);
        }
      })
      .catch((error) => {
        console.error('[provider-poll] pass failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  globalScope[PROVIDER_POLLING_LOOP_KEY] = timer;
  console.log(`[provider-poll] loop started interval=${intervalMs}ms limit=${limit}`);
  tick();
  return timer;
}
