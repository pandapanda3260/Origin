import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { recordContentFlag, scanSensitiveText } from '@/lib/content-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const text: string = (body.text || body.prompt || '').toString();
  const hits = scanSensitiveText(text);
  let flagId: string | null = null;
  const projectId = body.projectId ? String(body.projectId) : null;
  const sourceType = body.source_type || body.sourceType;
  const sourceId = body.source_id || body.sourceId;
  if (hits.length && projectId && sourceType && sourceId) {
    flagId = recordContentFlag({
      ownerId: user.id,
      projectId,
      sourceType: sourceType === 'image' || sourceType === 'video' ? sourceType : 'text',
      sourceId: String(sourceId),
      rawExcerpt: text,
      scanReason: `scan-sensitive:${hits.map((hit) => hit.term).join(',')}`,
      severity: hits.length > 2 ? 'high' : 'medium',
    });
  }
  return jsonOk({ flagged: hits.length > 0, hits, flagId });
}
