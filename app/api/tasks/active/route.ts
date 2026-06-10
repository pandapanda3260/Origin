import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const db = getDb();
  const rows = db
	    .prepare<{ uid: number }, any>(
	      `SELECT vt.id, vt.project_id, vt.group_idx, vt.prompt, vt.status, vt.progress, vt.filename, vt.created_at,
	              p.title AS project_title, p.data_json AS project_data_json
	         FROM video_tasks vt
	         LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
	        WHERE vt.owner_id = @uid AND vt.status IN ('queued','running')
	        ORDER BY vt.created_at DESC`,
    )
    .all({ uid: user.id });

  return jsonOk({ items: rows.map((r: any) => publicShape(r)), total: rows.length });
}

function publicShape(r: any) {
  const names = buildVideoSegmentNamesForRow(r);
  return {
    taskId: r.id,
    projectId: r.project_id,
    groupIdx: r.group_idx,
    title: names.displayName,
    displayName: names.displayName,
    downloadFilename: names.downloadFilename,
    filename: names.filename,
    type: 'video_segment',
    status: r.status,
    progress: r.progress,
    createdAt: r.created_at,
  };
}
