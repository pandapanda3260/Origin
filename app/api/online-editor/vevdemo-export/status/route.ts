import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import {
  getLatestVevDemoExportTaskForProject,
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

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  if (!projectId) return jsonError('缺少 Origin 项目 ID', 400);

  try {
    assertOwnedProject(projectId, Number(user.id));
    const task = getLatestVevDemoExportTaskForProject({
      ownerId: Number(user.id),
      projectId,
    });
    return jsonOk(
      {
        success: true,
        task: serializeVevDemoExportTask(task),
      },
      { headers: noStoreHeaders },
    );
  } catch (error: any) {
    if (error instanceof VevDemoExportTaskError && error.status < 500) {
      return jsonError(error.message, error.status);
    }
    console.error('[online-editor/vevdemo-export/status] failed:', error);
    return jsonError(error?.message || '读取 VevDemo 导出任务失败', error?.status || 500);
  }
}
