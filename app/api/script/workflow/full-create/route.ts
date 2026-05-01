import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, chatComplete, chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import {
  buildFullCreateMessages,
  buildStyleBibleMessages,
  buildRetagMessages,
  buildReviseMessages,
} from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { getJson } from '@/lib/kv-db';
import { CREDIT_PRICES, chargeCredits, refundCredits, InsufficientCreditsError } from '@/lib/credits';
import { sinicizeColorPalette } from '@/lib/style-bible';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 一句话 → 完整剧本（跳过老问路径）。
 * 流程同 consult/confirm，只是入口直接给一句话。
 * 为了和原站接口契约对齐，本路由也走 SSE。
 *
 * 同时支持 mode="revise"：基于已有剧本 + 修改指令重写。
 *   - 需要 body.script + body.instruction
 *   - 不重新写 oneSentence；style bible / emotions 重新提取
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const mode: string = (body.mode || 'create').toString();
  const oneSentence: string = (body.oneSentence || body.idea || body.text || '').toString();
  const baseScript: string = (body.script || '').toString();
  const instruction: string = (body.instruction || '').toString();
  const durationSec: number | undefined = body.durationSec || body.targetDurationSec;
  const audience: string | undefined = body.audience;

  return sseResponse(async (writer) => {
    const isRevise = mode === 'revise';
    writer.step(isRevise ? '正在按你的指令修改剧本…' : '正在生成剧本…');
    const persona = user ? (getJson('user_profiles', user.id, null) as any) : null;
    const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
    const finalSentence = oneSentence || (proj as any)?.oneSentence || '';
    const finalBaseScript = baseScript || (proj as any)?.script || (proj as any)?.scriptDraft || '';

    if (isRevise) {
      if (!finalBaseScript) { writer.error('当前没有剧本可修改，请先生成'); return; }
      if (!instruction) { writer.error('请输入修改指令'); return; }
    } else if (!finalSentence) {
      writer.error('请先填写一句话创意');
      return;
    }

    // 计费：剧本生成 ≈ 3 次 LLM 调用（剧本 + 风格圣经 + 情绪标签）
    let charge: { ledgerId: string; balanceAfter: number } | null = null;
    try {
      charge = chargeCredits({
        userId: user.id,
        amount: CREDIT_PRICES.text * 3,
        kind: 'text',
        reason: isRevise ? 'script.revise' : 'script.full-create',
        refId: projectId,
      });
    } catch (e: any) {
      if (e instanceof InsufficientCreditsError) {
        writer.event('error', { error: e.message, errorCode: 'INSUFFICIENT_CREDITS', required: e.required, balance: e.balance });
        return;
      }
      writer.error(e?.message || String(e));
      return;
    }

    let scriptText = '';
    const messages = isRevise
      ? buildReviseMessages({
          baseScript: finalBaseScript,
          instruction,
          durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
        })
      : buildFullCreateMessages({
          oneSentence: finalSentence,
          durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
          audience,
          creatorPersona: persona,
        });
    try {
      await chatStream(user, messages, { temperature: isRevise ? 0.6 : 0.8, maxTokens: 3000 }, (delta) => {
        scriptText += delta;
        writer.scriptChunk(delta);
      });
    } catch (e: any) {
      // LLM 调用失败 → 退积分 + 抛友好错误
      if (charge) {
        try { refundCredits({ userId: user.id, amount: CREDIT_PRICES.text * 3, kind: 'text', reason: 'script.error', refId: projectId }); } catch (_) {}
      }
      writer.error(`剧本生成失败：${e?.message || String(e)}`);
      return;
    }

    // 兜底：如果 LLM 还是输出了 <step> 标签，剥掉
    scriptText = scriptText.replace(/<step>[^<]*<\/step>\s*/gi, '').trim();
    // 兜底：把 LLM 偷懒输出的字面量 "\n"（两字符）替换成真换行；
    // 还有 \r\n 序列、行尾多余空格、多空行也一并整理
    scriptText = normalizeScriptWhitespace(scriptText);

    writer.phase('style_bible_start');
    writer.step('正在提取风格圣经…');
    let styleBible: any = null;
    try {
      styleBible = await chatCompleteJsonWithRetry(
        user,
        buildStyleBibleMessages(scriptText),
        { temperature: 0.4, maxTokens: 2500 },
        (raw) => parseJsonLoose(raw),
        'styleBible',
      );
    } catch (e: any) {
      console.warn('[full-create] styleBible failed after retries:', e?.message);
      styleBible = { visualStyle: '提取失败（请点击重新生成）', visualStyleDesc: '', colorPalette: [], era: '', mood: '', cameraStyle: '', worldRules: '' };
    }
    // 兜底：把 LLM 偷懒输出的英文色名翻成中文，避免前端展示 "TEAL · AMBER · CREAM" 这种
    styleBible = sinicizeColorPalette(styleBible);

    writer.phase('tag_emotions_start');
    writer.step('正在打情绪标签…');
    let emotions: any[] = [];
    try {
      const emoJson = await chatCompleteJsonWithRetry<{ emotions: any[] }>(
        user,
        buildRetagMessages(scriptText, durationSec || (proj as any)?.scriptTargetDurationSec),
        { temperature: 0.4, maxTokens: 1200 },
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
        styleBible,
        emotions,
        scriptApproved: false,
        scriptTargetDurationSec: durationSec || (proj as any).scriptTargetDurationSec || null,
        currentStep: 1,
      };
      // 修改模式不要覆盖 oneSentence —— 原创意要保留
      if (!isRevise) writePayload.oneSentence = finalSentence;
      updateProjectForUser(projectId, user.id, writePayload);
    }

    writer.done({
      script: scriptText,
      styleBible,
      // 前端 script.js 读 emotionSegments + durationSec
      emotionSegments: emotions,
      emotions,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec || null,
      title: extractTitle(scriptText, finalSentence),
    });
  });
}

function extractTitle(script: string, fallback: string): string {
  const firstLine = (script || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  if (firstLine.length > 0 && firstLine.length <= 40) return firstLine.replace(/^#+\s*/, '');
  return (fallback || '未命名项目').slice(0, 40);
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
