import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { shortKnowledgeHash } from '@/lib/knowledge/hash';
import { formatWorldContextForPrompt, projectWorldContextForStage } from '@/lib/world-template-context';
import { createEmptyEpisode, EPISODE_FIELDS, mirrorEpisodeFields } from '@/public/modules/episode_fields.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_EPISODE_CREATE = `你是短视频连续剧编剧。请基于前面分集继续创作下一集。
要求：
- 只输出新一集完整剧本，不要重写前几集
- 保持人物、世界观、悬念节奏和五段式短视频叙事
- 用中文，纯文本，不要 markdown 围栏
- 新一集应能独立进入后续资产、镜头、分镜流程`;

function cleanText(value: any): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function parseDurationSec(value: any): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.min(60 * 60, Math.round(value));
  const text = cleanText(value);
  if (!text) return null;
  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*(分钟|分|min|m)/i);
  if (minuteMatch) return Math.min(60 * 60, Math.round(Number(minuteMatch[1]) * 60));
  const secondMatch = text.match(/(\d+(?:\.\d+)?)\s*(秒|sec|s)/i);
  if (secondMatch) return Math.min(60 * 60, Math.round(Number(secondMatch[1])));
  const raw = Number(text);
  if (Number.isFinite(raw) && raw > 0) return Math.min(60 * 60, Math.round(raw));
  return null;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeEpisodeList(input: any, fallback: any): any[] {
  const source = Array.isArray(input) && input.length
    ? input
    : Array.isArray(fallback) && fallback.length
      ? fallback
      : [];
  return source
    .filter((ep) => ep && typeof ep === 'object')
    .map((ep, index) => ({
      ...clonePlain(ep),
      id: cleanText(ep.id) || `ep_${index + 1}`,
      title: cleanText(ep.title) || `第 ${index + 1} 集`,
    }));
}

function previousEpisodesText(episodes: any[], currentIdx: number): string {
  return episodes
    .slice(0, Math.max(0, currentIdx + 1))
    .map((ep, index) => {
      const title = cleanText(ep.title) || `第 ${index + 1} 集`;
      const script = cleanText(ep.scriptDraft || ep.script);
      return script ? `${title}：\n${script}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildEpisodePatch(project: any, episodes: any[], newEpisode: any, newIdx: number) {
  const mirrored = mirrorEpisodeFields({}, newEpisode);
  const patch: Record<string, any> = {
    ...mirrored,
    episodes,
    currentEpisodeIdx: newIdx,
  };
  for (const field of EPISODE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) {
      patch[field] = Object.prototype.hasOwnProperty.call(newEpisode, field) ? newEpisode[field] : null;
    }
  }
  return patch;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  if (!projectId) return new Response(JSON.stringify({ detail: 'projectId required' }), { status: 400 });

  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return new Response(JSON.stringify({ detail: '项目不存在' }), { status: 404 });

  const direction = cleanText(body.direction || body.hint);
  const sourceEpisodes = normalizeEpisodeList(body.episodes, (proj as any).episodes);
  const currentIdxRaw = Number(body.currentEpisodeIdx ?? (proj as any).currentEpisodeIdx ?? sourceEpisodes.length - 1);
  const currentIdx = Number.isFinite(currentIdxRaw)
    ? Math.max(0, Math.min(sourceEpisodes.length - 1, Math.round(currentIdxRaw)))
    : Math.max(0, sourceEpisodes.length - 1);
  const previousText = previousEpisodesText(sourceEpisodes, currentIdx);
  if (!previousText) return new Response(JSON.stringify({ detail: '没有可用于生成下一集的前集剧本' }), { status: 400 });

  const durationSec = parseDurationSec(body.durationSec) || parseDurationSec((proj as any).scriptTargetDurationSec);
  const newIdx = sourceEpisodes.length;
  const title = `第 ${newIdx + 1} 集`;

  return sseResponse(async (writer) => {
    writer.phase('episode_create_start');
    writer.step('正在生成续集剧本…');
    let buf = '';
    const worldContext = projectWorldContextForStage('episode_create', (proj as any).worldTemplateSnapshot, {
      project: proj,
      scriptText: previousText,
      target: { episodeIndex: newIdx, direction },
    });
    const worldText = formatWorldContextForPrompt(worldContext);
    await chatStream(
      user,
      [
        { role: 'system', content: SP_EPISODE_CREATE },
        {
          role: 'user',
          content: [
            `前情分集：\n${previousText}`,
            worldText ? `新一集参考的世界观事实与软默认：\n${worldText}` : '',
            durationSec ? `目标时长：约 ${durationSec} 秒` : '',
            direction ? `剧情方向：${direction}` : '剧情方向：延续前集悬念，自然推进下一集。',
            `请直接输出《${title}》的完整剧本。`,
          ].filter(Boolean).join('\n\n'),
        },
      ],
      { temperature: 0.82, maxTokens: 1800, modelRole: 'brain' },
      (delta) => {
        buf += delta;
        writer.scriptChunk(delta);
      },
    );

    const script = cleanText(buf);
    const newEpisode = {
      ...createEmptyEpisode({
        id: `ep_${Date.now()}`,
        title,
        scriptTargetDurationSec: durationSec,
      }),
      title,
      idea: direction || '续写自前集',
      script,
      scriptDraft: script,
      scriptTargetDurationSec: durationSec,
      scriptApproved: false,
      scriptReviewState: 'draft',
      emotionSegments: [],
      currentStep: 1,
    };
    const nextEpisodes = [...sourceEpisodes, newEpisode];
    const patch = buildEpisodePatch(proj, nextEpisodes, newEpisode, newIdx);
    const updated = updateProjectForUser(projectId, user.id, patch);
    if (!updated) throw new Error('项目不存在');

    try {
      const context = buildKnowledgeContextForStage({
        ownerId: user.id,
        project: {
          ...(updated as any),
          id: projectId,
        },
        stage: 'script_create',
        stageTarget: {
          mode: 'episode_create',
          episodeIndex: newIdx,
          previousEpisodesHash: shortKnowledgeHash(previousText),
          directionHash: direction ? shortKnowledgeHash(direction) : null,
          scriptHash: shortKnowledgeHash(script),
        },
      });
      recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context });
    } catch (error) {
      console.warn('[script/episode-create] knowledge context audit skipped:', error);
    }

    writer.done({
      episode: newEpisode,
      project: updated,
      currentEpisodeIdx: newIdx,
      script,
      emotionSegments: [],
      durationSec,
      title,
    });
  });
}
