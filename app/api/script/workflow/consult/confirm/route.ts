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
import { sinicizeColorPalette } from '@/lib/style-bible';

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

    let scriptText = '';
    const scriptMessages = buildFullCreateMessages({
      oneSentence,
      outline,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
      audience,
      creatorPersona: persona,
    });
    await chatStream(user, scriptMessages, { temperature: 0.8, maxTokens: 3000 }, (delta) => {
      scriptText += delta;
      writer.scriptChunk(delta);
    });

    // 兜底：如果 LLM 还是输出了 <step> 标签，剥掉
    scriptText = scriptText.replace(/<step>[^<]*<\/step>\s*/gi, '').trim();

    // === 2. 提取风格圣经（非流式 JSON，带 3 次重试）===
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
      console.warn('[consult/confirm] styleBible failed after retries:', e?.message);
      styleBible = {
        visualStyle: '提取失败（请点击重新生成）',
        visualStyleDesc: '',
        colorPalette: [],
        era: '',
        mood: '',
        cameraStyle: '',
        worldRules: '',
        _error: e?.message || String(e),
      };
    }
    styleBible = sinicizeColorPalette(styleBible);

    // === 3. 情绪标记（非流式 JSON，带 3 次重试）===
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
      console.warn('[consult/confirm] emotions failed after retries:', e?.message);
    }

    // === 4. 写回项目 ===
    if (projectId && proj) {
      updateProjectForUser(projectId, user.id, {
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
      // 前端 script.js 读 emotionSegments；同时保留 emotions 便于其它老调用方
      emotionSegments: emotions,
      emotions,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec || null,
    });
  });
}
