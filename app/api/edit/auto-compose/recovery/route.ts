import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { cleanStaleRunningComposeRuns, getComposeBootTs, hasActiveComposeRun, pushEdlHistory } from '@/lib/edit-auto-compose-state';
import { patchProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const action = String(body?.action || '').trim();
  if (!projectId) return jsonError('缺 projectId', 400);
  if (action !== 'accept-current' && action !== 'rollback') {
    return jsonError('未知恢复动作', 400);
  }

  let result: any = null;
  const patched = patchProjectForUser(projectId, user.id, (current) => {
    let editData = { ...(current.editData || {}) };
    // 与 auto-compose 主路由同口径：重启孤儿（心跳早于本次进程启动）立即清，不等 10 分钟。
    const cleaned = cleanStaleRunningComposeRuns(editData, undefined, getComposeBootTs());
    editData = cleaned.editData;
    if (hasActiveComposeRun(editData)) {
      result = { ok: false, status: 409, message: '已有一键成片任务正在运行，暂不能修改时间线基线' };
      return { editData };
    }

    if (action === 'accept-current') {
      const version = Number(editData?.edl?.version) || 0;
      if (editData?.edl && Array.isArray(editData.edl.timeline) && editData.edl.timeline.length) {
        editData = pushEdlHistory(editData, { source: 'manual', edl: editData.edl });
      }
      editData.lastAutoComposeEdlVersion = version;
      result = { ok: true, action, edlVersion: version };
      return { editData };
    }

    const history = Array.isArray(editData.edlHistory) ? editData.edlHistory : [];
    const last = [...history].reverse().find((item: any) => item?.edl && Array.isArray(item.edl.timeline) && item.edl.timeline.length);
    if (!last) {
      result = { ok: false, status: 400, message: '没有可回滚的自动成片历史' };
      return { editData };
    }
    editData.edl = last.edl;
    editData.version = (Number(editData.version) || 0) + 1;
    editData.lastAutoComposeEdlVersion = Number(last.edl?.version) || 0;
    result = { ok: true, action, edlVersion: editData.lastAutoComposeEdlVersion };
    return { editData };
  }) as any;

  if (!patched) return jsonError('项目不存在', 404);
  if (!result?.ok) return jsonError(result?.message || '恢复失败', result?.status || 400);
  return jsonOk(result);
}
