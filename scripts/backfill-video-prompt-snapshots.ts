import { getDb } from '../lib/db';
import { buildVideoPromptSnapshot } from '../lib/video-prompt-lifecycle';

type VideoTaskRow = {
  id: string;
  owner_id: number;
  project_id: string | null;
  group_idx: number | null;
  prompt: string;
  video_prompt_snapshot_json?: string;
  created_at: string;
};

type ProjectRow = {
  id: string;
  owner_id: number;
  data_json: string;
};

function parseJson(value: string) {
  try {
    return JSON.parse(value || '{}') || {};
  } catch {
    return {};
  }
}

function sourceHashForTask(project: any, groupIdx: number | null) {
  if (!project || groupIdx == null || !Number.isInteger(groupIdx) || groupIdx < 0) return null;
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  return storyboards[groupIdx]?.videoPromptSourceHash || null;
}

function main() {
  const db = getDb();
  const projects = new Map<string, any>();
  const projectRows = db
    .prepare('SELECT id, owner_id, data_json FROM projects')
    .all() as ProjectRow[];
  for (const row of projectRows) {
    projects.set(`${row.owner_id}:${row.id}`, parseJson(row.data_json));
  }

  const rows = db
    .prepare(
      `SELECT id, owner_id, project_id, group_idx, prompt, video_prompt_snapshot_json, created_at
         FROM video_tasks
        WHERE COALESCE(video_prompt_snapshot_json, '{}') = '{}'
          AND COALESCE(prompt, '') <> ''
        ORDER BY created_at ASC`,
    )
    .all() as VideoTaskRow[];

  let updated = 0;
  const stmt = db.prepare(
    `UPDATE video_tasks
        SET video_prompt_snapshot_json = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  );

  const txn = db.transaction(() => {
    for (const row of rows) {
      const project = row.project_id ? projects.get(`${row.owner_id}:${row.project_id}`) : null;
      const groupIdx = Number.isInteger(row.group_idx) && row.group_idx != null ? row.group_idx : -1;
      const snapshot = buildVideoPromptSnapshot({
        content: row.prompt,
        sourceHash: sourceHashForTask(project, row.group_idx),
        projectId: row.project_id || '',
        groupIdx,
        videoTaskId: row.id,
        legacy: true,
        createdAt: row.created_at,
      });
      stmt.run(JSON.stringify(snapshot), row.id);
      updated += 1;
    }
  });
  txn.immediate();
  console.log(`[backfill-video-prompt-snapshots] updated video_tasks=${updated}`);
}

main();
