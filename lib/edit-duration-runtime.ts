function positiveDurationSec(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
}

function completedVideoStatus(value: unknown): boolean {
  const status = String(value || '').toLowerCase();
  return status === 'completed' || status === 'done';
}

function currentMatchedVideoTask(project: any, groupIdx: number) {
  const storyboards: any[] = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const videoTasks: any[] = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  const sb = storyboards[groupIdx];
  const vt = videoTasks[groupIdx];
  if (!sb || !vt) return null;
  const sbTaskId = String(sb.videoTaskId || '');
  const vtTaskId = String(vt.taskId || '');
  if (!sbTaskId || !vtTaskId || sbTaskId !== vtTaskId) return null;
  if (sb.videoIsCurrent === false || vt.isCurrent === false) return null;
  if (!completedVideoStatus(vt.status)) return null;
  return vt;
}

function taskDurationSec(task: any): number {
  return positiveDurationSec(task?.durationSec ?? task?.duration_sec);
}

function shotDurationSec(shot: any): number {
  const n = Number(shot?.duration ?? shot?.durationSec);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 4;
}

function projectShotIndices(sb: any): number[] {
  return Array.isArray(sb?.shotIndices)
    ? sb.shotIndices
        .map((value: any) => Number(value))
        .filter((value: number) => Number.isInteger(value) && value >= 0)
    : [];
}

function sumProjectShotDurations(project: any, sb: any): number {
  const shots: any[] = Array.isArray(project?.shots) ? project.shots : [];
  const indices = projectShotIndices(sb);
  if (!shots.length || !indices.length) return 0;
  let total = 0;
  for (const shotIdx of indices) {
    if (!shots[shotIdx]) continue;
    total += shotDurationSec(shots[shotIdx]);
  }
  return positiveDurationSec(total);
}

function sumEmbeddedShotDurations(sb: any): number {
  const shots: any[] = Array.isArray(sb?.shots) ? sb.shots : [];
  if (!shots.length) return 0;
  return positiveDurationSec(shots.reduce((sum, shot) => sum + shotDurationSec(shot), 0));
}

export function resolveTrustedActualDurationSec(project: any, groupIdx: number): number {
  const storyboards: any[] = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const sb = storyboards[groupIdx];
  if (!sb) return 0;

  const storyboardDuration = positiveDurationSec(sb.videoDurationSec);
  if (storyboardDuration > 0) return storyboardDuration;

  const vt = currentMatchedVideoTask(project, groupIdx);
  return taskDurationSec(vt);
}

export function resolveGroupImportDurationSec(project: any, groupIdx: number): number {
  const storyboards: any[] = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const sb = storyboards[groupIdx];
  if (!sb) return 5;

  const trustedActual = resolveTrustedActualDurationSec(project, groupIdx);
  if (trustedActual > 0) return trustedActual;

  const plannedDuration = positiveDurationSec(sb.plannedDurationSec);
  if (plannedDuration > 0) return plannedDuration;

  const storyboardDuration = positiveDurationSec(sb.durationSec ?? sb.duration);
  if (storyboardDuration > 0) return storyboardDuration;

  const projectShotDuration = sumProjectShotDurations(project, sb);
  if (projectShotDuration > 0) return projectShotDuration;

  const embeddedShotDuration = sumEmbeddedShotDurations(sb);
  if (embeddedShotDuration > 0) return embeddedShotDuration;

  return 5;
}
