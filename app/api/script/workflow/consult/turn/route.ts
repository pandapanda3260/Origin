import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildConsultMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { normalizeScriptConsultState } from '@/lib/script-consult-state';
import { isScriptConsultDbHistoryOnlyEnabled } from '@/lib/system-config';
import { consultMessageHash, selectConsultTurnHistory } from '@/lib/script-consult-turn-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 去掉 <step>...</step> 标签，对话场景不需要这些 */
function stripStepTags(text: string): string {
  return text.replace(/<step>[^<]*<\/step>\s*/gi, '');
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const userMsg: string = (body.message || body.userMsg || body.text || '').toString();
  const projectId: string | undefined = body.projectId;
  const requestId = req.headers.get('x-request-id') || `consult_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dbHistoryOnly = isScriptConsultDbHistoryOnlyEnabled();

  if (!userMsg.trim()) {
    return new Response(JSON.stringify({ detail: '消息不能为空' }), { status: 400 });
  }

  let history: { role: 'user' | 'assistant'; content: string }[] = [];
  let requestHistoryForWrite: { role: 'user' | 'assistant'; content: string; readyToDraft?: boolean }[] = [];
  let requestHistorySource: 'db_existing_plus_current_turn' | 'request_history_plus_current_turn' = 'db_existing_plus_current_turn';
  let requestIncludedHistory = Array.isArray(body.messages) || Array.isArray(body.history);
  let project: any = null;

  // 取项目里已有的咨询历史（如果有）；默认请求体里的 history/messages 不参与写入。
  if (projectId) {
    project = getProjectByIdForUser(projectId, user.id);
    if (project) {
      const consult = normalizeScriptConsultState(project.scriptConsult);
      const selection = selectConsultTurnHistory(consult.messages as any, body, dbHistoryOnly);
      history = selection.history as any;
      requestHistoryForWrite = selection.requestHistory;
      requestHistorySource = selection.source;
      requestIncludedHistory = selection.requestIncludedHistory;
    }
  } else {
    const selection = selectConsultTurnHistory([], body, dbHistoryOnly);
    history = selection.history as any;
    requestHistoryForWrite = selection.requestHistory;
    requestHistorySource = selection.source;
    requestIncludedHistory = selection.requestIncludedHistory;
  }

  if (requestIncludedHistory && dbHistoryOnly) {
    console.warn('[scriptConsult.turn] ignored request history payload', {
      userId: user.id,
      projectId: projectId || null,
      requestId,
      keys: ['messages', 'history'].filter((key) => Array.isArray((body as any)[key])),
      requestHistoryCount: requestHistoryForWrite.length,
      firstMessageLength: requestHistoryForWrite[0]?.content?.length || 0,
      firstMessageHash: requestHistoryForWrite[0] ? consultMessageHash(requestHistoryForWrite[0].content) : null,
    });
  } else if (requestHistorySource === 'request_history_plus_current_turn') {
    console.warn('[scriptConsult.turn] using request history payload because db-only guard is disabled', {
      userId: user.id,
      projectId: projectId || null,
      requestId,
      requestHistoryCount: requestHistoryForWrite.length,
      firstMessageLength: requestHistoryForWrite[0]?.content?.length || 0,
      firstMessageHash: requestHistoryForWrite[0] ? consultMessageHash(requestHistoryForWrite[0].content) : null,
    });
  }

  return sseResponse(async (writer) => {
    writer.step('正在分析意图…');
    let buf = '';
    const messages = buildConsultMessages(history, userMsg);
    await chatStream(user, messages, {
      temperature: 0.6,
      maxTokens: 800,
      modelRole: 'brain',
      traceName: 'script.consult_turn',
      tokenContext: {
        projectId: project ? projectId || null : null,
        projectTitleSnapshot: project?.title || null,
        requestPath: req.nextUrl.pathname,
        routeName: 'script.workflow.consult.turn',
        moduleKey: 'script',
        moduleLabel: '剧本页面',
        featureKey: 'script_consult_turn',
        featureLabel: '剧本对话分析',
        callItemType: 'project',
        callItemId: project ? projectId || null : null,
        callItemLabel: project?.title || null,
        correlationId: requestId,
      },
    }, (delta) => {
      buf += delta;
      writer.aiChunk(delta);
    });

    // 检查 [READY] 标志，前端据此判断"够不够生成完整剧本"
    const readyIdx = buf.indexOf('[READY]');
    const ready = readyIdx >= 0;
    const outline = ready ? buf.slice(readyIdx + '[READY]'.length).trim() : '';
    // 去掉可能残留的 <step> 标签，对话场景不需要
    // 显示给用户的内容：把 [READY] 标记本身去掉，但保留前后所有文字（包括大纲）
    const replyMain = stripStepTags(buf.replace(/\[READY\]\s*/g, '').trim());

    // 把这一轮对话写回项目
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (proj) {
        const existing = normalizeScriptConsultState((proj as any).scriptConsult);
        const selection = selectConsultTurnHistory(existing.messages as any, body, dbHistoryOnly);
        const baseMessages = selection.history;
        const beforeCount = baseMessages.length;
        const newMessages = [
          ...(baseMessages || []),
          { role: 'user' as const, content: userMsg },
          // 把 readyToDraft 落到消息本身，刷新后前端回放能正确判断"是否挂确认按钮"
          // （否则只能依赖 sc.ready 兜底，多轮后追问可能误判）
          // 存剥干净的 replyMain 而不是原始 buf——不然历史里会残留 <step>…</step>
          // 标签（某些推理模型无视 prompt 里"禁止 <step>"的约束），刷新后回放穿帮。
          { role: 'assistant' as const, content: replyMain, readyToDraft: ready },
        ];
        updateProjectForUser(projectId, user.id, {
          scriptConsult: {
            messages: newMessages,
            outline: ready ? outline : (beforeCount > 0 ? existing.outline : ''),
            ready,
            startedAt: existing.startedAt || new Date().toISOString(),
            confirmedAt: existing.confirmedAt || null,
          },
        });
        console.info('[scriptConsult.turn] wrote messages', {
          userId: user.id,
          projectId,
          requestId,
          source: selection.source,
          dbHistoryOnly,
          countBefore: beforeCount,
          countAfter: newMessages.length,
          userMessageLength: userMsg.length,
          userMessageHash: consultMessageHash(userMsg),
          assistantMessageLength: replyMain.length,
          assistantMessageHash: consultMessageHash(replyMain),
        });
      }
    }

    writer.done({
      // 兼容前端 script.js（读 aiMessage / readyToDraft）和老调用方（读 reply / ready）
      reply: replyMain,
      aiMessage: replyMain,
      outline,
      ready,
      readyToDraft: ready,
      // 用户本轮消息直接含"确认/可以/直接生成"等意图时，前端会自动触发 confirm
      shouldAutoTrigger: ready && /(确认|可以|直接.{0,3}生成|开始|就这样|没问题)/.test(userMsg),
    });
  });
}
