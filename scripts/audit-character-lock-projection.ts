import Database from 'better-sqlite3';
import {
  applyAssetAuthorityToWorldCharacter,
  buildAssetAuthoritativeCharacterLock,
  resolveCharacterAssetForEntity,
} from '../lib/character-lock-authority';
import { ensureProjectConsistency, type CharacterLock } from '../lib/character-consistency';

type ProjectRow = {
  id: string;
  title: string | null;
  data_json: string;
};

function parseProject(row: ProjectRow): any {
  try {
    return JSON.parse(row.data_json || '{}');
  } catch {
    return {};
  }
}

function clean(value: any): string {
  return String(value ?? '').trim();
}

function diffField(out: Record<string, { from: string; to: string }>, key: string, from: any, to: any) {
  const before = clean(from);
  const after = clean(to);
  if (before !== after) out[key] = { from: before, to: after };
}

function diffJsonField(out: Record<string, { from: string; to: string }>, key: string, from: any, to: any) {
  const before = JSON.stringify(from ?? null);
  const after = JSON.stringify(to ?? null);
  if (before !== after) out[key] = { from: before, to: after };
}

function lockProjectionDiff(lock: CharacterLock, projected: CharacterLock) {
  const diff: Record<string, { from: string; to: string }> = {};
  diffField(diff, 'canonicalName', lock.canonicalName, projected.canonicalName);
  diffJsonField(diff, 'aliases', lock.aliases, projected.aliases);
  diffField(diff, 'identityLock.entityType', lock.identityLock.entityType, projected.identityLock.entityType);
  diffField(diff, 'identityLock.species', lock.identityLock.species, projected.identityLock.species);
  diffField(diff, 'visualLock.appearance', lock.visualLock.appearance, projected.visualLock.appearance);
  diffField(diff, 'visualLock.clothing', lock.visualLock.clothing, projected.visualLock.clothing);
  diffField(diff, 'visualLock.equipment', lock.visualLock.equipment, projected.visualLock.equipment);
  diffField(diff, 'visualLock.canonicalPrompt', lock.visualLock.canonicalPrompt, projected.visualLock.canonicalPrompt);
  diffField(diff, 'performanceLock.temperament', lock.performanceLock.temperament, projected.performanceLock.temperament);
  diffField(diff, 'performanceLock.actionTraits', lock.performanceLock.actionTraits, projected.performanceLock.actionTraits);
  return diff;
}

function worldCharacterDiff(character: any, projected: any) {
  const diff: Record<string, { from: string; to: string }> = {};
  diffField(diff, 'name', character?.name, projected?.name);
  diffJsonField(diff, 'aliases', character?.aliases, projected?.aliases);
  diffField(diff, 'role', character?.role, projected?.role);
  diffField(diff, 'identity', character?.identity, projected?.identity);
  diffField(diff, 'description', character?.description, projected?.description);
  diffField(diff, 'entityType', character?.entityType, projected?.entityType);
  diffField(diff, 'species', character?.species, projected?.species);
  diffField(diff, 'appearance', character?.appearance, projected?.appearance);
  diffField(diff, 'clothing', character?.clothing, projected?.clothing);
  diffField(diff, 'equipment', character?.equipment, projected?.equipment);
  diffField(diff, 'temperament', character?.temperament, projected?.temperament);
  diffField(diff, 'actionTraits', character?.actionTraits, projected?.actionTraits);
  diffField(diff, 'canonicalPrompt', character?.canonicalPrompt, projected?.canonicalPrompt);
  return diff;
}

const db = new Database('data/qd.sqlite', { readonly: true, fileMustExist: true });
const rows = db.prepare('select id, title, data_json from projects order by id').all() as ProjectRow[];
const showDetails = process.argv.includes('--details');

const summary = {
  projectsScanned: rows.length,
  locksScanned: 0,
  locksWithAsset: 0,
  locksChangedByProjection: 0,
  locksWithoutAsset: 0,
  ambiguousLockMatches: 0,
  snapshotCharactersScanned: 0,
  snapshotCharactersChangedByProjection: 0,
  ambiguousSnapshotMatches: 0,
};

const projectReports: any[] = [];

for (const row of rows) {
  const project = parseProject(row);
  project.id ||= row.id;
  project.title ||= row.title || '';
  const withConsistency = ensureProjectConsistency(project, { source: 'migration' });
  const locks: CharacterLock[] = Array.isArray(withConsistency.consistency?.characters)
    ? withConsistency.consistency.characters
    : [];
  const lockReports: any[] = [];
  for (const lock of locks) {
    summary.locksScanned += 1;
    const resolution = resolveCharacterAssetForEntity(project, lock);
    if (resolution.reason === 'ambiguous') summary.ambiguousLockMatches += 1;
    if (!resolution.asset) {
      summary.locksWithoutAsset += 1;
      if (resolution.reason === 'ambiguous') {
        lockReports.push({
          characterId: lock.characterId,
          canonicalName: lock.canonicalName,
          resolution,
        });
      }
      continue;
    }
    summary.locksWithAsset += 1;
    const projected = buildAssetAuthoritativeCharacterLock(lock, resolution.asset);
    const diff = lockProjectionDiff(lock, projected);
    if (Object.keys(diff).length) {
      summary.locksChangedByProjection += 1;
      lockReports.push({
        characterId: lock.characterId,
        canonicalName: lock.canonicalName,
        asset: resolution.asset?.name || resolution.asset?.id,
        resolution: resolution.reason,
        diff,
      });
    }
  }

  const snapshotReports: any[] = [];
  const snapshotCharacters = Array.isArray(project.worldTemplateSnapshot?.characters)
    ? project.worldTemplateSnapshot.characters
    : [];
  for (const character of snapshotCharacters) {
    summary.snapshotCharactersScanned += 1;
    const resolution = resolveCharacterAssetForEntity(project, character);
    if (resolution.reason === 'ambiguous') summary.ambiguousSnapshotMatches += 1;
    if (!resolution.asset) {
      if (resolution.reason === 'ambiguous') {
        snapshotReports.push({
          id: character?.id || character?.characterId,
          name: character?.name,
          resolution,
        });
      }
      continue;
    }
    const projected = applyAssetAuthorityToWorldCharacter(character, resolution.asset);
    const diff = worldCharacterDiff(character, projected);
    if (Object.keys(diff).length) {
      summary.snapshotCharactersChangedByProjection += 1;
      snapshotReports.push({
        id: character?.id || character?.characterId,
        name: character?.name,
        asset: resolution.asset?.name || resolution.asset?.id,
        resolution: resolution.reason,
        diff,
      });
    }
  }

  if (lockReports.length || snapshotReports.length) {
    projectReports.push({
      projectId: row.id,
      title: row.title || project.title || '',
      locks: lockReports,
      snapshotCharacters: snapshotReports,
    });
  }
}

const compactReports = projectReports.map((project) => ({
  projectId: project.projectId,
  title: project.title,
  lockChanges: project.locks.length,
  snapshotCharacterChanges: project.snapshotCharacters.length,
  ambiguousLockMatches: project.locks.filter((item: any) => item.resolution?.reason === 'ambiguous').length,
  ambiguousSnapshotMatches: project.snapshotCharacters.filter((item: any) => item.resolution?.reason === 'ambiguous').length,
}));

console.log(JSON.stringify({
  summary,
  projects: showDetails ? projectReports : compactReports,
  details: showDetails ? 'included' : 'run with --details for per-field diffs',
}, null, 2));
