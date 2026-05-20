import {
  describeArtifactStatus,
  type ArtifactUsageDecision,
  type TargetArtifact,
} from './artifact-usage-guard';

export const PROJECT_STATUS_ARTIFACTS: TargetArtifact[] = [
  'shot_plan',
  'storyboard_image',
  'video_prompt',
  'video_segment',
];

export function describeProjectArtifactStatus(
  project: any,
  projectId: string,
  opts: {
    artifacts?: Iterable<TargetArtifact>;
    includeSnapshots?: boolean;
    includeUsable?: boolean;
    consumerOperation?: string;
  } = {},
): ArtifactUsageDecision[] {
  const artifacts = new Set(opts.artifacts || PROJECT_STATUS_ARTIFACTS);
  const decisions: ArtifactUsageDecision[] = [];
  if (artifacts.has('shot_plan')) {
    decisions.push(describeArtifactStatus(project, {
      projectId,
      targetArtifact: 'shot_plan',
      consumerOperation: opts.consumerOperation,
      includeSnapshots: opts.includeSnapshots,
    }));
  }

  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  for (let groupIdx = 0; groupIdx < storyboards.length; groupIdx += 1) {
    for (const targetArtifact of PROJECT_STATUS_ARTIFACTS) {
      if (targetArtifact === 'shot_plan' || !artifacts.has(targetArtifact)) continue;
      decisions.push(describeArtifactStatus(project, {
        projectId,
        targetArtifact,
        groupIdx,
        consumerOperation: opts.consumerOperation,
        includeSnapshots: opts.includeSnapshots,
      }));
    }
  }

  return opts.includeUsable ? decisions : decisions.filter((decision) => decision.usability !== 'USABLE');
}
