import {
  hasStoryboardVideoArtifact,
  hasVideoTaskArtifact,
  markStoryboardVideoOutdated,
  markVideoTaskOutdated,
  type VideoOutdatedReason,
} from './video-prompt-state';

export const MAX_SHOT_FRAME_CANDIDATES = 12;
export const SHOT_FRAME_FULL_METADATA_KEEP_RECENT = 3;

export type ShotFrameCandidateSource = 'gen' | 'upload' | 'edit';
export type ShotFrameCandidateMode = 'structured_v1' | 'multi_ref_v1' | 'uploaded' | 'history_restore';
export type ShotFrameCandidateStatus = 'ready';
export type ShotFrameMetadataTier = 'full' | 'compact';

export type ShotFrameCandidate = {
  id: string;
  url: string;
  source: ShotFrameCandidateSource;
  mode: ShotFrameCandidateMode;
  status: ShotFrameCandidateStatus;
  createdAt: string;
  generatedAt?: string;
  prompt?: string;
  originalPrompt?: string;
  sourceHash?: string | null;
  taskId?: string;
  assetId?: string;
  metadataTier?: ShotFrameMetadataTier;
  planSummary?: any;
  safetyAudit?: any;
  safetyAuditRef?: any;
  consistencyCheck?: any;
  consistencyAttempts?: number;
  consistencyStatus?: string;
  visualAnchorDescription?: string;
};

export type ShotFrameState = {
  candidates: ShotFrameCandidate[];
  selectedCandidateId?: string;
};

export type MirrorFirstFrameResult = {
  project: any;
  storyboardChanged: boolean;
  videoInvalidated: boolean;
  selectedCandidate?: ShotFrameCandidate;
};

export type ShotFrameCandidateActionInput =
  | { action: 'select'; groupIdx: number; shotUid: string; candidateId: string }
  | { action: 'reorder'; groupIdx: number; shotUid: string; orderedIds: string[] }
  | { action: 'delete'; groupIdx: number; shotUid: string; candidateId: string };

export type PerShotStoryboardImageTarget = {
  groupIdx: number;
  idx: number;
  storyboardIdx: number;
  shotIdx: number;
  shotUid: string;
  shotIndices: number[];
  [key: string]: any;
};

const HEAVY_CANDIDATE_KEYS = [
  'planSummary',
  'safetyAudit',
  'consistencyCheck',
  'consistencyAttempts',
  'visualAnchorDescription',
];

function cleanText(value: any): string {
  return String(value || '').trim();
}

function isoOrEmpty(value: any): string {
  const raw = cleanText(value);
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function canonicalShotUid(shot: any): string {
  return cleanText(shot?.shotUid ?? shot?.shot_uid);
}

export function candidateTime(candidate: any): number {
  const created = Date.parse(cleanText(candidate?.createdAt));
  if (!Number.isNaN(created)) return created;
  const generated = Date.parse(cleanText(candidate?.generatedAt));
  if (!Number.isNaN(generated)) return generated;
  return 0;
}

function normalizeCandidate(candidate: any): ShotFrameCandidate | null {
  const id = cleanText(candidate?.id);
  const url = cleanText(candidate?.url);
  if (!id || !url) return null;
  const source = candidate?.source === 'upload' || candidate?.source === 'edit' ? candidate.source : 'gen';
  const fallbackMode: ShotFrameCandidateMode = source === 'upload'
    ? 'uploaded'
    : source === 'edit'
      ? 'multi_ref_v1'
      : 'structured_v1';
  const mode = cleanText(candidate?.mode) as ShotFrameCandidateMode || fallbackMode;
  const createdAt = isoOrEmpty(candidate?.createdAt) || isoOrEmpty(candidate?.generatedAt) || new Date(0).toISOString();
  return {
    ...candidate,
    id,
    url,
    source,
    mode,
    status: 'ready',
    createdAt,
    generatedAt: isoOrEmpty(candidate?.generatedAt) || candidate?.generatedAt,
  };
}

export function compactShotFrameCandidate(candidate: ShotFrameCandidate): ShotFrameCandidate {
  const next: any = { ...candidate, metadataTier: 'compact' as const };
  for (const key of HEAVY_CANDIDATE_KEYS) delete next[key];
  if (candidate.safetyAudit && typeof candidate.safetyAudit === 'object') {
    const audit = candidate.safetyAudit;
    next.safetyAuditRef = {
      correlationId: audit.correlationId,
      generatedImageId: audit.generatedImageId,
      moderationRecovered: audit.moderationRecovered,
    };
  }
  delete next.safetyAudit;
  return next as ShotFrameCandidate;
}

export function normalizeShotFrameState(input: any): ShotFrameState {
  const seen = new Set<string>();
  const rawCandidates: any[] = Array.isArray(input?.candidates) ? input.candidates : [];
  const ordered: ShotFrameCandidate[] = rawCandidates
    .map(normalizeCandidate)
    .filter((candidate): candidate is ShotFrameCandidate => {
      if (!candidate || seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    });

  const latest = [...ordered].sort((a, b) => candidateTime(b) - candidateTime(a))[0];
  let selectedCandidateId: string | undefined = cleanText(input?.selectedCandidateId) || undefined;
  if (!selectedCandidateId || !ordered.some((candidate) => candidate.id === selectedCandidateId)) {
    selectedCandidateId = latest?.id || undefined;
  }

  const keepIds = new Set<string>();
  if (selectedCandidateId) keepIds.add(selectedCandidateId);
  [...ordered]
    .sort((a, b) => candidateTime(b) - candidateTime(a))
    .forEach((candidate) => {
      if (keepIds.size < MAX_SHOT_FRAME_CANDIDATES) keepIds.add(candidate.id);
    });

  const kept = ordered.filter((candidate) => keepIds.has(candidate.id));
  const fullMetadataIds = new Set<string>();
  if (selectedCandidateId) fullMetadataIds.add(selectedCandidateId);
  [...kept]
    .sort((a, b) => candidateTime(b) - candidateTime(a))
    .slice(0, SHOT_FRAME_FULL_METADATA_KEEP_RECENT)
    .forEach((candidate) => fullMetadataIds.add(candidate.id));

  return {
    candidates: kept.map((candidate) => {
      if (fullMetadataIds.has(candidate.id)) return { ...candidate, metadataTier: 'full' };
      return compactShotFrameCandidate(candidate);
    }),
    selectedCandidateId,
  };
}

export function appendShotFrameCandidate(state: any, candidate: any): ShotFrameState {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) return normalizeShotFrameState(state);
  const current = Array.isArray(state?.candidates) ? state.candidates : [];
  const nextCandidates = current.filter((item: any) => cleanText(item?.id) !== normalized.id);
  nextCandidates.push(normalized);
  return normalizeShotFrameState({
    candidates: nextCandidates,
    selectedCandidateId: normalized.id,
  });
}

export function selectedShotFrameCandidate(state: any): ShotFrameCandidate | undefined {
  const normalized = normalizeShotFrameState(state);
  return normalized.candidates.find((candidate) => candidate.id === normalized.selectedCandidateId);
}

function firstShotUidForGroup(project: any, groupIdx: number): string {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = Array.isArray(sb.shotIndices) ? sb.shotIndices : [groupIdx];
  return canonicalShotUid(shots[shotIndices[0]]);
}

function shotUidsForGroup(project: any, groupIdx: number): string[] {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = Array.isArray(sb.shotIndices) ? sb.shotIndices : [groupIdx];
  return shotIndices.map((idx: any) => canonicalShotUid(shots[Number(idx)])).filter(Boolean);
}

function routeError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

function targetGroupIdx(target: any): number | null {
  const n = Number(target?.groupIdx ?? target?.storyboardIdx ?? target?.idx);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function targetShotIndices(project: any, target: any, groupIdx: number): number[] {
  const explicit = Array.isArray(target?.shotIndices)
    ? target.shotIndices.map((idx: any) => Number(idx)).filter((idx: number) => Number.isInteger(idx) && idx >= 0)
    : [];
  if (explicit.length) return explicit;
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const sb = storyboards[groupIdx] || {};
  const stored = Array.isArray(sb.shotIndices)
    ? sb.shotIndices.map((idx: any) => Number(idx)).filter((idx: number) => Number.isInteger(idx) && idx >= 0)
    : [];
  return stored.length ? stored : [groupIdx];
}

export function expandStoryboardImageTargetsForPerShot(project: any, targets: any[]): PerShotStoryboardImageTarget[] {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const out: PerShotStoryboardImageTarget[] = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    const groupIdx = targetGroupIdx(target);
    if (groupIdx == null) throw routeError('invalid_group_idx');
    const shotIndices = targetShotIndices(project, target, groupIdx);
    const shotUidToIndex = new Map<string, number>();
    for (const shotIdx of shotIndices) {
      const shotUid = canonicalShotUid(shots[shotIdx]);
      if (!shotUid) throw routeError('missing_shot_uid');
      shotUidToIndex.set(shotUid, shotIdx);
    }
    const requestedShotUid = cleanText(target?.shotUid ?? target?.shot_uid);
    const selectedShotUids = requestedShotUid ? [requestedShotUid] : Array.from(shotUidToIndex.keys());
    for (const shotUid of selectedShotUids) {
      const shotIdx = shotUidToIndex.get(shotUid);
      if (!Number.isInteger(shotIdx)) throw routeError('shot_uid_not_in_group', 422);
      out.push({
        ...target,
        groupIdx,
        idx: groupIdx,
        storyboardIdx: groupIdx,
        shotIdx,
        shotUid,
        shotIndices,
      });
    }
  }
  return out;
}

function sourceForFirstFrame(candidate: ShotFrameCandidate): string {
  if (candidate.source === 'upload') return 'uploaded';
  if (candidate.mode === 'history_restore') return 'history_restore';
  return 'generated';
}

function anchorForStoryboard(sb: any): string {
  const url = cleanText(sb?.firstFrameUrl || sb?.frames?.first?.url || sb?.firstFrame?.currentUrl);
  const mode = cleanText(sb?.firstFrameMode || sb?.frames?.first?.mode);
  return `${url}|${mode}`;
}

function clearLegacyFirstFrameFields(sb: any): any {
  const next = { ...(sb || {}) };
  delete next.url;
  delete next.imageUrl;
  delete next.rawUrl;
  delete next.firstFrameUrl;
  delete next.firstFrame;
  delete next.firstFramePrompt;
  delete next.firstFrameMode;
  delete next.firstFrameSourceHash;
  delete next.firstFramePlanSummary;
  delete next.firstFrameSafetyAudit;
  delete next.firstFrameConsistencyCheck;
  delete next.firstFrameConsistencyStatus;
  delete next.effectiveVisualDescription;
  delete next.imagePrompt;
  delete next.firstFrameLastError;
  delete next.firstFrameFailedAt;
  if (next.frames && typeof next.frames === 'object') {
    const frames = { ...next.frames };
    delete frames.first;
    next.frames = frames;
  }
  return next;
}

function writeLegacyFirstFrameFields(sb: any, candidate: ShotFrameCandidate, shotIndices: number[]): any {
  const source = sourceForFirstFrame(candidate);
  const next: any = {
    ...(sb || {}),
    url: candidate.url,
    imageUrl: candidate.url,
    rawUrl: candidate.url,
    firstFrameUrl: candidate.url,
    firstFrameMode: candidate.mode,
    firstFrameSourceHash: candidate.sourceHash ?? null,
    firstFramePrompt: candidate.prompt,
    imagePrompt: candidate.prompt,
    firstFramePlanSummary: candidate.planSummary,
    firstFrameSafetyAudit: candidate.safetyAudit,
    firstFrameConsistencyCheck: candidate.consistencyCheck,
    firstFrameConsistencyStatus: candidate.consistencyStatus,
    effectiveVisualDescription: candidate.visualAnchorDescription,
    firstFrame: {
      currentUrl: candidate.url,
      rawUrl: candidate.url,
      status: 'ready',
      source,
      lastKnownGoodUrl: candidate.url,
      sourceHash: candidate.sourceHash ?? null,
      safetyAudit: candidate.safetyAudit,
      visualAnchorDescription: candidate.visualAnchorDescription,
      consistencyCheck: candidate.consistencyCheck,
      consistencyStatus: candidate.consistencyStatus,
    },
    frames: {
      ...((sb && typeof sb.frames === 'object') ? sb.frames : {}),
      first: {
        url: candidate.url,
        status: 'ready',
        source,
        mode: candidate.mode,
        sourceHash: candidate.sourceHash ?? null,
        prompt: candidate.prompt,
        originalPrompt: candidate.originalPrompt,
        planSummary: candidate.planSummary,
        safetyAudit: candidate.safetyAudit,
        visualAnchorDescription: candidate.visualAnchorDescription,
        consistencyCheck: candidate.consistencyCheck,
        consistencyAttempts: candidate.consistencyAttempts,
        consistencyStatus: candidate.consistencyStatus,
        generatedAt: candidate.generatedAt || candidate.createdAt,
        shotIndices,
      },
    },
  };
  delete next.firstFrameLastError;
  delete next.firstFrameFailedAt;
  if (!candidate.planSummary) delete next.firstFramePlanSummary;
  if (!candidate.safetyAudit) delete next.firstFrameSafetyAudit;
  if (!candidate.consistencyCheck) delete next.firstFrameConsistencyCheck;
  if (!candidate.consistencyStatus) delete next.firstFrameConsistencyStatus;
  if (!candidate.visualAnchorDescription) delete next.effectiveVisualDescription;
  return next;
}

export function mirrorSelectedFirstFrameToLegacyFields(
  project: any,
  groupIdx: number,
  opts: { shotUid?: string; reason?: VideoOutdatedReason; now?: string } = {},
): MirrorFirstFrameResult {
  const storyboards = Array.isArray(project?.storyboards) ? [...project.storyboards] : [];
  if (groupIdx < 0 || groupIdx >= storyboards.length) {
    return { project, storyboardChanged: false, videoInvalidated: false };
  }
  const prev = storyboards[groupIdx] || {};
  const shotFrames = prev.shotFrames && typeof prev.shotFrames === 'object' ? prev.shotFrames : {};
  const firstShotUid = firstShotUidForGroup(project, groupIdx);
  const targetShotUid = cleanText(opts.shotUid || firstShotUid);
  if (!targetShotUid || targetShotUid !== firstShotUid) {
    return { project, storyboardChanged: false, videoInvalidated: false };
  }

  const state = normalizeShotFrameState(shotFrames[targetShotUid]);
  const selected = state.candidates.find((candidate) => candidate.id === state.selectedCandidateId);
  const shotIndices = Array.isArray(prev.shotIndices) ? prev.shotIndices : [groupIdx];
  const beforeAnchor = anchorForStoryboard(prev);
  let nextStoryboard = selected
    ? writeLegacyFirstFrameFields(prev, selected, shotIndices)
    : clearLegacyFirstFrameFields(prev);
  nextStoryboard = {
    ...nextStoryboard,
    shotFrames: {
      ...shotFrames,
      [targetShotUid]: state,
    },
  };

  const afterAnchor = anchorForStoryboard(nextStoryboard);
  let videoInvalidated = false;
  if (beforeAnchor !== afterAnchor) {
    const now = opts.now || new Date().toISOString();
    const reason = opts.reason || 'first_frame_candidate_changed';
    nextStoryboard = markStoryboardVideoOutdated(nextStoryboard, reason, now);
    const videoTasks = Array.isArray(project?.videoTasks) ? [...project.videoTasks] : [];
    if (videoTasks[groupIdx] && hasVideoTaskArtifact(videoTasks[groupIdx])) {
      videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], reason, now);
      project = { ...project, videoTasks };
    }
    videoInvalidated = hasStoryboardVideoArtifact(prev) || hasVideoTaskArtifact(project?.videoTasks?.[groupIdx]);
  }

  storyboards[groupIdx] = nextStoryboard;
  return {
    project: { ...project, storyboards },
    storyboardChanged: true,
    videoInvalidated,
    selectedCandidate: selected,
  };
}

export function applyShotFrameCandidateAction(project: any, input: ShotFrameCandidateActionInput): {
  project: any;
  state: ShotFrameState;
  selectedCandidate?: ShotFrameCandidate;
  videoInvalidated: boolean;
} {
  const groupIdx = Number(input.groupIdx);
  if (!Number.isInteger(groupIdx) || groupIdx < 0) throw routeError('invalid_group_idx');
  const shotUid = cleanText(input.shotUid);
  if (!shotUid) throw routeError('missing_shot_uid');
  const validShotUids = shotUidsForGroup(project, groupIdx);
  if (!validShotUids.includes(shotUid)) throw routeError('shot_uid_not_in_group', 422);

  const storyboards = Array.isArray(project?.storyboards) ? [...project.storyboards] : [];
  const prev = storyboards[groupIdx] || {};
  const shotFrames = prev.shotFrames && typeof prev.shotFrames === 'object' ? { ...prev.shotFrames } : {};
  let state = normalizeShotFrameState(shotFrames[shotUid]);
  const originalCandidates = state.candidates;
  const candidateIds = new Set(originalCandidates.map((candidate) => candidate.id));

  if (input.action === 'select') {
    if (!candidateIds.has(input.candidateId)) throw routeError('candidate_not_found', 422);
    state = normalizeShotFrameState({ ...state, selectedCandidateId: input.candidateId });
  } else if (input.action === 'reorder') {
    const orderedIds = input.orderedIds.map(cleanText).filter(Boolean);
    const orderedSet = new Set(orderedIds);
    if (orderedIds.length !== originalCandidates.length || orderedSet.size !== candidateIds.size) {
      throw routeError('invalid_candidate_order', 422);
    }
    for (const id of orderedIds) {
      if (!candidateIds.has(id)) throw routeError('invalid_candidate_order', 422);
    }
    const byId = new Map(originalCandidates.map((candidate) => [candidate.id, candidate]));
    state = normalizeShotFrameState({
      candidates: orderedIds.map((id) => byId.get(id)),
      selectedCandidateId: orderedIds[orderedIds.length - 1],
    });
  } else if (input.action === 'delete') {
    const idx = originalCandidates.findIndex((candidate) => candidate.id === input.candidateId);
    if (idx < 0) throw routeError('candidate_not_found', 422);
    const remaining = originalCandidates.filter((candidate) => candidate.id !== input.candidateId);
    let selectedCandidateId = state.selectedCandidateId;
    if (selectedCandidateId === input.candidateId) {
      selectedCandidateId = remaining[idx]?.id || remaining[idx - 1]?.id;
    }
    state = normalizeShotFrameState({ candidates: remaining, selectedCandidateId });
  } else {
    throw routeError('unsupported_action');
  }

  shotFrames[shotUid] = state;
  storyboards[groupIdx] = {
    ...prev,
    shotFrames,
  };
  let nextProject = { ...project, storyboards };
  let videoInvalidated = false;
  if (shotUid === firstShotUidForGroup(project, groupIdx)) {
    const mirrored = mirrorSelectedFirstFrameToLegacyFields(nextProject, groupIdx, { shotUid });
    nextProject = mirrored.project;
    videoInvalidated = mirrored.videoInvalidated;
    state = normalizeShotFrameState(nextProject.storyboards?.[groupIdx]?.shotFrames?.[shotUid]);
  }

  return {
    project: nextProject,
    state,
    selectedCandidate: state.candidates.find((candidate) => candidate.id === state.selectedCandidateId),
    videoInvalidated,
  };
}
