import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { shortKnowledgeHash } from '@/lib/knowledge/hash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_CONTINUE = `你是短视频编剧助理。请在用户给的剧本末尾续写后续情节，保持原文的人物、风格和五段式节奏。
要求：
- 续写 3-5 句即可，不要重写整个剧本
- 用中文，纯文本，不要 markdown 围栏
- 续写完成后，把完整剧本（原文 + 续写）一起返回`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const currentScript: string = (body.script || '').toString();
  const direction: string = (body.direction || body.hint || '').toString();

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const baseScript = currentScript || (proj as any)?.scriptDraft || (proj as any)?.script || '';
  if (!baseScript) {
    return new Response(JSON.stringify({ detail: '当前没有剧本可续写' }), { status: 400 });
  }

  return sseResponse(async (writer) => {
    writer.phase('continue_start');
    writer.step('正在续写…');
    let buf = '';
    await chatStream(
      user,
      [
        { role: 'system', content: SP_CONTINUE },
        { role: 'user', content: `已有剧本：\n${baseScript}\n\n续写方向（可空）：${direction}` },
      ],
      { temperature: 0.8, maxTokens: 1200, modelRole: 'brain' },
      (delta) => {
        buf += delta;
        writer.scriptChunk(delta);
      },
    );

    if (projectId && proj) {
      updateProjectForUser(projectId, user.id, {
        scriptDraft: buf,
        script: buf,
      });
      try {
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(proj as any),
            id: projectId,
            scriptDraft: buf,
            script: buf,
          },
          stage: 'script_create',
          stageTarget: {
            mode: 'continue',
            baseScriptHash: shortKnowledgeHash(baseScript),
            directionHash: direction ? shortKnowledgeHash(direction) : null,
            scriptHash: shortKnowledgeHash(buf),
          },
        });
        recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context });
      } catch (error) {
        console.warn('[script/continue] knowledge context audit skipped:', error);
      }
    }

    writer.done({
      script: buf,
      // 前端 episodes.js 读 emotionSegments / durationSec / title；本端点不做情绪标注，给空数组
      emotionSegments: [],
      durationSec: (proj as any)?.scriptTargetDurationSec || null,
    });
  });
}
