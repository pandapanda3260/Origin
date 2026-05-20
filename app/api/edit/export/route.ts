import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { EditExportError, startEditExport } from '@/lib/edit-export';
import { isExportEnabled } from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 剪辑工作台导出入口。
 *
 * 核心导出行为已搬到 lib/edit-export.ts，便于 /api/edit/auto-compose 复用。
 * 这里仅保留鉴权、参数读取和 HTTP 响应适配，避免旧导出入口行为漂移。
 */
export async function POST(req: NextRequest) {
  try {
    if (!isExportEnabled()) {
      return jsonError('导出功能暂时关闭，请稍后再试', 503);
    }

    const user = await getCurrentUser(req);
    if (!user) return jsonError('unauthorized', 401);

    const body = await req.json().catch(() => ({} as any));
    const projectId: string = (body.projectId || '').toString();
    if (!projectId) return jsonError('缺 projectId', 400);

    const proj = getProjectByIdForUser(projectId, user.id) as any;
    if (!proj) return jsonError('项目不存在', 404);

    const result = await startEditExport({
      user,
      projectId,
      project: proj,
      edl: body.edl,
      bgmId: body.bgmId ? String(body.bgmId) : undefined,
      edlVersion: Number.isFinite(Number(body.edlVersion)) ? Number(body.edlVersion) : undefined,
    });
    return jsonOk(result);
  } catch (err: any) {
    if (err instanceof EditExportError) {
      return new Response(
        JSON.stringify(err.payload || { detail: err.message }),
        { status: err.status, headers: { 'Content-Type': 'application/json' } },
      );
    }
    console.error('[export] unhandled error:', err?.stack || err?.message || err);
    return jsonError('导出失败：' + (err?.message || String(err)), 500);
  }
}
