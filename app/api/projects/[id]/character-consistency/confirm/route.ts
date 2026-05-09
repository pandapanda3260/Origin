import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { attachVideoPromptReadiness } from '@/lib/video-prompt-state';
import { ensureProjectConsistency, mutateCharacterLock, type CharacterLock } from '@/lib/character-consistency';
import { patchProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CharacterFix = {
  characterId?: string;
  characterName?: string;
  species?: string;
};

function cleanText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value || {}));
}

function findLock(project: any, fix: CharacterFix): CharacterLock | null {
  const locks: CharacterLock[] = Array.isArray(project?.consistency?.characters)
    ? project.consistency.characters
    : [];
  const id = cleanText(fix.characterId);
  const name = cleanText(fix.characterName);
  return locks.find((lock) => {
    if (id && (lock.characterId === id || lock.sourceAssetId === id)) return true;
    if (name && lock.canonicalName === name) return true;
    return false;
  }) || null;
}

function updateAssetSpecies(project: any, lock: CharacterLock, species: string) {
  if (!species || lock.identityLock.entityType !== 'non-human') return;
  const assets = { ...(project.assets || {}) };
  const assetChars = Array.isArray(assets.characters) ? [...assets.characters] : [];
  const topChars = Array.isArray(project.characters) ? [...project.characters] : [];
  const matches = (ch: any) => {
    const id = cleanText(ch?.characterId || ch?.id);
    const name = cleanText(ch?.name || ch?.role);
    return (
      (!!id && (id === lock.characterId || id === lock.sourceAssetId)) ||
      (!!name && name === lock.canonicalName)
    );
  };

  let touched = false;
  for (let i = 0; i < assetChars.length; i++) {
    if (!matches(assetChars[i])) continue;
    assetChars[i] = { ...assetChars[i], species };
    touched = true;
  }
  for (let i = 0; i < topChars.length; i++) {
    if (!matches(topChars[i])) continue;
    topChars[i] = { ...topChars[i], species };
    touched = true;
  }
  if (!touched) return;
  assets.characters = assetChars;
  project.assets = assets;
  if (topChars.length) project.characters = topChars;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const fixes: CharacterFix[] = Array.isArray(body.fixes) ? body.fixes : [];
  if (!fixes.length) return jsonError('缺少角色确认项', 400);

  const updated = patchProjectForUser(params.id, user.id, (current) => {
    let working: any = ensureProjectConsistency(cloneJson(current), { source: 'migration' });
    const confirmed: string[] = [];

    for (const fix of fixes) {
      const lock = findLock(working, fix);
      if (!lock) continue;
      const species = cleanText(fix.species || lock.identityLock.species);
      updateAssetSpecies(working, lock, species);
      const mutation = mutateCharacterLock(
        working,
        lock.characterId,
        {
          status: 'locked',
          identityLock: species && lock.identityLock.entityType === 'non-human' ? { species } : undefined,
        },
        { source: 'user_confirm', userConfirmed: true },
      );
      working = mutation.project;
      confirmed.push(lock.characterId);
    }

    if (!confirmed.length) return null;
    return {
      assets: working.assets,
      characters: working.characters,
      consistency: working.consistency,
    };
  });

  if (!updated) return jsonError('项目不存在或没有可确认的角色', 404);
  return jsonOk({
    ok: true,
    project: attachVideoPromptReadiness(updated as any),
  });
}
