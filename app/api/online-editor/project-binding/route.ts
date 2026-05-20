import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { ensureVevDemoProjectBinding } from '@/lib/vevdemo-project-registration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) return jsonError('缺少 Origin 项目 ID', 400);

  try {
    const binding = await ensureVevDemoProjectBinding(projectId, Number(user.id));
    return jsonOk({
      success: true,
      projectIsolationReady: true,
      originProjectId: binding.originProjectId,
      vevProjectId: binding.vevProjectId,
      vevGroupId: binding.vevGroupId,
      vevSpace: binding.vevSpace,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    });
  } catch (err: any) {
    console.error('[online-editor/project-binding] failed:', err);
    return jsonError(err?.message || '创建 VevDemo 工程绑定失败', err?.status || 500);
  }
}
