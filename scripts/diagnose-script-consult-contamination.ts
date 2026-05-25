import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dataPath } from '../lib/runtime-paths';
import {
  inspectScriptConsultContamination,
  scriptConsultMessageHash,
} from '../lib/script-consult-contamination';
import { emptyScriptConsultState } from '../lib/script-consult-state';

type Args = {
  db: string;
  since?: string;
  until?: string;
  limit: number;
  apply: boolean;
  backup: string;
  batchSize: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    db: process.env.DB_PATH || dataPath('qd.sqlite'),
    limit: 200,
    apply: false,
    backup: dataPath(`backups/script-consult-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`),
    batchSize: 100,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') out.db = argv[++i] || out.db;
    else if (arg === '--since') out.since = argv[++i];
    else if (arg === '--until') out.until = argv[++i];
    else if (arg === '--limit') out.limit = Math.max(1, Number(argv[++i]) || out.limit);
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--backup') out.backup = argv[++i] || out.backup;
    else if (arg === '--batch-size') out.batchSize = Math.max(1, Number(argv[++i]) || out.batchSize);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npx tsx scripts/diagnose-script-consult-contamination.ts [--db path] [--since iso --until iso] [--limit n] [--apply --backup path]');
      process.exit(0);
    }
  }
  return out;
}

function assertApplyWindow(args: Args) {
  if (!args.apply) return;
  if (!args.since || !args.until) {
    console.error(JSON.stringify({
      ok: false,
      error: 'apply_requires_accident_window',
      detail: '清洗写入必须显式传入 --since 和 --until；无时间窗只能 dry-run。',
    }, null, 2));
    process.exit(2);
  }
  const sinceMs = Date.parse(args.since);
  const untilMs = Date.parse(args.until);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
    console.error(JSON.stringify({
      ok: false,
      error: 'invalid_accident_window',
      detail: '--since/--until 必须是合法 ISO 时间，且 since <= until。',
    }, null, 2));
    process.exit(2);
  }
}

function parseData(row: any) {
  try { return JSON.parse(row.data_json || '{}'); } catch { return {}; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertApplyWindow(args);
  const db = new Database(resolve(args.db), { readonly: !args.apply });
  const rows = db.prepare(
    `SELECT id, owner_id, title, created_at, updated_at, data_json
       FROM projects
      ORDER BY created_at DESC
      LIMIT ?`,
  ).all(args.limit) as any[];

  const firstHashes = new Map<string, number>();
  const parsed = rows.map((row) => {
    const data = parseData(row);
    const messages = Array.isArray(data?.scriptConsult?.messages) ? data.scriptConsult.messages : [];
    const first = messages[0]?.content || '';
    if (first) {
      const hash = scriptConsultMessageHash(first);
      firstHashes.set(hash, (firstHashes.get(hash) || 0) + 1);
    }
    return { row, data };
  });
  const duplicateHashes = new Set(Array.from(firstHashes.entries()).filter(([, count]) => count > 1).map(([hash]) => hash));

  const findings = parsed
    .map(({ row, data }) => inspectScriptConsultContamination({
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      data,
    }, {
      accidentStartAt: args.since,
      accidentEndAt: args.until,
      duplicateHashes,
    }))
    .filter(Boolean);

  console.log(JSON.stringify({ ok: true, mode: args.apply ? 'apply' : 'dry-run', scanned: rows.length, findings }, null, 2));
  if (!args.apply || !findings.length) return;

  const backupPath = resolve(args.backup);
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, '');
  const update = db.prepare(
    `UPDATE projects
        SET data_json = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  );
  const byId = new Map(parsed.map((item) => [item.row.id, item]));
  for (let i = 0; i < findings.length; i += args.batchSize) {
    const batch = findings.slice(i, i + args.batchSize);
    const txn = db.transaction(() => {
      for (const finding of batch) {
        const item = byId.get(finding!.projectId);
        if (!item) continue;
        appendFileSync(backupPath, JSON.stringify(item.row) + '\n');
        const nextData = {
          ...item.data,
          scriptConsult: emptyScriptConsultState(),
          scriptConsultCleanupAudit: {
            cleanedAt: new Date().toISOString(),
            cleanedBy: 'diagnose-script-consult-contamination',
            originalBackupRef: backupPath,
            reason: finding!.reasons,
          },
        };
        update.run(JSON.stringify(nextData), finding!.projectId);
      }
    });
    txn();
  }
  console.log(JSON.stringify({ ok: true, cleaned: findings.length, backup: backupPath }));
}

main();
