import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildVideoPromptMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import {
  VIDEO_REFERENCE_IMAGE_BUDGET,
  type ReferenceManifestItem,
  type VideoReferenceRole,
} from '@/lib/video-reference-manifest';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from '@/lib/video-prompt-state';
import { validateCharacterConsistencyForGroup } from '@/lib/character-consistency-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function compactText(value: unknown): string {
  return String(value || '').trim();
}

function roleDefaults(role: VideoReferenceRole): Pick<ReferenceManifestItem, 'useFor' | 'immutable' | 'promptHint'> {
  if (role === 'first_frame') {
    return {
      useFor: ['锁定第 0 帧开场构图', '光照', '主体位置', '画面比例', '色调基准'],
      immutable: ['构图', '光照方向', '主体站位', '画面比例'],
      promptHint: '角色身份由 character reference 锁定，场景细节由 scene reference 锁定。',
    };
  }
  if (role === 'scene') {
    return {
      useFor: ['锁定环境布局', '空间结构', '材质', '氛围'],
      immutable: ['场景类型', '道路/地形结构', '主色调', '主要空间关系'],
    };
  }
  if (role === 'character') {
    return {
      useFor: ['锁定角色脸部', '体型', '服装', '物种特征'],
      immutable: ['脸型', '毛发/发色', '服装颜色', '身体类型'],
    };
  }
  return {
    useFor: ['锁定道具材质', '颜色', '尺度', '识别特征'],
    immutable: ['核心形状', '主色', '材质', '用途'],
  };
}

function normalizeRole(value: unknown): VideoReferenceRole | null {
  const role = compactText(value);
  if (role === 'first_frame' || role === 'scene' || role === 'character' || role === 'prop') return role;
  return null;
}

function buildReferenceManifestFromRequest(body: any, groupIdx: number): ReferenceManifestItem[] {
  if (Array.isArray(body?.referenceManifest) && body.referenceManifest.length) {
    return body.referenceManifest
      .slice(0, VIDEO_REFERENCE_IMAGE_BUDGET)
      .map((item: any, idx: number) => ({
        imageNo: idx + 1,
        role: normalizeRole(item?.role) || 'prop',
        assetId: compactText(item?.assetId) || undefined,
        assetName: compactText(item?.assetName) || undefined,
        label: compactText(item?.label || item?.assetName || `reference image ${idx + 1}`),
        url: compactText(item?.url),
        useFor: Array.isArray(item?.useFor) ? item.useFor.map(compactText).filter(Boolean) : roleDefaults(normalizeRole(item?.role) || 'prop').useFor,
        immutable: Array.isArray(item?.immutable) ? item.immutable.map(compactText).filter(Boolean) : roleDefaults(normalizeRole(item?.role) || 'prop').immutable,
        promptHint: compactText(item?.promptHint) || roleDefaults(normalizeRole(item?.role) || 'prop').promptHint,
      }))
      .filter((item: ReferenceManifestItem) => item.url);
  }

  const assetRefs = Array.isArray(body?.assetRefs) ? body.assetRefs : [];
  if (assetRefs.length) {
    return assetRefs
      .slice(0, VIDEO_REFERENCE_IMAGE_BUDGET)
      .map((ref: any, idx: number) => {
        const role = normalizeRole(ref?.role || ref?.type) || 'prop';
        const defaults = roleDefaults(role);
        return {
          imageNo: idx + 1,
          role,
          assetId: compactText(ref?.assetId) || undefined,
          assetName: compactText(ref?.assetName || ref?.name) || undefined,
          label: compactText(ref?.label || ref?.assetName || ref?.name || `${role} reference`),
          url: compactText(ref?.url),
          localPath: compactText(ref?.localPath) || undefined,
          useFor: Array.isArray(ref?.useFor) ? ref.useFor.map(compactText).filter(Boolean) : defaults.useFor,
          immutable: Array.isArray(ref?.immutable) ? ref.immutable.map(compactText).filter(Boolean) : defaults.immutable,
          promptHint: compactText(ref?.promptHint) || defaults.promptHint,
          priority: Number.isFinite(Number(ref?.priority)) ? Number(ref.priority) : undefined,
          matchReason: compactText(ref?.matchReason) || undefined,
          score: Number.isFinite(Number(ref?.score)) ? Number(ref.score) : undefined,
          panelInfo: ref?.panelInfo && typeof ref.panelInfo === 'object'
            ? {
                panel: compactText(ref.panelInfo.panel),
                intent: compactText(ref.panelInfo.intent),
              }
            : undefined,
        };
      })
      .filter((item: ReferenceManifestItem) => item.url);
  }

  const manifest: ReferenceManifestItem[] = [];
  const storyboardImageUrl = compactText(body?.storyboardImageUrl);
  if (storyboardImageUrl) {
    manifest.push({
      imageNo: 1,
      role: 'first_frame',
      label: `segment ${groupIdx + 1} first frame`,
      url: storyboardImageUrl,
      ...roleDefaults('first_frame'),
    });
  }

  for (const ref of assetRefs) {
    if (manifest.length >= VIDEO_REFERENCE_IMAGE_BUDGET) break;
    const role = normalizeRole(ref?.role || ref?.type);
    if (!role || role === 'first_frame') continue;
    const url = compactText(ref?.url);
    if (!url || manifest.some((item) => item.url === url)) continue;
    const defaults = roleDefaults(role);
    manifest.push({
      imageNo: manifest.length + 1,
      role,
      assetId: compactText(ref?.assetId) || undefined,
      assetName: compactText(ref?.assetName || ref?.name) || undefined,
      label: compactText(ref?.label || ref?.assetName || ref?.name || `${role} reference`),
      url,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: compactText(ref?.promptHint) || defaults.promptHint,
    });
  }

  return manifest.map((item, idx) => ({ ...item, imageNo: idx + 1 }));
}

/**
 * 按 group（多个连贯镜头）流式生成视频提示词。
 * 入参对齐原站前端 modules/videoPrompts.js 的 generateGroupVideoPrompt：
 *   { shots, shotIndices, styleBible, assets, narrations, allGroupsShots, allGroupsShotIndices,
 *     groupIdx, totalGroups, storyboardImageUrl, imageUrls, projectId? }
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const shots: any[] = Array.isArray(body.shots) ? body.shots : [];
  const styleBible: any = body.styleBible || {};
  const assets: any = body.assets || {};
  const narrations: any[] = Array.isArray(body.narrations) ? body.narrations : [];
  const groupIdx: number = Number.isInteger(body.groupIdx) ? body.groupIdx : 0;
  const totalGroups: number = Number.isInteger(body.totalGroups) ? body.totalGroups : 1;
  const referenceManifest = buildReferenceManifestFromRequest(body, groupIdx);
  const droppedReferences = Array.isArray(body.droppedReferences) ? body.droppedReferences : [];
  const promptRunId = compactText(body.videoPromptRunId) || randomUUID();
  // 用户反馈：videoPrompt 的内容跟 storyboards[i].shotIndices 对不上→视频段
  // 阶段抓不准本组对应的 shot.dialogue。这里把前端传过来的 shotIndices 和
  // 实际入参的 shots 一并落库，video_segments executor 才能拿到正确映射。
  const shotIndices: number[] = Array.isArray(body.shotIndices)
    ? body.shotIndices.filter((x: any) => Number.isInteger(x))
    : [];

  if (!shots.length) {
    return new Response(JSON.stringify({ detail: '本组没有镜头' }), { status: 400 });
  }

  return sseResponse(async (writer) => {
    writer.step(`正在生成第 ${groupIdx + 1}/${totalGroups} 组提示词…`);
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (proj) {
        const gate = validateCharacterConsistencyForGroup(proj as any, {
          groupIdx,
          shotIndices,
          target: 'videoPrompt',
        });
        if (!gate.allowed) {
          writer.error(`角色一致性未通过：${gate.blockers.map((b) => b.message).join('；')}`);
          return;
        }
        const storyboards = Array.isArray((proj as any).storyboards) ? [...(proj as any).storyboards] : [];
        while (storyboards.length <= groupIdx) storyboards.push({});
        const now = new Date().toISOString();
        storyboards[groupIdx] = {
          ...markStoryboardVideoOutdated(storyboards[groupIdx] || {}, 'video_prompt_regeneration', now),
          videoPromptStatus: 'generating',
          videoPromptRunId: promptRunId,
          videoPromptStartedAt: now,
          videoPromptLastError: undefined,
          videoPromptFailedAt: undefined,
        };
        const videoTasks = Array.isArray((proj as any).videoTasks) ? [...(proj as any).videoTasks] : [];
        if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
          videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration', now);
        }
        updateProjectForUser(projectId, user.id, { storyboards, videoTasks });
      }
    }

    let prompt = '';
    try {
      await chatStream(
        user,
        buildVideoPromptMessages({ shots, styleBible, assets, narrations, referenceManifest, groupIdx, totalGroups }),
        { temperature: 0.7, maxTokens: 1800, modelRole: 'brain' },
        (delta) => {
          prompt += delta;
          writer.chunk(delta);
        },
      );
    } catch (e: any) {
      if (projectId) {
        const proj = getProjectByIdForUser(projectId, user.id);
        if (proj) {
          const storyboards = Array.isArray((proj as any).storyboards) ? [...(proj as any).storyboards] : [];
          while (storyboards.length <= groupIdx) storyboards.push({});
          const prev = storyboards[groupIdx] || {};
          if (!prev.videoPromptRunId || prev.videoPromptRunId === promptRunId) {
            const now = new Date().toISOString();
            storyboards[groupIdx] = {
              ...markStoryboardVideoOutdated(prev, 'video_prompt_failed', now),
              videoPromptStatus: 'failed',
              videoPromptRunId: promptRunId,
              videoPromptFailedAt: now,
              videoPromptLastError: (e?.message || String(e)).slice(0, 500),
            };
            const videoTasks = Array.isArray((proj as any).videoTasks) ? [...(proj as any).videoTasks] : [];
            if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
              videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_failed', now);
            }
            updateProjectForUser(projectId, user.id, { storyboards, videoTasks });
          }
        }
      }
      writer.error('视频提示词生成失败：' + (e?.message || String(e)));
      return;
    }

    // 写回到对应 storyboard group 的 videoPrompt + shotIndices
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (proj) {
        const gate = validateCharacterConsistencyForGroup(proj as any, {
          groupIdx,
          shotIndices,
          target: 'videoPrompt',
        });
        const storyboards = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards : [];
        const patch: any = {
          videoPrompt: prompt,
          videoPromptStatus: 'ready',
          videoPromptRunId: promptRunId,
          videoPromptUpdatedAt: new Date().toISOString(),
          videoPromptLastError: undefined,
          videoPromptFailedAt: undefined,
          _vpCache: null,
          videoReferenceManifest: referenceManifest,
          videoReferenceDropped: droppedReferences,
          consistency: {
            ...((storyboards[groupIdx] || {}).consistency || {}),
            videoPrompt: {
              characterUsages: gate.characterUsages,
              score: gate.score,
              level: gate.level,
              warnings: gate.warnings,
            },
          },
        };
        if (shotIndices.length) patch.shotIndices = shotIndices;
        if (storyboards[groupIdx]) {
          if (storyboards[groupIdx].videoPromptRunId && storyboards[groupIdx].videoPromptRunId !== promptRunId) {
            writer.error('视频提示词生成结果已过期：该片段已有更新的生成任务');
            return;
          }
          storyboards[groupIdx] = {
            ...markStoryboardVideoOutdated(storyboards[groupIdx], 'video_prompt_regeneration'),
            ...patch,
          };
        } else {
          while (storyboards.length <= groupIdx) storyboards.push({});
          storyboards[groupIdx] = patch;
        }
        const videoTasks = Array.isArray((proj as any).videoTasks) ? [...(proj as any).videoTasks] : [];
        if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
          videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration');
        }
        updateProjectForUser(projectId, user.id, { storyboards, videoTasks });
      }
    }

    writer.done({
      videoPrompt: prompt,
      narrationsUsed: narrations,
      referenceManifest,
      droppedReferences,
      groupIdx,
      videoPromptStatus: 'ready',
      videoPromptRunId: promptRunId,
    });
  });
}
