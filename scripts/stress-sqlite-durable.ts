import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function initDb(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stress_writes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      writer TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS stress_heartbeats (
      writer TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  db.close();
}

function runWorker(opts: { dbPath: string; writer: string; durationMs: number; payloadBytes: number }) {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    const payload = 'x'.repeat(workerData.payloadBytes);
    const insert = db.prepare('INSERT INTO stress_writes (writer, payload) VALUES (?, ?)');
    const heartbeat = db.prepare("INSERT INTO stress_heartbeats (writer, count) VALUES (?, 1) ON CONFLICT(writer) DO UPDATE SET count=count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    const deadline = Date.now() + workerData.durationMs;
    let writes = 0;
    let busy = 0;
    let locked = 0;
    let errors = 0;
    const latencies = [];
    while (Date.now() < deadline) {
      const started = Date.now();
      try {
        db.transaction(() => {
          insert.run(workerData.writer, payload);
          heartbeat.run(workerData.writer);
        }).immediate();
        writes++;
        latencies.push(Date.now() - started);
      } catch (error) {
        const message = String(error && error.message || error);
        if (/SQLITE_BUSY|database is locked/i.test(message)) busy++;
        else if (/SQLITE_LOCKED/i.test(message)) locked++;
        else errors++;
      }
    }
    db.close();
    parentPort.postMessage({ writer: workerData.writer, writes, busy, locked, errors, latencies });
  `;
  return new Promise<any>((resolvePromise, rejectPromise) => {
    const worker = new Worker(code, { eval: true, workerData: opts });
    worker.once('message', resolvePromise);
    worker.once('error', rejectPromise);
    worker.once('exit', (code) => {
      if (code !== 0) rejectPromise(new Error(`worker ${opts.writer} exited ${code}`));
    });
  });
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function main() {
  const tempDir = process.env.DB_PATH ? '' : mkdtempSync(join(tmpdir(), 'origin-sqlite-stress-'));
  const dbPath = resolve(process.env.DB_PATH || join(tempDir, 'stress.sqlite'));
  const durationMs = envInt('SQLITE_STRESS_DURATION_MS', 10_000, 1_000, 24 * 60 * 60 * 1000);
  const payloadBytes = envInt('SQLITE_STRESS_PAYLOAD_BYTES', 512, 16, 1024 * 1024);
  const maxBusyRate = Number(process.env.ORIGIN_SQLITE_STRESS_MAX_BUSY_RATE || process.env.SQLITE_STRESS_MAX_BUSY_RATE || '0.001');
  const maxP99Ms = envInt('SQLITE_STRESS_MAX_P99_MS', 200, 10, 60_000);

  try {
    initDb(dbPath);
    const results = await Promise.all([
      runWorker({ dbPath, writer: 'web', durationMs, payloadBytes }),
      runWorker({ dbPath, writer: 'worker', durationMs, payloadBytes }),
    ]);
    const writes = results.reduce((sum, row) => sum + row.writes, 0);
    const busy = results.reduce((sum, row) => sum + row.busy, 0);
    const locked = results.reduce((sum, row) => sum + row.locked, 0);
    const errors = results.reduce((sum, row) => sum + row.errors, 0);
    const attempts = writes + busy + locked + errors;
    const lockRate = attempts > 0 ? (busy + locked) / attempts : 0;
    const latencies = results.flatMap((row) => row.latencies || []);
    const p99Ms = percentile(latencies, 99);
    const ok = lockRate <= maxBusyRate && p99Ms <= maxP99Ms && errors === 0;

    console.log(JSON.stringify({
      ok,
      dbPath,
      durationMs,
      writers: results.map(({ writer, writes, busy, locked, errors }: any) => ({ writer, writes, busy, locked, errors })),
      totals: { attempts, writes, busy, locked, errors, lockRate, p99Ms },
      thresholds: { maxBusyRate, maxP99Ms },
    }));
    if (!ok) process.exit(1);
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[stress-sqlite] failed:', error?.message || error);
  process.exit(1);
});
