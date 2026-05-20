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
  factsForRefineGuardMode,
  normalizeRefineGuardMode,
  normalizeDialogueText,
  validateRefineOutput,
} = require('../refine-output-guard.ts');
const {
  buildRefineMessages,
} = require('../../prompts.ts');

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
  assert.match(strictMessages[0].content, /严禁改写、删减或新增原有台词/);
  assert.match(sanitizeMessages[0].content, /敏感词安全替换/);
  assert.match(sanitizeMessages[0].content, /允许在台词、角色描述、场景、动作或约束段中替换这些敏感词/);
  assert.doesNotMatch(sanitizeMessages[0].content, /严禁改写、删减或新增原有台词/);
});
