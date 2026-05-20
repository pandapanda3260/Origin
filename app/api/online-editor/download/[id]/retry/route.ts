import '@/lib/init-executors';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { retryOnlineEditorDownload } from '@/lib/online-editor-downloads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const exportId = String(params.id || '').trim();
  if (!exportId || !/^[a-zA-Z0-9-]+$/.test(exportId)) {
    return jsonError('bad export id', 400);
  }

  const result = retryOnlineEditorDownload({ exportId, ownerId: Number(user.id) });
  if (!result.ok) {
    return jsonError(result.detail, result.code);
  }

  return jsonOk({
    success: true,
    exportId,
    localDownloadStatus: result.status,
  });
}
