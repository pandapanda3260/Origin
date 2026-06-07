import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { deleteProjectForUser, getProjectByIdForUser, StaleProjectVersionError, updateProjectForUser } from '@/lib/projects-db';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { attachVideoPromptReadiness } from '@/lib/video-prompt-state';
import { mutateCharacterLock, syncWorldCharactersIntoConsistency } from '@/lib/character-consistency';
import { attachAssetLibraryCurrentToProject } from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const perfDiag = process.env.PERF_DIAG === '1';
  const t0 = perfDiag ? performance.now() : 0;
  const user = await getCurrentUser(req);
  const tAuth = perfDiag ? performance.now() : 0;
  if (!user) return jsonError('unauthorized', 401);
  const proj = getProjectByIdForUser(params.id, user.id);
  const tDb = perfDiag ? performance.now() : 0;
  if (!proj) return jsonError('项目不存在', 404);
  const withAsset = attachAssetLibraryCurrentToProject(proj as any, user.id);
  const tAsset = perfDiag ? performance.now() : 0;
  const result = attachVideoPromptReadiness(withAsset);
  if (perfDiag) {
    const tEnd = performance.now();
    const fmt = (n: number) => n.toFixed(0);
    console.log(
      `[perf-diag] WIP GET /api/projects/${params.id} uid=${user.id} total=${fmt(tEnd - t0)}ms`
        + ` auth=${fmt(tAuth - t0)}ms`
        + ` getProject=${fmt(tDb - tAuth)}ms`
        + ` attachAssetLib=${fmt(tAsset - tDb)}ms`
        + ` attachVideoReadiness=${fmt(tEnd - tAsset)}ms`,
    );
  }
  return jsonOk(result);
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
  delete (patch as any).allowStyleBibleRunOverwrite;
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

function applyProjectPutWorldConsistency(current: any, patch: any) {
  if (!current || !patch || typeof patch !== 'object') return patch;
  const worldTouched = Object.prototype.hasOwnProperty.call(patch, 'worldTemplateSnapshot')
    || Object.prototype.hasOwnProperty.call(patch, 'selectedWorldTemplateId');
  if (!worldTouched) return patch;

  const nextProject: any = { ...current, ...patch };
  const result = syncWorldCharactersIntoConsistency(nextProject, { source: 'world_template' });
  return result.changed ? { ...patch, consistency: result.project.consistency } : patch;
}

function applyProjectPutConsistency(current: any, body: any) {
  const withCharacterConsistency = applyProjectPutCharacterConsistency(current, body);
  return applyProjectPutWorldConsistency(current, withCharacterConsistency);
}

// `If-Match` 头格式约定：`v<int>`（兼容前端 project.js `_serverSave` 的发送格式）。
// 不带头 / 解析失败 → 返回 undefined（回退到老的"无版本校验"语义，兼容老客户端）。
function parseIfMatchVersion(req: NextRequest): number | undefined {
  const raw = req.headers.get('if-match');
  if (!raw) return undefined;
  const m = String(raw).trim().match(/^"?v(\d+)"?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function isExplicitTitleUpdate(req: NextRequest, body: any): boolean {
  const header = String(req.headers.get('x-origin-title-update') || '').trim().toLowerCase();
  return header === '1' || header === 'true' || body?.__titleUpdate === true;
}

function removeRouteOnlyFields(patch: any): any {
  if (!patch || typeof patch !== 'object') return patch;
  const next = { ...patch };
  delete next.__titleUpdate;
  return next;
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const current = getProjectByIdForUser(params.id, user.id);
  if (!current) return jsonError('项目不存在', 404);
  // 乐观锁：前端 If-Match 落后于服务器 version 时返回 409 stale_version。
  // 这条挡的核心场景：batch executor / 单镜头路由刚把镜头状态权威写到 DB，
  // 前端内存里还停在旧快照，debounced saveProject 拿着旧 storyboards 来 PUT。
  // 老前端 / 老客户端不发 If-Match → expectedVersion=undefined → 走原本的覆盖语义，不破坏现状。
  const expectedVersion = parseIfMatchVersion(req);
  const allowTitleUpdate = isExplicitTitleUpdate(req, body);
  const patch = removeRouteOnlyFields(applyProjectPutConsistency(current as any, body));
  let proj: any;
  try {
    proj = updateProjectForUser(
      params.id,
      user.id,
      patch,
      {
        ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
        allowTitleUpdate,
      },
    );
  } catch (e: any) {
    if (e instanceof StaleProjectVersionError) {
      return NextResponse.json(
        {
          error: 'stale_version',
          serverVersion: e.serverVersion,
          clientVersion: e.clientVersion,
        },
        { status: 409 },
      );
    }
    throw e;
  }
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
