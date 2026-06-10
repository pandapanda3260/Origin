import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedVideoUrl, normalizeAssetUrlTtl } from '@/lib/signed-asset-url';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return jsonError('bad id', 400);

  const db = getDb();
	const row = db
	    .prepare<{ id: string; uid: number }, any>(
	      `SELECT vt.id, vt.project_id, vt.group_idx, vt.filename,
	              p.title AS project_title, p.data_json AS project_data_json
	         FROM video_tasks vt
	         LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
	        WHERE vt.id = @id AND vt.owner_id = @uid LIMIT 1`,
	    )
    .get({ id, uid: user.id });
  if (!row) return jsonError('视频不存在', 404);

  const reqUrl = new URL(req.url);
	  const ttl = normalizeAssetUrlTtl(reqUrl.searchParams.get('ttl'));
	  const signed = buildSignedVideoUrl(id, user.id, ttl);
	  const names = buildVideoSegmentNamesForRow(row);
	  return jsonOk({
	    ...signed,
	    filename: names.filename,
	    displayName: names.displayName,
	    downloadFilename: names.downloadFilename,
	    protectedUrl: '/api/videos/file/' + encodeURIComponent(id),
	  });
}
