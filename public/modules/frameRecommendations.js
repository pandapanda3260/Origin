export function clipNum(v, min, max, dflt) {
  var n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export function firstFrameImageUrl(sb) {
  sb = sb || {};
  return (sb.frames && sb.frames.first && sb.frames.first.url) ||
    sb.firstFrameUrl ||
    (sb.firstFrame && sb.firstFrame.currentUrl) ||
    '';
}

export function tailFrameImageUrl(sb) {
  sb = sb || {};
  var tail = (sb.frames && sb.frames.tail) || null;
  return (tail && tail.url) || sb.tailFrameUrl || '';
}

export function canGenerateTailFrame(sb) {
  if (!sb) return false;
  var firstUrl =
    sb.firstFrameUrl ||
    (sb.frames && sb.frames.first && sb.frames.first.url) ||
    (sb.firstFrame && sb.firstFrame.currentUrl);
  if (!firstUrl) return false;
  var mode = String(sb.firstFrameMode || '');
  var framesFirstStatus = (sb.frames && sb.frames.first && sb.frames.first.status) || '';
  var firstFrameStatus = (sb.firstFrame && sb.firstFrame.status) || '';
  if (framesFirstStatus === 'failed' || firstFrameStatus === 'failed') return false;
  if (mode === 'legacy_pencil') return false;
  if (mode === 'structured_v1' || mode === 'multi_ref_v1') return true;
  if (framesFirstStatus === 'ready') return true;
  return false;
}

export function isTailRequested(sb) {
  sb = sb || {};
  return sb.tailFrameIntent === 'requested' || !!tailFrameImageUrl(sb);
}

function _normalizeTailFrameDependency(value) {
  var raw = String(value || '').trim();
  if (
    raw === 'requires_first_frame' ||
    raw === 'first_frame' ||
    raw === 'continuity' ||
    raw === 'continuous'
  ) return 'requires_first_frame';
  if (
    raw === 'independent' ||
    raw === 'standalone' ||
    raw === 'script_only' ||
    raw === 'asset_driven'
  ) return 'independent';
  return '';
}

function _tailSignalScore(signals, key) {
  var n = Number(signals && signals[key]);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

export function tailFrameDependencyForGroup(group, sb) {
  sb = sb || {};
  var explicitSb = _normalizeTailFrameDependency(
    sb.tailFrameDependency ||
    sb.tailFrameDependencyMode ||
    (sb.frames && sb.frames.tail && sb.frames.tail.dependency) ||
    (sb.tailFramePlanSummary && sb.tailFramePlanSummary.dependency)
  );
  if (explicitSb) return explicitSb;

  var shots = (group && Array.isArray(group.shots)) ? group.shots : [];
  var continuity = 0;
  var actionLanding = 0;
  var visualTransform = 0;
  var emotionPeak = 0;
  for (var i = 0; i < shots.length; i++) {
    var shot = shots[i] || {};
    var explicitShot = _normalizeTailFrameDependency(
      shot.tailFrameDependency ||
      shot.tailFrameDependencyMode ||
      (shot.tailFrameSignals && (shot.tailFrameSignals.dependency || shot.tailFrameSignals.dependencyMode))
    );
    if (explicitShot) return explicitShot;
    var signals = shot.tailFrameSignals && typeof shot.tailFrameSignals === 'object' ? shot.tailFrameSignals : {};
    continuity = Math.max(continuity, _tailSignalScore(signals, 'continuityNeed'));
    actionLanding = Math.max(actionLanding, _tailSignalScore(signals, 'actionLandingNeed'));
    visualTransform = Math.max(visualTransform, _tailSignalScore(signals, 'visualTransformationNeed'));
    emotionPeak = Math.max(emotionPeak, _tailSignalScore(signals, 'emotionPeakNeed'));
  }

  if (continuity >= 3 || actionLanding >= 3 || visualTransform >= 3 || emotionPeak >= 4) {
    return 'requires_first_frame';
  }
  return 'independent';
}

function _tailFrameStatus(sb) {
  sb = sb || {};
  var tail = (sb.frames && sb.frames.tail) || null;
  var tailUrl = tailFrameImageUrl(sb);
  return (tail && tail.status) || (sb.tailFrameLastError ? 'failed' : (tailUrl ? 'ready' : 'missing'));
}

export function tailFrameSuggestionForGroup(group, sb) {
  var shots = (group && Array.isArray(group.shots)) ? group.shots : [];
  if (!shots.length) return { level: 'none', score: 0, label: '' };
  if (isTailRequested(sb)) return { level: 'requested', score: 100, label: '已选择尾帧' };
  var weights = {
    actionLandingNeed: 18,
    visualTransformationNeed: 16,
    revealNeed: 16,
    endingCompositionNeed: 14,
    emotionPeakNeed: 12,
    continuityNeed: 0,
  };
  var weightTotal = 0;
  Object.keys(weights).forEach(function (k) { weightTotal += weights[k]; });
  var weighted = 0;
  var simpleDialogueCount = 0;
  var totalDuration = 0;
  shots.forEach(function (shot) {
    var sig = (shot && shot.tailFrameSignals) || {};
    Object.keys(weights).forEach(function (key) {
      weighted += clipNum(sig[key], 0, 5, 0) * weights[key];
    });
    if (sig.isSimpleStaticDialogue === true) simpleDialogueCount++;
    totalDuration += clipNum(shot.duration || shot.durationSec, 0, 120, 4);
  });
  var base = weighted / Math.max(1, shots.length * weightTotal * 5) * 100;
  var durationBonus = clipNum(totalDuration - 6, 0, 10, 0);
  var simpleDialoguePenalty = simpleDialogueCount === shots.length ? 15 : 0;
  var score = Math.round(clipNum(base + durationBonus - simpleDialoguePenalty, 0, 100, 0));
  if (score >= 70) return { level: 'strong', score: score, label: '强烈建议尾帧' };
  if (score >= 45) return { level: 'suggest', score: score, label: '建议尾帧' };
  return { level: 'none', score: score, label: '' };
}

export function tailFrameAdviceForGroup(group, sb) {
  sb = sb || {};
  var hidden = { kind: 'hidden', score: 0 };
  var shots = (group && Array.isArray(group.shots)) ? group.shots : [];
  if (!shots.length) return hidden;
  if (isTailRequested(sb)) return hidden;
  if (String(sb.firstFrameMode || '') === 'legacy_pencil') return hidden;
  var tailUiStatus = _tailFrameStatus(sb);
  if (tailUiStatus === 'ready' || tailUiStatus === 'degraded' || tailUiStatus === 'failed') {
    return hidden;
  }
  var hasAnySignals = shots.some(function (shot) {
    return shot && shot.tailFrameSignals && typeof shot.tailFrameSignals === 'object';
  });
  if (!hasAnySignals) return hidden;

  var suggestion = tailFrameSuggestionForGroup(group, sb);
  if (suggestion.level === 'requested') return hidden;

  var signalDefs = [
    { key: 'actionLandingNeed', label: '动作落点' },
    { key: 'visualTransformationNeed', label: '视觉转化' },
    { key: 'revealNeed', label: '揭示节点' },
    { key: 'endingCompositionNeed', label: '镜头收束' },
    { key: 'emotionPeakNeed', label: '情绪峰值' },
  ];
  var aggMax = {};
  var simpleDialogueCount = 0;
  var totalDuration = 0;
  shots.forEach(function (shot) {
    var sig = (shot && shot.tailFrameSignals) || {};
    signalDefs.forEach(function (def) {
      var v = clipNum(sig[def.key], 0, 5, 0);
      if (v > (aggMax[def.key] || 0)) aggMax[def.key] = v;
    });
    if (sig.isSimpleStaticDialogue === true) simpleDialogueCount++;
    totalDuration += clipNum(shot.duration || shot.durationSec, 0, 120, 4);
  });
  var reasonLongParts = signalDefs.map(function (def) {
    return def.label + ' ' + Math.round((aggMax[def.key] || 0) * 20);
  });
  var reasonLong = '评分 ' + suggestion.score + '：' + reasonLongParts.join(' / ');

  if (suggestion.level === 'strong' || suggestion.level === 'suggest') {
    var topSignals = signalDefs
      .map(function (def) { return { label: def.label, value: aggMax[def.key] || 0 }; })
      .filter(function (s) { return s.value >= 4; })
      .sort(function (a, b) { return b.value - a.value; })
      .slice(0, 2)
      .map(function (s) { return s.label; });
    var reasonShortPos = topSignals.length ? topSignals.join(' · ') : '镜头综合评分较高';
    return {
      kind: 'recommend',
      label: '建议生成尾帧',
      reasonShort: reasonShortPos,
      reasonLong: reasonLong,
      score: suggestion.score,
    };
  }

  var negParts = [];
  if (shots.length > 0 && simpleDialogueCount === shots.length) negParts.push('简单对白镜头');
  if (totalDuration < 6) negParts.push('时长较短');
  if (!negParts.length) negParts.push('镜头信号偏弱');
  return {
    kind: 'discourage',
    label: '不建议使用尾帧',
    reasonShort: negParts.join(' · ') + '，首帧主控更稳',
    reasonLong: reasonLong,
    score: suggestion.score,
  };
}

export function frameRecommendationForGroup(group, sb) {
  sb = sb || {};
  var idxs = Array.isArray(group && group.shotIndices) ? group.shotIndices : [];
  var isMerged = idxs.length > 1;
  var hasFirst = !!firstFrameImageUrl(sb);
  var hasTail = !!tailFrameImageUrl(sb);
  var requestedTail = isTailRequested(sb);
  var tailStatus = _tailFrameStatus(sb);
  var canTail = canGenerateTailFrame(sb);
  var tailDependency = tailFrameDependencyForGroup(group, sb);
  var suggestion = tailFrameSuggestionForGroup(group, sb);
  var tailAdvice = tailFrameAdviceForGroup(group, sb);

  if (!hasTail && !requestedTail && tailStatus !== 'failed') {
    if (isMerged) {
      tailAdvice = {
        kind: 'discourage',
        label: '不建议使用尾帧',
        reasonShort: '合并片段走首帧/参考图模式',
        reasonLong: '合并片段由段首首帧和素材参考控制画面，不自动生成尾帧。',
        score: null,
      };
    } else if (tailDependency === 'requires_first_frame' && !canTail) {
      tailAdvice = {
        kind: 'discourage',
        label: '暂不建议尾帧',
        reasonShort: '需先完成彩色首帧',
        reasonLong: '尾帧需要可用的彩色首帧作为锚点。',
        score: null,
      };
    }
  }

  var tailRecommended = !isMerged &&
    !hasTail &&
    !requestedTail &&
    (suggestion.level === 'strong' || suggestion.level === 'suggest');
  var tailNeedsAttention = tailStatus === 'failed';
  return {
    first: {
      recommended: !hasFirst,
      hasFrame: hasFirst,
      reason: hasFirst ? '首帧已生成' : '片段开场锚点',
      bannerKind: hasFirst ? 'hidden' : 'recommend',
      defaultCollapsed: false,
    },
    tail: {
      recommended: tailRecommended,
      hasFrame: hasTail,
      requested: requestedTail,
      dependency: tailDependency,
      requiresFirstFrame: tailDependency === 'requires_first_frame',
      canGenerate: tailDependency === 'requires_first_frame' ? canTail : true,
      level: suggestion.level,
      score: suggestion.score,
      reason: tailAdvice.reasonShort || '',
      advice: tailAdvice,
      bannerKind: tailAdvice.kind || 'hidden',
      defaultCollapsed: !(tailRecommended || hasTail || requestedTail || tailNeedsAttention),
    },
  };
}

export function tailFrameGenerationIntentForGroup(group, sb) {
  var recommendation = frameRecommendationForGroup(group, sb || {});
  var tail = recommendation.tail || {};
  var dependency = tail.dependency || tailFrameDependencyForGroup(group, sb || {});
  return {
    wanted: !!tail.requested || !!tail.recommended,
    recommended: !!tail.recommended,
    requested: !!tail.requested,
    hasFrame: !!tail.hasFrame,
    dependency: dependency,
    requiresFirstFrame: dependency === 'requires_first_frame',
    canGenerate: dependency === 'requires_first_frame' ? canGenerateTailFrame(sb || {}) : true,
    level: tail.level || 'none',
    reason: tail.reason || '',
    recommendation: recommendation,
  };
}

export function segmentInfoForShot(project, shotIdx) {
  var numericShotIdx = Number(shotIdx);
  if (!Number.isInteger(numericShotIdx)) numericShotIdx = 0;
  var sbs = (project && Array.isArray(project.storyboards)) ? project.storyboards : [];
  for (var g = 0; g < sbs.length; g++) {
    var sb = sbs[g];
    var idxs = sb && Array.isArray(sb.shotIndices) ? sb.shotIndices.map(function (v) { return Number(v); }) : [];
    if (idxs.indexOf(numericShotIdx) >= 0) {
      var anchor = Number.isInteger(idxs[0]) ? idxs[0] : numericShotIdx;
      return {
        groupIdx: g,
        groupNo: g + 1,
        shotIndices: idxs,
        anchorShotIdx: anchor,
        anchorShotNo: anchor + 1,
        isSegmentFirst: numericShotIdx === anchor,
        isSolo: idxs.length <= 1,
      };
    }
  }
  return {
    groupIdx: numericShotIdx,
    groupNo: numericShotIdx + 1,
    shotIndices: [numericShotIdx],
    anchorShotIdx: numericShotIdx,
    anchorShotNo: numericShotIdx + 1,
    isSegmentFirst: true,
    isSolo: true,
  };
}

export function frameCollapseKeyForGroup(projectId, group, gIdx, kind) {
  var idxs = Array.isArray(group && group.shotIndices) ? group.shotIndices : [];
  var normalized = idxs
    .map(function (v) { return Number(v); })
    .filter(function (v) { return Number.isInteger(v) && v >= 0; });
  var segmentKey = normalized.length ? normalized.join(',') : ('g' + String(gIdx));
  var projectKey = projectId == null ? 'local' : String(projectId);
  return 'frame:' + projectKey + ':' + segmentKey + ':' + String(kind || 'first');
}
