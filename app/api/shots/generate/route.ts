import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import { buildShotsMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { pickSceneForShots } from '@/lib/scene-selection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FRAMINGS = ['大全景','远景','全景','中景','中近景','近景','特写','大特写','俯拍','仰拍','主观镜头','过肩镜头','广角全景'];
const MOVEMENTS = ['固定镜头','缓慢推进','轻微推近','推近','快速推进','缓慢拉远','拉远','快速拉远','跟随','环绕','手持轻晃','甩镜头','摇镜头','固定机位','推','拉','摇','跟','航拍','手持','轨道'];

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const scriptText: string = (body.script || '').toString();
  const totalDurationSec: number | undefined = body.durationSec || body.totalDurationSec;

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const finalScript = scriptText || (proj as any)?.scriptDraft || (proj as any)?.script || '';
  if (!finalScript) {
    return new Response(JSON.stringify({ detail: '当前没有剧本可分析' }), { status: 400 });
  }

  return sseResponse(async (writer) => {
    writer.step('正在设计镜头…');
    writer.chunk('分析剧本节奏与情绪曲线…\n');

    let shots: any[] = [];
    const assetsForShots = {
      characters: (proj as any)?.characters || (proj as any)?.assets?.characters || [],
      environments: (proj as any)?.environments || (proj as any)?.assets?.scenes || [],
      props: (proj as any)?.props || (proj as any)?.assets?.props || [],
    };
    try {
      const json = await chatCompleteJsonWithRetry<{ shots: any[] }>(
        user,
        buildShotsMessages({
          script: finalScript,
          styleBible: (proj as any)?.styleBible,
          assets: assetsForShots,
          totalDurationSec: totalDurationSec || (proj as any)?.scriptTargetDurationSec,
        }),
        { temperature: 0.5, maxTokens: 3500, modelRole: 'structured' },
        parseJsonLoose,
        'shots.generate',
      );
      shots = Array.isArray(json?.shots) ? json.shots : [];
    } catch (e: any) {
      writer.error('镜头表生成失败：' + (e?.message || String(e)));
      return;
    }

    // 后处理：保证字段齐全 + 枚举值合法
    shots = shots.map((s, i) => {
      const description = String(s.visual || s.description || '').slice(0, 300);
      const pickedScene = pickSceneForShots({
        assets: assetsForShots,
        shots: [s],
        text: [
          s.sceneId,
          s.sceneName,
          s.scene,
          s.location,
          s.visual,
          s.description,
          s.desc,
          s.scriptRef,
        ].filter(Boolean).join(' '),
      });
      const sceneId = String(pickedScene.scene?.id || pickedScene.scene?.sceneId || s.sceneId || '').trim();
      const sceneName = String(
        pickedScene.scene?.name ||
          pickedScene.scene?.sceneName ||
          pickedScene.scene?.location ||
          s.sceneName ||
          s.scene ||
          s.location ||
          '',
      ).trim();
      return {
        idx: typeof s.idx === 'number' ? s.idx : i + 1,
        sceneId,
        sceneName,
        scene: sceneName,
        durationSec: clampNum(s.duration ?? s.durationSec, 1, 12, 4),
        framing: pickEnum(s.shotType ?? s.framing, FRAMINGS, '中景'),
        movement: pickEnum(s.camera ?? s.movement, MOVEMENTS, '固定镜头'),
        description,
        dialog: String(s.dialogue || s.dialog || '——'),
        stylePillar: String(s.keyInfo || s.stylePillar || '').slice(0, 30),
      };
    });

    writer.step(`已生成 ${shots.length} 个镜头`);

    if (projectId && proj) {
      updateProjectForUser(projectId, user.id, {
        shots,
        shotsApproved: false,
        currentStep: 3,
      });
    }

    writer.done({ shots });
  });
}

function clampNum(v: any, min: number, max: number, dflt: number) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pickEnum(v: any, list: string[], dflt: string) {
  const s = String(v || '').trim();
  return list.includes(s) ? s : dflt;
}
