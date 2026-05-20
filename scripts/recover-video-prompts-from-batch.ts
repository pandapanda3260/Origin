import { getDb } from '../lib/db';
import { patchProjectForUser } from '../lib/projects-db';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from '../lib/video-prompt-state';

type Args = {
  apply: boolean;
  markMissingFailed: boolean;
  projectId?: string;
  runId?: string;
};

type RecoveryCandidate = {
  projectId: string;
  ownerId: number;
  projectTitle: string;
  groupIdx: number;
  currentRunId: string;
  currentStatus: string;
  sourceBatchId: string | null;
  sourceTaskId: string | null;
  sourceTaskStatus: string | null;
  sourceBatchStatus: string | null;
  prompt: string;
  latestCompletedBatchId: string | null;
  latestCompletedHasPrompt: boolean;
  action: 'recover_from_current_run' | 'mark_retryable' | 'inspect';
  applied?: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, markMissingFailed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--mark-missing-failed') {
      args.markMissingFailed = true;
    } else if (arg === '--project') {
      args.projectId = argv[++i];
    } else if (arg === '--run-id') {
      args.runId = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log([
    'Usage: npx tsx scripts/recover-video-prompts-from-batch.ts [options]',
    '',
    'Options:',
    '  --project <projectId>       Limit scan to one project.',
    '  --run-id <batchId>          Limit scan to one current videoPromptRunId.',
    '  --apply                     Write recoverable prompts back to projects.',
    '  --mark-missing-failed       With --apply, mark no-result stuck items as failed/retryable.',
    '',
    'Default mode is dry-run. Recovery only trusts the batch currently stored on the storyboard.',
  ].join('\n'));
}

function parseJson(value: string | null | undefined): any {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function taskGroupIdx(task: any): number | null {
  const target = parseJson(task?.target_json);
  const raw = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
  const groupIdx = Number(raw);
  if (!Number.isFinite(groupIdx) || groupIdx < 0) return null;
  return Math.floor(groupIdx);
}

function promptFromResult(result: any): string {
  const extraPrompt = result?.extra?.videoPrompt;
  const patchPrompt = result?.patch?.type === 'video_prompt' ? result?.patch?.value : '';
  return String(extraPrompt || patchPrompt || '').trim();
}

function findPromptForCurrentRun(db: ReturnType<typeof getDb>, batchId: string, groupIdx: number) {
  const rows = db
    .prepare<{ batchId: string }, any>(
      `SELECT bt.*, b.status AS batch_status
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE bt.batch_id = @batchId
        ORDER BY bt.seq ASC`,
    )
    .all({ batchId });
  for (const row of rows) {
    if (taskGroupIdx(row) !== groupIdx) continue;
    const result = parseJson(row.result_json);
    const prompt = promptFromResult(result);
    return {
      taskId: String(row.id || ''),
      taskStatus: String(row.status || ''),
      batchStatus: String(row.batch_status || ''),
      prompt,
    };
  }
  return null;
}

function findLatestCompletedPromptForAudit(db: ReturnType<typeof getDb>, projectId: string, groupIdx: number) {
  const rows = db
    .prepare<{ projectId: string }, any>(
      `SELECT bt.*, b.id AS batch_id, b.status AS batch_status, b.updated_at AS batch_updated_at
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE b.project_id = @projectId
          AND b.batch_type = 'video_prompts'
          AND bt.status = 'completed'
        ORDER BY b.updated_at DESC, bt.seq ASC`,
    )
    .all({ projectId });
  for (const row of rows) {
    if (taskGroupIdx(row) !== groupIdx) continue;
    const prompt = promptFromResult(parseJson(row.result_json));
    if (prompt) return { batchId: String(row.batch_id || ''), prompt };
  }
  return null;
}

function collectCandidates(args: Args): RecoveryCandidate[] {
  const db = getDb();
  const rows = db
    .prepare<any, any>(
      `SELECT id, owner_id, title, data_json
         FROM projects
        WHERE (@projectId IS NULL OR id = @projectId)
        ORDER BY updated_at DESC`,
    )
    .all({ projectId: args.projectId || null });
  const candidates: RecoveryCandidate[] = [];
  for (const row of rows) {
    const data = parseJson(row.data_json);
    const storyboards = Array.isArray(data.storyboards) ? data.storyboards : [];
    storyboards.forEach((sb: any, groupIdx: number) => {
      const currentRunId = String(sb?.videoPromptRunId || '').trim();
      const hasPrompt = !!String(sb?.videoPrompt || '').trim();
      if (hasPrompt || sb?.videoPromptStatus !== 'generating' || !currentRunId) return;
      if (args.runId && currentRunId !== args.runId) return;

      const source = findPromptForCurrentRun(db, currentRunId, groupIdx);
      const latest = findLatestCompletedPromptForAudit(db, String(row.id), groupIdx);
      const prompt = source?.prompt || '';
      candidates.push({
        projectId: String(row.id),
        ownerId: Number(row.owner_id),
        projectTitle: String(row.title || ''),
        groupIdx,
        currentRunId,
        currentStatus: String(sb.videoPromptStatus || ''),
        sourceBatchId: source ? currentRunId : null,
        sourceTaskId: source?.taskId || null,
        sourceTaskStatus: source?.taskStatus || null,
        sourceBatchStatus: source?.batchStatus || null,
        prompt,
        latestCompletedBatchId: latest?.batchId || null,
        latestCompletedHasPrompt: !!latest?.prompt,
        action: prompt ? 'recover_from_current_run' : (args.markMissingFailed ? 'mark_retryable' : 'inspect'),
      });
    });
  }
  return candidates;
}

function applyCandidate(candidate: RecoveryCandidate) {
  const now = new Date().toISOString();
  const updated = patchProjectForUser(candidate.projectId, candidate.ownerId, (fresh) => {
    if (!fresh) return null;
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const prev = storyboards[candidate.groupIdx] || {};
    if (String(prev.videoPrompt || '').trim()) return null;
    if (prev.videoPromptStatus !== 'generating') return null;
    if (prev.videoPromptRunId !== candidate.currentRunId) return null;

    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    if (candidate.prompt) {
      storyboards[candidate.groupIdx] = {
        ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', now),
        idx: candidate.groupIdx,
        shotIdx: candidate.groupIdx + 1,
        videoPrompt: candidate.prompt,
        videoPromptStatus: 'ready',
        videoPromptRunId: candidate.currentRunId,
        videoPromptUpdatedAt: now,
        videoPromptLastError: undefined,
        videoPromptFailedAt: undefined,
      };
    } else {
      storyboards[candidate.groupIdx] = {
        ...markStoryboardVideoOutdated(prev, 'video_prompt_failed', now),
        idx: candidate.groupIdx,
        shotIdx: candidate.groupIdx + 1,
        videoPromptStatus: 'failed',
        videoPromptRunId: candidate.currentRunId,
        videoPromptFailedAt: now,
        videoPromptLastError: '旧批次没有可回填的视频提示词，请重新生成',
      };
    }
    if (videoTasks.length > candidate.groupIdx && videoTasks[candidate.groupIdx]) {
      videoTasks[candidate.groupIdx] = markVideoTaskOutdated(
        videoTasks[candidate.groupIdx],
        candidate.prompt ? 'video_prompt_regeneration' : 'video_prompt_failed',
        now,
      );
    }
    return { storyboards, videoTasks };
  });
  const sb = Array.isArray((updated as any)?.storyboards)
    ? (updated as any).storyboards[candidate.groupIdx] || {}
    : {};
  candidate.applied = candidate.prompt
    ? sb.videoPromptStatus === 'ready' && String(sb.videoPrompt || '').trim() === candidate.prompt
    : sb.videoPromptStatus === 'failed';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = collectCandidates(args);
  const writable = candidates.filter((item) => item.prompt || args.markMissingFailed);
  if (args.apply) {
    writable.forEach(applyCandidate);
  }
  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    projectId: args.projectId || null,
    runId: args.runId || null,
    scannedStuckCount: candidates.length,
    writableCount: writable.length,
    candidates: candidates.map((item) => ({
      projectId: item.projectId,
      projectTitle: item.projectTitle,
      groupIdx: item.groupIdx,
      shotLabel: item.groupIdx + 1,
      currentRunId: item.currentRunId,
      sourceBatchId: item.sourceBatchId,
      sourceTaskId: item.sourceTaskId,
      sourceTaskStatus: item.sourceTaskStatus,
      sourceBatchStatus: item.sourceBatchStatus,
      hasRecoverablePrompt: !!item.prompt,
      promptSummary: item.prompt ? `${item.prompt.slice(0, 120)}${item.prompt.length > 120 ? '...' : ''}` : '',
      latestCompletedBatchId: item.latestCompletedBatchId,
      latestCompletedHasPrompt: item.latestCompletedHasPrompt,
      action: item.action,
      applied: item.applied ?? false,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
