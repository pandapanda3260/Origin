import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { countProjectsForUser, createProjectForUser, listProjectsByUser } from '@/lib/projects-db';
import { getBalance, renewDueSubscription, settleExpiredSubscription } from '@/lib/credits';
import { getPlan } from '@/lib/billing-config';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const items = listProjectsByUser(user.id);
  // 原站前端兼容：同时给出 projects 和 items 两个字段名
  return jsonOk({ projects: items, items, total: items.length });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  // 配额：按会员档权威拦截（docs/series-episode-continue-plan.md §6.5）。
  // 先惰性结算过期订阅（照抄 billing/me 的打法），防止过期 Plus 还按 1000 算；
  // 降级后存量超限不删不锁，只拦新建。
  try { settleExpiredSubscription(user.id); } catch (_) {}
  try { renewDueSubscription(user.id); } catch (_) {}
  let planCode = 'free';
  try { planCode = getBalance(user.id).planCode || 'free'; } catch (_) {}
  const plan = getPlan(planCode) || getPlan('free');
  const maxProjects = Number(plan?.limits?.projects) > 0 ? Number(plan!.limits.projects) : 100;
  const used = countProjectsForUser(user.id);
  if (used >= maxProjects) {
    return NextResponse.json(
      {
        error: 'project_quota_exceeded',
        max: maxProjects,
        used,
        plan: plan?.code || planCode,
        detail: `${plan?.title || planCode} 套餐最多保存 ${maxProjects} 个任务（当前 ${used} 个）。删除旧任务或升级会员后可继续创建。`,
      },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const project = createProjectForUser(user.id, body);
  return jsonOk(project);
}
