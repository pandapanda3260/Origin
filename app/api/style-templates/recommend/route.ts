import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  computeStyleTemplateAutoScriptKey,
  getRecordedStyleTemplateRecommendation,
  recommendStyleTemplateForScript,
  recommendStyleTemplateForWorld,
} from '@/lib/style-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const projectId = req.nextUrl.searchParams.get('projectId') || '';
  if (projectId) {
    const project = getProjectByIdForUser(projectId, user.id);
    if (!project) return jsonError('项目不存在', 404);
    const cached = getRecordedStyleTemplateRecommendation(user.id, project, {
      script: String((project as any).script || ''),
      worldTemplateSnapshot: (project as any).worldTemplateSnapshot || null,
    });
    if (cached) return jsonOk(cached);
    const result = await recommendStyleTemplateForScript(user, {
      script: String((project as any).script || ''),
      worldTemplateSnapshot: (project as any).worldTemplateSnapshot || null,
      projectId,
      projectTitleSnapshot: (project as any).title || null,
      requestPath: req.nextUrl.pathname,
      routeName: 'style-templates.recommend',
    });
    persistAutoRecommendationIfStillEligible(projectId, user.id, result);
    return jsonOk(result);
  }

  const script = req.nextUrl.searchParams.get('script') || req.nextUrl.searchParams.get('scriptText') || '';
  if (script.trim()) {
    const result = await recommendStyleTemplateForScript(user, { script });
    return jsonOk(result);
  }

  const worldTemplateId = req.nextUrl.searchParams.get('worldId') || req.nextUrl.searchParams.get('worldTemplateId') || '';
  const ownerRaw = req.nextUrl.searchParams.get('worldOwnerId') || req.nextUrl.searchParams.get('worldTemplateOwnerId') || '';
  const worldTemplateOwnerId = ownerRaw ? Number(ownerRaw) : undefined;
  const result = recommendStyleTemplateForWorld(user.id, { worldTemplateId, worldTemplateOwnerId });
  return jsonOk(result);
}

function persistAutoRecommendationIfStillEligible(projectId: string, userId: number, recommendation: any) {
  const template = recommendation?.styleTemplate;
  const templateId = String(template?.id || '').trim();
  if (!template || !templateId) return;

  try {
    patchProjectForUser(projectId, userId, (current: any) => {
      const cached = getRecordedStyleTemplateRecommendation(userId, current, {
        script: String(current?.script || ''),
        worldTemplateSnapshot: current?.worldTemplateSnapshot || null,
      });
      if (cached) return null;

      const styleOptions = { ...(current?.styleOptions || {}) };
      const recommendationSource = String(recommendation?.source || 'script_auto').trim() || 'script_auto';
      styleOptions.styleTemplateSelectionMode = 'auto';
      styleOptions.styleTemplateSelectionSource = recommendationSource;
      styleOptions.styleTemplateSelectedAt = new Date().toISOString();
      styleOptions.autoStyleTemplateId = templateId;
      styleOptions.autoStyleTemplateReason = String(recommendation.reason || '').slice(0, 300);
      styleOptions.autoStyleTemplateScriptKey = computeStyleTemplateAutoScriptKey({
        script: String(current?.script || ''),
        selectedWorldTemplateId: current?.selectedWorldTemplateId || '',
        worldTemplateSnapshot: current?.worldTemplateSnapshot || null,
      });
      delete styleOptions.selectedTemplateId;
      delete styleOptions.selectedTemplateName;
      delete styleOptions.templateStyleBibleSnapshot;
      delete styleOptions.userControls;

      return {
        selectedStyleTemplateId: templateId,
        styleTemplateSnapshot: template,
        styleOptions,
      };
    });
  } catch (error) {
    console.warn('[style-template-recommend] persist auto recommendation skipped:', error);
  }
}
