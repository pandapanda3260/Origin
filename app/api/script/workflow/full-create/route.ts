import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, chatComplete, chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import {
  buildFullCreateMessages,
  buildStyleBibleMessages,
  buildRetagMessages,
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
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const oneSentence: string = (body.oneSentence || body.idea || body.text || '').toString();
  const durationSec: number | undefined = body.durationSec || body.targetDurationSec;
  const audience: string | undefined = body.audience;

  return sseResponse(async (writer) => {
    writer.step('正在生成剧本…');
    const persona = user ? (getJson('user_profiles', user.id, null) as any) : null;
    const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
    const finalSentence = oneSentence || (proj as any)?.oneSentence || '';

    if (!finalSentence) {
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
        reason: 'script.full-create',
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
    const messages = buildFullCreateMessages({
      oneSentence: finalSentence,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
      audience,
      creatorPersona: persona,
    });
    await chatStream(user, messages, { temperature: 0.8, maxTokens: 3000 }, (delta) => {
      scriptText += delta;
      writer.scriptChunk(delta);
    });

    // 兜底：如果 LLM 还是输出了 <step> 标签，剥掉
    scriptText = scriptText.replace(/<step>[^<]*<\/step>\s*/gi, '').trim();

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
      updateProjectForUser(projectId, user.id, {
        oneSentence: finalSentence,
        scriptDraft: scriptText,
        script: scriptText,
        styleBible,
        emotions,
        scriptApproved: false,
        scriptTargetDurationSec: durationSec || (proj as any).scriptTargetDurationSec || null,
        currentStep: 1,
      });
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
