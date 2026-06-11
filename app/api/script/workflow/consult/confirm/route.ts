import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import {
  buildFullCreateMessages,
  buildRetagMessages,
} from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { getJson } from '@/lib/kv-db';
import { projectWorldContextForStage } from '@/lib/world-template-context';
import { looksLikeFiveActScript } from '@/lib/script-output-guard';
import { appendScriptTimeline, buildDraftEvent, nextScriptTimelineVersion } from '@/lib/script-timeline';
import { beginStageRun, progressStageRun, endStageRun, SCRIPT_GENERATE_STAGE } from '@/lib/stage-inflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const durationSec: number | undefined = body.durationSec || body.targetDurationSec;
  const audience: string | undefined = body.audience;

  return sseResponse(async (writer) => {
    // === 1. 生成剧本（流式）===
    writer.step('正在生成剧本…');
    const persona = user ? (getJson('user_profiles', user.id, null) as any) : null;
    const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;

    // 从 scriptConsult 里提取创意和大纲
    const scriptConsult = (proj as any)?.scriptConsult || {};
    const consultMessages: { role: string; content: string }[] = scriptConsult.messages || [];
    // 把所有用户消息合并，作为完整的创意描述
    const allUserMsgs = consultMessages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join(' ');
    // AI 标记 [READY] 后给的大纲（已经是对创意的总结）
    const outline = scriptConsult.outline || '';

    // 优先用 AI 生成的大纲，因为它更完整；用户消息作为补充
    const oneSentence = (body.oneSentence || '').toString() || outline || allUserMsgs;

    if (!oneSentence) {
      writer.error('请先在对话中描述你的创意');
      return;
    }

    // 刷新续接 + 防重：与 full-create / expand 共用 script_generate stage
    //（同项目同时只允许一路剧本生成，防双扣积分；详见 lib/stage-inflight.ts）
    const trackInflight = !!(projectId && proj);
    if (trackInflight) {
      const begin = beginStageRun(user.id, projectId!, SCRIPT_GENERATE_STAGE, {
        step: '正在生成剧本…',
        pct: 15,
        meta: { mode: 'consult_confirm' },
      });
      if (!begin.ok) {
        writer.error('该项目的剧本生成已在后台进行中，请稍候，完成后会自动写入项目');
        return;
      }
    }
    let inflightEnded = false;
    const endInflight = (outcome: 'done' | 'error', errMsg?: string) => {
      if (!trackInflight || inflightEnded) return;
      inflightEnded = true;
      endStageRun(user.id, projectId!, SCRIPT_GENERATE_STAGE, outcome, errMsg);
    };
    const stepInflight = (label: string, pct: number) => {
      if (!trackInflight || inflightEnded) return;
      progressStageRun(user.id, projectId!, SCRIPT_GENERATE_STAGE, label, pct);
    };

	    let scriptText = '';
    const worldContext = proj
      ? projectWorldContextForStage('script_create', (proj as any).worldTemplateSnapshot, {
          project: proj,
          scriptText: oneSentence,
        })
      : undefined;
    const scriptMessages = buildFullCreateMessages({
      oneSentence,
      outline,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
      audience,
      creatorPersona: persona,
      worldContext,
    });
    try {
      await chatStream(user, scriptMessages, {
        temperature: 0.8,
        maxTokens: 3000,
        modelRole: 'brain',
        traceName: 'script.consult_confirm',
        tokenContext: {
          projectId: proj ? projectId || null : null,
          projectTitleSnapshot: (proj as any)?.title || null,
          requestPath: req.nextUrl.pathname,
          routeName: 'script.workflow.consult.confirm',
          moduleKey: 'script',
          moduleLabel: '剧本页面',
          featureKey: 'script_consult_confirm',
          featureLabel: '对话确认生成剧本',
          callItemType: 'project',
          callItemId: proj ? projectId || null : null,
          callItemLabel: (proj as any)?.title || null,
        },
      }, (delta) => {
        scriptText += delta;
        writer.scriptChunk(delta);
      });
    } catch (e: any) {
      const failMsg = '剧本生成失败：' + (e?.message || String(e));
      endInflight('error', failMsg);
      writer.error(failMsg);
      return;
    }

    // 兜底：如果 LLM 还是输出了 <step> 标签，剥掉
    scriptText = scriptText.replace(/<step>[^<]*<\/step>\s*/gi, '').trim();
    // 兜底：把 LLM 字面量 "\n" 还原为真换行（prompt 里的 \\n 字面，
    // gpt-5.5/o1 等推理模型经常老老实实照打）
    scriptText = scriptText
      .replace(/\\r\\n|\\n/g, '\n')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 守门：输出不像五段式剧本（模型把指令当聊天回应）→ 不落库不重标
    if (!looksLikeFiveActScript(scriptText)) {
      const guardMsg = 'AI 没有按剧本格式输出，本次结果未保存，请再点一次"确认生成剧本"或补充描述后重试。';
      endInflight('error', guardMsg);
      writer.error(guardMsg);
      return;
    }

    // === 2. 情绪标记（非流式 JSON，带 3 次重试）===
    writer.phase('tag_emotions_start');
    writer.step('正在打情绪标签…');
    stepInflight('正在打情绪标签…', 80);
    let emotions: any[] = [];
    try {
      const emoJson = await chatCompleteJsonWithRetry<{ emotions: any[] }>(
        user,
        buildRetagMessages(scriptText, durationSec || (proj as any)?.scriptTargetDurationSec),
        {
          temperature: 0.4,
          maxTokens: 1200,
          modelRole: 'structured',
          traceName: 'script.consult_confirm.emotions',
          tokenContext: {
            projectId: proj ? projectId || null : null,
            projectTitleSnapshot: (proj as any)?.title || null,
            requestPath: req.nextUrl.pathname,
            routeName: 'script.workflow.consult.confirm',
            moduleKey: 'script',
            moduleLabel: '剧本页面',
            featureKey: 'script_consult_emotions',
            featureLabel: '对话生成剧本情绪标签',
            callItemType: 'project',
            callItemId: proj ? projectId || null : null,
            callItemLabel: (proj as any)?.title || null,
          },
        },
        (raw) => parseJsonLoose<{ emotions: any[] }>(raw),
        'emotions',
      );
      emotions = Array.isArray(emoJson?.emotions) ? emoJson.emotions : [];
    } catch (e: any) {
      console.warn('[consult/confirm] emotions failed after retries:', e?.message);
    }

    // === 3. 写回项目 ===
    let savedServerVersion: number | null = null;
    let savedTimeline: any[] | null = null;
    if (projectId && proj) {
      const baseTimeline = (proj as any).scriptTimeline;
      savedTimeline = appendScriptTimeline(baseTimeline, [
        buildDraftEvent({
          version: nextScriptTimelineVersion(baseTimeline),
          script: scriptText,
          source: 'generate',
          emotionSegments: emotions.length ? emotions : undefined,
        }),
      ]);
      try {
        const updated = updateProjectForUser(projectId, user.id, {
          scriptDraft: scriptText,
          script: scriptText,
          emotions,
          scriptApproved: false,
          scriptReviewState: 'draft',
          scriptTargetDurationSec: durationSec || (proj as any).scriptTargetDurationSec || null,
          currentStep: 1,
          scriptTimeline: savedTimeline,
        });
        savedServerVersion = typeof (updated as any)?.version === 'number' ? (updated as any).version : null;
      } catch (e: any) {
        const saveMsg = '保存失败：' + (e?.message || String(e));
        endInflight('error', saveMsg);
        writer.error(saveMsg);
        return;
      }
    }

    endInflight('done');
    writer.done({
      script: scriptText,
      // 前端 script.js 读 emotionSegments；同时保留 emotions 便于其它老调用方
      emotionSegments: emotions,
      emotions,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec || null,
      // 服务端已 version+1，带回给前端对齐 If-Match，避免后续 PUT 必撞 409
      serverVersion: savedServerVersion ?? undefined,
      // 前端必须把最新时间线写回内存，否则随后的整项目 PUT 会用旧数组盖掉这次 append
      scriptTimeline: savedTimeline ?? undefined,
    });
  });
}
