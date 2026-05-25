import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../lib/db';
import { READY_QUALITY_THRESHOLD } from '../lib/character-consistency';
import { READY_PANEL_CONFIDENCE } from '../lib/character-reference-update';
import { getDataDir } from '../lib/runtime-paths';

type Mode = 'dry-run' | 'apply';

type Candidate = {
  projectId: string;
  title: string;
  idx: number;
  name: string;
  previousStatus: string;
  recoveredStatus: 'ready' | 'degraded';
  qualityScore: number | null;
  recoveryUrl: string | null;
  reason: string;
};

const args = new Set(process.argv.slice(2));
const mode: Mode = args.has('--apply') ? 'apply' : 'dry-run';
const projectId = valueArg('--projectId');
const now = new Date().toISOString();

function valueArg(name: string): string | null {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasText(value: unknown): boolean {
  return !!String(value || '').trim();
}

function hasPanelUrl(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  return ['sheetUrl', 'headshotUrl', 'frontUrl', 'sideUrl', 'backUrl'].some((key) => hasText(value[key]));
}

function normalizeEntityType(value: any): string {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'non-human' || text === 'nonhuman' || text.includes('非人')) return 'non-human';
  if (text === 'human' || text.includes('人物') || text.includes('人类')) return 'human';
  return text;
}

function panelSchemaEntityType(value: any): string {
  const schema = String(value?.schema || '').trim().toLowerCase();
  if (!schema) return '';
  if (schema.includes('non-human') || schema.includes('nonhuman')) return 'non-human';
  if (schema.includes('human-character')) return 'human';
  return '';
}

function reusableReferenceLock(lock: any): any {
  const referenceLock = lock?.referenceLock;
  if (!referenceLock || !hasPanelUrl(referenceLock)) return null;
  if (referenceLock.referenceStatus === 'missing' || referenceLock.referenceStatus === 'failed') return null;
  return referenceLock;
}

function canReuseReferenceForCharacter(character: any, lock: any): boolean {
  const entityType = normalizeEntityType(character?.entityType || lock?.identityLock?.entityType);
  const characterEntity = normalizeEntityType(character?.entityType);
  if (entityType && characterEntity && entityType !== characterEntity) return false;
  const schemaEntity = panelSchemaEntityType(character?.panels);
  if (entityType && schemaEntity && entityType !== schemaEntity) return false;
  if (entityType === 'non-human' && !characterEntity && !schemaEntity && !reusableReferenceLock(lock)) return false;
  return true;
}

function characterIds(character: any): Set<string> {
  return new Set(
    [
      character?.characterId,
      character?.id,
      character?.name,
      character?.role,
    ].filter(Boolean).map((value) => String(value)),
  );
}

function findLock(project: any, character: any): any {
  const locks = Array.isArray(project?.consistency?.characters) ? project.consistency.characters : [];
  const ids = characterIds(character);
  return locks.find((lock: any) => (
    ids.has(String(lock?.characterId || '')) ||
    ids.has(String(lock?.sourceAssetId || '')) ||
    ids.has(String(lock?.canonicalName || '')) ||
    (Array.isArray(lock?.aliases) && lock.aliases.some((alias: any) => ids.has(String(alias || ''))))
  )) || null;
}

function hasOldGoodReference(character: any, lock: any): boolean {
  const reference = character?.reference || {};
  const referenceLock = reusableReferenceLock(lock);
  return hasText(reference.lastKnownGoodUrl)
    || hasText(reference.currentUrl)
    || hasPanelUrl(character?.panels)
    || hasPanelUrl(referenceLock);
}

function recoveryUrl(character: any, lock: any): string | null {
  const reference = character?.reference || {};
  const panels = character?.panels || {};
  const referenceLock = reusableReferenceLock(lock) || {};
  const url = [
    reference.lastKnownGoodUrl,
    reference.currentUrl,
    character?.imageUrl,
    character?.rawUrl,
    character?.realPhotoUrl,
    character?.pencilUrl,
    panels.sheetUrl,
    referenceLock.sheetUrl,
    panels.headshotUrl,
    referenceLock.headshotUrl,
    panels.frontUrl,
    referenceLock.frontUrl,
    panels.sideUrl,
    referenceLock.sideUrl,
    panels.backUrl,
    referenceLock.backUrl,
  ].find(hasText);
  return url ? String(url).trim() : null;
}

function needsRecoveredUrl(character: any, lock: any): boolean {
  if (!character?.reference?.recoveredAt) return false;
  if (character.reference.status !== 'ready' && character.reference.status !== 'degraded') return false;
  if (!canReuseReferenceForCharacter(character, lock)) return false;
  if (!recoveryUrl(character, lock)) return false;
  return !hasText(character.reference.currentUrl)
    || !hasText(character.reference.lastKnownGoodUrl)
    || !hasText(character.imageUrl)
    || !hasText(character.rawUrl);
}

function recoverStatus(lock: any, character: any): { status: 'ready' | 'degraded'; score: number | null; reason: string } {
  const rawScore = reusableReferenceLock(lock)?.qualityScore ?? character?.panels?.confidence ?? character?.reference?.qualityScore;
  const score = Number(rawScore);
  if (Number.isFinite(score)) {
    if (score >= READY_PANEL_CONFIDENCE) return { status: 'ready', score, reason: 'qualityScore>=READY_PANEL_CONFIDENCE' };
    if (score >= READY_QUALITY_THRESHOLD) return { status: 'degraded', score, reason: 'qualityScore>=READY_QUALITY_THRESHOLD' };
    return { status: 'degraded', score, reason: 'qualityScore<READY_QUALITY_THRESHOLD' };
  }
  return { status: 'degraded', score: null, reason: 'qualityScore_missing' };
}

function recoverCharacter(character: any, lock: any, candidate: Omit<Candidate, 'projectId' | 'title' | 'idx' | 'name'>): boolean {
  if (!character || typeof character !== 'object') return false;
  if (!canReuseReferenceForCharacter(character, lock)) return false;
  const statusRecoverable = character.reference?.status === 'failed' && !character.reference?.recoveredAt;
  const urlRecoverable = needsRecoveredUrl(character, lock);
  if (!statusRecoverable && !urlRecoverable) return false;
  const url = candidate.recoveryUrl || recoveryUrl(character, lock);
  character.reference = {
    ...(character.reference || {}),
    status: candidate.recoveredStatus,
    currentUrl: character.reference?.currentUrl || url || undefined,
    lastKnownGoodUrl: character.reference?.lastKnownGoodUrl || url || undefined,
    recoveredAt: now,
    recoveryMeta: {
      reason: 'preserve_last_good_reference_backfill',
      previousStatus: candidate.previousStatus,
      qualityScore: candidate.qualityScore,
      decision: candidate.reason,
      recoveryUrl: url || null,
    },
  };
  if (url) {
    character.imageUrl = character.imageUrl || url;
    character.rawUrl = character.rawUrl || url;
    character.realPhotoUrl = character.realPhotoUrl || url;
    character.pencilUrl = character.pencilUrl || url;
  }
  delete character.panelsError;
  delete character.panelsErrorAt;
  const referenceLock = reusableReferenceLock(lock);
  if (referenceLock) {
    lock.referenceLock = {
      ...referenceLock,
      referenceStatus: candidate.recoveredStatus,
    };
  }
  return true;
}

const db = getDb();
const rows = db.prepare(
  `SELECT id, title, data_json
     FROM projects
    WHERE (@projectId IS NULL OR id = @projectId)
    ORDER BY updated_at DESC`,
).all({ projectId }) as Array<{ id: string; title: string; data_json: string }>;

const candidates: Candidate[] = [];
const updates: Array<{ id: string; title: string; before: string; after: string }> = [];

for (const row of rows) {
  let project: any;
  try {
    project = JSON.parse(row.data_json || '{}');
  } catch {
    continue;
  }
  const chars = Array.isArray(project?.assets?.characters) ? project.assets.characters : [];
  const topChars = Array.isArray(project?.characters) ? project.characters : [];
  let changed = false;

  for (let idx = 0; idx < Math.max(chars.length, topChars.length); idx += 1) {
    const character = chars[idx] || topChars[idx];
    if (!character?.reference) continue;
    const lock = findLock(project, character);
    if (!canReuseReferenceForCharacter(character, lock)) continue;
    const statusRecoverable = character.reference.status === 'failed' && !character.reference.recoveredAt && hasOldGoodReference(character, lock);
    const urlRecoverable = needsRecoveredUrl(character, lock);
    if (!statusRecoverable && !urlRecoverable) continue;

    const decision = recoverStatus(lock, character);
    const url = recoveryUrl(character, lock);
    const candidate: Candidate = {
      projectId: row.id,
      title: row.title,
      idx,
      name: String(character.name || character.role || character.id || `characters[${idx}]`),
      previousStatus: String(character.reference.status || ''),
      recoveredStatus: decision.status,
      qualityScore: decision.score,
      recoveryUrl: url,
      reason: decision.reason,
    };
    candidates.push(candidate);

    const assetChanged = recoverCharacter(chars[idx], lock, candidate);
    const topChanged = recoverCharacter(topChars[idx], lock, candidate);
    changed = changed || assetChanged || topChanged;
  }

  if (changed) {
    updates.push({
      id: row.id,
      title: row.title,
      before: row.data_json,
      after: JSON.stringify(project),
    });
  }
}

if (mode === 'apply' && updates.length) {
  const backupDir = join(getDataDir(), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `character-reference-backfill-${now.replace(/[:.]/g, '-')}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: now, candidates, updates: updates.map((item) => ({ id: item.id, title: item.title, before: JSON.parse(item.before) })) }, null, 2));
  const update = db.prepare("UPDATE projects SET data_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
  const tx = db.transaction(() => {
    for (const item of updates) update.run(item.after, item.id);
  });
  tx();
  console.log(JSON.stringify({ mode, candidates: candidates.length, updatedProjects: updates.length, backupPath, details: candidates }, null, 2));
} else {
  console.log(JSON.stringify({ mode, candidates: candidates.length, updatedProjects: updates.length, details: candidates }, null, 2));
}
