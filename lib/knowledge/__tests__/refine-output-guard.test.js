const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

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
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const {
  buildImmutableFactsSnapshot,
  extractTimeRangeTitles,
  factsForRefineGuardMode,
  normalizeRefineGuardMode,
  normalizeDialogueText,
  validateRefineOutput,
} = require('../refine-output-guard.ts');
const {
  buildRefineMessages,
  buildVideoPromptMessages,
} = require('../../prompts.ts');
const {
  plannedTimelineGroupsFromProject,
  plannedTimelineStartFromGroups,
} = require('../../video-reference-manifest.ts');
const {
  buildSeedancePromptParts,
  stripEditablePromptTimingLines,
} = require('../../video-prompt-runtime.ts');

test('planned timeline start matches cumulative storyboard card timing', () => {
  const project = {
    shots: [
      { duration: 4 },
      { duration: 4 },
      { duration: 4 },
      { duration: 5 },
      { duration: 4 },
      { duration: 4 },
      { duration: 4 },
      { duration: 4 },
    ],
    storyboards: [
      { shotIndices: [0] },
      { shotIndices: [1] },
      { shotIndices: [2] },
      { shotIndices: [3] },
      { shotIndices: [4] },
      { shotIndices: [5] },
      { shotIndices: [6] },
      { shotIndices: [7] },
    ],
  };
  const groups = plannedTimelineGroupsFromProject(project);
  assert.equal(plannedTimelineStartFromGroups(groups, 7), 29);
});

test('video prompt messages use the absolute timeline start for time labels', () => {
  const messages = buildVideoPromptMessages({
    shots: [{ idx: 8, duration: 4, shotType: '远景', camera: '缓慢拉远', dialogue: '' }],
    styleBible: {},
    assets: {},
    groupIdx: 7,
    totalGroups: 8,
    timelineStartSec: 29,
  });
  assert.match(messages[1].content, /镜头8: 4秒（0:29-0:33）/);
});

test('video prompt messages expose canonical Image bindings without forcing dialogue into visible body', () => {
  const messages = buildVideoPromptMessages({
    shots: [{
      idx: 1,
      duration: 4,
      pace: 'normal',
      shotType: '中近景',
      camera: '固定镜头',
      dialogue: '老周：“明天目标，客单翻倍。”',
      characters: ['老周'],
    }],
    styleBible: {},
    assets: {},
    referenceManifest: [
      { imageNo: 1, role: 'first_frame', label: '首帧画面', url: '/first.png', useFor: [], immutable: [] },
      { imageNo: 2, role: 'character', assetName: '老周', label: '老周角色参考', url: '/laozhou.png', useFor: [], immutable: [] },
    ],
  });
  const content = messages[1].content;
  assert.match(content, /角色段只写这些角色绑定：老周（Image 2）/);
  assert.match(content, /非角色参考（禁止写进角色段，只能在场景\/镜头\/约束中自然引用）：首帧画面（Image 1）/);
  assert.match(content, /编号集合：Image 1、Image 2/);
  assert.match(content, /后台台词表 - 仅用于理解说话人和语速，不要逐字写进可见正文/);
  assert.doesNotMatch(content, /把上面所有台词按出场顺序\*\*逐字\*\*写进对应镜头/);
});

test('seedance prompt injects structured shot duration and pace outside editable prompt body', () => {
  const result = buildSeedancePromptParts({
    prompt: '4秒（0:00-0:04）\n⟦外景大全景·24mm快速推进⟧\n镜头从街角快速推进到门店正面。',
    ratio: '16:9',
    durationSec: 5,
    shotPlan: [
      { idx: 1, durationSec: 4, pace: 'fast_forward', shotType: '大全景', camera: '快速推进' },
    ],
  });

  assert.match(result.finalPrompt, /【镜头计划 - 结构化参数为准】/);
  assert.match(result.finalPrompt, /镜头 01：时长 4秒；节奏 快进；景别 大全景；运镜 快速推进/);
  assert.match(result.finalPrompt, /供应商请求时长为 5秒/);
  assert.doesNotMatch(result.finalPrompt, /4秒（0:00-0:04）/);
  assert.match(result.finalPrompt, /镜头 01\n⟦外景大全景·24mm快速推进⟧/);
});

test('editable prompt timing sanitizer removes only standalone timing headings', () => {
  assert.equal(
    stripEditablePromptTimingLines([
      '运镜系统',
      '4秒（0:00-0:04）',
      '⟦外景大全景⟧',
      '画面保持4秒钟的压迫感，但这句不是标题。',
      '时间码 0:00-0:04',
      '0:04-0:08',
      '第二段画面。',
    ].join('\n')),
    [
      '运镜系统',
      '镜头 01',
      '⟦外景大全景⟧',
      '画面保持4秒钟的压迫感，但这句不是标题。',
      '镜头 02',
      '第二段画面。',
    ].join('\n'),
  );
});

test('dialogue normalization tolerates quote and colon variants but not text rewrites', () => {
  assert.equal(
    normalizeDialogueText('李雷沉声开口：“把账本交出来！”'),
    normalizeDialogueText("李雷沉声开口: '把账本交出来!'"),
  );
  assert.notEqual(
    normalizeDialogueText('把账本交出来'),
    normalizeDialogueText('把账册交出来'),
  );
});

test('refine guard accepts safe punctuation-only changes', () => {
  const original = [
    '0-3s 李雷沉声开口：“把账本交出来！”',
    '3-7s 参考 Image 1，阿岚：保持沉默。',
  ].join('\n');
  const facts = buildImmutableFactsSnapshot({ currentPrompt: original });
  const result = validateRefineOutput({
    originalPrompt: original,
    refinedPrompt: [
      "0-3s 李雷沉声开口: '把账本交出来!'",
      '3-7s 参考 Image 1，阿岚：保持沉默。',
    ].join('\n'),
    facts,
  });
  assert.equal(result.accepted, true);
});

test('refine guard rejects missing dialogue, reordered time ranges and changed Image numbers', () => {
  const original = [
    '0-3s 李雷沉声开口：“把账本交出来！”',
    '3-7s 参考 Image 1，阿岚：保持沉默。',
  ].join('\n');
  const facts = buildImmutableFactsSnapshot({ currentPrompt: original });
  const result = validateRefineOutput({
    originalPrompt: original,
    refinedPrompt: [
      '3-7s 参考 Image 2，阿岚：保持沉默。',
      '0-3s 李雷沉声开口：“把东西交出来！”',
    ].join('\n'),
    facts,
  });
  assert.equal(result.accepted, false);
  assert.ok(result.violations.some((item) => item.type === 'dialogue_missing'));
  assert.ok(result.violations.some((item) => item.type === 'time_range_changed'));
  assert.ok(result.violations.some((item) => item.type === 'image_number_changed'));
});

test('refine guard preserves current duration plus timecode titles', () => {
  const original = [
    '4秒（0:00-0:04） 李雷沉声开口：“把账本交出来！”',
    '4秒（0:04-0:08） 参考 Image 1，阿岚：保持沉默。',
  ].join('\n');
  assert.deepEqual(extractTimeRangeTitles(original), [
    '4秒（0:00-0:04）',
    '4秒（0:04-0:08）',
  ]);

  const facts = buildImmutableFactsSnapshot({ currentPrompt: original });
  const result = validateRefineOutput({
    originalPrompt: original,
    refinedPrompt: [
      "4秒（0:00-0:04） 李雷沉声开口: '把账本交出来!'",
      '5秒（0:04-0:09） 参考 Image 1，阿岚：保持沉默。',
    ].join('\n'),
    facts,
  });
  assert.equal(result.accepted, false);
  assert.ok(result.violations.some((item) => item.type === 'time_range_changed'));
});

test('old refine body can extract character candidates from colon prefixes', () => {
  const facts = buildImmutableFactsSnapshot({
    currentPrompt: '0-3s 阿岚：压低声音观察门口。\n3-7s Image 1 锁定场景。',
  });
  assert.ok(facts.characterNamesOrIds.includes('阿岚'));
  assert.deepEqual(facts.imageNumbers, [1]);
});

test('character lock matching ignores one-character substring hits', () => {
  const facts = buildImmutableFactsSnapshot({
    currentPrompt: '0-3s 林舟压低声音观察门口。\n3-7s Image 1 锁定场景。',
    project: {
      consistency: {
        characters: [
          { characterId: 'c1', canonicalName: '林', aliases: [] },
          { characterId: 'c2', canonicalName: '林舟', aliases: [] },
        ],
      },
    },
  });
  assert.ok(!facts.characterNamesOrIds.includes('林'));
  assert.ok(facts.characterNamesOrIds.includes('林舟'));
});

test('refine guard does not force project shot dialogue back into new visible prompt format', () => {
  const currentPrompt = [
    '运镜系统',
    '固定机位守住桌面轴线。',
    '',
    '角色',
    '角色出场：老周（Image 2）。',
    '',
    '镜头 01',
    '老周压低声音开口，台词见台词表；对面角色短暂停住筷子，只做听者反应。',
  ].join('\n');
  const facts = buildImmutableFactsSnapshot({
    currentPrompt,
    project: {
      shots: [
        {
          dialogue: '老周：“明天目标，客单翻倍。”',
          characters: ['老周'],
        },
      ],
      storyboards: [{ shotIndices: [0], videoReferenceManifest: [{ imageNo: 2, label: '老周', assetName: '老周' }] }],
    },
    groupIdx: 0,
  });
  assert.ok(!facts.dialogueTexts.some((text) => text.includes('明天目标')));
  assert.ok(facts.characterNamesOrIds.includes('老周'));
  assert.deepEqual(facts.imageNumbers, [2]);

  const result = validateRefineOutput({
    originalPrompt: currentPrompt,
    refinedPrompt: currentPrompt.replace('压低声音', '更克制地压低声音'),
    facts,
  });
  assert.equal(result.accepted, true);
});

test('guardMode fact filtering keeps only the facts each supported mode can enforce', () => {
  const facts = {
    dialogueTexts: ['把账本交出来'],
    timeRangeTitles: ['0-3s', '3-7s'],
    imageNumbers: [1, 2],
    characterNamesOrIds: ['阿岚'],
    referenceLabels: ['角色参考'],
  };
  assert.equal(normalizeRefineGuardMode(undefined), 'strict');
  assert.equal(normalizeRefineGuardMode('relaxed'), 'strict');
  assert.equal(normalizeRefineGuardMode('off'), 'off');
  assert.deepEqual(factsForRefineGuardMode(facts, 'strict'), facts);
  assert.deepEqual(factsForRefineGuardMode(facts, 'off'), {
    dialogueTexts: [],
    timeRangeTitles: [],
    imageNumbers: [],
    characterNamesOrIds: [],
    referenceLabels: [],
  });
});

test('guardMode off uses the sanitize system prompt that allows sensitive dialogue replacements', () => {
  const strictMessages = buildRefineMessages('0-3s 角色：“杀了他”', '加一点雾气');
  const sanitizeMessages = buildRefineMessages(
    '0-3s 角色：“杀了他”',
    '请仅替换敏感词：杀 -> 打',
    '',
    { guardMode: 'off' },
  );
  assert.match(strictMessages[0].content, /正文里已有的台词或引号句必须保留/);
  assert.match(sanitizeMessages[0].content, /敏感词安全替换/);
  assert.match(sanitizeMessages[0].content, /允许在正文已有台词、角色绑定、场景、动作或约束段中替换这些敏感词/);
  assert.doesNotMatch(sanitizeMessages[0].content, /严禁改写、删减或新增原有台词/);
});
