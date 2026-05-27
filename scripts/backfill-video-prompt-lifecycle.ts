import { getDb } from '../lib/db';
import { buildVideoPromptBackupBackfillPatch } from '../lib/video-prompt-lifecycle';

type ProjectRow = {
  id: string;
  owner_id: number;
  data_json: string;
  updated_at: string;
};

function parseJson(value: string) {
  try {
    return JSON.parse(value || '{}') || {};
  } catch {
    return {};
  }
}

function main() {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, owner_id, data_json, updated_at FROM projects ORDER BY created_at ASC')
    .all() as ProjectRow[];
  let updated = 0;
  const stmt = db.prepare(
    `UPDATE projects
       SET data_json = ?,
           version = version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND owner_id = ?`,
  );

  const txn = db.transaction(() => {
    for (const row of rows) {
      const project = {
        ...parseJson(row.data_json),
        id: row.id,
        ownerId: row.owner_id,
        updatedAt: row.updated_at,
      };
      const patch = buildVideoPromptBackupBackfillPatch(project);
      if (!patch) continue;
      const data = {
        ...parseJson(row.data_json),
        ...patch,
      };
      stmt.run(JSON.stringify(data), row.id, row.owner_id);
      updated += 1;
    }
  });
  txn.immediate();
  console.log(`[backfill-video-prompt-lifecycle] updated projects=${updated}`);
}

main();
