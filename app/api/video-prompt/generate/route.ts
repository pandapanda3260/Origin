import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildVideoPromptMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 按 group（多个连贯镜头）流式生成视频提示词。
 * 入参对齐原站前端 modules/videoPrompts.js 的 generateGroupVideoPrompt：
 *   { shots, shotIndices, styleBible, assets, narrations, allGroupsShots, allGroupsShotIndices,
 *     groupIdx, totalGroups, storyboardImageUrl, imageUrls, projectId? }
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const shots: any[] = Array.isArray(body.shots) ? body.shots : [];
  const styleBible: any = body.styleBible || {};
  const assets: any = body.assets || {};
  const narrations: any[] = Array.isArray(body.narrations) ? body.narrations : [];
  const groupIdx: number = Number.isInteger(body.groupIdx) ? body.groupIdx : 0;
  const totalGroups: number = Number.isInteger(body.totalGroups) ? body.totalGroups : 1;

  if (!shots.length) {
    return new Response(JSON.stringify({ detail: '本组没有镜头' }), { status: 400 });
  }

  return sseResponse(async (writer) => {
    writer.step(`正在生成第 ${groupIdx + 1}/${totalGroups} 组提示词…`);

    let prompt = '';
    try {
      await chatStream(
        user,
        buildVideoPromptMessages({ shots, styleBible, assets, narrations, groupIdx, totalGroups }),
        { temperature: 0.7, maxTokens: 1800 },
        (delta) => {
          prompt += delta;
          writer.chunk(delta);
        },
      );
    } catch (e: any) {
      writer.error('视频提示词生成失败：' + (e?.message || String(e)));
      return;
    }

    // 写回到对应 storyboard group 的 videoPrompt
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (proj) {
        const storyboards = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards : [];
        if (storyboards[groupIdx]) {
          storyboards[groupIdx] = { ...storyboards[groupIdx], videoPrompt: prompt, _vpCache: null };
        } else {
          while (storyboards.length <= groupIdx) storyboards.push({});
          storyboards[groupIdx] = { videoPrompt: prompt, _vpCache: null };
        }
        updateProjectForUser(projectId, user.id, { storyboards });
      }
    }

    writer.done({
      videoPrompt: prompt,
      narrationsUsed: narrations,
      groupIdx,
    });
  });
}
