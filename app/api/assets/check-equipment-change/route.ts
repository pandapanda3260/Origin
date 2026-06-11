import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_CHECK = `你是连续性检查官。给你"角色当前装备/服装"和"该角色在新一段剧本中的装备/服装"，判断是否发生了视觉上的关键变化（不算细节、表情、姿势）。
输出严格 JSON：{ "changed": true|false, "items": [{ "field": "服装|发型|手持物|其他", "from": "...", "to": "..." }] }`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body.projectId || '').trim();
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;

  if (!body.before || !body.after) return jsonOk({ changed: false, items: [] });

  try {
    const json = await chatCompleteJsonWithRetry<{ changed: boolean; items: any[] }>(
      user,
      [
        { role: 'system', content: SP_CHECK },
        { role: 'user', content: `对比：\n${JSON.stringify({ before: body.before, after: body.after })}` },
      ],
      {
        temperature: 0.2,
        maxTokens: 500,
        modelRole: 'structured',
        traceName: 'assets.check-equipment-change',
        tokenContext: {
          projectId: project ? projectId : null,
          projectTitleSnapshot: (project as any)?.title || null,
          requestPath: req.nextUrl.pathname,
          routeName: 'assets.check-equipment-change',
          moduleKey: 'assets',
          moduleLabel: '资产生成',
          featureKey: 'asset_equipment_change_check',
          featureLabel: '角色装备变化检查',
          callItemType: 'asset',
          callItemId: String(body.assetId || body.characterId || '').trim() || null,
          callItemLabel: String(body.assetName || body.characterName || '').trim() || null,
        },
      },
      parseJsonLoose,
      'assets.check-equipment-change',
    );
    return jsonOk({ changed: !!json.changed, items: Array.isArray(json.items) ? json.items : [] });
  } catch (e: any) {
    return jsonOk({ changed: false, items: [], _error: e?.message || String(e) });
  }
}
