/**
 * Browser-session export completion endpoint.
 *
 * This path is called by the Origin parent page after it receives
 * `vevdemo:exportComplete` from the iframe. It intentionally uses the normal
 * Origin login session instead of HMAC; external webhooks must use
 * /api/volcengine/export-callback.
 */

import '@/lib/init-executors';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { OnlineEditorExportRecordError, saveVevDemoExportRecord } from '@/lib/online-editor-export-records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({}));
  try {
    const payload = saveVevDemoExportRecord({
      userId: Number(user.id),
      projectId: body.projectId,
      taskId: body.taskId,
      outputUrl: body.outputUrl,
      duration: body.duration,
      format: body.format || 'mp4',
      edlJson: body.edlJson,
    });
    return jsonOk(payload);
  } catch (err: any) {
    console.error('[OnlineEditorExportComplete] Failed to save export:', err);
    if (err instanceof OnlineEditorExportRecordError) {
      return jsonError(err.message, err.status);
    }
    return jsonError('保存导出记录失败: ' + (err?.message || 'unknown error'), 500);
  }
}
