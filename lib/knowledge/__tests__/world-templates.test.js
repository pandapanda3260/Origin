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
  buildWorldTemplateFromProject,
  listWorldTemplateSummaries,
  mergeProjectCharacterLocksIntoWorldTemplate,
  upsertWorldTemplate,
} = require('../../world-templates-db.ts');
const { buildWorldContextFromSnapshot } = require('../../world-template-context.ts');
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
  assert.equal(ch.realPhotoUrl, '/images/lin-head.png');
  assert.equal(ch.referencePanels.headshotUrl, '/images/lin-head.png');
  assert.equal(ch.referencePanels.sourceImageId, undefined);
  assert.deepEqual(ch.voiceHint.negativeRules, ['不要读角色名']);
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
  assert.deepEqual(reduced.locations, []);
  assert.deepEqual(reduced.props, []);
  assert.deepEqual(reduced.terminology, {});
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
