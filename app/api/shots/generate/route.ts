import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import { buildShotsMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { makeSingleShotStoryboardSlots, maybeAssertStoryboardsAlignedWithShots } from '@/lib/frame-workflow-state';
import { hashNormalizedScript } from '@/lib/script-style-state';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { maybeInjectKnowledgePromptBlock } from '@/lib/knowledge/inject-messages';
import type { KnowledgeContextForStage } from '@/lib/knowledge/types';
import { computeShotPlanSourceHash, computeShotPlanSourceSnapshot } from '@/lib/project-dependency-state';
import { normalizeGeneratedShotPlan } from '@/lib/shot-plan-normalize';
import { projectWorldContextForStage } from '@/lib/world-template-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    let planMeta: any = null;
    const assetsForShots = {
      characters: (proj as any)?.characters || (proj as any)?.assets?.characters || [],
      environments: (proj as any)?.environments || (proj as any)?.assets?.scenes || [],
      props: (proj as any)?.props || (proj as any)?.assets?.props || [],
    };
    const scriptHash = hashNormalizedScript(finalScript);
    let knowledgeContext: KnowledgeContextForStage | null = null;
    const worldContext = projectWorldContextForStage('shots_generate', (proj as any)?.worldTemplateSnapshot, {
      project: proj,
      scriptText: finalScript,
    });
    const originalMessages = buildShotsMessages({
      script: finalScript,
      styleBible: (proj as any)?.styleBible,
      assets: assetsForShots,
      totalDurationSec: totalDurationSec || (proj as any)?.scriptTargetDurationSec,
      worldContext,
    });
    let finalMessages = originalMessages;
    if (projectId && proj) {
      try {
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(proj as any),
            id: projectId,
          },
          stage: 'shots_generate',
          stageTarget: {
            scriptHash,
            totalDurationSec: totalDurationSec || (proj as any)?.scriptTargetDurationSec || null,
            assetCounts: {
              characters: assetsForShots.characters.length,
              environments: assetsForShots.environments.length,
              props: assetsForShots.props.length,
            },
          },
        });
        const injected = maybeInjectKnowledgePromptBlock({ messages: originalMessages, context });
        finalMessages = injected.messages;
        knowledgeContext = injected.context;
      } catch (error) {
        console.warn('[shots/generate] knowledge context injection skipped:', error);
      }
    }
    try {
      const json = await chatCompleteJsonWithRetry<{ shots: any[] }>(
        user,
        finalMessages,
        {
          temperature: 0.5,
          maxTokens: 3500,
          modelRole: 'structured',
          tokenContext: {
            projectId: projectId || null,
            projectTitleSnapshot: (proj as any)?.title || null,
            requestPath: req.nextUrl.pathname,
            routeName: 'shots.generate',
            moduleKey: 'shots',
            moduleLabel: '镜头规划',
            featureKey: 'shot_plan_generate',
            featureLabel: '镜头表生成',
            callItemType: 'project',
            callItemId: projectId || null,
            callItemLabel: (proj as any)?.title || null,
          },
        },
        parseJsonLoose,
        'shots.generate',
      );
      shots = Array.isArray(json?.shots) ? json.shots : [];
    } catch (e: any) {
      writer.error('镜头表生成失败：' + (e?.message || String(e)));
      return;
    }

    const generatedAt = new Date().toISOString();
    const normalizedPlan = normalizeGeneratedShotPlan(shots, {
      assets: assetsForShots,
      styleBible: (proj as any)?.styleBible,
      generatedAt,
    });
    shots = normalizedPlan.shots;
    planMeta = normalizedPlan.planMeta;
    if (!shots.length) {
      writer.error('镜头表生成失败：AI 返回的镜头都没有内容，请稍后重试或换个剧本');
      return;
    }

    writer.step(`已生成 ${shots.length} 个镜头`);

    if (projectId && proj) {
      const storyboards = makeSingleShotStoryboardSlots(shots);
      const projectForHash = {
        ...(proj as any),
        script: finalScript,
        ...(totalDurationSec != null ? { scriptTargetDurationSec: totalDurationSec } : {}),
      };
      const sourceSnapshot = computeShotPlanSourceSnapshot(projectForHash);
      const sourceHash = computeShotPlanSourceHash(projectForHash);
      const staleFlags = { ...(((proj as any)._staleFlags || {}) as Record<string, any>) };
      Object.keys(staleFlags).forEach((key) => {
        if (
          key === 'shotPlan' ||
          key.startsWith('storyboard_') ||
          key.startsWith('video_prompt_') ||
          key.startsWith('shot_prompt_') ||
          key.startsWith('tail_frame_') ||
          key.startsWith('shot_')
        ) {
          delete staleFlags[key];
        }
      });
      maybeAssertStoryboardsAlignedWithShots(
        { ...(proj as any), shots, storyboards, videoTasks: [] },
        'shots-generate-route',
      );
      updateProjectForUser(projectId, user.id, {
        shots,
        planMeta,
        shotsApproved: false,
        imagesApproved: false,
        videoPromptsApproved: false,
        storyboards,
        videoTasks: [],
        currentStep: 3,
        _staleFlags: staleFlags,
        shotPlanStatus: 'ready',
        shotPlanSourceHash: sourceHash,
        shotPlanSourceSnapshot: sourceSnapshot,
        shotPlanGeneratedAt: generatedAt,
        shotPlanStaleReason: undefined,
        shotPlanStaleReasons: [],
        shotPlanStaleAt: undefined,
        shotPlanLastError: undefined,
        shotPlanFailedAt: undefined,
      });
      try {
        if (knowledgeContext) recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: knowledgeContext });
      } catch (error) {
        console.warn('[shots/generate] knowledge context audit skipped:', error);
      }
    }

    writer.done({ shots, planMeta });
  });
}
