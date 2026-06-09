import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import {
  buildAdaptSourceMessages,
  buildFullCreateMessages,
  buildRetagMessages,
  buildReviseMessages,
} from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { getJson } from '@/lib/kv-db';
import { InsufficientCreditsError } from '@/lib/credits';
import { assertCanStartPaidOperation } from '@/lib/usage-billing';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { shortKnowledgeHash } from '@/lib/knowledge/hash';
import { projectWorldContextForStage } from '@/lib/world-template-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 一句话 → 完整剧本（跳过老问路径）。
 * 流程同 consult/confirm，只是入口直接给一句话。
 * 为了和原站接口契约对齐，本路由也走 SSE。
 *
 * 同时支持 mode="revise"：基于已有剧本 + 修改指令重写。
 *   - 需要 body.script + body.instruction
 *   - 不重新写 oneSentence；情绪标签重新提取
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const mode: string = (body.mode || 'create').toString();
  const oneSentence: string = (body.oneSentence || body.idea || body.text || '').toString();
  const sourceText: string = (body.sourceText || '').toString().trim();
  const baseScript: string = (body.script || '').toString();
  const instruction: string = (body.instruction || '').toString();
  const durationSec: number | undefined = body.durationSec || body.targetDurationSec;
  const audience: string | undefined = body.audience;

  return sseResponse(async (writer) => {
    const isRevise = mode === 'revise';
    // mode="adapt" is an audit hint from the client; routing is decided by sourceText.
    const isAdapt = !isRevise && sourceText.length > 0;
    writer.step(isRevise ? '正在按你的指令修改剧本…' : isAdapt ? '正在把原文改编成剧本…' : '正在生成剧本…');
    const persona = user ? (getJson('user_profiles', user.id, null) as any) : null;
    const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
    const finalSentence = oneSentence || (proj as any)?.oneSentence || '';
    const finalBaseScript = baseScript || (proj as any)?.script || (proj as any)?.scriptDraft || '';
    const oneSentenceBrief = isAdapt ? makeSourceTextBrief(sourceText) : finalSentence;

    if (isRevise) {
      if (!finalBaseScript) { writer.error('当前没有剧本可修改，请先生成'); return; }
      if (!instruction) { writer.error('请输入修改指令'); return; }
    } else if (isAdapt) {
      if (sourceText.length < 100) { writer.error('原文内容过短，请补充或改用创意描述'); return; }
    } else if (!finalSentence) {
      writer.error('请先填写一句话创意');
      return;
    }

    try {
      assertCanStartPaidOperation(user.id);
    } catch (e: any) {
      if (e instanceof InsufficientCreditsError) {
        writer.event('error', { error: e.message, errorCode: 'INSUFFICIENT_CREDITS', required: e.required, balance: e.balance });
        return;
      }
      writer.error(e?.message || String(e));
      return;
    }

	    let scriptText = '';
    const worldContext = proj
      ? projectWorldContextForStage('script_create', (proj as any).worldTemplateSnapshot, {
          project: proj,
          scriptText: finalBaseScript || sourceText || finalSentence,
        })
      : undefined;
    const messages = isRevise
      ? buildReviseMessages({
          baseScript: finalBaseScript,
          instruction,
          durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
          worldContext,
        })
      : isAdapt
      ? buildAdaptSourceMessages({
          sourceText,
          durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
          audience,
          creatorPersona: persona,
          worldContext,
        })
      : buildFullCreateMessages({
          oneSentence: finalSentence,
          durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
          audience,
          creatorPersona: persona,
          worldContext,
        });
    try {
      await chatStream(user, messages, {
        temperature: isRevise ? 0.6 : 0.8,
        maxTokens: 3000,
        modelRole: 'brain',
        traceName: isRevise ? 'script.revise' : isAdapt ? 'script.adapt' : 'script.full_create',
        tokenContext: {
          projectId: projectId || null,
          projectTitleSnapshot: (proj as any)?.title || null,
          requestPath: req.nextUrl.pathname,
          routeName: 'script.workflow.full-create',
          moduleKey: 'script',
          moduleLabel: '剧本页面',
          featureKey: isRevise ? 'script_revise' : isAdapt ? 'script_adapt' : 'script_full_create',
          featureLabel: isRevise ? '剧本改写' : isAdapt ? '源文本改编' : '完整剧本生成',
          callItemType: 'project',
          callItemId: projectId || null,
          callItemLabel: (proj as any)?.title || null,
        },
      }, (delta) => {
        scriptText += delta;
        writer.scriptChunk(delta);
      });
    } catch (e: any) {
      writer.error(formatScriptGenerationError(e, { isAdapt }));
      return;
    }

    // 兜底：如果 LLM 还是输出了 <step> 标签，剥掉
    scriptText = scriptText.replace(/<step>[^<]*<\/step>\s*/gi, '').trim();
    // 兜底：把 LLM 偷懒输出的字面量 "\n"（两字符）替换成真换行；
    // 还有 \r\n 序列、行尾多余空格、多空行也一并整理
    scriptText = normalizeScriptWhitespace(scriptText);

    writer.phase('tag_emotions_start');
    writer.step('正在打情绪标签…');
    let emotions: any[] = [];
    try {
      const emoJson = await chatCompleteJsonWithRetry<{ emotions: any[] }>(
        user,
        buildRetagMessages(scriptText, durationSec || (proj as any)?.scriptTargetDurationSec),
        {
          temperature: 0.4,
          maxTokens: 1200,
          modelRole: 'structured',
          tokenContext: {
            projectId: projectId || null,
            projectTitleSnapshot: (proj as any)?.title || null,
            requestPath: req.nextUrl.pathname,
            routeName: 'script.workflow.full-create',
            moduleKey: 'script',
            moduleLabel: '剧本页面',
            featureKey: 'emotion_tagging',
            featureLabel: '情绪标签生成',
            callItemType: 'project',
            callItemId: projectId || null,
            callItemLabel: (proj as any)?.title || null,
          },
        },
        (raw) => parseJsonLoose<{ emotions: any[] }>(raw),
        'emotions',
      );
      emotions = Array.isArray(emoJson?.emotions) ? emoJson.emotions : [];
    } catch (e: any) {
      console.warn('[full-create] emotions failed after retries:', e?.message);
    }

    if (projectId && proj) {
      const writePayload: Record<string, any> = {
        scriptDraft: scriptText,
        script: scriptText,
        emotions,
        scriptApproved: false,
        scriptReviewState: 'draft',
        scriptTargetDurationSec: durationSec || (proj as any).scriptTargetDurationSec || null,
        currentStep: 1,
      };
      // 修改模式不要覆盖 oneSentence —— 原创意要保留
      if (!isRevise) writePayload.oneSentence = oneSentenceBrief;
      try {
        updateProjectForUser(projectId, user.id, writePayload);
      } catch (e: any) {
        writer.error('保存失败：' + (e?.message || String(e)));
        return;
      }
      try {
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(proj as any),
            id: projectId,
            ...writePayload,
          },
          stage: 'script_create',
          stageTarget: {
            mode: isRevise ? 'revise' : isAdapt ? 'adapt' : 'create',
            durationSec: durationSec || (proj as any).scriptTargetDurationSec || null,
            audience: audience || null,
            oneSentenceHash: oneSentenceBrief ? shortKnowledgeHash(oneSentenceBrief) : null,
            sourceTextHash: isAdapt ? shortKnowledgeHash(sourceText) : null,
            baseScriptHash: isRevise && finalBaseScript ? shortKnowledgeHash(finalBaseScript) : null,
            instructionHash: isRevise && instruction ? shortKnowledgeHash(instruction) : null,
            scriptHash: shortKnowledgeHash(scriptText),
            emotionCount: emotions.length,
          },
        });
        recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context });
      } catch (error) {
        console.warn('[script/full-create] knowledge context audit skipped:', error);
      }
    }

    writer.done({
      script: scriptText,
      // 前端 script.js 读 emotionSegments + durationSec
      emotionSegments: emotions,
      emotions,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec || null,
      title: extractTitle(scriptText, isAdapt ? oneSentenceBrief : finalSentence),
      generationMode: isRevise ? 'revise' : isAdapt ? 'adapt' : 'create',
      oneSentenceBrief: isAdapt ? oneSentenceBrief : undefined,
    });
  });
}

function extractTitle(script: string, fallback: string): string {
  const firstLine = (script || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  if (firstLine.length > 0 && firstLine.length <= 40) return firstLine.replace(/^#+\s*/, '');
  return (fallback || '未命名项目').slice(0, 40);
}

function makeSourceTextBrief(sourceText: string): string {
  const cleaned = (sourceText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^(请|帮我|麻烦你)?(把|将)?(下面|以下|这段|这些)?(原文|小说|内容|文字|故事)?(改成|改写成?|整理成|生成)?(短视频)?(剧本|脚本)?[：:，,\s-]*/i, '')
    .trim();
  const brief = cleaned.slice(0, 180);
  return brief ? `原文改编：${brief}${cleaned.length > 180 ? '…' : ''}` : '原文改编';
}

function formatScriptGenerationError(error: any, opts: { isAdapt: boolean }): string {
  const raw = (error?.message || error || '').toString();
  const normalized = raw.toLowerCase();
  const isInputTpmLimit =
    normalized.includes('request_limit_exceeded')
    || normalized.includes('input tokens per minute')
    || normalized.includes('workspace input tokens')
    || /llm\s*429/.test(normalized);

  if (isInputTpmLimit) {
    return opts.isAdapt
      ? '原文较长，模型本分钟可处理的文字额度已满。请稍等 1-2 分钟再试，或缩短原文后生成。'
      : '模型本分钟可处理的文字额度已满。请稍等 1-2 分钟后重试。';
  }

  return `剧本生成失败：${raw || '请稍后重试'}`;
}

/**
 * 修剪剧本里的换行 / 空格异常：
 *   1. LLM 把 prompt 里的 "\n" 当字面量输出了 → 还原为真换行
 *   2. \r\n / \r → \n 统一
 *   3. 行尾多余空格 / 段首多余空格全干掉
 *   4. 连续 3+ 空行收成 2 行
 */
function normalizeScriptWhitespace(s: string): string {
  if (!s) return s;
  return s
    .replace(/\\r\\n|\\n/g, '\n')      // 字面量 \n / \r\n → 真换行
    .replace(/\r\n?/g, '\n')           // 物理 \r\n → \n
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')        // 3+ 空行收成 1 个空行
    .trim();
}
