import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { analyzeUsableSegments } from '@/lib/edit-analyze';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { sseResponse } from '@/lib/sse';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import type { KnowledgeContextForStage } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 剪辑工作台 · AI 分析（叙事结构 / 情绪曲线 / 段落标签 / BGM 建议）。
 *
 * 协议：SSE — 前端 apiPostStream 期望 chunk 流 + done 事件。
 * 完成后写入 project.editData.segmentTags，并 bump editData.version 作为
 * serverVersion 返回给前端，让 _ctx.bumpProjectVersion 推进版本号。
 *
 * 返回 schema 必须严格匹配前端 _renderEditTags 的消费字段，否则右侧面板会
 * 渲染成空白：
 *   {
 *     narrative,
 *     suggestedBGMCategory,
 *     segments: [
 *       { groupIdx, plotRole, pace, emotion, emotionIntensity, keyAction, keyCharacters }
 *     ]
 *   }
 */

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response(
      `data: ${JSON.stringify({ type: 'error', error: 'unauthorized' })}\n\n`,
      { status: 401, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body?.projectId;

  return sseResponse(async (writer) => {
    if (!projectId) { writer.error('缺 projectId'); return; }
    const proj = getProjectByIdForUser(projectId, user.id) as any;
    if (!proj) { writer.error('项目不存在'); return; }

    let result: any;
    let knowledgeContext: KnowledgeContextForStage | null = null;
    try {
      result = await analyzeUsableSegments({
        user,
        project: proj,
        knowledge: {
          ownerId: user.id,
          projectId,
          stageTarget: {
            source: 'api_edit_analyze',
          },
        },
        onKnowledgeContext: (context) => { knowledgeContext = context; },
        onStep: (label) => writer.step(label),
        onChunk: (delta) => writer.chunk(delta),
      });
    } catch (e: any) {
      writer.error('分析失败：' + (e?.message || String(e)));
      return;
    }

    try {
      const fresh = getProjectByIdForUser(projectId, user.id) as any;
      const editData = { ...(fresh?.editData || {}) };
      editData.segmentTags = result;
      const next = (Number(editData.version) || 0) + 1;
      editData.version = next;
      updateProjectForUser(projectId, user.id, { editData });
      if (knowledgeContext) {
        recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: knowledgeContext });
      }
      writer.done({ result, serverVersion: next });
    } catch (e: any) {
      writer.error('保存失败：' + (e?.message || String(e)));
    }
  });
}
