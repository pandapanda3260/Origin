import { NextRequest } from 'next/server';
import { MOCK_CLIENT_CONFIG } from '@/mocks/config';
import { jsonOk } from '@/lib/api-helpers';
import { readSystemConfig } from '@/lib/system-config';
import { getCurrentUser } from '@/lib/auth';
import { getBalance, renewDueSubscription, settleExpiredSubscription } from '@/lib/credits';
import { getPlan } from '@/lib/billing-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // maxProjects 按会员档下发（docs/series-episode-continue-plan.md §6.5）：
  // 真相源是 PLANS[].limits.projects（Free 100 / Plus 1000 / Pro 5000），
  // 未登录或读取失败按 Free 兜底。前端 main.js 读 limits.maxProjects，零改动。
  let maxProjects = Number(getPlan('free')?.limits?.projects) || 100;
  try {
    const user = await getCurrentUser(req);
    if (user) {
      try { settleExpiredSubscription(user.id); } catch (_) {}
      try { renewDueSubscription(user.id); } catch (_) {}
      const plan = getPlan(getBalance(user.id).planCode);
      if (Number(plan?.limits?.projects) > 0) maxProjects = Number(plan!.limits!.projects);
    }
  } catch (_) {}

  return jsonOk({
    ...MOCK_CLIENT_CONFIG,
    features: {
      ...MOCK_CLIENT_CONFIG.features,
      projectActivationGuard: readSystemConfig('frontend_project_activation_guard_enabled', true),
      scriptConsultGuard: readSystemConfig('frontend_script_consult_guard_enabled', true),
    },
    limits: {
      ...MOCK_CLIENT_CONFIG.limits,
      maxProjects,
    },
  });
}
