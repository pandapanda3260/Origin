import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatComplete, parseJsonLoose } from '@/lib/llm';
import { buildAssetsExtractMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 从剧本里识别角色/场景/道具。
 * 走 SSE 让前端有"AI 正在分析剧本…"的进度提示动画。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const scriptText: string = (body.script || body.scriptText || '').toString();

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const finalScript = scriptText || (proj as any)?.scriptDraft || (proj as any)?.script || '';
  const styleBible = (proj as any)?.styleBible || null;

  return sseResponse(async (writer) => {
    if (!finalScript) {
      writer.error('当前没有剧本，请先生成或上传剧本');
      return;
    }

    writer.step('正在分析剧本结构…');
    writer.chunk('开始抽取角色 / 场景 / 道具…\n');

    let parsed: any = { characters: [], environments: [], props: [] };
    try {
      const raw = await chatComplete(user, buildAssetsExtractMessages(finalScript, styleBible), {
        temperature: 0.4,
        responseFormat: 'json_object',
        maxTokens: 3000,
      });
      const json = parseJsonLoose(raw);
      parsed = {
        characters: ensureArray(json.characters),
        environments: ensureArray(json.environments || json.scenes),
        props: ensureArray(json.props),
      };
    } catch (e: any) {
      writer.error('资产抽取失败：' + (e?.message || String(e)));
      return;
    }

    writer.step('已识别角色 ' + parsed.characters.length + ' 个');
    writer.step('已识别场景 ' + parsed.environments.length + ' 个');
    writer.step('已识别道具 ' + parsed.props.length + ' 个');

    if (projectId && proj) {
      // 写回项目：兼容前端 project.assets.{characters/scenes/props} 老结构 + 新顶层结构
      updateProjectForUser(projectId, user.id, {
        characters: parsed.characters,
        environments: parsed.environments,
        props: parsed.props,
        assets: {
          characters: parsed.characters,
          scenes: parsed.environments,
          props: parsed.props,
        },
        assetsApproved: false,
        currentStep: 2,
      });
    }

    writer.done(parsed);
  });
}

function ensureArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}
