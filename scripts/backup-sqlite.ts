import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getDataDir } from '../lib/runtime-paths';

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const dbPath = resolve(process.env.DB_PATH || join(getDataDir(), 'qd.sqlite'));
  if (!existsSync(dbPath)) {
    throw new Error(`SQLite database not found: ${dbPath}`);
  }
  const backupDir = resolve(process.env.ORIGIN_SQLITE_BACKUP_DIR || process.env.SQLITE_BACKUP_DIR || join(dirname(dbPath), 'backups'));
  const retain = envInt('SQLITE_BACKUP_RETAIN', 14, 1, 365);
  mkdirSync(backupDir, { recursive: true });

  const backupPath = join(backupDir, `${basename(dbPath)}.${timestampSlug()}.bak`);
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    await db.backup(backupPath);
  } finally {
    db.close();
  }

  const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backupDb.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`backup integrity_check failed: ${integrity}`);
    }
  } finally {
    backupDb.close();
  }

  const prefix = `${basename(dbPath)}.`;
  const suffix = '.bak';
  const backups = readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => {
      const path = join(backupDir, name);
      return { name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of backups.slice(retain)) {
    unlinkSync(old.path);
  }

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    backupPath,
    backupDir,
    retained: Math.min(backups.length, retain),
    removed: Math.max(0, backups.length - retain),
  }));
}

main().catch((error) => {
  console.error('[backup-sqlite] failed:', error?.message || error);
  process.exit(1);
});
