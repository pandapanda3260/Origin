import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import {
  extractVevDemoTaskIdFromSubmitResult,
  recordVevDemoExportSubmission,
  serializeVevDemoExportTask,
  VevDemoExportTaskError,
} from '@/lib/vevdemo-export-tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function assertOwnedProject(projectId: string, ownerId: number) {
  const row = getDb()
    .prepare('SELECT id FROM projects WHERE id = @id AND owner_id = @ownerId LIMIT 1')
    .get({ id: projectId, ownerId });
  if (!row) throw new VevDemoExportTaskError('Origin project not found or not owned by user', 404);
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) return jsonError('缺少 Origin 项目 ID', 400);
  const submitResult = body.submitResult ?? body.rawResult ?? body.result ?? {};
  const providerTaskId =
    (typeof body.providerTaskId === 'string' && body.providerTaskId.trim()) ||
    extractVevDemoTaskIdFromSubmitResult(submitResult);
  if (!providerTaskId) return jsonError('缺少 VevDemo 导出 TaskId', 400);

  try {
    assertOwnedProject(projectId, Number(user.id));
    const recorded = recordVevDemoExportSubmission({
      ownerId: Number(user.id),
      projectId,
      vevProjectId: body.vevProjectId,
      vevGroupId: body.vevGroupId,
      vevSpace: body.vevSpace,
      providerTaskId,
      submitRequest: body.submitRequest || {},
      submitResult,
    });
    return jsonOk(
      {
        success: true,
        duplicate: recorded.duplicate,
        task: serializeVevDemoExportTask(recorded.task),
      },
      { headers: noStoreHeaders },
    );
  } catch (error: any) {
    if (error instanceof VevDemoExportTaskError && error.status < 500) {
      return jsonError(error.message, error.status);
    }
    console.error('[online-editor/vevdemo-export/submit] failed:', error);
    return jsonError(error?.message || '保存 VevDemo 导出任务失败', error?.status || 500);
  }
}
