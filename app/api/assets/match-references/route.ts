import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 把分镜里出现的角色/场景与已生成的"参考图"做匹配。
 * 阶段二仅返回结构化空匹配（保留接口契约），等阶段三接图像生成后再做真匹配。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  return jsonOk({ matches: [], note: '[阶段二占位] 真实匹配在阶段三（图像生成）完成后启用' });
}
