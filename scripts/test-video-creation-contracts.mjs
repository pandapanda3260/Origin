import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const videoByProjectSource = readFileSync(new URL('../app/api/tasks/video-by-project/route.ts', import.meta.url), 'utf8');
const editTimelineSource = readFileSync(new URL('../app/api/edit/timeline/route.ts', import.meta.url), 'utf8');
const editReadinessSource = readFileSync(new URL('../lib/video-creation/edit-readiness.ts', import.meta.url), 'utf8');
const batchStartSource = readFileSync(new URL('../app/api/batch/start/route.ts', import.meta.url), 'utf8');
const startRunsSource = readFileSync(new URL('../lib/video-creation/start-runs.ts', import.meta.url), 'utf8');
const promptReadinessSource = readFileSync(new URL('../lib/video-creation/prompt-readiness.ts', import.meta.url), 'utf8');
const batchExecutorsSource = readFileSync(new URL('../lib/batch-executors.ts', import.meta.url), 'utf8');
const draftCommitSource = readFileSync(new URL('../lib/video-prompt-draft-commit.ts', import.meta.url), 'utf8');
const promptsStartRouteSource = readFileSync(new URL('../app/api/video-creation/prompts/start/route.ts', import.meta.url), 'utf8');
const videosStartRouteSource = readFileSync(new URL('../app/api/video-creation/videos/start/route.ts', import.meta.url), 'utf8');
const videoStateSource = readFileSync(new URL('../lib/video-creation/state.ts', import.meta.url), 'utf8');
const videoHistorySource = readFileSync(new URL('../lib/video-creation/history.ts', import.meta.url), 'utf8');
const videoUrlsSource = readFileSync(new URL('../lib/video-creation/urls.ts', import.meta.url), 'utf8');
const currentVideoSource = readFileSync(new URL('../lib/video-creation/current-video.ts', import.meta.url), 'utf8');
const stateRouteSource = readFileSync(new URL('../app/api/video-creation/state/route.ts', import.meta.url), 'utf8');
const historyRouteSource = readFileSync(new URL('../app/api/video-creation/videos/history/route.ts', import.meta.url), 'utf8');
const currentRouteSource = readFileSync(new URL('../app/api/video-creation/videos/current/route.ts', import.meta.url), 'utf8');
const importRouteSource = readFileSync(new URL('../app/api/video-creation/videos/import/route.ts', import.meta.url), 'utf8');
const editTimelineRouteSource = readFileSync(new URL('../app/api/edit/timeline/route.ts', import.meta.url), 'utf8');
const importToEditSource = readFileSync(new URL('../lib/video-creation/import-to-edit.ts', import.meta.url), 'utf8');
const videoTasksFrontendSource = readFileSync(new URL('../public/modules/videoTasks.js', import.meta.url), 'utf8');
const videoPromptsFrontendSource = readFileSync(new URL('../public/modules/videoPrompts.js', import.meta.url), 'utf8');
const workspaceSource = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');

function sectionBetween(source, start, end, label) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `${label}: missing start marker ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `${label}: missing end marker ${end}`);
  return source.slice(startIndex, endIndex);
}

const setCurrentSection = currentVideoSource;

assert.match(
  setCurrentSection,
  /const protectedUrl = buildProtectedVideoUrl\(row\.id\);/,
  'set-current must derive a persistent protected video URL',
);

assert.match(
  setCurrentSection,
  /const signedUrl = buildSignedVideoPlaybackUrl\(row\.id, args\.ownerId\);/,
  'set-current may still build a signed playback URL for the response',
);

assert.match(
  setCurrentSection,
  /sb\.videoUrl = protectedUrl;/,
  'storyboard videoUrl must persist the protected URL, not the expiring signed URL',
);

assert.doesNotMatch(
  setCurrentSection,
  /sb\.videoUrl = signedUrl;/,
  'storyboard videoUrl must not persist signed URLs',
);

assert.match(
  setCurrentSection,
  /videoUrl: protectedUrl,/,
  'EDL timeline videoUrl must persist the protected URL, not the expiring signed URL',
);

assert.doesNotMatch(
  setCurrentSection,
  /videoUrl: signedUrl,/,
  'EDL timeline videoUrl must not persist signed URLs',
);

assert.match(
  setCurrentSection,
  /url: signedUrl,/,
  'set-current response must keep returning a signed playback URL for clients',
);

assert.match(
  setCurrentSection,
  /protectedUrl,/,
  'set-current response must keep returning the protected URL',
);

assert.match(
  videoByProjectSource,
  /setCurrentVideoForGroup\(/,
  'legacy video-by-project POST must delegate set-current to current-video service',
);

assert.match(
  videoByProjectSource,
  /deleteCurrentVideoForGroup\(/,
  'legacy video-by-project DELETE must delegate deletion to current-video service',
);

for (const field of [
  'videoUrl',
  '_originVideoUrl',
  'videoTaskId',
  'videoCoverUrl',
  'videoStatus',
  'videoMode',
  'videoTaskFinishedAt',
  'videoDurationSec',
  'videoFilename',
  'videoDisplayName',
  'videoDownloadFilename',
  'readyForEdit',
  'videoWarnings',
  'videoIsCurrent',
  'videoAssetId',
]) {
  assert.match(
    currentVideoSource,
    new RegExp(`delete next\\.${field};`),
    `delete current video must clear storyboard field ${field}`,
  );
}

assert.match(
  currentRouteSource,
  /setCurrentVideoForGroup\(/,
  'new current route POST must use current-video service',
);

assert.match(
  currentRouteSource,
  /deleteCurrentVideoForGroup\(/,
  'new current route DELETE must use current-video service',
);

assert.match(
  importRouteSource,
  /importVideoGroupToEdit\(/,
  'video import endpoint must delegate to the shared import-to-edit service',
);

assert.doesNotMatch(
  importRouteSource,
  /POST as postEditTimeline|new NextRequest\(/,
  'video import endpoint must not call another route handler via a synthetic request',
);

assert.match(
  editTimelineRouteSource,
  /case 'import-group':[\s\S]*?applyImportGroupToEdit\(proj, idx\)/,
  'edit timeline import-group branch must use the shared import-to-edit implementation',
);

assert.match(
  importToEditSource,
  /export function applyImportGroupToEdit/,
  'import-to-edit service must expose the authoritative import-group mutation',
);

assert.match(
  importToEditSource,
  /sb\.videoIsCurrent === false \|\| vt\?\.isCurrent === false/,
  'import-to-edit service must keep the stale video import gate',
);

assert.match(
  importToEditSource,
  /syncEditProjectClips\(/,
  'import-to-edit high-level service must keep edit clip sync side effect',
);

for (const path of [
  '/api/video-creation/videos/start',
  '/api/video-creation/state',
  '/api/video-creation/videos/history',
  '/api/video-creation/videos/current',
  '/api/video-creation/videos/import',
]) {
  assert.match(
    videoTasksFrontendSource,
    new RegExp(path.replace(/\//g, '\\/')),
    `videoTasks frontend must call ${path}`,
  );
}

assert.doesNotMatch(
  videoTasksFrontendSource,
  /apiPost\(["']\/api\/batch\/start["']/,
  'videoTasks frontend must not start video generation through legacy /api/batch/start',
);

assert.doesNotMatch(
  videoTasksFrontendSource,
  /api(?:Get|Post)\(["']\/api\/tasks\/video-by-project/,
  'videoTasks frontend must not call legacy video-by-project adapter for video creation actions',
);

assert.match(
  videoPromptsFrontendSource,
  /apiPost\(['"]\/api\/video-creation\/prompts\/start['"]/,
  'videoPrompts frontend must start prompt generation through video-creation prompts/start',
);

assert.doesNotMatch(
  videoPromptsFrontendSource,
  /apiPost\(['"]\/api\/batch\/start['"]/,
  'videoPrompts frontend must not start prompt generation through legacy /api/batch/start',
);

assert.match(
  workspaceSource,
  /"\/modules\/videoTasks\.js":\s*"\/modules\/videoTasks\.js\?v=309"/,
  'workspace import map must cache-bust updated videoTasks module',
);

assert.match(
  workspaceSource,
  /"\/modules\/videoPrompts\.js":\s*"\/modules\/videoPrompts\.js\?v=119"/,
  'workspace import map must cache-bust updated videoPrompts module',
);

assert.match(
  videoStateSource,
  /FROM video_tasks/,
  'video creation state must merge latest video_tasks rows for refresh recovery',
);

assert.match(
  videoStateSource,
  /error_msg/,
  'video creation state must read video_tasks.error_msg',
);

assert.match(
  videoStateSource,
  /errorMsg,/,
  'video creation state response must expose video.errorMsg',
);

assert.match(
  videoStateSource,
  /latestRowStatus === 'failed'/,
  'video creation state must preserve failed task status from latest video_tasks row',
);

assert.match(
  videoStateSource,
  /storyboardShotIndices\(project, groupIdx, sb, \{ mode: 'single-shot-strict' \}\)/,
  'video creation state must keep current-slot filtering before projecting task rows',
);

for (const [label, source] of [
  ['current video service', currentVideoSource],
  ['edit timeline route', editTimelineSource],
]) {
  assert.match(
    source,
    /import \{ computeEditReadiness \} from '(?:@\/lib\/video-creation\/edit-readiness|\.\/edit-readiness)';/,
    `${label} must use the shared edit-readiness producer`,
  );
  assert.doesNotMatch(
    source,
    /function computeReadiness\(/,
    `${label} must not keep a private edit-readiness producer`,
  );
}

assert.match(
  editReadinessSource,
  /canEnterEdit: readyCount >= 1/,
  'edit readiness must preserve the existing partial-enter-edit threshold',
);

assert.match(
  editReadinessSource,
  /sb\.videoIsCurrent !== false && vt\?\.isCurrent !== false/,
  'edit readiness must keep blocking stale/outdated videos',
);

assert.match(
  promptReadinessSource,
  /assertVideoPromptReadyForGroups\(project, groupIdxs, target, opts\)/,
  'video generation gate must reuse assertVideoPromptReadyForGroups',
);

assert.match(
  promptReadinessSource,
  /deriveVideoPromptReadiness\(sb, groupIdx\)/,
  'video prompt UI projection must reuse deriveVideoPromptReadiness',
);

assert.match(
  promptReadinessSource,
  /export function canDraftSatisfyVideoPromptBlock/,
  'draft-satisfiable blocker filtering must be shared for video start adapters',
);

for (const helperName of [
  'formatVideoPreflightBlockedItem',
  'formatVideoPayloadPreflightItem',
  'canDraftSatisfyVideoPromptBlock',
]) {
  assert.match(
    startRunsSource,
    new RegExp(`import \\{[\\s\\S]*${helperName}[\\s\\S]*\\} from '\\./prompt-readiness';`),
    `video creation start service must import shared ${helperName}`,
  );
}

assert.match(
  startRunsSource,
  /const readiness = assertVideoCanStart\(project as any, groupIdxs, 'videoSegment', \{ skipConsistency: true \}\);/,
  'video_segments start must call the shared video generation gate',
);

assert.doesNotMatch(
  batchStartSource,
  /function formatVideoPreflightBlockedItem\(/,
  'batch/start must not keep a private blocked formatter',
);

assert.doesNotMatch(
  batchStartSource,
  /function canDraftSatisfyVideoPromptBlock\(/,
  'batch/start must not keep private draft-satisfiable blocker filtering',
);

assert.match(
  startRunsSource,
  /status: 409,[\s\S]*?code: 'video_segment_preflight_failed',[\s\S]*?preflight: \{[\s\S]*?allowed: false,[\s\S]*?blocked: blockedItems,[\s\S]*?warnings: warningItems/,
  'video prompt readiness blocked response must remain HTTP 409 with the existing preflight shape',
);

assert.match(
  startRunsSource,
  /status: 409,[\s\S]*?code: 'video_segment_preflight_failed',[\s\S]*?blocked: payloadBlocked/,
  'video payload blocked response must remain HTTP 409 with preflight.blocked',
);

assert.match(
  batchStartSource,
  /startVideoPromptRun\(/,
  'batch/start video_prompts branch must delegate to video creation start service',
);

assert.match(
  batchStartSource,
  /startVideoSegmentRun\(/,
  'batch/start video_segments branch must delegate to video creation start service',
);

assert.match(
  batchStartSource,
  /if \(batchType === 'tail_frame_images'[\s\S]*?skipped: 'merged_no_tail'/,
  'merged_no_tail must remain scoped to tail_frame_images, not video start contracts',
);

assert.match(
  promptsStartRouteSource,
  /startVideoPromptRun\(/,
  'new prompts/start endpoint must use the shared video prompt run service',
);

assert.match(
  videosStartRouteSource,
  /startVideoSegmentRun\(/,
  'new videos/start endpoint must use the shared video segment run service',
);

assert.doesNotMatch(
  videosStartRouteSource + startRunsSource,
  /skipped: 'merged_no_tail'/,
  'video creation video start contract must not include tail-frame-only merged_no_tail',
);

assert.match(
  videoUrlsSource,
  /PROTECTED_VIDEO_FILE_RE = \/\\\/api\\\/videos\\\/file\\\/\(\[\^\/\?#\]\+\)\//,
  'video URL helpers must recognize protected /api/videos/file/{id} URLs for re-signing',
);

assert.match(
  videoUrlsSource,
  /buildSignedVideoUrl\(id, ownerId\)\.url/,
  'video URL helpers must re-sign playback URLs from task id',
);

assert.match(
  videoStateSource,
  /latestTaskRowHasVideo[\s\S]*buildSignedVideoPlaybackUrl\(String\(latestTaskRow\.id\), args\.ownerId\)/,
  'state endpoint must re-sign playable video_tasks rows for playbackUrl',
);

assert.match(
  videoStateSource,
  /taskId && !latestTaskRow \? buildSignedVideoPlaybackUrl\(taskId, args\.ownerId\) : ''/,
  'state endpoint must not sign failed non-playable task rows as playbackUrl',
);

assert.match(
  videoStateSource,
  /videoUrl: protectedUrl,/,
  'state endpoint must expose persistent protected URLs as videoUrl',
);

assert.doesNotMatch(
  videoStateSource,
  /playbackUrl: .*sb\?\.videoUrl/,
  'state endpoint must not replay persisted storyboard videoUrl as playbackUrl',
);

assert.match(
  videoHistorySource,
  /url: buildSignedVideoPlaybackUrl\(taskId, args\.ownerId\),/,
  'history endpoint must re-sign each history video URL',
);

assert.match(
  videoHistorySource,
  /protected_url: buildProtectedVideoUrl\(taskId\),/,
  'history endpoint must also return protected_url',
);

assert.match(
  stateRouteSource,
  /getVideoCreationState\(/,
  'state route must use the video creation state service',
);

assert.match(
  historyRouteSource,
  /getVideoCreationHistoryForGroup\(/,
  'history route must use the video creation history service',
);

assert.match(
  videoByProjectSource,
  /scope === 'all-completed'/,
  'legacy video-by-project GET must preserve all-completed mode',
);

assert.match(
  videoByProjectSource,
  /const historyGroupRaw = url\.searchParams\.get\('groupIdx'\);/,
  'legacy video-by-project GET must preserve group history mode',
);

assert.match(
  videoByProjectSource,
  /getVideoCreationHistoryForGroup\(/,
  'legacy video-by-project group history must delegate to video creation history service',
);

assert.match(
  videoByProjectSource,
  /task_id:[\s\S]*?target_idx:[\s\S]*?result_url:[\s\S]*?protected_url:/,
  'legacy video-by-project default reattach mode must preserve snake_case task fields',
);

assert.match(
  batchExecutorsSource,
  /import \{ commitVideoPromptDraftForSegment \} from '\.\/video-prompt-draft-commit';/,
  'video_segments executor must keep using the shared draft commit gate',
);

assert.doesNotMatch(
  batchExecutorsSource,
  /function commitVideoPromptDraftForSegment\(/,
  'batch-executors must not keep a private draft commit implementation',
);

for (const required of [
  'storyboardShotIndices',
  'computeVideoPromptSourceHash',
  'validateCharacterConsistencyForGroup',
  'applyVideoPromptWrite',
  'VIDEO_PROMPT_DRAFT_COMMIT_FAILED',
  'preflight_video_prompt_not_ready',
]) {
  assert.match(
    draftCommitSource,
    new RegExp(required),
    `shared draft commit must preserve ${required}`,
  );
}

assert.match(
  batchExecutorsSource,
  /const commitResult = commitVideoPromptDraftForSegment\(/,
  'video_segments executor must still commit drafts inside the run before generating video',
);

console.log('test-video-creation-contracts passed');
