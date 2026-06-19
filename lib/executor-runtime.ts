export type ExecutorEnv = Record<string, string | undefined>;

export function envFlagFrom(env: ExecutorEnv, name: string, fallback: boolean) {
  const raw = env[name] || env[`ORIGIN_${name}`];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function computeExecutorRuntime(env: ExecutorEnv = process.env) {
  const workerProcess =
    env.ORIGIN_PROCESS_ROLE === 'worker' ||
    envFlagFrom(env, 'WORKER_ENABLED', false);
  const externalWorkerExpected = envFlagFrom(env, 'EXPECT_WORKER', env.NODE_ENV === 'production');
  const localCoordinatorEnabled =
    !workerProcess &&
    !externalWorkerExpected &&
    envFlagFrom(env, 'LOCAL_WORKER_IN_WEB', env.NODE_ENV !== 'production');

  return {
    workerProcess,
    externalWorkerExpected,
    localCoordinatorEnabled,
    recoveryEnabled: workerProcess || localCoordinatorEnabled,
  };
}
