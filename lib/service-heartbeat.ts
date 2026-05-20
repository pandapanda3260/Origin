import { hostname } from 'node:os';
import { getDb } from './db';

const timers = new Map<string, NodeJS.Timeout>();
const startedAt = new Date().toISOString();

export function recordServiceHeartbeat(service: string, meta: Record<string, any> = {}) {
  const name = String(service || '').trim();
  if (!name) return;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO runtime_service_heartbeats
         (service, pid, hostname, meta_json, heartbeat_at, started_at, updated_at)
       VALUES
         (@service, @pid, @hostname, @meta_json, @heartbeat_at, @started_at, @heartbeat_at)
       ON CONFLICT(service) DO UPDATE SET
         pid=excluded.pid,
         hostname=excluded.hostname,
         meta_json=excluded.meta_json,
         heartbeat_at=excluded.heartbeat_at,
         updated_at=excluded.updated_at`,
    )
    .run({
      service: name,
      pid: process.pid,
      hostname: hostname(),
      meta_json: JSON.stringify(meta || {}),
      heartbeat_at: now,
      started_at: startedAt,
    });
}

export function startServiceHeartbeat(service: string, meta: Record<string, any> = {}, intervalMs = 15_000) {
  const name = String(service || '').trim();
  if (!name) throw new Error('service heartbeat requires a service name');
  const existing = timers.get(name);
  if (existing) return existing;

  recordServiceHeartbeat(name, meta);
  const timer = setInterval(() => {
    try {
      recordServiceHeartbeat(name, meta);
    } catch (e) {
      console.error(`[heartbeat] failed for ${name}:`, e);
    }
  }, Math.max(5_000, intervalMs));
  timer.unref?.();
  timers.set(name, timer);
  return timer;
}

export function getServiceHeartbeat(service: string) {
  const row = getDb()
    .prepare<{ service: string }, any>(
      'SELECT * FROM runtime_service_heartbeats WHERE service = @service',
    )
    .get({ service });
  if (!row) return null;
  let meta: any = {};
  try { meta = JSON.parse(row.meta_json || '{}'); } catch {}
  return {
    service: row.service,
    pid: row.pid,
    hostname: row.hostname,
    meta,
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    ageMs: Date.now() - Date.parse(row.heartbeat_at || ''),
  };
}
