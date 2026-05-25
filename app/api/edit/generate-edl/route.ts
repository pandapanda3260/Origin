import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatStream, parseJsonLoose, type ChatMessage } from '@/lib/llm';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { sseResponse } from '@/lib/sse';
import {
  SP_GENERATE_EDL,
  buildEdlResult,
  collectEdlGenerationContext,
  normalizeGeneratedEdl,
} from '@/lib/edit-edl';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { maybeInjectKnowledgePromptBlock } from '@/lib/knowledge/inject-messages';
import type { KnowledgeContextForStage } from '@/lib/knowledge/types';
import { syncEditProjectClips } from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 剪辑工作台 · AI 一键生成 EDL（剪辑决策表）。
 *
 * 协议：SSE — 前端 apiPostStream 期望 chunk 流 + done 事件。
 * 完成后写入 project.editData.edl（结构与 /api/edit/timeline 一致：
 *   { timeline: [...], bgm, version }），让剪辑页 _renderEditTimeline 直接消费。
 * 同时返回 serverVersion，前端 _ctx.bumpProjectVersion 推进版本号。
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
  const targetDurationSec: number = Number(body?.targetDurationSec || body?.durationSec || 30);

  return sseResponse(async (writer) => {
    if (!projectId) { writer.error('缺 projectId'); return; }
    const proj = getProjectByIdForUser(projectId, user.id) as any;
    if (!proj) { writer.error('项目不存在'); return; }

    const collected = collectEdlGenerationContext({
      projectId,
      userId: user.id,
      project: proj,
      body,
      targetDurationSec,
    });
    if (!collected.ok) {
      writer.error(collected.error);
      return;
    }
    const { ctx, clips, segTags } = collected;

    let raw = '';
    let knowledgeContext: KnowledgeContextForStage | null = null;
    try {
      writer.step('正在生成剪辑方案…');
      const edlMaxTokens = Math.min(12_000, Math.max(4_000, clips.length * 800));
      let messages: ChatMessage[] = [
        { role: 'system', content: SP_GENERATE_EDL },
        { role: 'user', content: JSON.stringify(ctx) },
      ];
      try {
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(proj as any),
            id: projectId,
          },
          stage: 'edit_edl',
          stageTarget: {
            source: 'api_edit_generate_edl',
            targetDurationSec,
            inputHash: collected.inputHash,
            clipIds: collected.clipIds,
            clipCount: clips.length,
          },
        });
        const injected = maybeInjectKnowledgePromptBlock({ messages, context });
        messages = injected.messages;
        knowledgeContext = injected.context;
      } catch (error) {
        console.warn('[edit/generate-edl] knowledge context injection skipped:', error);
      }
      await chatStream(
        user,
        messages,
        {
          temperature: 0.5,
          responseFormat: 'json_object',
          maxTokens: edlMaxTokens,
          modelRole: 'structured',
          reasoningEffort: 'none',
          traceName: 'edit.generate-edl',
          tokenContext: {
            projectId,
            projectTitleSnapshot: (proj as any)?.title || null,
            requestPath: req.nextUrl.pathname,
            routeName: 'edit.generate-edl',
            moduleKey: 'edit_export',
            moduleLabel: '剪辑导出',
            featureKey: 'edl_generate',
            featureLabel: '剪辑 EDL 生成',
            callItemType: 'project',
            callItemId: projectId,
            callItemLabel: (proj as any)?.title || null,
          },
        },
        (delta) => { raw += delta; writer.chunk(delta); },
      );
    } catch (e: any) {
      writer.error('EDL 生成失败：' + (e?.message || String(e)));
      return;
    }

    let json: any = {};
    try { json = parseJsonLoose<any>(raw); } catch (_) {
      writer.error('AI 输出无法解析为 JSON，请稍后重试');
      return;
    }

    const { timeline, totalDuration } = normalizeGeneratedEdl(json, clips, segTags);

    // 写盘到 editData.edl，并把 storyboards[i].importedToEdit 翻 true
    try {
      const fresh = getProjectByIdForUser(projectId, user.id) as any;
      const editData = { ...(fresh?.editData || {}) };
      const prevEdl = editData.edl && typeof editData.edl === 'object' ? editData.edl : {};
      const result = buildEdlResult(json, timeline, totalDuration, prevEdl);
      editData.edl = result;
      // 顶层 version 也推一下，bumpProjectVersion 取 max
      editData.version = (Number(editData.version) || 0) + 1;

      const sbs = Array.isArray(fresh?.storyboards) ? [...fresh.storyboards] : [];
      const inTl = new Set<number>(timeline.map((e) => e.groupIdx).filter((g) => Number.isInteger(g)) as number[]);
      let sbsTouched = false;
      for (let i = 0; i < sbs.length; i++) {
        const want = inTl.has(i);
        if (sbs[i] && !!sbs[i].importedToEdit !== want) {
          sbs[i] = { ...sbs[i], importedToEdit: want };
          sbsTouched = true;
        }
      }

      const patch: any = { editData };
      if (sbsTouched) patch.storyboards = sbs;
      updateProjectForUser(projectId, user.id, patch);
      try {
        syncEditProjectClips({ ownerId: user.id, projectId, timeline: result.timeline || [] });
      } catch (clipError) {
        console.warn('[edit/generate-edl] pinned clip sync skipped:', clipError);
      }
      if (knowledgeContext) {
        recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: knowledgeContext });
      }

      writer.done({ result, serverVersion: editData.version });
    } catch (e: any) {
      writer.error('保存失败：' + (e?.message || String(e)));
    }
  });
}
