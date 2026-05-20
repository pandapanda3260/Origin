#!/usr/bin/env tsx
import { getDb } from '../lib/db';
import { SHOT_PLAN_STALE_FLAG } from '../lib/project-dependency-state';

type Summary = {
  apply: boolean;
  scanned: number;
  candidates: number;
  updated: number;
  skippedNoShots: number;
  skippedHasState: number;
  parseFailed: number;
};

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    apply: args.has('--apply'),
  };
}

function shouldMigrate(data: any) {
  const shots = Array.isArray(data?.shots) ? data.shots : [];
  if (!shots.length) return 'no_shots' as const;
  if (data?.shotPlanSourceHash || data?.shotPlanStatus) return 'has_state' as const;
  return 'migrate' as const;
}

function migrateData(data: any) {
  return {
    ...data,
    shotPlanStatus: 'legacy_unknown',
    shotPlanStaleReasons: [],
    _staleFlags: {
      ...(data?._staleFlags || {}),
      [SHOT_PLAN_STALE_FLAG]: true,
    },
  };
}

async function main() {
  const { apply } = parseArgs();
  const db = getDb();
  const summary: Summary = {
    apply,
    scanned: 0,
    candidates: 0,
    updated: 0,
    skippedNoShots: 0,
    skippedHasState: 0,
    parseFailed: 0,
  };

  const rows = db
    .prepare<[], { id: string; owner_id: number; data_json: string }>(
      'SELECT id, owner_id, data_json FROM projects ORDER BY owner_id ASC, id ASC',
    )
    .all();

  const updates: Array<{ id: string; ownerId: number; dataJson: string }> = [];
  for (const row of rows) {
    summary.scanned += 1;
    let data: any;
    try {
      data = JSON.parse(row.data_json || '{}');
    } catch {
      summary.parseFailed += 1;
      continue;
    }
    const decision = shouldMigrate(data);
    if (decision === 'no_shots') {
      summary.skippedNoShots += 1;
      continue;
    }
    if (decision === 'has_state') {
      summary.skippedHasState += 1;
      continue;
    }
    summary.candidates += 1;
    updates.push({
      id: row.id,
      ownerId: row.owner_id,
      dataJson: JSON.stringify(migrateData(data)),
    });
  }

  if (apply && updates.length) {
    const updateStmt = db.prepare(
      `UPDATE projects
          SET data_json = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND owner_id = ?`,
    );
    const txn = db.transaction((items: typeof updates) => {
      for (const item of items) {
        const result = updateStmt.run(item.dataJson, item.id, item.ownerId);
        if (result.changes > 0) summary.updated += 1;
      }
    });
    txn.immediate(updates);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[migrate-shot-plan-legacy] failed:', error?.message || error);
  process.exit(1);
});
