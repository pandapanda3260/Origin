import {
  ensureProjectConsistency,
  type CharacterLock,
  type CharacterVersions,
  type VersionKey,
} from './character-consistency';
import { resolveCharacterMentions } from './character-mention-resolver';
import { isBlockingReferenceStatus, resolveAssetReferenceState } from './visual-reference-state';
import { storyboardShotIndices } from './frame-workflow-state';
import { resolveCharacterAssetForEntity } from './character-lock-authority';
import { isAnonymousCrowdAsset, isLegacyCrowdText } from './crowd-character';

export type CharacterConsistencyTarget = 'videoPrompt' | 'videoSegment';

export type CharacterUsageSnapshot = {
  characterId: string;
  canonicalName: string;
  status: CharacterLock['status'];
  versions: Partial<CharacterVersions>;
};

export type CharacterConsistencyWarningCode =
  | 'mention_ambiguous'
  | 'reference_missing'
  | 'visual_soft_conflict'
  | 'voice_soft_conflict'
  | 'manifest_conflict'
  | 'stale_nonblocking';

export type CharacterConsistencyBlockerCode =
  | 'character_status_not_locked'
  | 'nonhuman_species_missing'
  | 'critical_reference_missing';

export type CharacterConsistencyFinding = {
  code: CharacterConsistencyWarningCode | CharacterConsistencyBlockerCode;
  characterId?: string;
  characterName?: string;
  subReason: string;
  message: string;
};

export type CharacterConsistencyGateResult = {
  target: CharacterConsistencyTarget;
  groupIdx: number;
  allowed: boolean;
  score: number;
  level: 'green' | 'yellow' | 'red';
  blockers: CharacterConsistencyFinding[];
  warnings: CharacterConsistencyFinding[];
  characterUsages: CharacterUsageSnapshot[];
};

const TARGET_VERSION_DEPS: Record<CharacterConsistencyTarget, VersionKey[]> = {
  videoPrompt: ['identityVersion', 'visualVersion', 'performanceVersion', 'resolverVersion'],
  videoSegment: ['identityVersion', 'visualVersion', 'performanceVersion', 'voiceVersion', 'resolverVersion', 'referenceVersion'],
};

const WARNING_PENALTY: Record<CharacterConsistencyWarningCode, number> = {
  mention_ambiguous: 12,
  reference_missing: 15,
  visual_soft_conflict: 12,
  voice_soft_conflict: 10,
  manifest_conflict: 10,
  stale_nonblocking: 10,
};

const WARNING_CAP: Record<CharacterConsistencyWarningCode, number> = {
  mention_ambiguous: 24,
  reference_missing: 30,
  visual_soft_conflict: 30,
  voice_soft_conflict: 20,
  manifest_conflict: 20,
  stale_nonblocking: 25,
};

// Warning-only problems should bottom out at 75 (yellow, never a red stop sign).
// Hard blockers are handled separately by allowed=false and are the only one-vote veto.
const TARGET_WARNING_TOTAL_CAP = 25;

function normalizeText(value: any): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function groupShotIndices(project: any, groupIdx: number, explicit?: number[]): number[] {
  const sb = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] : null;
  return storyboardShotIndices(project, groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices: explicit,
  });
}

function groupText(project: any, groupIdx: number, explicitShotIndices?: number[]) {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const indices = groupShotIndices(project, groupIdx, explicitShotIndices);
  const shotText = indices.map((idx) => {
    const sh = shots[idx] || {};
    return [
      sh.characters,
      sh.speaker,
      sh.visual,
      sh.description,
      sh.desc,
      sh.dialogue,
      sh.scriptRef,
      sh.keyInfo,
    ].flat().map(normalizeText).filter(Boolean).join(' ');
  });
  const sb = storyboards[groupIdx] || {};
  return [
    sb.videoPrompt,
    sb.firstFramePrompt,
    sb.imagePrompt,
    sb.description,
    sb.dialogue,
    ...shotText,
  ].map(normalizeText).filter(Boolean).join('\n');
}

function lockNames(lock: CharacterLock): string[] {
  return [lock.canonicalName, ...lock.aliases].map(normalizeText).filter(Boolean);
}

function isCrowdLockForGate(project: any, lock: CharacterLock): boolean {
  const resolution = resolveCharacterAssetForEntity(project, lock);
  if (resolution.asset) return isAnonymousCrowdAsset(resolution.asset);
  return isLegacyCrowdText(lockNames(lock).join(' '));
}

function versionSnapshot(lock: CharacterLock, deps: VersionKey[]): Partial<CharacterVersions> {
  const out: Partial<CharacterVersions> = {};
  deps.forEach((key) => {
    out[key] = lock.versions[key];
  });
  return out;
}

function scoreWarnings(warnings: CharacterConsistencyFinding[]): number {
  const perCharacterCode = new Map<string, number>();
  for (const warning of warnings) {
    const code = warning.code as CharacterConsistencyWarningCode;
    const penalty = WARNING_PENALTY[code] || 0;
    const key = `${code}:${warning.characterId || 'project'}`;
    const prev = perCharacterCode.get(key) || 0;
    const capped = Math.min(prev + penalty, WARNING_CAP[code] || penalty);
    perCharacterCode.set(key, capped);
  }
  const totalPenalty = Math.min(
    Array.from(perCharacterCode.values()).reduce((sum, value) => sum + value, 0),
    TARGET_WARNING_TOTAL_CAP,
  );
  return 100 - totalPenalty;
}

function scoreLevel(score: number, hasBlocker: boolean): CharacterConsistencyGateResult['level'] {
  if (hasBlocker) return 'red';
  if (score >= 90) return 'green';
  if (score >= 75) return 'yellow';
  return 'red';
}

function targetSnapshot(project: any, groupIdx: number, target: CharacterConsistencyTarget): any {
  if (target === 'videoSegment') {
    return project?.videoTasks?.[groupIdx]?.consistency?.videoSegment;
  }
  return project?.storyboards?.[groupIdx]?.consistency?.videoPrompt;
}

function isRelaxedTarget(target: CharacterConsistencyTarget): boolean {
  if (target !== 'videoPrompt') return false;
  return process.env.RELAX_VIDEO_PROMPT_BLOCKERS !== '0';
}

function logRelaxedBlock(payload: {
  target: CharacterConsistencyTarget;
  code: string;
  groupIdx: number;
  characterId?: string;
  characterName?: string;
  subReason?: string;
}) {
  try {
    console.warn('[relaxed_block]', JSON.stringify(payload));
  } catch {
    console.warn('[relaxed_block]', payload);
  }
}

function pushAssetReferenceFindings(
  project: any,
  text: string,
  findings: {
    warnings: CharacterConsistencyFinding[];
    blockers: CharacterConsistencyFinding[];
  },
  ctx: { target: CharacterConsistencyTarget; groupIdx: number },
) {
  const props = Array.isArray(project?.assets?.props) ? project.assets.props : [];
  const relax = isRelaxedTarget(ctx.target);
  for (const prop of props) {
    const name = normalizeText(prop?.name || prop?.propName);
    if (!name || !text.includes(name)) continue;
    const reference = resolveAssetReferenceState(prop);
    if (isBlockingReferenceStatus(reference.status)) {
      const finding: CharacterConsistencyFinding = {
        code: 'critical_reference_missing',
        subReason: `prop:${reference.status}`,
        message: `道具 ${name} 暂无可用参考图，建议先生成后再启动视频。`,
      };
      if (relax) {
        logRelaxedBlock({
          target: ctx.target,
          code: 'critical_reference_missing',
          groupIdx: ctx.groupIdx,
          subReason: finding.subReason,
        });
        findings.warnings.push({
          ...finding,
          code: 'reference_missing',
          message: `[已放行] ${finding.message}`,
        });
      } else {
        findings.blockers.push(finding);
      }
    }
  }
}

export function validateCharacterConsistencyForGroup(
  project: any,
  opts: {
    groupIdx: number;
    shotIndices?: number[];
    target: CharacterConsistencyTarget;
    snapshot?: any;
  },
): CharacterConsistencyGateResult {
  const projectWithConsistency = ensureProjectConsistency(project || {}, { source: 'migration' });
  const allLocks: CharacterLock[] = Array.isArray(projectWithConsistency.consistency?.characters)
    ? projectWithConsistency.consistency.characters
    : [];
  const locks = allLocks.filter((lock) => !isCrowdLockForGate(projectWithConsistency, lock));
  const deps = TARGET_VERSION_DEPS[opts.target];
  const text = groupText(project, opts.groupIdx, opts.shotIndices);
  const warnings: CharacterConsistencyFinding[] = [];
  const blockers: CharacterConsistencyFinding[] = [];
  const usedIds = new Set<string>();

  const resolutions = resolveCharacterMentions({
    text,
    characters: locks,
    contextText: text,
  });
  for (const resolution of resolutions) {
    if (resolution.confidence >= 0.9 && resolution.characterId) {
      usedIds.add(resolution.characterId);
    } else if (resolution.confidence >= 0.65) {
      warnings.push({
        code: 'mention_ambiguous',
        characterId: resolution.characterId,
        subReason: resolution.reason,
        message: `角色提及 "${resolution.textSpan}" 置信度 ${resolution.confidence.toFixed(2)}，需要人工确认映射。`,
      });
    }
  }

  for (const lock of locks) {
    const names = lockNames(lock);
    if (names.some((name) => text.includes(name))) usedIds.add(lock.characterId);
  }

  const usedLocks = locks.filter((lock) => usedIds.has(lock.characterId));
  const snapshots: CharacterUsageSnapshot[] = usedLocks.map((lock) => ({
    characterId: lock.characterId,
    canonicalName: lock.canonicalName,
    status: lock.status,
    versions: versionSnapshot(lock, deps),
  }));

  const relaxBlockers = isRelaxedTarget(opts.target);
  for (const lock of usedLocks) {
    if (lock.status !== 'locked') {
      const finding: CharacterConsistencyFinding = {
        code: 'character_status_not_locked',
        characterId: lock.characterId,
        characterName: lock.canonicalName,
        subReason: lock.status,
        message: `${lock.canonicalName} 当前状态为 ${lock.status}，必须确认 locked 后才能生成 ${opts.target}。`,
      };
      if (relaxBlockers) {
        logRelaxedBlock({
          target: opts.target,
          code: 'character_status_not_locked',
          groupIdx: opts.groupIdx,
          characterId: lock.characterId,
          characterName: lock.canonicalName,
          subReason: lock.status,
        });
        warnings.push({ ...finding, message: `[已放行] ${finding.message}` });
      } else {
        blockers.push(finding);
      }
    }
    if (lock.identityLock.entityType === 'non-human' && !lock.identityLock.species) {
      const finding: CharacterConsistencyFinding = {
        code: 'nonhuman_species_missing',
        characterId: lock.characterId,
        characterName: lock.canonicalName,
        subReason: 'species_missing',
        message: `${lock.canonicalName} 是非人角色，但缺少 species，容易被真人化。`,
      };
      if (relaxBlockers) {
        logRelaxedBlock({
          target: opts.target,
          code: 'nonhuman_species_missing',
          groupIdx: opts.groupIdx,
          characterId: lock.characterId,
          characterName: lock.canonicalName,
          subReason: 'species_missing',
        });
        warnings.push({ ...finding, message: `[已放行] ${finding.message}` });
      } else {
        blockers.push(finding);
      }
    }
    if (opts.target === 'videoSegment' && lock.referenceLock.referenceStatus !== 'ready') {
      if (lock.referenceLock.referenceStatus === 'missing' || lock.referenceLock.referenceStatus === 'failed') {
        blockers.push({
          code: 'critical_reference_missing',
          characterId: lock.characterId,
          characterName: lock.canonicalName,
          subReason: `character:${lock.referenceLock.referenceStatus}`,
          message: `${lock.canonicalName} 的角色参考图状态为 ${lock.referenceLock.referenceStatus}，不能进入 videoSegment。`,
        });
      } else {
        warnings.push({
          code: 'reference_missing',
          characterId: lock.characterId,
          characterName: lock.canonicalName,
          subReason: lock.referenceLock.referenceStatus,
          message: `${lock.canonicalName} 的角色参考图状态为 ${lock.referenceLock.referenceStatus}。`,
        });
      }
    }
  }

  pushAssetReferenceFindings(project, text, { warnings, blockers }, { target: opts.target, groupIdx: opts.groupIdx });

  const prevSnapshot = opts.snapshot || targetSnapshot(project, opts.groupIdx, opts.target);
  const previousUsages: CharacterUsageSnapshot[] = Array.isArray(prevSnapshot?.characterUsages)
    ? prevSnapshot.characterUsages
    : [];
  for (const current of snapshots) {
    const old = previousUsages.find((item) => item.characterId === current.characterId);
    if (!old) continue;
    for (const dep of deps) {
      if (old.versions?.[dep] && current.versions?.[dep] && old.versions[dep] !== current.versions[dep]) {
        warnings.push({
          code: 'stale_nonblocking',
          characterId: current.characterId,
          characterName: current.canonicalName,
          subReason: dep,
          message: `${current.canonicalName} 的 ${dep} 已变化，当前 ${opts.target} 快照过期。`,
        });
      }
    }
  }

  const score = scoreWarnings(warnings);
  return {
    target: opts.target,
    groupIdx: opts.groupIdx,
    allowed: blockers.length === 0,
    score,
    level: scoreLevel(score, blockers.length > 0),
    blockers,
    warnings,
    characterUsages: snapshots,
  };
}

export function computeCharacterConsistencyStale(project: any) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  const stale: Array<{
    groupIdx: number;
    target: CharacterConsistencyTarget;
    score: number;
    level: string;
    warnings: CharacterConsistencyFinding[];
    blockers: CharacterConsistencyFinding[];
  }> = [];

  storyboards.forEach((_: any, groupIdx: number) => {
    const promptGate = validateCharacterConsistencyForGroup(project, { groupIdx, target: 'videoPrompt' });
    const promptStaleWarnings = promptGate.warnings.filter((warning) => warning.code === 'stale_nonblocking');
    if (promptStaleWarnings.length || promptGate.blockers.length) {
      stale.push({
        groupIdx,
        target: 'videoPrompt',
        score: promptGate.score,
        level: promptGate.level,
        warnings: promptStaleWarnings,
        blockers: promptGate.blockers,
      });
    }
    if (videoTasks[groupIdx]) {
      const segmentGate = validateCharacterConsistencyForGroup(project, { groupIdx, target: 'videoSegment' });
      const segmentStaleWarnings = segmentGate.warnings.filter((warning) => warning.code === 'stale_nonblocking');
      if (segmentStaleWarnings.length || segmentGate.blockers.length) {
        stale.push({
          groupIdx,
          target: 'videoSegment',
          score: segmentGate.score,
          level: segmentGate.level,
          warnings: segmentStaleWarnings,
          blockers: segmentGate.blockers,
        });
      }
    }
  });

  return stale;
}
