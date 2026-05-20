import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { getStyleTemplateForUser } from '@/lib/style-templates-db';
import { getWorldTemplate } from '@/lib/world-templates-db';
import { shortKnowledgeHash, stableKnowledgeValue } from '@/lib/knowledge/hash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAGE_LABELS: Record<string, string> = {
  script_create: '剧本生成',
  style_bible: '风格圣经',
  assets_extract: '资产抽取',
  shots_generate: '镜头设计',
  storyboard_sketch_prompt: '分镜草图',
  first_frame_image: '首帧图',
  tail_frame_image: '尾帧图',
  video_prompt: '视频提示词',
  video_prompt_refine: '提示词精修',
  video_submit: '视频生成',
  edit_analyze: '剪辑分析',
  edit_edl: '剪辑方案',
  export: '导出',
};

const HASH_OMIT_KEYS = new Set([
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'migrationKey',
  'summaryOnly',
]);

function cleanText(value: any, max = 400) {
  return String(value || '').trim().slice(0, max);
}

function cleanList(value: any, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, 120)).filter(Boolean).slice(0, max);
}

function publicStyleBible(styleBible: any) {
  const sb = styleBible && typeof styleBible === 'object' ? styleBible : {};
  return {
    vision: cleanText(sb.vision || sb.visualStyle || sb.visual_style, 800),
    narrative: cleanText(sb.narrative, 800),
    camera: cleanText(sb.camera || sb.cameraStyle || sb.camera_style, 800),
    mood: cleanText(sb.mood, 500),
    aspectRatio: cleanText(sb.aspectRatio, 40),
    editingRhythm: cleanText(sb.editingRhythm || sb.editing_rhythm, 300),
  };
}

function publicCharacterLock(lock: any) {
  const identity = lock?.identityLock || {};
  const visual = lock?.visualLock || {};
  const performance = lock?.performanceLock || {};
  const voice = lock?.voiceLock || {};
  const reference = lock?.referenceLock || {};
  return {
    characterId: cleanText(lock?.characterId || lock?.sourceAssetId || lock?.canonicalName, 120),
    canonicalName: cleanText(lock?.canonicalName, 120),
    aliases: cleanList(lock?.aliases, 8),
    status: cleanText(lock?.status, 40),
    identityLock: {
      role: cleanText(identity.role, 160),
      identity: cleanText(identity.identity, 300),
      entityType: cleanText(identity.entityType, 40),
    },
    visualLock: {
      appearance: cleanText(visual.appearance, 500),
      clothing: cleanText(visual.clothing, 300),
      equipment: cleanText(visual.equipment, 300),
      signatureColors: cleanList(visual.signatureColors, 8),
    },
    performanceLock: {
      temperament: cleanText(performance.temperament, 240),
      actionTraits: cleanText(performance.actionTraits, 300),
    },
    voiceLock: {
      voiceGender: cleanText(voice.voiceGender, 80),
      voiceAge: cleanText(voice.voiceAge, 80),
      timbre: cleanText(voice.timbre, 160),
      speechStyle: cleanText(voice.speechStyle, 160),
      accent: cleanText(voice.accent, 120),
    },
    referenceLock: {
      referenceStatus: cleanText(reference.referenceStatus, 80),
      qualityScore: Number.isFinite(Number(reference.qualityScore)) ? Number(reference.qualityScore) : null,
    },
  };
}

function stableForDrift(value: any): any {
  if (Array.isArray(value)) return value.map(stableForDrift);
  if (!value || typeof value !== 'object') return value ?? null;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (HASH_OMIT_KEYS.has(key)) continue;
    const item = value[key];
    if (typeof item === 'undefined') continue;
    out[key] = stableForDrift(item);
  }
  return stableKnowledgeValue(out);
}

function driftInfo(snapshot: any, source: any) {
  const snapshotHash = snapshot ? shortKnowledgeHash(stableForDrift(snapshot), 12) : null;
  const sourceHash = source ? shortKnowledgeHash(stableForDrift(source), 12) : null;
  return {
    hasSnapshot: !!snapshot,
    hasSource: !!source,
    isDrifted: !!snapshotHash && !!sourceHash && snapshotHash !== sourceHash,
  };
}

function templateId(snapshot: any) {
  return cleanText(snapshot?.id || snapshot?.templateId || snapshot?.template_id, 120);
}

function listRecentStageSummaries(ownerId: number, projectId: string) {
  const rows = getDb().prepare(
    `SELECT stage,
            provider,
            stage_target_json AS stageTargetJson,
            rule_card_ids_json AS ruleCardIdsJson,
            updated_at AS updatedAt
       FROM project_knowledge_contexts
      WHERE owner_id = ?
        AND project_id = ?
      ORDER BY updated_at DESC
      LIMIT 300`,
  ).all(ownerId, projectId) as any[];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const row of rows) {
    if (seen.has(row.stage)) continue;
    seen.add(row.stage);
    let ruleCardIds: any[] = [];
    try { ruleCardIds = JSON.parse(row.ruleCardIdsJson || '[]'); } catch { ruleCardIds = []; }
    out.push({
      stage: row.stage,
      label: STAGE_LABELS[row.stage] || row.stage,
      updatedAt: row.updatedAt,
      ruleCardCount: Array.isArray(ruleCardIds) ? ruleCardIds.length : 0,
      hasContext: true,
    });
  }
  return out;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const project = getProjectByIdForUser(params.id, user.id) as any;
  if (!project) return jsonError('项目不存在', 404);

  const styleSnapshot = project.styleTemplateSnapshot || null;
  const worldSnapshot = project.worldTemplateSnapshot || null;
  const styleId = templateId(styleSnapshot);
  const worldId = templateId(worldSnapshot);
  const styleSource = styleId ? getStyleTemplateForUser(user.id, styleId) : null;
  const worldSource = worldId ? getWorldTemplate(user.id, worldId) : null;

  const locks = Array.isArray(project?.consistency?.characters) ? project.consistency.characters : [];

  return jsonOk({
    project: {
      id: project.id,
      title: project.title || project.name || '',
      updatedAt: project.updatedAt,
    },
    style: {
      template: styleSnapshot ? {
        id: styleId,
        name: cleanText(styleSnapshot.name || styleSnapshot.title, 160),
        category: cleanText(styleSnapshot.category, 120),
        summary: cleanText(styleSnapshot.summary || styleSnapshot.description, 500),
      } : null,
      styleBible: publicStyleBible(project.styleBible),
      drift: driftInfo(styleSnapshot, styleSource),
    },
    world: {
      template: worldSnapshot ? {
        id: worldId,
        name: cleanText(worldSnapshot.name || worldSnapshot.title, 160),
        summary: cleanText(worldSnapshot.summary || worldSnapshot.description, 500),
        characterCount: Array.isArray(worldSnapshot.characters) ? worldSnapshot.characters.length : 0,
        locationCount: Array.isArray(worldSnapshot.locations) ? worldSnapshot.locations.length : 0,
        propCount: Array.isArray(worldSnapshot.props) ? worldSnapshot.props.length : 0,
      } : null,
      drift: driftInfo(worldSnapshot, worldSource),
    },
    characters: locks.map(publicCharacterLock),
    recentStages: listRecentStageSummaries(user.id, project.id),
  });
}
