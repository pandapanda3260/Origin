import { readFileSync } from 'node:fs';
import { getDb } from '../lib/db';
import {
  claimDueStyleBibleRuns,
  createStyleBibleRun,
  getStyleBibleRunByRunId,
  processStyleBibleRun,
  reconcileStaleStyleBibleRuns,
  setStyleBibleRunJsonCallerForTests,
  tickStyleBibleRunWorker,
  updateStyleBibleRun,
} from '../lib/style-bible-runs';
import {
  getProjectByIdForUser,
  patchProjectForUser,
  updateProjectForUser,
} from '../lib/projects-db';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function projectData(runId: string) {
  return JSON.stringify({
    script: '雨夜婚礼，萧南归来复仇。',
    scriptApproved: true,
    styleBibleStatus: 'generating',
    styleBibleRunId: runId,
    styleBibleStartedAt: new Date().toISOString(),
    styleBibleStage: 'core',
    styleBibleProgress: 0,
  });
}

function resetProject(projectId: string) {
  const db = getDb();
  db.prepare('DELETE FROM style_bible_runs WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

function ensureTestUser() {
  getDb().prepare(
    `INSERT INTO users (id, username, display_name, password_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(1, 'style-bible-run-test-user', 'Style Bible Run Test User', 'x');
}

function insertProject(projectId: string, runId: string) {
  ensureTestUser();
  getDb().prepare(
    'INSERT INTO projects (id, owner_id, title, data_json) VALUES (?, ?, ?, ?)',
  ).run(projectId, 1, projectId, projectData(runId));
}

function outputForStage(stage: string) {
  if (stage === 'core') {
    return {
      visualStyle: '真人写实/雨夜复仇/婚礼压迫',
      visualStyleDesc: '雨夜都市婚礼空间中，冷峻写实地呈现复仇归来与错位情感。',
      era: '现代都市深夜，雨中广场、广告屏与室内婚宴厅相连，现实商业空间冷硬而压迫。',
      mood: '冷峻克制，前段压抑蓄势，婚礼揭示后情绪骤然收紧。',
      worldRules: '世界遵循现实都市逻辑，没有超自然能力；血、雨、广告屏、婚纱和戒指都是现实物件，被镜头强化但不脱离真实质感。',
      castingProfile: { ethnicityType: 'han_chinese' },
    };
  }
  if (stage === 'characters') {
    return {
      characters: [
        { name: '萧南', appearance: '二十多岁，身形清瘦，雨水压低眉眼，神情冷硬疲惫', clothing: '黑色湿西装，白衬衫贴身，肩头有雨痕' },
      ],
    };
  }
  if (stage === 'visual_palette') {
    return {
      colorPalette: [
        { hex: '#111111', name: '墨黑' },
        { hex: '#8B1A1A', name: '暗红' },
        { hex: '#D6C7B0', name: '婚纱白' },
        { hex: '#4A6F8A', name: '冷蓝' },
        { hex: '#B08A55', name: '暖金' },
      ],
    };
  }
  if (stage === 'visual_prompts') {
    return {
      colorPalette: [{ hex: '#cfd8dc', name: '污染灰' }],
      negativePrompt: '卡通化；塑料皮肤；过度磨皮；廉价网剧滤镜；CG渲染感',
      additionalPrompt: '真人电影摄影；自然皮肤纹理；雨夜反光；真实婚宴空间；克制表演',
    };
  }
  if (stage === 'visual_lens') {
    return {
      cameraStyle: '真人电影摄影镜头，中近景人物表演、稳定跟拍、克制推拉、真实景深和可信空间关系',
      compositionGuidance: '9:16 竖构图突出人物孤立感，广告屏和囍字向纵深压迫，戒指与婚纱用中近景强调。',
      lighting: '室外冷蓝霓虹侧逆光，雨面反射偏硬；室内暖黄顶侧光，低补光，高反差。',
      texture: '湿西装、雨水皮肤、白纱、大理石与金属戒指清晰可触，带轻微胶片颗粒。',
    };
  }
  if (stage === 'production') {
    return {
      editingRhythm: '前段慢推蓄压，进门硬切，戒指落地后放慢，结尾定格骤停。',
      audio: '低频弦乐与冷钢琴铺底，雨声贯穿，戒指撞击清脆刺耳。',
      subtitleStyle: '白色无衬线小字置底，关键台词轻微淡入，停顿留空。',
      dialogueStyle: '旁白低哑克制，只交代时间与执念；对白短句留白，不煽情。',
    };
  }
  throw new Error(`unexpected stage ${stage}`);
}

async function runClaimed(runId: string) {
  const claimed = claimDueStyleBibleRuns(1).find((row) => row.run_id === runId);
  assert(claimed, `expected ${runId} to be claimed`);
  await processStyleBibleRun(claimed);
}

async function runSixStageSmoke() {
  const projectId = 'p-style-run-six-stage';
  const runId = 'run-six-stage';
  resetProject(projectId);
  insertProject(projectId, runId);

  const stages: string[] = [];
  let visualPromptsSawPalette = false;
  setStyleBibleRunJsonCallerForTests((async (_user: any, messages: any[], _opts: any, _parser: any, taskName = '') => {
    const stage = String(taskName).replace(/^styleBible\./, '');
    stages.push(stage);
    if (stage === 'visual_prompts') {
      visualPromptsSawPalette = messages.some((msg) => String(msg?.content || '').includes('#111111'));
    }
    return outputForStage(stage);
  }) as any);

  try {
    createStyleBibleRun({
      ownerId: 1,
      projectId,
      runId,
      input: { script: '雨夜婚礼，萧南归来复仇。', styleOptions: { aspectRatio: '9:16' } },
    });

    for (let i = 0; i < 6; i += 1) {
      await runClaimed(runId);
    }

    const row = getStyleBibleRunByRunId(runId);
    assert(row?.status === 'completed', `six-stage run should complete, got ${row?.status}`);
    assert(
      stages.join('>') === 'core>characters>visual_palette>visual_prompts>visual_lens>production',
      `unexpected stage order: ${stages.join('>')}`,
    );
    assert(visualPromptsSawPalette, 'visual_prompts should receive previous colorPalette in draft context');

    const finalDraft = JSON.parse(row.draft_json || '{}');
    assert(finalDraft.colorPalette?.[0]?.hex === '#111111', 'visual_prompts must not overwrite visual_palette colorPalette');
    const meta = JSON.parse(row.meta_json || '{}');
    assert(String(meta.stageOutputs?.visual_prompts?.colorPalette?.[0]?.hex || '').toLowerCase() === '#cfd8dc', 'raw visual_prompts output should be kept in meta.stageOutputs');
  } finally {
    setStyleBibleRunJsonCallerForTests(null);
  }
}

async function runSupersededSmoke() {
  const projectId = 'p-style-run-superseded';
  resetProject(projectId);
  insertProject(projectId, 'run-a');

  createStyleBibleRun({
    ownerId: 1,
    projectId,
    runId: 'run-a',
    input: { script: '测试剧本', styleOptions: { aspectRatio: '9:16' } },
  });

  const claimed = claimDueStyleBibleRuns(1)[0];
  assert(claimed?.run_id === 'run-a', 'run-a should be claimed');

  getDb().prepare(
    `UPDATE projects
     SET data_json = ?
     WHERE id = ?`,
  ).run(projectData('run-b'), projectId);

  await processStyleBibleRun(claimed);

  const cancelled = getDb()
    .prepare('SELECT status, error_code FROM style_bible_runs WHERE run_id = ?')
    .get('run-a') as { status: string; error_code: string | null };
  assert(cancelled.status === 'cancelled', `run-a should be cancelled, got ${cancelled.status}`);
  assert(cancelled.error_code === 'superseded', `run-a should be superseded, got ${cancelled.error_code}`);

  const reclaimed = claimDueStyleBibleRuns(5).map((row) => row.run_id);
  assert(!reclaimed.includes('run-a'), 'cancelled run-a should not be claimed again');

  const reconciled = reconcileStaleStyleBibleRuns();
  const afterReconcile = getDb()
    .prepare('SELECT status, error_code FROM style_bible_runs WHERE run_id = ?')
    .get('run-a') as { status: string; error_code: string | null };
  assert(reconciled === 0, `reconcile should not touch cancelled rows, got ${reconciled}`);
  assert(afterReconcile.status === 'cancelled', `cancelled row should stay cancelled, got ${afterReconcile.status}`);

  const source = readFileSync('lib/style-bible-runs.ts', 'utf8');
  const supersededBranches = source.match(/errorCode:\s*'superseded'/g) || [];
  assert(supersededBranches.length >= 3, `expected at least 3 superseded checkpoints, got ${supersededBranches.length}`);
}

async function runPutPreserveSmoke() {
  const projectId = 'p-style-run-put-preserve';
  const runId = 'run-put-preserve';
  resetProject(projectId);
  insertProject(projectId, runId);
  createStyleBibleRun({
    ownerId: 1,
    projectId,
    runId,
    input: { script: '测试剧本', styleOptions: { aspectRatio: '9:16' } },
  });

  updateProjectForUser(projectId, 1, {
    oneSentence: '前端旧快照保存',
    styleBibleStatus: 'ready',
    styleBibleRunId: null,
    styleBibleStage: null,
    styleBibleProgress: 100,
  });

  let project: any = getProjectByIdForUser(projectId, 1);
  assert(project.styleBibleStatus === 'generating', `active run status should be preserved, got ${project.styleBibleStatus}`);
  assert(project.styleBibleRunId === runId, `active run id should be preserved, got ${project.styleBibleRunId}`);

  setStyleBibleRunJsonCallerForTests((async (_user: any, _messages: any[], _opts: any, _parser: any, taskName = '') => {
    return outputForStage(String(taskName).replace(/^styleBible\./, ''));
  }) as any);
  try {
    await runClaimed(runId);
  } finally {
    setStyleBibleRunJsonCallerForTests(null);
  }

  const row = getStyleBibleRunByRunId(runId);
  assert(row?.status !== 'cancelled', 'worker should not treat preserved run as superseded');

  patchProjectForUser(projectId, 1, () => ({
    allowStyleBibleRunOverwrite: true,
    styleBibleStatus: 'failed',
    styleBibleRunId: null,
    styleBibleStage: null,
    styleBibleProgress: null,
    styleBibleErrorCode: 'smoke_internal_clear',
  }));
  project = getProjectByIdForUser(projectId, 1) as any;
  assert(project.styleBibleRunId === null, 'internal clear should remove active run id');
  assert(project.styleBibleErrorCode === 'smoke_internal_clear', 'internal clear should keep error code');
}

async function runReadyStyleBibleRollbackProtectSmoke() {
  const projectId = 'p-style-run-ready-protect';
  resetProject(projectId);
  insertProject(projectId, 'completed-run');
  patchProjectForUser(projectId, 1, () => ({
    allowStyleBibleRunOverwrite: true,
    oneSentence: 'ready project',
    styleBibleStatus: 'ready',
    styleBibleRunId: null,
    styleBibleStage: null,
    styleBibleProgress: 100,
    styleBible: {
      visualStyle: '新风格',
      colorPalette: [{ name: '新色', hex: '#111111' }],
    },
    styleBibleGeneratedAt: '2026-05-18T16:33:36.908Z',
    styleBibleSource: 'generated',
  }));

  updateProjectForUser(projectId, 1, {
    oneSentence: 'ordinary save after completion',
    styleBibleStatus: 'generating',
    styleBibleRunId: 'old-run',
    styleBibleStage: 'characters',
    styleBibleProgress: 17,
    styleBible: {
      visualStyle: '旧风格',
      colorPalette: [{ name: '污染灰', hex: '#cfd8dc' }],
    },
    styleBibleGeneratedAt: '2026-05-18T14:11:22.864Z',
    styleBibleSource: 'generated',
  });

  const project: any = getProjectByIdForUser(projectId, 1);
  assert(project.oneSentence === 'ordinary save after completion', 'ordinary field should still be saved');
  assert(project.styleBibleStatus === 'ready', `ready status should not roll back, got ${project.styleBibleStatus}`);
  assert(project.styleBibleRunId === null, `completed run id should stay null, got ${project.styleBibleRunId}`);
  assert(project.styleBibleProgress === 100, `completed progress should stay 100, got ${project.styleBibleProgress}`);
  assert(project.styleBibleGeneratedAt === '2026-05-18T16:33:36.908Z', `generatedAt should not roll back, got ${project.styleBibleGeneratedAt}`);
  assert(project.styleBible?.visualStyle === '新风格', `styleBible body should not roll back, got ${project.styleBible?.visualStyle}`);
  assert(project.styleBible?.colorPalette?.[0]?.hex === '#111111', 'styleBible palette should not be polluted');
}

async function runStageObsoleteSmoke() {
  const projectId = 'p-style-run-obsolete';
  const runId = 'run-obsolete';
  resetProject(projectId);
  insertProject(projectId, runId);
  createStyleBibleRun({
    ownerId: 1,
    projectId,
    runId,
    input: { script: '测试剧本', styleOptions: { aspectRatio: '9:16' } },
  });
  updateStyleBibleRun(runId, {
    status: 'retry_pending',
    stage: 'visual',
    attempt: 0,
    nextRetryAt: new Date(Date.now() - 1000).toISOString(),
  });

  await tickStyleBibleRunWorker();

  const row = getStyleBibleRunByRunId(runId);
  assert(row?.status === 'cancelled', `obsolete visual stage should be cancelled, got ${row?.status}`);
  assert(row?.error_code === 'stage_obsolete', `obsolete visual stage code should be stage_obsolete, got ${row?.error_code}`);
  const claimed = claimDueStyleBibleRuns(5).map((item) => item.run_id);
  assert(!claimed.includes(runId), 'obsolete cancelled run should not be claimed again');
}

async function runTemplateSourcePreserveSmoke() {
  const projectId = 'p-style-run-template-source';
  const runId = 'run-template-source';
  resetProject(projectId);
  insertProject(projectId, runId);

  const styleTemplateSnapshot = {
    id: 'style_live_action_realistic',
    name: '真人写实',
    updatedAt: '2026-05-28T00:00:00.000Z',
    visual: { lighting: '自然光' },
  };
  createStyleBibleRun({
    ownerId: 1,
    projectId,
    runId,
    input: {
      script: '雨夜婚礼，萧南归来复仇。',
      styleOptions: { aspectRatio: '9:16' },
      styleTemplateSnapshot,
      styleBibleGenerationContext: {
        aspectRatio: '9:16',
        worldTemplateId: null,
        worldTemplateHash: null,
        styleTemplateId: 'style_live_action_realistic',
        styleTemplateHash: 'style_live_action_realistic:2026-05-28T00:00:00.000Z',
      },
    },
  });

  setStyleBibleRunJsonCallerForTests((async (_user: any, _messages: any[], _opts: any, _parser: any, taskName = '') => {
    return outputForStage(String(taskName).replace(/^styleBible\./, ''));
  }) as any);
  try {
    for (let i = 0; i < 6; i += 1) {
      await runClaimed(runId);
    }
  } finally {
    setStyleBibleRunJsonCallerForTests(null);
  }

  const project: any = getProjectByIdForUser(projectId, 1);
  assert(project.styleBibleStatus === 'ready', `template-source run should be ready, got ${project.styleBibleStatus}`);
  assert(project.selectedStyleTemplateId === 'style_live_action_realistic', `selected style template should be restored, got ${project.selectedStyleTemplateId}`);
  assert(project.styleTemplateSnapshot?.name === '真人写实', 'style template snapshot should be restored from run input');
  assert(project.styleBibleGenerationContext?.styleTemplateId === 'style_live_action_realistic', 'generation context should retain style template id');
}

function runFrontendResponsePreserveStaticSmoke() {
  const source = readFileSync('public/modules/script.js', 'utf8');
  const assignment = 'proj.styleBibleGenerationContext = resp.styleBibleGenerationContext || null';
  const assignmentIndex = source.indexOf(assignment);
  const guardIndex = assignmentIndex >= 0
    ? source.lastIndexOf('hasOwnProperty.call(resp || {}, "styleBibleGenerationContext")', assignmentIndex)
    : -1;
  assert(
    guardIndex >= 0 && assignmentIndex - guardIndex < 180,
    'frontend must guard styleBibleGenerationContext overwrite on explicit response fields',
  );
  assert(
    source.includes('if (resp.styleTemplateSnapshot)'),
    'frontend should preserve or restore style template snapshot from completed responses',
  );
}

async function main() {
  await runSixStageSmoke();
  await runSupersededSmoke();
  await runPutPreserveSmoke();
  await runReadyStyleBibleRollbackProtectSmoke();
  await runStageObsoleteSmoke();
  await runTemplateSourcePreserveSmoke();
  runFrontendResponsePreserveStaticSmoke();
  console.log('style bible run state smoke ok');
}

main().catch((error) => {
  setStyleBibleRunJsonCallerForTests(null);
  console.error(error);
  process.exit(1);
});
