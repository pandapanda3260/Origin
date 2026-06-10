import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedVideoUrl } from '@/lib/signed-asset-url';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') || 'user';
  const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
  const projectId = String(url.searchParams.get('projectId') || '').trim();

  const db = getDb();
  const rows = db
    .prepare<{ uid: number; lim: number; projectId: string }, any>(
	      `SELECT vt.id, vt.project_id, vt.group_idx, vt.prompt, vt.video_prompt_snapshot_json, vt.status,
	              vt.progress, vt.filename, vt.duration_sec, vt.cover_image_id, vt.created_at, vt.updated_at,
	              p.title AS project_title, p.data_json AS project_data_json
	         FROM video_tasks vt
	         LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
	        WHERE vt.owner_id = @uid
	          AND vt.status = 'completed'
	          AND (@projectId = '' OR vt.project_id = @projectId)
	        ORDER BY vt.created_at DESC
	       LIMIT @lim`,
    )
    .all({ uid: user.id, lim: limit, projectId });

  const parseSnapshot = (value: unknown) => {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

	  const items = rows.map((r: any) => {
	    const protectedUrl = `/api/videos/file/${r.id}`;
	    const videoPromptSnapshot = parseSnapshot(r.video_prompt_snapshot_json);
	    const names = buildVideoSegmentNamesForRow(r);
	    return {
	      taskId: r.id,
	      projectId: r.project_id,
	      groupIdx: r.group_idx,
	      filename: names.filename,
	      displayName: names.displayName,
	      downloadFilename: names.downloadFilename,
	      prompt: r.prompt,
      videoPromptSnapshot,
      videoPromptHistory: videoPromptSnapshot?.content || r.prompt,
      videoPromptSnapshotLegacy: !videoPromptSnapshot?.content || !!videoPromptSnapshot?.legacy,
      canApplyVideoPromptHistory: !!videoPromptSnapshot?.content && (!projectId || r.project_id === projectId),
      status: r.status,
      durationSec: r.duration_sec,
      url: buildSignedVideoUrl(r.id, user.id).url,
      protectedUrl,
      coverUrl: r.cover_image_id ? `/api/images/file/${r.cover_image_id}` : null,
      createdAt: r.created_at,
    };
  });

  return jsonOk({ items, total: items.length, scope });
}
