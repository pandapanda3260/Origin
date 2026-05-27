import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { getProjectByIdForUser } from '@/lib/projects-db';
import {
  validateRefineOutput,
} from '@/lib/knowledge/refine-output-guard';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { prepareVideoPromptRefineMessagesWithKnowledge } from '@/lib/knowledge/video-prompt-refine-injection';
import { artifactUsageBlockedPayload, describeArtifactStatus } from '@/lib/sentinel';
import { applyBlockerFilter } from '@/lib/batch-preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const currentPrompt: string = (body.currentPrompt || body.prompt || '').toString();
  const instruction: string = (body.instruction || body.intent || '').toString();
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const groupIdx = Number.isInteger(body.groupIdx) ? Number(body.groupIdx) : null;
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  if (!currentPrompt || !instruction) {
    return new Response(JSON.stringify({ detail: '缺 currentPrompt 或 instruction' }), { status: 400 });
  }
  if (projectId && !project) {
    return new Response(JSON.stringify({ detail: '项目不存在' }), { status: 404 });
  }
  if (projectId && project && groupIdx != null) {
    const decision = applyBlockerFilter(describeArtifactStatus(project as any, {
      projectId,
      targetArtifact: 'video_prompt',
      groupIdx,
      consumerOperation: 'video_prompt_refine',
    }));
    if (decision.usability === 'BLOCKED') {
      return Response.json(artifactUsageBlockedPayload(decision), { status: 409 });
    }
  }
  let prepared: ReturnType<typeof prepareVideoPromptRefineMessagesWithKnowledge>;
  if (projectId && project) {
    try {
      prepared = prepareVideoPromptRefineMessagesWithKnowledge({
        ownerId: user.id,
        projectId,
        project: project as any,
        groupIdx,
        currentPrompt,
        instruction,
        referenceManifest: body.referenceManifest,
        guardMode: body.guardMode,
      });
    } catch (error) {
      console.warn('[video-prompt/refine] knowledge context injection skipped:', error);
      prepared = prepareVideoPromptRefineMessagesWithKnowledge({
        ownerId: user.id,
        projectId: null,
        project: null,
        groupIdx,
        currentPrompt,
        instruction,
        referenceManifest: body.referenceManifest,
        guardMode: body.guardMode,
      });
    }
  } else {
    prepared = prepareVideoPromptRefineMessagesWithKnowledge({
      ownerId: user.id,
      projectId: null,
      project: null,
      groupIdx,
      currentPrompt,
      instruction,
      referenceManifest: body.referenceManifest,
      guardMode: body.guardMode,
    });
  }
  const { messages: finalMessages, knowledgeContext, guardFacts, guardMode } = prepared;

  return sseResponse(async (writer) => {
    writer.step('正在微调提示词…');
    let buf = '';
    try {
      await chatStream(
        user,
        finalMessages,
        {
          temperature: 0.5,
          maxTokens: 1500,
          modelRole: 'structured',
          traceName: 'video-prompt.refine',
          tokenContext: {
            projectId: projectId || null,
            projectTitleSnapshot: (project as any)?.title || null,
            requestPath: req.nextUrl.pathname,
            routeName: 'video-prompt.refine',
            moduleKey: 'video_prompt',
            moduleLabel: '视频提示词',
            featureKey: 'video_prompt_refine',
            featureLabel: '视频提示词微调',
            callItemType: 'storyboard_group',
            callItemId: groupIdx == null ? null : String(groupIdx),
            callItemLabel: groupIdx == null ? null : `分镜组 ${groupIdx + 1}`,
          },
        },
        (delta) => {
          buf += delta;
          writer.chunk(delta);
        },
      );
    } catch (e: any) {
      writer.error('微调失败：' + (e?.message || String(e)));
      return;
    }
    const refined = buf.trim();
    if (!refined) {
      writer.error('AI 没有返回提示词，请稍后重试');
      return;
    }
    const guard = guardMode === 'off'
      ? { accepted: true, violations: [] }
      : validateRefineOutput({
          originalPrompt: currentPrompt,
          refinedPrompt: refined,
          facts: guardFacts,
        });
    if (projectId && project && knowledgeContext) {
      try {
        const stageTarget = {
          ...knowledgeContext.stageTarget,
          accepted: guard.accepted,
          violationTypes: guard.violations.map((item) => item.type),
        };
        const auditContext = {
          ...knowledgeContext,
          stageTarget,
          structured: {
            ...knowledgeContext.structured,
            stageTarget,
          },
        };
        recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: auditContext });
      } catch (error) {
        console.warn('[video-prompt/refine] knowledge context audit skipped:', error);
      }
    }
    writer.done({
      videoPrompt: refined,
      accepted: guard.accepted,
      violations: guard.violations,
      previousPrompt: currentPrompt,
      guardMode,
    });
  });
}
