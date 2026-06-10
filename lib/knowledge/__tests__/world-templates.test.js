const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

process.env.DB_PATH = path.join(os.tmpdir(), `origin-world-template-test-${process.pid}-${Date.now()}.sqlite`);
process.env.SEED_PASSWORD = process.env.SEED_PASSWORD || 'world-template-test-password';

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

const {
  applyWorldTemplateTerminologyOverride,
  buildWorldTemplateFromProject,
  buildWorldTemplateFromProjectSnapshot,
  filterWorldTemplateEntityKeys,
  listWorldTemplateSummaries,
  mergeProjectCharacterLocksIntoWorldTemplate,
  mergeWorldTemplateSnapshotIntoSource,
  prepareWorldTemplateSaveInput,
  upsertWorldTemplate,
} = require('../../world-templates-db.ts');
const {
  buildWorldContextFromSnapshot,
  formatWorldContextForPrompt,
  projectWorldContextForStage,
} = require('../../world-template-context.ts');
const { getDb } = require('../../db.ts');

test('world templates strip visual fields while preserving setting and preview panels', () => {
  const template = upsertWorldTemplate(1, {
    id: 'world-strip-test',
    name: '视觉字段剥离测试',
    visualStyle: 'should be stripped',
    colorPalette: ['red'],
    cameraStyle: 'should be stripped',
    editingRhythm: 'should be stripped',
    negativePrompt: 'should be stripped',
    videoNegativePrompt: 'should be stripped',
    styleBibleGenerationContext: { should: 'strip' },
    visualStyleDesc: 'should be stripped',
    styleBible: { visualStyle: 'nested legacy object' },
    setting: {
      era: '未来边境',
      geography: '海上都市',
      rules: ['能源短缺'],
    },
    storyRules: {
      allowedConflicts: ['资源争夺'],
      forbiddenPlots: ['天降万能解法'],
      toneBoundaries: ['不走童话结尾'],
    },
    characters: [
      {
        name: '阿岚',
        referencePanels: { headshotUrl: '/images/head.png' },
      },
    ],
  });
  assert.equal(template.visualStyle, undefined);
  assert.equal(template.colorPalette, undefined);
  assert.equal(template.cameraStyle, undefined);
  assert.equal(template.editingRhythm, undefined);
  assert.equal(template.negativePrompt, undefined);
  assert.equal(template.videoNegativePrompt, undefined);
  assert.equal(template.styleBibleGenerationContext, undefined);
  assert.equal(template.visualStyleDesc, undefined);
  assert.equal(template.styleBible, undefined);
  assert.equal(template.setting.era, '未来边境');

  const summary = listWorldTemplateSummaries(1).find((item) => item.id === 'world-strip-test');
  assert.equal(summary.coverImageUrl, '/images/head.png');

  const context = buildWorldContextFromSnapshot(template);
  assert.equal(context.setting.era, '未来边境');
  assert.deepEqual(context.storyRules.forbiddenPlots, ['天降万能解法']);
  assert.ok(context.forbiddenRules.includes('天降万能解法'));
});

test('project sync maps character locks into world template characters', () => {
  const templateInput = buildWorldTemplateFromProject({
    id: 'project-world-sync',
    title: '项目同步',
    styleBible: {
      worldRules: { era: '近未来', rules: ['身份芯片不可伪造'] },
      forbiddenRules: ['不能出现魔法'],
    },
    consistency: {
      characters: [
        {
          characterId: 'c1',
          canonicalName: '林舟',
          status: 'locked',
          aliases: ['队长'],
          identityLock: { role: '队长', identity: '调查队负责人', entityType: 'human' },
          visualLock: {
            appearance: '短发',
            clothing: '黑色风衣',
            equipment: '旧终端',
            negativeRules: ['不要改成年轻学生'],
            signatureColors: ['黑色'],
            canonicalPrompt: '林舟，短发，黑色风衣',
          },
          performanceLock: { temperament: '冷静', actionTraits: '先观察再行动', gestureRules: ['少笑'] },
          voiceLock: {
            voiceGender: 'male',
            voiceAge: 'middle-aged',
            timbre: 'low',
            speechStyle: 'calm',
            accent: 'none',
            negativeRules: ['不要读角色名'],
          },
          referenceLock: {
            headshotUrl: '/images/lin-head.png',
            sourceImageId: 'img-1',
            referenceStatus: 'ready',
            qualityScore: 0.9,
          },
        },
      ],
    },
  });
  const ch = templateInput.characters[0];
  assert.equal(ch.name, '林舟');
  // realPhotoUrl 保持资产侧语义（写实原图）；特写预览改放 previewUrl，绝不混入 realPhotoUrl
  assert.equal(ch.realPhotoUrl, undefined);
  assert.equal(ch.previewUrl, '/images/lin-head.png');
  assert.equal(ch.referencePanels.headshotUrl, '/images/lin-head.png');
  assert.equal(ch.referencePanels.sourceImageId, 'img-1');
  assert.deepEqual(ch.voiceHint.negativeRules, ['不要读角色名']);
  assert.deepEqual(templateInput.characterCandidates, []);
});

test('world template summaries count locked and candidate characters as one deduped pool', () => {
  upsertWorldTemplate(1, {
    id: 'world-summary-character-pool',
    name: '角色池计数',
    characters: [{ id: 'c1', name: '林舟', realPhotoUrl: '/images/lin.png' }],
    characterCandidates: [
      { id: 'c1', name: '林舟', realPhotoUrl: '/images/lin-draft.png' },
      { id: 'c2', name: '许棠', realPhotoUrl: '/images/xu.png' },
    ],
  });

  const summary = listWorldTemplateSummaries(1).find((item) => item.id === 'world-summary-character-pool');
  assert.equal(summary.characterCount, 2);
  assert.deepEqual(summary.characterPreviewUrls, ['/images/lin.png', '/images/xu.png']);
});

test('project world template include flags default to full sync and support subtractive output', () => {
  const project = {
    id: 'project-include-flags',
    title: 'Include Flags',
    styleBible: {
      terminology: { chip: '身份芯片' },
      worldRules: { era: '近未来', rules: ['身份芯片不可伪造'] },
    },
    consistency: {
      characters: [
        {
          characterId: 'locked-include',
          canonicalName: '默认角色',
          status: 'locked',
          identityLock: { role: '主角', identity: '已确认', entityType: 'human' },
          visualLock: {},
          performanceLock: {},
          voiceLock: {},
          referenceLock: {},
        },
      ],
    },
    environments: [{ id: 'env-1', name: '码头', description: '潮湿码头' }],
    props: [{ id: 'prop-1', name: '芯片', description: '旧芯片' }],
  };
  const full = buildWorldTemplateFromProject(project);
  assert.equal(full.characters.length, 1);
  assert.deepEqual(full.characterCandidates, []);
  assert.equal(full.locations.length, 1);
  assert.equal(full.props.length, 1);
  assert.deepEqual(full.terminology, { chip: '身份芯片' });

  const reduced = buildWorldTemplateFromProject(project, {
    include: {
      characters: false,
      locations: false,
      props: false,
      terminology: false,
    },
  });
  assert.deepEqual(reduced.characters, []);
  assert.deepEqual(reduced.characterCandidates, []);
  assert.deepEqual(reduced.locations, []);
  assert.deepEqual(reduced.props, []);
  assert.deepEqual(reduced.terminology, {});
});

test('world template terminology override replaces existing terminology', () => {
  const existing = {
    id: 'world-terminology-override',
    name: '旧模板',
    terminology: {
      旧称谓: '旧解释',
    },
    locations: [{ id: 'l1', name: '旧地点' }],
  };
  const incoming = {
    id: 'world-terminology-override',
    name: '新模板',
    terminology: {
      新称谓: '来自项目的解释',
    },
    locations: [{ id: 'l2', name: '新地点' }],
  };
  const merged = mergeWorldTemplateSnapshotIntoSource(existing, incoming, {
    name: '新模板',
    templateId: 'world-terminology-override',
    include: { terminology: true },
  }).template;
  const replaced = applyWorldTemplateTerminologyOverride(merged, {
    混沌钟: '混沌圣地入门考核核心帝兵',
    系统任务面板: '',
  });

  assert.deepEqual(replaced.terminology, {
    混沌钟: '混沌圣地入门考核核心帝兵',
    系统任务面板: '系统任务面板',
  });
  assert.equal(replaced.locations.length, 2);
});

test('world template per-entity exclusions filter characters locations props and terminology', () => {
  const filtered = filterWorldTemplateEntityKeys({
    characters: [
      { id: 'c1', name: '林舟' },
      { id: 'c2', name: '许棠' },
    ],
    characterCandidates: [
      { id: 'draft-1', name: '候选少年' },
    ],
    locations: [
      { id: 'l1', name: '边界门' },
      { id: 'l2', name: '地下港' },
    ],
    props: [
      { id: 'p1', name: '灯塔证' },
      { id: 'p2', name: '旧终端' },
    ],
    terminology: {
      巡界人: '边界巡逻人员',
      CamelTerm: '大小写敏感术语',
      camelterm: '另一个术语',
    },
  }, {
    characters: ['c2', 'draft-1'],
    locations: ['l1'],
    props: ['p2'],
    terminology: ['CamelTerm'],
  });

  assert.deepEqual(filtered.characters.map((item) => item.name), ['林舟']);
  assert.deepEqual(filtered.characterCandidates, []);
  assert.deepEqual(filtered.locations.map((item) => item.name), ['地下港']);
  assert.deepEqual(filtered.props.map((item) => item.name), ['灯塔证']);
  assert.deepEqual(filtered.terminology, { 巡界人: '边界巡逻人员', camelterm: '另一个术语' });
});

test('project snapshot is the source when saving world template from project', () => {
  const input = buildWorldTemplateFromProjectSnapshot({
    id: 'project-snapshot-source',
    title: '项目标题',
    styleBible: {
      worldRules: { era: '旧风格圣经时代' },
    },
    worldTemplateSnapshot: {
      id: 'source-template',
      name: 'Snapshot 世界观',
      summary: '来自项目 snapshot 的摘要',
      setting: { era: 'snapshot 时代' },
      characters: [{ id: 'c1', name: '林舟', appearance: 'snapshot 外观' }],
      characterCandidates: [{ id: 'c2', name: '许棠', appearance: 'snapshot 候选' }],
      locations: [{ id: 'old-env', name: '旧地点' }],
      props: [{ id: 'old-prop', name: '旧道具' }],
      terminology: { 旧词: '旧解释' },
    },
    consistency: {
      characters: [
        {
          characterId: 'c2',
          canonicalName: '许棠',
          status: 'locked',
          identityLock: { role: '新锁定角色', identity: '已确认', entityType: 'human' },
          visualLock: { appearance: '项目锁定外观' },
          performanceLock: {},
          voiceLock: {},
          referenceLock: {},
        },
        {
          characterId: 'draft-3',
          canonicalName: '候选少年',
          status: 'draft',
          identityLock: { role: '候选', identity: '待确认', entityType: 'human' },
          visualLock: { appearance: '灰衣' },
          performanceLock: {},
          voiceLock: {},
          referenceLock: {},
        },
      ],
    },
    environments: [{ id: 'new-env', name: '新地点', description: '项目新地点' }],
    props: [{ id: 'new-prop', name: '新道具', description: '项目新道具' }],
    styleBible: {
      terminology: { 新词: '新解释' },
    },
  }, {
    mode: 'create',
    name: '保存后的世界观',
  });

  assert.equal(input.id, 'world_project-snapshot-source');
  assert.equal(input.name, '保存后的世界观');
  assert.equal(input.summary, '来自项目 snapshot 的摘要');
  assert.equal(input.setting.era, 'snapshot 时代');
  assert.equal(input.characters[0].appearance, 'snapshot 外观');
  assert.ok(input.characters.some((ch) => ch.characterId === 'c2'));
  assert.deepEqual(input.characterCandidates.map((ch) => ch.name), ['候选少年']);
  assert.deepEqual(input.locations.map((item) => item.name), ['旧地点', '新地点']);
  assert.deepEqual(input.props.map((item) => item.name), ['旧道具', '新道具']);
  assert.deepEqual(input.terminology, { 旧词: '旧解释', 新词: '新解释' });
});

test('snapshot include flags still remove project-side appended entities', () => {
  const input = buildWorldTemplateFromProjectSnapshot({
    id: 'project-snapshot-include-flags',
    title: '项目标题',
    worldTemplateSnapshot: {
      id: 'source-template',
      name: 'Snapshot 世界观',
      characters: [{ id: 'c1', name: '林舟' }],
      locations: [{ id: 'old-env', name: '旧地点' }],
      props: [{ id: 'old-prop', name: '旧道具' }],
      terminology: { 旧词: '旧解释' },
    },
    consistency: {
      characters: [
        {
          characterId: 'c2',
          canonicalName: '许棠',
          status: 'locked',
          identityLock: { role: '主角', identity: '已确认', entityType: 'human' },
          visualLock: {},
          performanceLock: {},
          voiceLock: {},
          referenceLock: {},
        },
      ],
    },
    environments: [{ id: 'new-env', name: '新地点' }],
    props: [{ id: 'new-prop', name: '新道具' }],
    styleBible: { terminology: { 新词: '新解释' } },
  }, {
    include: {
      characters: false,
      locations: false,
      props: false,
      terminology: false,
    },
  });

  assert.deepEqual(input.characters, []);
  assert.deepEqual(input.characterCandidates, []);
  assert.deepEqual(input.locations, []);
  assert.deepEqual(input.props, []);
  assert.deepEqual(input.terminology, {});
});

test('world template update without project snapshot still merges instead of replacing', () => {
  const existingTemplate = {
    id: 'world-project-no-snapshot',
    name: '已有派生模板',
    characters: [{ id: 'old-char', name: '旧角色' }],
    locations: [{ id: 'old-env', name: '旧地点' }],
    props: [{ id: 'old-prop', name: '旧道具' }],
    terminology: { 旧词: '旧解释' },
  };
  const prepared = prepareWorldTemplateSaveInput({
    mode: 'update',
    templateId: 'world-project-no-snapshot',
    name: '更新后模板',
    existingTemplate,
    include: { characters: true, locations: true, props: true, terminology: true },
    project: {
      id: 'project-no-snapshot',
      title: '无 Snapshot 项目',
      consistency: {
        characters: [
          {
            characterId: 'new-char',
            canonicalName: '新角色',
            status: 'locked',
            identityLock: { role: '主角', identity: '已确认', entityType: 'human' },
            visualLock: {},
            performanceLock: {},
            voiceLock: {},
            referenceLock: {},
          },
        ],
      },
      environments: [{ id: 'new-env', name: '新地点' }],
      props: [{ id: 'new-prop', name: '新道具' }],
      styleBible: { terminology: { 新词: '新解释' } },
    },
  });

  assert.equal(prepared.finalInput.name, '更新后模板');
  assert.deepEqual(prepared.finalInput.characters.map((item) => item.id), ['old-char', 'new-char']);
  assert.deepEqual(prepared.finalInput.locations.map((item) => item.id), ['old-env', 'new-env']);
  assert.deepEqual(prepared.finalInput.props.map((item) => item.id), ['old-prop', 'new-prop']);
  assert.deepEqual(prepared.finalInput.terminology, { 旧词: '旧解释', 新词: '新解释' });
  assert.equal(prepared.additionTotal, 4);
});

test('world template update promotes candidate characters without leaving duplicates', () => {
  const baseProject = {
    id: 'project-promote-candidate',
    title: '候选转正',
    consistency: {
      characters: [
        {
          characterId: 'hero-1',
          canonicalName: '许棠',
          status: 'locked',
          identityLock: { role: '主角', identity: '已确认', entityType: 'human' },
          visualLock: {},
          performanceLock: {},
          voiceLock: {},
          referenceLock: {},
        },
      ],
    },
  };
  const existingTemplate = {
    id: 'world-promote-candidate',
    name: '候选模板',
    characters: [],
    characterCandidates: [{ id: 'hero-1', name: '许棠' }],
  };
  const prepared = prepareWorldTemplateSaveInput({
    mode: 'update',
    templateId: 'world-promote-candidate',
    existingTemplate,
    project: baseProject,
  });

  assert.equal(prepared.additions.characters.length, 0);
  assert.equal(prepared.promotions.characterCandidatesToCharacters.length, 1);
  assert.deepEqual(prepared.finalInput.characters.map((item) => item.id), ['hero-1']);
  assert.deepEqual(prepared.finalInput.characterCandidates, []);

  const excluded = prepareWorldTemplateSaveInput({
    mode: 'update',
    templateId: 'world-promote-candidate',
    existingTemplate,
    project: baseProject,
    excludeEntityKeys: { characters: ['hero-1'] },
  });
  assert.deepEqual(excluded.finalInput.characters, []);
  assert.deepEqual(excluded.finalInput.characterCandidates.map((item) => item.id), ['hero-1']);
});

test('create save preparation returns an empty change preview', () => {
  const prepared = prepareWorldTemplateSaveInput({
    mode: 'create',
    project: {
      id: 'project-create-preview-empty',
      title: '新建预览',
      environments: [{ id: 'env-1', name: '地点' }],
    },
  });

  assert.equal(prepared.additionTotal, 0);
  assert.equal(prepared.promotionTotal, 0);
  assert.equal(prepared.changeTotal, 0);
  assert.deepEqual(prepared.additions.locations, []);
});

test('snapshot update merges missing fields without overwriting source manual edits', () => {
  const source = {
    id: 'tpl-existing',
    name: '源模板',
    characters: [
      { id: 'c1', name: '林舟', appearance: '源表手改外观', clothing: '' },
    ],
  };
  const snapshot = {
    id: 'tpl-existing',
    name: '项目 snapshot',
    characters: [
      { id: 'c1', name: '林舟', appearance: '项目外观', clothing: '黑色风衣', equipment: '旧终端' },
      { id: 'c2', name: '许棠', appearance: '短发' },
    ],
  };

  const merged = mergeWorldTemplateSnapshotIntoSource(source, snapshot, {
    templateId: 'tpl-existing',
    name: '更新后的模板名',
  }).template;

  assert.equal(merged.name, '更新后的模板名');
  assert.equal(merged.characters.length, 2);
  assert.equal(merged.characters[0].appearance, '源表手改外观');
  assert.equal(merged.characters[0].clothing, '黑色风衣');
  assert.equal(merged.characters[0].equipment, '旧终端');
  assert.equal(merged.characters[1].name, '许棠');
});

test('world context stage projection keeps hard facts while trimming stage scope', () => {
  const snapshot = {
    id: 'world-projection',
    setting: {
      era: '近未来封闭城市',
      geography: '城市被边界墙包围',
      society: '巡界人负责维护秩序',
      powerSystem: '所有身份芯片都可追踪',
      rules: ['身份芯片不可伪造', '边界门夜间关闭'],
    },
    worldRules: ['城市边界不可离开', '夜间不能使用明火', '普通人不能飞行'],
    storyRules: {
      forbiddenPlots: ['不能出现魔法复活'],
      toneBoundaries: ['不要童话化结尾'],
    },
    terminology: {
      巡界人: '边界巡逻人员',
      灯塔证: '通行许可',
    },
    characters: [
      { name: '林舟', role: '巡界队长', appearance: '短发，黑色风衣', clothing: '黑色风衣' },
      { name: '许棠', role: '调查员', appearance: '短发，灰色制服' },
    ],
    locations: [{ name: '边界门', description: '巨型闸门' }],
    props: [{ name: '灯塔证', description: '铜色通行证' }],
  };
  const scriptProjection = projectWorldContextForStage('script_create', snapshot);
  assert.equal(scriptProjection.setting.powerSystem, '所有身份芯片都可追踪');
  assert.deepEqual(scriptProjection.terminology.巡界人, '边界巡逻人员');
  assert.ok(scriptProjection.forbiddenRules.includes('不能出现魔法复活'));

  const videoProjection = projectWorldContextForStage('video_prompt_refine', snapshot);
  const promptBlock = formatWorldContextForPrompt(videoProjection);
  assert.ok(promptBlock.includes('世界观禁忌'));
  assert.ok(promptBlock.includes('巡界人'));
  assert.ok(promptBlock.includes('林舟'));

  assert.equal(projectWorldContextForStage('shots_generate', null), undefined);
});

test('world context merges empty characters with candidate characters for generation', () => {
  const context = buildWorldContextFromSnapshot({
    id: 'candidate-world',
    characters: [],
    characterCandidates: [
      {
        id: 'draft-1',
        name: '草稿角色',
        role: '临时角色',
        identity: '待确认',
        appearance: '灰衣',
      },
    ],
  });

  assert.equal(context.characterCandidates.length, 1);
  assert.equal(context.characterCandidates[0].name, '草稿角色');
  assert.ok(context.hardFacts.includes('角色：草稿角色（临时角色；待确认）'));
});

test('world context preserves hard and soft field strength in prompt formatting', () => {
  const snapshot = {
    id: 'world-strength',
    setting: { era: '近未来', rules: ['身份芯片不可伪造'] },
    characters: [
      {
        id: 'c1',
        name: '林舟',
        role: '巡界队长',
        identity: '调查队负责人',
        appearance: '短发',
        clothing: '黑色风衣',
        equipment: '旧终端',
        fieldMeta: {
          clothing: { strength: 'soft' },
          equipment: { strength: 'soft' },
        },
      },
    ],
    locations: [{ id: 'l1', name: '边界门', description: '巨型闸门' }],
  };
  const context = projectWorldContextForStage('video_prompt', snapshot);
  const allText = formatWorldContextForPrompt(context);
  assert.ok(allText.includes('世界观禁忌/硬事实'));
  assert.ok(allText.includes('林舟 appearance：短发'));
  assert.ok(allText.includes('世界观软默认'));
  assert.ok(allText.includes('林舟 clothing：黑色风衣'));
  assert.ok(allText.includes('地点：边界门'));
  assert.ok(!context.softDefaults.includes('角色默认：林舟 appearance=短发'));

  const hardOnly = formatWorldContextForPrompt(context, { includeSoft: false });
  assert.ok(hardOnly.includes('林舟 appearance：短发'));
  assert.ok(!hardOnly.includes('林舟 clothing：黑色风衣'));
  assert.ok(!hardOnly.includes('地点：边界门'));
});

test('project character sync skips draft locks by default but allows explicit selection', () => {
  const baseProject = {
    id: 'project-lock-filter',
    title: '锁定过滤',
    consistency: {
      characters: [
        {
          characterId: 'locked-1',
          canonicalName: '已锁角色',
          status: 'locked',
          aliases: [],
          identityLock: { role: '主角', identity: '已确认', entityType: 'human' },
          visualLock: { appearance: '黑衣', clothing: '', equipment: '', negativeRules: [], signatureColors: [], canonicalPrompt: '' },
          performanceLock: { temperament: '', actionTraits: '', gestureRules: [] },
          voiceLock: { negativeRules: [] },
          referenceLock: {},
        },
        {
          characterId: 'draft-1',
          canonicalName: '草稿角色',
          status: 'draft',
          aliases: [],
          identityLock: { role: '临时角色', identity: '待确认', entityType: 'human' },
          visualLock: { appearance: '灰衣', clothing: '', equipment: '', negativeRules: [], signatureColors: [], canonicalPrompt: '' },
          performanceLock: { temperament: '', actionTraits: '', gestureRules: [] },
          voiceLock: { negativeRules: [] },
          referenceLock: {},
        },
      ],
    },
  };
  const defaultTemplate = buildWorldTemplateFromProject(baseProject);
  assert.deepEqual(defaultTemplate.characters.map((ch) => ch.characterId), ['locked-1']);
  assert.deepEqual(defaultTemplate.characterCandidates.map((ch) => ch.characterId), ['draft-1']);

  upsertWorldTemplate(1, { id: 'merge-draft-test', name: '草稿选择测试', characters: [] });
  const selectedTemplate = mergeProjectCharacterLocksIntoWorldTemplate(1, 'merge-draft-test', baseProject, {
    characterIds: ['draft-1'],
  });
  assert.deepEqual(selectedTemplate.characters.map((ch) => ch.characterId), ['draft-1']);
});

test('legacy visual field stripping warns once per template field', () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO world_templates
       (id, owner_id, name, source_project_id, cover_image_id, schema_version, source, data_json)
     VALUES (?, 1, ?, NULL, NULL, 1, 'user', ?)`,
  ).run(
    'legacy-warn-repeat',
    '重复 warn 测试',
    JSON.stringify({ visualStyle: 'legacy style field', characters: [] }),
  );
  const originalWarn = console.warn;
  const messages = [];
  console.warn = (...args) => { messages.push(args.join(' ')); };
  try {
    listWorldTemplateSummaries(1);
    listWorldTemplateSummaries(1);
  } finally {
    console.warn = originalWarn;
  }
  const hits = messages.filter((msg) => msg.includes('legacy-warn-repeat') && msg.includes('visualStyle'));
  assert.equal(hits.length, 1);
});
