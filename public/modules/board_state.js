import { firstFrameImageUrl } from '/modules/frameRecommendations.js';
import { resolveCharacterImageUrl, resolvePropImageUrl, resolveSceneImageUrl } from '/modules/asset_display_state.js';
export { resolveCharacterImageUrl, resolvePropImageUrl, resolveSceneImageUrl } from '/modules/asset_display_state.js';

const REF_W = 280;
const PLAN_W = 280;
const SEG_W = 440;
const VID_W = 260;
const GAP_X = 140;
const GAP_Y = 36;
const ROW_H = 124;
const SEG_PAD_Y = 58;

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstAssetUrl(...values) {
  for (const value of values) {
    const url = text(value);
    if (url) return url;
  }
  return '';
}

export function resolveVideoCoverUrl(project, groupIdx) {
  const storyboards = arr(asObject(project).storyboards);
  const videoTasks = arr(asObject(project).videoTasks);
  const sb = asObject(storyboards[groupIdx]);
  const vt = asObject(videoTasks[groupIdx]);
  return firstAssetUrl(sb.videoCoverUrl, vt.coverUrl, firstFrameImageUrl(sb));
}

export function resolveVideoStatus(project, groupIdx) {
  const storyboards = arr(asObject(project).storyboards);
  const videoTasks = arr(asObject(project).videoTasks);
  const sb = asObject(storyboards[groupIdx]);
  const vt = asObject(videoTasks[groupIdx]);
  const rawStatus = text(sb.videoStatus || vt.status).toLowerCase();
  if (rawStatus === 'failed' || rawStatus === 'timeout' || rawStatus === 'error') return 'failed';
  if (rawStatus === 'generating' || rawStatus === 'running' || rawStatus === 'queued') return 'generating';
  if (sb.videoIsCurrent === false || vt.isCurrent === false || vt.outdated) return 'outdated';
  if ((rawStatus === 'succeeded' || rawStatus === 'done' || rawStatus === 'completed') && vt.filename) return 'ready';
  if (sb.videoTaskId || vt.taskId || sb.videoUrl || vt.url || vt.protectedUrl) return 'ready';
  return 'missing';
}

function shotUidOf(project, shotIdx) {
  const shot = arr(asObject(project).shots)[shotIdx] || {};
  return text(shot.shotUid ?? shot.shot_uid);
}

function boardCandidateFromShotFrame(candidate, selectedCandidateId, idx) {
  const item = asObject(candidate);
  const id = text(item.id) || `candidate-${idx + 1}`;
  const url = text(item.url);
  if (!url) return null;
  return {
    id,
    url,
    source: text(item.source),
    mode: text(item.mode),
    status: text(item.status) || 'ready',
    label: text(item.label) || `候选 ${idx + 1}`,
    selected: id === selectedCandidateId,
    metadataTier: text(item.metadataTier),
  };
}

function videoHistoryRowsForGroup(opts, groupIdx) {
  const source = opts?.videoHistoriesByGroup;
  if (!source) return [];
  if (source instanceof Map) {
    return arr(source.get(groupIdx) || source.get(String(groupIdx)));
  }
  if (typeof source === 'object') {
    return arr(source[groupIdx] || source[String(groupIdx)]);
  }
  return [];
}

function videoCandidateFromHistory(row, selectedTaskId, idx) {
  const item = asObject(row);
  const taskId = text(item.taskId || item.task_id || item.id);
  if (!taskId) return null;
  return {
    taskId,
    coverUrl: text(item.coverUrl || item.cover_url),
    playbackUrl: text(item.playbackUrl || item.url),
    protectedUrl: text(item.protectedUrl || item.protected_url),
    status: text(item.status) || 'completed',
    durationSec: numberOrZero(item.durationSec ?? item.duration_sec),
    prompt: text(item.prompt),
    createdAt: text(item.createdAt || item.created_at),
    isCurrent: item.isCurrent === true || item.is_current === true,
    selected: taskId === selectedTaskId,
    label: text(item.label || item.title || item.name) || `候选 ${idx + 1}`,
  };
}

function shotFrameCandidatesForRow(sb, group, rowIdx, shotIdx, shotUid, coverUrl) {
  const shotFrames = asObject(sb.shotFrames);
  const state = shotUid ? asObject(shotFrames[shotUid]) : {};
  const selectedCandidateId = text(state.selectedCandidateId);
  const candidates = arr(state.candidates)
    .map((candidate, idx) => boardCandidateFromShotFrame(candidate, selectedCandidateId, idx))
    .filter(Boolean);
  if (candidates.length) return { candidates, selectedCandidateId };
  if (coverUrl && rowIdx === 0) {
    return {
      selectedCandidateId: `first:${group.gIdx}:${shotIdx}`,
      candidates: [{
        id: `first:${group.gIdx}:${shotIdx}`,
        url: coverUrl,
        kind: 'segment-cover-placeholder',
        label: '片段封面占位',
        selected: true,
        readOnly: true,
      }],
    };
  }
  return { candidates: [], selectedCandidateId: '' };
}

function groupsFromProject(project, opts) {
  const storyboards = arr(asObject(project).storyboards);
  const groups = arr(opts && opts.groups);
  if (groups.length) {
    return groups.map((group, idx) => {
      const gIdx = Number.isInteger(Number(group && (group.gIdx ?? group.groupIdx))) ? Number(group.gIdx ?? group.groupIdx) : idx;
      const sb = asObject(storyboards[gIdx]);
      const shotIndices = arr(group && group.shotIndices).length ? arr(group.shotIndices) : (arr(sb.shotIndices).length ? arr(sb.shotIndices) : [gIdx]);
      return { gIdx, shotIndices: shotIndices.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0) };
    });
  }
  return storyboards.map((sb, gIdx) => {
    const shotIndices = arr(sb && sb.shotIndices).length ? arr(sb.shotIndices) : [gIdx];
    return { gIdx, shotIndices: shotIndices.map((value) => Number(value)).filter((n) => Number.isInteger(n) && n >= 0) };
  });
}

function buildReference(project) {
  const assets = asObject(asObject(project).assets);
  const characters = arr(assets.characters).map((item, idx) => ({
    id: text(item && (item.id || item.characterId || item.name)) || `character-${idx + 1}`,
    name: text(item && item.name) || `角色${idx + 1}`,
    coverUrl: resolveCharacterImageUrl(project, item, idx),
  }));
  const scenes = arr(assets.scenes).map((item, idx) => ({
    id: text(item && (item.id || item.sceneId || item.name)) || `scene-${idx + 1}`,
    name: text(item && item.name) || `场景${idx + 1}`,
    coverUrl: resolveSceneImageUrl(item, 'establishing'),
  }));
  const props = arr(assets.props).map((item, idx) => ({
    id: text(item && (item.id || item.propId || item.name)) || `prop-${idx + 1}`,
    name: text(item && item.name) || `道具${idx + 1}`,
    coverUrl: resolvePropImageUrl(item),
  }));
  return {
    empty: characters.length + scenes.length + props.length === 0,
    characters,
    scenes,
    props,
  };
}

function buildShotPlan(project) {
  const shots = arr(asObject(project).shots);
  return {
    generated: shots.length > 0,
    shotCount: shots.length,
    steps: {
      confirmShots: !!project.shotsApproved,
      prepareAssets: !!project.assetsApproved,
      composePrompt: !!(project.videoPromptsApproved || project.promptsApproved),
    },
  };
}

function buildSegments(project, opts) {
  const storyboards = arr(asObject(project).storyboards);
  return groupsFromProject(project, opts).map((group) => {
    const sb = asObject(storyboards[group.gIdx]);
    const coverUrl = firstFrameImageUrl(sb);
    const shotRows = group.shotIndices.map((shotIdx, rowIdx) => {
      const shotUid = shotUidOf(project, shotIdx);
      const shotFrames = shotFrameCandidatesForRow(sb, group, rowIdx, shotIdx, shotUid, coverUrl);
      return {
        shotIdx,
        shotUid,
        selectedCandidateId: shotFrames.selectedCandidateId,
        candidates: shotFrames.candidates,
        coverUrl,
        readOnlyReason: shotUid ? '' : 'missing_shot_uid',
      };
    });
    const videoTask = asObject(arr(project.videoTasks)[group.gIdx]);
    const selectedTaskId = text(sb.videoTaskId || videoTask.taskId);
    const videoCandidates = videoHistoryRowsForGroup(opts, group.gIdx)
      .map((row, idx) => videoCandidateFromHistory(row, selectedTaskId, idx))
      .filter(Boolean);
    return {
      gIdx: group.gIdx,
      shotIndices: group.shotIndices,
      shotRows,
      coverUrl,
      video: {
        gIdx: group.gIdx,
        coverUrl: resolveVideoCoverUrl(project, group.gIdx),
        status: resolveVideoStatus(project, group.gIdx),
        selectedTaskId,
        candidates: videoCandidates,
      },
    };
  });
}

function layoutBoard(model) {
  const colRef = 0;
  const colPlan = colRef + REF_W + GAP_X;
  const colSeg = colPlan + PLAN_W + GAP_X;
  const colVid = colSeg + SEG_W + GAP_X;
  const segYs = [];
  let cursorY = 0;
  model.segments.forEach((segment) => {
    const rows = Math.max(1, segment.shotRows.length);
    const h = SEG_PAD_Y + rows * ROW_H;
    segYs.push({ gIdx: segment.gIdx, y: cursorY, h });
    cursorY += h + GAP_Y;
  });
  const stackH = Math.max(260, cursorY ? cursorY - GAP_Y : 260);
  const refH = model.reference.empty ? 220 : Math.min(560, Math.max(260, 120 + (model.reference.characters.length + model.reference.scenes.length + model.reference.props.length) * 44));
  const planH = 240;
  const nodes = [
    { id: 'reference', kind: 'reference', x: colRef, y: (stackH - refH) / 2, w: REF_W, h: refH, data: model.reference },
    { id: 'shot-plan', kind: 'shot-plan', x: colPlan, y: (stackH - planH) / 2, w: PLAN_W, h: planH, data: model.shotPlan },
  ];
  segYs.forEach((slot) => {
    const segment = model.segments.find((item) => item.gIdx === slot.gIdx);
    nodes.push({ id: `segment:${slot.gIdx}`, kind: 'segment', x: colSeg, y: slot.y, w: SEG_W, h: slot.h, data: segment });
    nodes.push({ id: `video:${slot.gIdx}`, kind: 'video', x: colVid, y: slot.y, w: VID_W, h: slot.h, data: segment.video });
  });
  const edges = [{ from: 'reference', to: 'shot-plan' }];
  model.segments.forEach((segment) => {
    edges.push({ from: 'shot-plan', to: `segment:${segment.gIdx}` });
    edges.push({ from: `segment:${segment.gIdx}`, to: `video:${segment.gIdx}` });
  });
  return { nodes, edges, bounds: { x: 0, y: 0, w: colVid + VID_W, h: stackH } };
}

export function buildBoardViewModel(project, opts = {}) {
  project = asObject(project);
  const model = {
    reference: buildReference(project),
    shotPlan: buildShotPlan(project),
    segments: buildSegments(project, opts),
  };
  const layout = layoutBoard(model);
  return { ...model, ...layout };
}
