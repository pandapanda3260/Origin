import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, chatComplete, parseJsonLoose } from '@/lib/llm';
import {
  buildFullCreateMessages,
  buildStyleBibleMessages,
  buildRetagMessages,
} from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { getJson } from '@/lib/kv-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const oneSentence: string = (body.oneSentence || '').toString();
  const outline: string = (body.outline || '').toString();
  const durationSec: number | undefined = body.durationSec || body.targetDurationSec;
  const audience: string | undefined = body.audience;

  return sseResponse(async (writer) => {
    // === 1. 生成剧本（流式）===
    writer.step('正在生成剧本…');
    const persona = user ? (getJson('user_profiles', user.id, null) as any) : null;
    const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;

    let scriptText = '';
    const scriptMessages = buildFullCreateMessages({
      oneSentence: oneSentence || (proj as any)?.oneSentence || '',
      outline,
      durationSec: durationSec || (proj as any)?.scriptTargetDurationSec,
      audience,
      creatorPersona: persona,
    });
    await chatStream(user, scriptMessages, { temperature: 0.8, maxTokens: 3000 }, (delta) => {
      scriptText += delta;
      writer.chunk(delta);
    });

    // === 2. 提取风格圣经（非流式 JSON）===
    writer.step('正在提取风格圣经…');
    let styleBible: any = null;
    try {
      const sbRaw = await chatComplete(user, buildStyleBibleMessages(scriptText), {
        temperature: 0.4,
        responseFormat: 'json_object',
        maxTokens: 800,
      });
      styleBible = parseJsonLoose(sbRaw);
    } catch (e: any) {
      console.warn('[consult/confirm] styleBible failed:', e?.message);
      styleBible = {
        vision: '',
        colorPalette: '',
        fashion: '',
        mood: '',
        cameraStyle: '',
        worldRules: '',
        _error: e?.message || String(e),
      };
    }

    // === 3. 情绪标记（非流式 JSON）===
    writer.step('正在打情绪标签…');
    let emotions: any[] = [];
    try {
      const emoRaw = await chatComplete(
        user,
        buildRetagMessages(scriptText, durationSec || (proj as any)?.scriptTargetDurationSec),
        { temperature: 0.4, responseFormat: 'json_object', maxTokens: 800 },
      );
      const emoJson = parseJsonLoose<{ emotions: any[] }>(emoRaw);
      emotions = Array.isArray(emoJson?.emotions) ? emoJson.emotions : [];
    } catch (e: any) {
      console.warn('[consult/confirm] emotions failed:', e?.message);
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
      emotions,
    });
  });
}
