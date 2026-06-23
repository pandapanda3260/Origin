export type EditReadiness = {
  totalCount: number;
  readyCount: number;
  canEnterEdit: boolean;
};

export function computeEditReadiness(project: any): EditReadiness {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  let readyCount = 0;
  for (let i = 0; i < storyboards.length; i += 1) {
    const sb = storyboards[i];
    const vt = videoTasks[i];
    if (sb && typeof sb.videoUrl === 'string' && sb.videoUrl.trim() && sb.videoIsCurrent !== false && vt?.isCurrent !== false) {
      readyCount += 1;
    }
  }
  return {
    totalCount: storyboards.length,
    readyCount,
    canEnterEdit: readyCount >= 1,
  };
}
