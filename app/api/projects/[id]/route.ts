import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { deleteProjectForUser, getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { attachVideoPromptReadiness } from '@/lib/video-prompt-state';
import { mutateCharacterLock } from '@/lib/character-consistency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const proj = getProjectByIdForUser(params.id, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  return jsonOk(attachVideoPromptReadiness(proj as any));
}

function cleanText(value: any): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function cleanList(value: any): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[，,、/]/);
  return Array.from(new Set(raw.map(cleanText).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function characterFingerprint(character: any) {
  return JSON.stringify({
    name: cleanText(character?.name),
    role: cleanText(character?.role),
    identity: cleanText(character?.identity || character?.intro),
    entityType: character?.entityType === 'non-human' ? 'non-human' : 'human',
    species: cleanText(character?.species),
    gender: cleanText(character?.gender),
    ageBand: cleanText(character?.ageBand || character?.age),
    aliases: cleanList(character?.aliases),
    appearance: cleanText(character?.appearance || character?.detail || character?.description || character?.intro),
    clothing: cleanText(character?.clothing),
    equipment: cleanText(character?.equipment),
    temperament: cleanText(character?.temperament),
    actionTraits: cleanText(character?.actionTraits),
    imageUrl: cleanText(character?.imageUrl || character?.rawUrl || character?.realPhotoUrl || character?.pencilUrl),
    panels: {
      sheetUrl: cleanText(character?.panels?.sheetUrl),
      headshotUrl: cleanText(character?.panels?.headshotUrl),
      frontUrl: cleanText(character?.panels?.frontUrl),
      sideUrl: cleanText(character?.panels?.sideUrl),
      backUrl: cleanText(character?.panels?.backUrl),
      sourceImageId: cleanText(character?.panels?.sourceImageId),
      confidence: Number.isFinite(Number(character?.panels?.confidence)) ? Number(character.panels.confidence) : undefined,
    },
  });
}

function characterPatchFromAsset(character: any) {
  const panels = character?.panels || {};
  const referenceUrl = panels.sheetUrl || character?.imageUrl || character?.rawUrl || character?.realPhotoUrl || character?.pencilUrl;
  return {
    sourceAssetId: character?.id || character?.characterId,
    canonicalName: character?.name || character?.role || character?.characterId || character?.id,
    aliases: [character?.name, character?.role, ...(Array.isArray(character?.aliases) ? character.aliases : [])].filter(Boolean),
    identityLock: {
      role: character?.role || character?.intro || '',
      identity: character?.identity || character?.intro || '',
      entityType: character?.entityType === 'non-human' ? 'non-human' as const : 'human' as const,
      species: character?.species,
      gender: character?.gender,
      ageBand: character?.ageBand || character?.age,
    },
    visualLock: {
      appearance: character?.appearance || character?.detail || character?.description || character?.intro || '',
      clothing: character?.clothing || '',
      equipment: character?.equipment || '',
      scaleRule: character?.scaleRule,
      negativeRules: character?.negativeRules,
      signatureColors: character?.signatureColors,
      canonicalPrompt: character?.imagePrompt || '',
    },
    performanceLock: {
      temperament: character?.temperament || '',
      actionTraits: character?.actionTraits || '',
      gestureRules: character?.gestureRules,
    },
    referenceLock: {
      sheetUrl: referenceUrl || undefined,
      headshotUrl: panels.headshotUrl,
      frontUrl: panels.frontUrl,
      sideUrl: panels.sideUrl,
      backUrl: panels.backUrl,
      sourceImageId: panels.sourceImageId,
      referenceStatus: referenceUrl ? 'ready' as const : 'missing' as const,
      qualityScore: Number.isFinite(Number(panels.confidence)) ? Number(panels.confidence) : undefined,
    },
  };
}

function applyProjectPutCharacterConsistency(current: any, body: any) {
  const patch = { ...(body || {}) };
  delete (patch as any).consistency;
  if (!current) return patch;

  const nextProject: any = { ...current, ...patch };
  const nextChars: any[] = Array.isArray(nextProject?.assets?.characters)
    ? nextProject.assets.characters
    : Array.isArray(nextProject?.characters)
      ? nextProject.characters
      : [];
  if (!nextChars.length) return patch;

  const currentChars: any[] = Array.isArray(current?.assets?.characters)
    ? current.assets.characters
    : Array.isArray(current?.characters)
      ? current.characters
      : [];
  const confirmingAssets = patch.assetsApproved === true && current.assetsApproved !== true;
  let consistencyProject = nextProject;
  let changed = false;

  nextChars.forEach((character, index) => {
    const previous = currentChars[index];
    const characterId = character?.characterId || character?.id || previous?.characterId || previous?.id || character?.name || `characters[${index}]`;
    const hasLock = Array.isArray(consistencyProject?.consistency?.characters)
      && consistencyProject.consistency.characters.some((c: any) => c.characterId === characterId || c.sourceAssetId === characterId);
    const semanticChanged = !previous || characterFingerprint(previous) !== characterFingerprint(character);
    if (!confirmingAssets && !semanticChanged && hasLock) return;

    const result = mutateCharacterLock(
      consistencyProject,
      String(characterId),
      characterPatchFromAsset(character),
      {
        source: confirmingAssets ? 'user_confirm' : 'asset_edit',
        userConfirmed: confirmingAssets,
      },
    );
    consistencyProject = result.project;
    changed = true;
  });

  return changed ? { ...patch, consistency: consistencyProject.consistency } : patch;
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const current = getProjectByIdForUser(params.id, user.id);
  if (!current) return jsonError('项目不存在', 404);
  const proj = updateProjectForUser(params.id, user.id, applyProjectPutCharacterConsistency(current as any, body));
  if (!proj) return jsonError('项目不存在', 404);
  return jsonOk(attachVideoPromptReadiness(proj as any));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const ok = deleteProjectForUser(params.id, user.id);
  if (!ok) return jsonError('项目不存在', 404);
  return jsonOk({ ok: true });
}
