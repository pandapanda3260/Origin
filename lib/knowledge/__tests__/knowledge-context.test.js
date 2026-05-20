const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

process.env.DB_PATH = path.join(os.tmpdir(), `origin-knowledge-test-${process.pid}-${Date.now()}.sqlite`);
process.env.SEED_PASSWORD = process.env.SEED_PASSWORD || 'knowledge-test-password';

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveOriginAlias(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    return originalResolve.call(this, path.join(process.cwd(), request.slice(2)), parent, isMain, options);
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function compileTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      allowJs: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      resolveJsonModule: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { getDb } = require('../../db.ts');
const { buildKnowledgeContextForStage } = require('../compile-context.ts');
const { upsertProjectKnowledgeContext } = require('../context-db.ts');
const {
  getUserCard,
  listSystemAndUserCards,
  upsertUserCard,
} = require('../cards-db.ts');
const {
  getKnowledgeSelectiveInjectionStages,
  isKnowledgeSelectiveInjectionEnabledForStage,
} = require('../../feature-flags.ts');
const { maybeInjectKnowledgePromptBlock } = require('../inject-messages.ts');
const { estimatePromptBlockTokens } = require('../token-estimate.ts');
const { deleteProjectForUser } = require('../../projects-db.ts');
const { prepareVideoPromptRefineMessagesWithKnowledge } = require('../video-prompt-refine-injection.ts');

function project(overrides = {}) {
  return {
    id: 'project-kb-test',
    title: '知识库测试项目',
    styleTemplateSnapshot: {
      id: 'style_live_action_realistic',
      name: '真人写实',
      data: { visual_rules: { camera: 'stable', lighting: 'natural' } },
    },
    worldTemplateSnapshot: {
      id: 'world-a',
      name: '测试世界观',
      data: { terminology: { A: 'alpha' }, worldRules: ['rule-a'] },
    },
    consistency: {
      characters: [{ characterId: 'c1', canonicalName: '角色甲' }],
    },
    ...overrides,
  };
}

function videoContext(stageTarget) {
  return buildKnowledgeContextForStage({
    ownerId: 1,
    project: project(),
    stage: 'video_prompt',
    stageTarget,
  });
}

test('knowledge context hash is stable across repeated builds and object key order changes', () => {
  const a = buildKnowledgeContextForStage({
    ownerId: 1,
    project: project(),
    stage: 'style_bible',
    stageTarget: { aspectRatio: '9:16', scriptHash: 'script-a', nested: { b: 2, a: 1 } },
  });
  const b = buildKnowledgeContextForStage({
    ownerId: 1,
    project: project({
      worldTemplateSnapshot: {
        name: '测试世界观',
        data: { worldRules: ['rule-a'], terminology: { A: 'alpha' } },
        id: 'world-a',
      },
      styleTemplateSnapshot: {
        data: { visual_rules: { lighting: 'natural', camera: 'stable' } },
        name: '真人写实',
        id: 'style_live_action_realistic',
      },
    }),
    stage: 'style_bible',
    stageTarget: { nested: { a: 1, b: 2 }, scriptHash: 'script-a', aspectRatio: '9:16' },
  });
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.contextHash, b.contextHash);
});

test('stage target is part of the input hash', () => {
  const a = videoContext({ groupIdx: 0, shotIndices: [0], referenceImages: [{ imageNo: 1 }] });
  const b = videoContext({ groupIdx: 1, shotIndices: [1], referenceImages: [{ imageNo: 1 }] });
  assert.notEqual(a.inputHash, b.inputHash);
});

test('selective injection feature flag is part of the input hash', () => {
  const prev = process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
  try {
    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = '';
    const off = videoContext({ groupIdx: 0, shotIndices: [0] });

    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = 'video_prompt';
    const on = videoContext({ groupIdx: 0, shotIndices: [0] });

    assert.notEqual(off.inputHash, on.inputHash);
    assert.notEqual(off.contextHash, on.contextHash);
  } finally {
    if (prev === undefined) delete process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
    else process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = prev;
  }
});

test('card version changes affect input hash', () => {
  const db = getDb();
  const before = videoContext({ groupIdx: 0, shotIndices: [0] });
  db.prepare(
    `UPDATE knowledge_cards
     SET version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 'sys-video-prompt-dialogue-verbatim'`,
  ).run();
  const after = videoContext({ groupIdx: 0, shotIndices: [0] });
  assert.notEqual(before.inputHash, after.inputHash);
});

test('seeded system cards cover all calibrated audit stages', () => {
  const cases = [
    ['script_create', ['narrative_structure']],
    ['style_bible', ['style_bible']],
    ['assets_extract', ['asset_extraction', 'identity_consistency']],
    ['shots_generate', ['shot_design', 'narrative_structure']],
    ['storyboard_sketch_prompt', ['storyboard_prompt']],
    ['first_frame_image', ['frame_image', 'provider_runtime']],
    ['tail_frame_image', ['frame_image', 'provider_runtime']],
    ['video_prompt', ['video_prompt', 'provider_runtime']],
    ['video_prompt_refine', ['video_prompt_refine', 'video_prompt', 'identity_consistency']],
    ['video_submit', ['provider_runtime']],
    ['edit_analyze', ['edit_strategy', 'narrative_structure']],
    ['edit_edl', ['edit_strategy', 'narrative_structure']],
    ['export', ['audio_subtitle_export']],
  ];

  for (const [stage, expectedModules] of cases) {
    const context = buildKnowledgeContextForStage({
      ownerId: 1,
      project: project(),
      stage,
      provider: 'seedance',
      stageTarget: { testStage: stage },
    });
    const modules = new Set(context.structured.cards.map((card) => card.module));
    assert.ok(context.ruleCardIds.length > 0, `${stage} should include at least one system card`);
    for (const module of expectedModules) {
      assert.ok(modules.has(module), `${stage} should include ${module}`);
    }
  }
});

test('knowledge selective injection stage flag parser trims, filters and supports wildcard', () => {
  const prev = process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
  try {
    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = '';
    assert.deepEqual(getKnowledgeSelectiveInjectionStages(), []);
    assert.equal(isKnowledgeSelectiveInjectionEnabledForStage('style_bible'), false);

    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = ' video_prompt_refine, style_bible,, ';
    assert.deepEqual(getKnowledgeSelectiveInjectionStages(), ['video_prompt_refine', 'style_bible']);
    assert.equal(isKnowledgeSelectiveInjectionEnabledForStage('style_bible'), true);
    assert.equal(isKnowledgeSelectiveInjectionEnabledForStage('video_prompt'), false);

    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = '*';
    assert.deepEqual(getKnowledgeSelectiveInjectionStages(), ['*']);
    assert.equal(isKnowledgeSelectiveInjectionEnabledForStage('export'), true);
  } finally {
    if (prev === undefined) delete process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
    else process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = prev;
  }
});

test('user card updates increment version and archived cards are excluded by default', () => {
  const first = upsertUserCard(1, {
    id: 'user-card-version-test',
    module: 'video_prompt',
    cardType: 'preference',
    title: '用户视频偏好',
    tags: ['user'],
    data: { content: '第一版' },
  });
  const second = upsertUserCard(1, {
    id: first.id,
    module: 'video_prompt',
    cardType: 'preference',
    title: '用户视频偏好',
    tags: ['user'],
    data: { content: '第二版' },
  });
  assert.equal(second.version, first.version + 1);

  const archived = upsertUserCard(1, {
    id: first.id,
    module: 'video_prompt',
    cardType: 'preference',
    title: '用户视频偏好',
    tags: ['user'],
    data: { content: '第二版' },
    lifecycle: 'archived',
  });
  assert.equal(archived.version, second.version + 1);
  assert.equal(getUserCard(1, first.id).lifecycle, 'archived');
  const visible = listSystemAndUserCards(1, 'video_prompt').map((card) => card.id);
  assert.ok(!visible.includes(first.id));
});

test('upsert refreshes run id and returns the persisted row on conflict', async () => {
  const context = buildKnowledgeContextForStage({
    ownerId: 1,
    project: project(),
    stage: 'video_prompt',
    provider: 'seedance',
    stageTarget: { groupIdx: 9, shotIndices: [9] },
  });
  const first = upsertProjectKnowledgeContext({
    ownerId: 1,
    projectId: 'project-kb-test',
    context,
    runId: 'run-a',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = upsertProjectKnowledgeContext({
    ownerId: 1,
    projectId: 'project-kb-test',
    context,
    runId: 'run-b',
  });
  assert.equal(second.id, first.id);
  assert.equal(second.provider, 'seedance');
  assert.equal(second.createdByRunId, 'run-b');
  assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
});

test('upsert refreshes stage target and context json on conflict', async () => {
  const base = buildKnowledgeContextForStage({
    ownerId: 1,
    project: project(),
    stage: 'video_prompt_refine',
    stageTarget: {
      groupIdx: 2,
      guardMode: 'strict',
      factCounts: { dialogues: 1, timeRanges: 1, imageNumbers: 1 },
    },
  });
  const firstStageTarget = {
    ...base.stageTarget,
    accepted: false,
    violationTypes: ['dialogue_missing'],
  };
  const secondStageTarget = {
    ...base.stageTarget,
    accepted: true,
    violationTypes: [],
  };
  const first = upsertProjectKnowledgeContext({
    ownerId: 1,
    projectId: 'project-kb-test',
    context: {
      ...base,
      stageTarget: firstStageTarget,
      structured: { ...base.structured, stageTarget: firstStageTarget },
      injection: {
        enabled: true,
        injected: false,
        reason: 'token_limit_exceeded',
        estimatedTokens: 999,
        maxTokens: 400,
        placement: 'user_tail',
        promptBlockHash: 'old-block',
      },
    },
    runId: 'refine-a',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = upsertProjectKnowledgeContext({
    ownerId: 1,
    projectId: 'project-kb-test',
    context: {
      ...base,
      stageTarget: secondStageTarget,
      structured: { ...base.structured, stageTarget: secondStageTarget },
      injection: {
        enabled: true,
        injected: true,
        reason: 'injected',
        estimatedTokens: 12,
        maxTokens: 400,
        placement: 'user_tail',
        promptBlockHash: 'new-block',
      },
    },
    runId: 'refine-b',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.createdByRunId, 'refine-b');
  assert.equal(second.stageTarget.accepted, true);
  assert.deepEqual(second.stageTarget.violationTypes, []);
  assert.equal(second.context.stageTarget.accepted, true);
  assert.equal(second.context.structured.stageTarget.accepted, true);
  assert.equal(second.context.injection?.reason, 'injected');
  assert.equal(second.context.injection?.promptBlockHash, 'new-block');
});

test('context cleanup keeps at most 50 rows per owner/project/stage', () => {
  const db = getDb();
  for (let i = 0; i < 55; i++) {
    const context = buildKnowledgeContextForStage({
      ownerId: 1,
      project: project({ id: 'cleanup-project' }),
      stage: 'assets_extract',
      stageTarget: { scriptHash: `script-${i}`, hasWorldTemplate: true },
    });
    upsertProjectKnowledgeContext({
      ownerId: 1,
      projectId: 'cleanup-project',
      context,
      runId: `cleanup-${i}`,
    });
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM project_knowledge_contexts
       WHERE owner_id = 1
         AND project_id = 'cleanup-project'
         AND stage = 'assets_extract'`,
    )
    .get();
  assert.equal(row.count, 50);
});

test('prompt block token estimate is dependency-free and scoped to prompt text', () => {
  assert.equal(estimatePromptBlockTokens(''), 0);
  assert.equal(estimatePromptBlockTokens('abcd'), 1);
  assert.equal(estimatePromptBlockTokens('abcdefgh'), 2);
  assert.equal(estimatePromptBlockTokens('角色保持一致'), 6);
  assert.ok(estimatePromptBlockTokens('Image 1 保持角色一致') >= 6);
});

test('knowledge prompt block no longer carries the P0 audit title', () => {
  const context = buildKnowledgeContextForStage({
    ownerId: 1,
    project: project(),
    stage: 'video_prompt_refine',
    stageTarget: { groupIdx: 1 },
  });
  assert.ok(context.promptBlock);
  assert.ok(!context.promptBlock.includes('P0 审计快照'));
  assert.ok(!context.promptBlock.includes('【知识库规则卡'));
});

test('provider runtime cards remain audit cards but are excluded from injectable promptBlock', () => {
  const context = buildKnowledgeContextForStage({
    ownerId: 1,
    project: project(),
    stage: 'video_prompt',
    provider: 'seedance',
    stageTarget: { groupIdx: 1 },
  });
  const modules = new Set(context.structured.cards.map((card) => card.module));
  const injectedModules = new Set(context.structured.injectedCards.map((card) => card.module));
  const auditOnlyModules = new Set(context.structured.auditOnlyCards.map((card) => card.module));
  assert.ok(modules.has('provider_runtime'));
  assert.ok(!injectedModules.has('provider_runtime'));
  assert.ok(auditOnlyModules.has('provider_runtime'));
  assert.ok(!context.promptBlock.includes('(provider_runtime,'));
});

test('knowledge injection obeys flag, token limit and does not mutate input messages', () => {
  const prev = process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
  const baseContext = buildKnowledgeContextForStage({
    ownerId: 1,
    project: project(),
    stage: 'video_prompt_refine',
    stageTarget: { groupIdx: 1 },
  });
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'original user prompt' },
  ];
  try {
    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = '';
    const off = maybeInjectKnowledgePromptBlock({ messages, context: baseContext });
    assert.equal(off.injection.reason, 'flag_off');
    assert.equal(off.injection.injected, false);
    assert.notEqual(off.messages, messages);
    assert.equal(messages[1].content, 'original user prompt');
    assert.equal(off.messages[1].content, 'original user prompt');

    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = 'video_prompt_refine';
    const injected = maybeInjectKnowledgePromptBlock({ messages, context: baseContext });
    assert.equal(injected.injection.reason, 'injected');
    assert.equal(injected.injection.injected, true);
    assert.equal(injected.context.injection.promptBlockHash.length, 12);
    assert.ok(injected.messages[1].content.includes('【项目知识库约束】'));
    assert.ok(injected.messages[1].content.includes(baseContext.promptBlock));
    assert.equal(messages[1].content, 'original user prompt');

    const huge = {
      ...baseContext,
      promptBlock: '超限'.repeat(500),
      promptBlocks: ['超限'.repeat(500)],
    };
    const limited = maybeInjectKnowledgePromptBlock({ messages, context: huge });
    assert.equal(limited.injection.reason, 'token_limit_exceeded');
    assert.equal(limited.injection.injected, false);
    assert.equal(limited.messages[1].content, 'original user prompt');
  } finally {
    if (prev === undefined) delete process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
    else process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = prev;
  }
});

test('knowledge injection supports explicit best-effort skip reasons', () => {
  const prev = process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
  try {
    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = 'video_prompt_refine';
    const context = buildKnowledgeContextForStage({
      ownerId: 1,
      project: project(),
      stage: 'video_prompt_refine',
      stageTarget: { groupIdx: 2 },
    });
    const result = maybeInjectKnowledgePromptBlock({
      messages: [{ role: 'user', content: 'prompt' }],
      context,
      skipReason: 'guard_mode_off',
    });
    assert.equal(result.injection.reason, 'guard_mode_off');
    assert.equal(result.injection.enabled, true);
    assert.equal(result.injection.injected, false);
    assert.equal(result.messages[0].content, 'prompt');
  } finally {
    if (prev === undefined) delete process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
    else process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = prev;
  }
});

test('video prompt refine message preparation injects only when stage flag and strict guard allow it', () => {
  const prev = process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
  const currentPrompt = [
    '0-3s 林舟："保持队形。"',
    'Image 1 作为首帧参考，角色 林舟 站在雨夜码头。',
  ].join('\n');
  const instruction = '只调整环境光线，让雨夜更冷。';
  try {
    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = '';
    const off = prepareVideoPromptRefineMessagesWithKnowledge({
      ownerId: 1,
      projectId: 'project-kb-test',
      project: project(),
      groupIdx: 0,
      currentPrompt,
      instruction,
      guardMode: 'strict',
    });
    assert.equal(off.knowledgeContext.injection.reason, 'flag_off');
    assert.ok(!off.messages.at(-1).content.includes('【项目知识库约束】'));

    process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = 'video_prompt_refine';
    const on = prepareVideoPromptRefineMessagesWithKnowledge({
      ownerId: 1,
      projectId: 'project-kb-test',
      project: project(),
      groupIdx: 0,
      currentPrompt,
      instruction,
      guardMode: 'strict',
    });
    assert.equal(on.knowledgeContext.injection.reason, 'injected');
    assert.ok(on.messages.at(-1).content.includes('【项目知识库约束】'));

    const guardOff = prepareVideoPromptRefineMessagesWithKnowledge({
      ownerId: 1,
      projectId: 'project-kb-test',
      project: project(),
      groupIdx: 0,
      currentPrompt,
      instruction,
      guardMode: 'off',
    });
    assert.equal(guardOff.knowledgeContext.injection.reason, 'guard_mode_off');
    assert.ok(!guardOff.messages.at(-1).content.includes('【项目知识库约束】'));
  } finally {
    if (prev === undefined) delete process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES;
    else process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES = prev;
  }
});

test('project deletion clears knowledge audit and preserves derived world templates', () => {
  const db = getDb();
  const cleanupDeleteProjectFixtures = () => {
    db.prepare(
      `DELETE FROM project_knowledge_contexts
       WHERE project_id IN ('delete-project-audit', 'delete-project-other')
          OR owner_id IN (SELECT id FROM users WHERE username LIKE 'delete_knowledge_%')`,
    ).run();
    db.prepare(`DELETE FROM users WHERE username LIKE 'delete_knowledge_%'`).run();
  };
  cleanupDeleteProjectFixtures();
  const user = db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, email_verified)
     VALUES (?, ?, ?, ?, 1)
     RETURNING id`,
  ).get('delete_knowledge_user', 'delete_knowledge_user@example.test', 'Delete Knowledge User', 'hash');
  const otherUser = db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, email_verified)
     VALUES (?, ?, ?, ?, 1)
     RETURNING id`,
  ).get('delete_knowledge_other', 'delete_knowledge_other@example.test', 'Delete Knowledge Other', 'hash');

  db.prepare(
    `INSERT INTO projects (id, owner_id, title, description, status, data_json)
     VALUES (?, ?, ?, '', 'draft', '{}')`,
  ).run('delete-project-audit', user.id, '删除知识审计项目');
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, description, status, data_json)
     VALUES (?, ?, ?, '', 'draft', '{}')`,
  ).run('delete-project-other', otherUser.id, '其他用户项目');

  const context = buildKnowledgeContextForStage({
    ownerId: user.id,
    project: project({ id: 'delete-project-audit' }),
    stage: 'video_prompt_refine',
    stageTarget: { groupIdx: 1 },
  });
  upsertProjectKnowledgeContext({
    ownerId: user.id,
    projectId: 'delete-project-audit',
    context,
    runId: 'delete-run',
  });
  const otherContext = buildKnowledgeContextForStage({
    ownerId: otherUser.id,
    project: project({ id: 'delete-project-audit' }),
    stage: 'video_prompt_refine',
    stageTarget: { groupIdx: 1 },
  });
  upsertProjectKnowledgeContext({
    ownerId: otherUser.id,
    projectId: 'delete-project-audit',
    context: otherContext,
    runId: 'other-delete-run',
  });

  db.prepare(
    `INSERT INTO world_templates
       (id, owner_id, name, source_project_id, cover_image_id, schema_version, source, data_json)
     VALUES (?, ?, ?, ?, NULL, 1, 'user', '{}')`,
  ).run('world-from-deleted-project', user.id, '派生世界观', 'delete-project-audit');
  db.prepare(
    `INSERT INTO world_templates
       (id, owner_id, name, source_project_id, cover_image_id, schema_version, source, data_json)
     VALUES (?, ?, ?, ?, NULL, 1, 'user', '{}')`,
  ).run('world-other-owner', otherUser.id, '其他用户派生世界观', 'delete-project-audit');

  assert.equal(deleteProjectForUser('delete-project-audit', user.id), true);

  const deletedAuditCount = db.prepare(
    `SELECT COUNT(*) AS count FROM project_knowledge_contexts
     WHERE owner_id = ? AND project_id = ?`,
  ).get(user.id, 'delete-project-audit').count;
  assert.equal(deletedAuditCount, 0);

  const otherAuditCount = db.prepare(
    `SELECT COUNT(*) AS count FROM project_knowledge_contexts
     WHERE owner_id = ? AND project_id = ?`,
  ).get(otherUser.id, 'delete-project-audit').count;
  assert.equal(otherAuditCount, 1);

  const derivedWorld = db.prepare(
    `SELECT source_project_id FROM world_templates
     WHERE owner_id = ? AND id = ?`,
  ).get(user.id, 'world-from-deleted-project');
  assert.ok(derivedWorld);
  assert.equal(derivedWorld.source_project_id, null);

  const otherWorld = db.prepare(
    `SELECT source_project_id FROM world_templates
     WHERE owner_id = ? AND id = ?`,
  ).get(otherUser.id, 'world-other-owner');
  assert.ok(otherWorld);
  assert.equal(otherWorld.source_project_id, 'delete-project-audit');
  cleanupDeleteProjectFixtures();
});
