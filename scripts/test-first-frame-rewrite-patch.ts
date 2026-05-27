import assert from 'node:assert/strict';
import {
  normalizeFirstFrameRewriteOperations,
  parseFirstFrameRewriteResult,
} from '../lib/first-frame-rewrite-patch';

{
  const parsed = parseFirstFrameRewriteResult(JSON.stringify({
    assistantMessage: 'ok',
    draftPatch: {
      referenceOverrides: { op: 'clear' },
    },
  }));

  assert.deepEqual(parsed.draftPatch?.referenceOverrides, { op: 'clear' });
}

{
  const parsed = parseFirstFrameRewriteResult(JSON.stringify({
    assistantMessage: 'ok',
    draftPatch: {
      referenceOverrides: { op: 'keep' },
    },
  }));

  assert.deepEqual(parsed.draftPatch?.referenceOverrides, { op: 'keep' });
}

{
  const normalized = normalizeFirstFrameRewriteOperations({
    referenceOverrides: {
      op: 'update',
      added: [{ role: 'character', assetName: '老板' }],
      excluded: [{ role: 'scene', assetName: '厨房' }],
    },
  });

  assert.deepEqual(normalized.referenceOverrides, {
    op: 'update',
    add: [{ role: 'character', assetName: '老板' }],
    exclude: [{ role: 'scene', assetName: '厨房' }],
  });
}

{
  const parsed = parseFirstFrameRewriteResult(JSON.stringify({
    assistantMessage: 'ok',
    draftPatch: {
      styleRuleOverrides: { op: 'add', value: ['更冷的色调'] },
      content: { op: 'set', value: '冷蓝色夜景，背景更克制' },
    },
  }));

  assert.equal(Object.prototype.hasOwnProperty.call(parsed.draftPatch || {}, 'styleRuleOverrides'), false);
  assert.deepEqual(parsed.draftPatch?.content, { op: 'set', value: '冷蓝色夜景，背景更克制' });
  assert.equal(parsed.parserWarnings?.some((item) => item.code === 'style_rules_ignored'), true);
}

{
  const parsed = parseFirstFrameRewriteResult(JSON.stringify({
    assistantMessage: 'ok',
    nextDraft: {
      styleRuleOverrides: ['更冷的色调'],
      content: '冷蓝色夜景，背景更克制',
    },
  }));

  assert.equal(Object.prototype.hasOwnProperty.call(parsed.draftPatch || {}, 'styleRuleOverrides'), false);
  assert.deepEqual(parsed.draftPatch?.content, { op: 'set', value: '冷蓝色夜景，背景更克制' });
  assert.equal(parsed.parserWarnings?.some((item) => item.code === 'style_rules_ignored'), true);
}

{
  const parsed = parseFirstFrameRewriteResult(JSON.stringify({
    assistantMessage: 'ok',
    draftPatch: {
      quality: 'high',
      size: '16:9',
    },
  }));

  assert.deepEqual(parsed.draftPatch, {});
  assert.equal(parsed.parserWarnings?.filter((item) => item.code === 'forbidden_field_ignored').length, 2);
}

console.log('test-first-frame-rewrite-patch passed');
