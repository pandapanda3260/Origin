import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  applyCharacterPanelResult,
  existingPanelVersion,
  inferEntityTypeFromCharacter,
  splitCharacterPanels,
  type CharacterEntityType,
} from '@/lib/character-panels';
import { mutateCharacterLock } from '@/lib/character-consistency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseCharacterIndex(body: any): number {
  const direct = Number(body?.idx ?? body?.characterIndex ?? body?.assetIndex);
  if (Number.isInteger(direct) && direct >= 0) return direct;
  const ref = String(body?.assetRef || '');
  const m = /characters\[(\d+)\]/.exec(ref);
  return m ? Number(m[1]) : -1;
}

function pickSourceImageUrl(body: any, character: any): string {
  return String(
    body?.sourceImageUrl ||
    character?.rawUrl ||
    character?.imageUrl ||
    character?.realPhotoUrl ||
    character?.pencilUrl ||
    '',
  );
}

function pickEntityType(body: any, character: any): CharacterEntityType {
  if (body?.entityType === 'human' || body?.entityType === 'non-human') {
    return body.entityType;
  }
  return inferEntityTypeFromCharacter(character);
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return jsonError('invalid json body', 400);
  }

  const projectId = String(body?.projectId || '');
  if (!projectId) return jsonError('projectId is required', 400);

  const idx = parseCharacterIndex(body);
  if (idx < 0) return jsonError('character index is required', 400);

  const proj = getProjectByIdForUser(projectId, user.id) as any;
  if (!proj) return jsonError('项目不存在', 404);

  const character = proj?.assets?.characters?.[idx] ?? proj?.characters?.[idx];
  if (!character) return jsonError(`找不到 characters[${idx}]`, 404);

  const sourceImageUrl = pickSourceImageUrl(body, character);
  if (!sourceImageUrl) return jsonError('角色缺少可切分的图片 URL', 400);

  const entityType = pickEntityType(body, character);
  const assetRef = String(body?.assetRef || `characters[${idx}]`);
  const result = await splitCharacterPanels({
    user,
    projectId,
    assetRef,
    sourceImageUrl,
    entityType,
    prompt: String(character?.imagePrompt || character?.prompt || character?.name || ''),
    version: existingPanelVersion(character) + 1,
  });

  patchProjectForUser(projectId, user.id, (fresh) => {
    if (!fresh) return null;
    const assets = { ...((fresh as any).assets || {}) };
    const chars = Array.isArray(assets.characters) ? [...assets.characters] : [];
    const top = Array.isArray((fresh as any).characters) ? [...(fresh as any).characters] : [];

    const assetChar = chars[idx] || top[idx] || {};
    chars[idx] = applyCharacterPanelResult(assetChar, result);

    const topChar = top[idx] || chars[idx] || {};
    top[idx] = applyCharacterPanelResult(topChar, result);

    assets.characters = chars;
    const patch: any = { assets, characters: top };
    const nextChar = chars[idx] || top[idx] || {};
    const panels = nextChar.panels || {};
    const mutation = mutateCharacterLock(
      { ...(fresh as any), ...patch },
      nextChar.characterId || nextChar.id || nextChar.name || `characters[${idx}]`,
      {
        referenceLock: {
          sheetUrl: panels.sheetUrl || sourceImageUrl,
          headshotUrl: panels.headshotUrl,
          frontUrl: panels.frontUrl,
          sideUrl: panels.sideUrl,
          backUrl: panels.backUrl,
          sourceImageId: panels.sourceImageId || (result.ok ? result.panels.sourceImageId || undefined : undefined),
          referenceStatus: result.ok ? 'ready' : 'degraded',
          qualityScore: result.ok ? result.panels.confidence : undefined,
        },
      },
      { source: 'panel_split' },
    );
    return { ...patch, consistency: mutation.project.consistency };
  });

  if (!result.ok) {
    return jsonOk({ ok: false, error: result.error });
  }

  return jsonOk({
    ok: true,
    projectId,
    idx,
    entityType,
    panels: result.panels,
    panelImageIds: result.panelImageIds,
  });
}
