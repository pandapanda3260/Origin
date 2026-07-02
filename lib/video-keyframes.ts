import { resolveLocalImagePath } from './image-gen';
import { shotDurationSec } from './segment-planning';
import {
  canonicalShotUid,
  selectedShotFrameCandidate,
  type ShotFrameCandidate,
} from './shot-frame-candidates';

export type VideoKeyframeReference = {
  role: 'keyframe';
  path: string;
  url: string;
  shotUid: string;
  shotIdx: number;
  orderIndex: number;
  candidateId: string;
  atSecHint: number;
};

export type DroppedVideoKeyframe = {
  shotUid: string;
  shotIdx: number;
  orderIndex: number;
  reason: 'missing_shot_uid' | 'missing_candidate' | 'candidate_not_ready' | 'file_unresolvable';
};

export type CollectSelectedShotKeyframesResult = {
  keyframes: VideoKeyframeReference[];
  dropped: DroppedVideoKeyframe[];
};

function roundSec(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampAtSec(value: number, durationSec?: number): number {
  const upper = Number(durationSec);
  if (!Number.isFinite(upper) || upper <= 0) return roundSec(Math.max(0, value));
  return roundSec(Math.max(0, Math.min(value, upper)));
}

export function collectSelectedShotKeyframes(input: {
  project?: any;
  storyboard?: any;
  shots?: any[];
  groupShotIndices?: number[];
  ownerId: number;
  durationSec?: number;
}): CollectSelectedShotKeyframesResult {
  const project = input.project || {};
  const storyboard = input.storyboard || {};
  const shots = Array.isArray(input.shots) ? input.shots : (Array.isArray(project?.shots) ? project.shots : []);
  const groupShotIndices = Array.isArray(input.groupShotIndices)
    ? input.groupShotIndices
    : (Array.isArray(storyboard?.shotIndices) ? storyboard.shotIndices : []);
  const shotFrames = storyboard?.shotFrames && typeof storyboard.shotFrames === 'object'
    ? storyboard.shotFrames
    : {};
  const keyframes: VideoKeyframeReference[] = [];
  const dropped: DroppedVideoKeyframe[] = [];
  let elapsedSec = 0;

  groupShotIndices.forEach((rawShotIdx: number, orderIndex: number) => {
    const shotIdx = Number(rawShotIdx);
    const shot = Number.isInteger(shotIdx) && shotIdx >= 0 ? shots[shotIdx] : null;
    const shotUid = canonicalShotUid(shot);
    const atSecHint = clampAtSec(elapsedSec, input.durationSec);
    elapsedSec += shotDurationSec(shot);

    if (!shotUid) {
      dropped.push({ shotUid: '', shotIdx, orderIndex, reason: 'missing_shot_uid' });
      return;
    }

    const candidate = selectedShotFrameCandidate(shotFrames[shotUid]) as ShotFrameCandidate | undefined;
    if (!candidate) {
      dropped.push({ shotUid, shotIdx, orderIndex, reason: 'missing_candidate' });
      return;
    }
    if (String(candidate.status || 'ready') !== 'ready') {
      dropped.push({ shotUid, shotIdx, orderIndex, reason: 'candidate_not_ready' });
      return;
    }

    const path = resolveLocalImagePath(candidate.url, input.ownerId);
    if (!path) {
      dropped.push({ shotUid, shotIdx, orderIndex, reason: 'file_unresolvable' });
      return;
    }

    keyframes.push({
      role: 'keyframe',
      path,
      url: candidate.url,
      shotUid,
      shotIdx,
      orderIndex,
      candidateId: candidate.id,
      atSecHint,
    });
  });

  return { keyframes, dropped };
}
