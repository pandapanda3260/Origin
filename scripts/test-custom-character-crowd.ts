import assert from 'node:assert/strict';
import {
  buildCustomCharacterImagePrompt,
  normalizeCustomCharacterFields,
  normalizeCustomCharacterParams,
} from '../lib/custom-character-prompt';

const params = normalizeCustomCharacterParams({
  entityType: 'human',
  gender: 'auto',
  ageRange: 'teen',
  isCrowd: true,
  crowdSize: '  十几人  ',
});

assert.equal(params.isCrowd, true);
assert.equal(params.crowdSize, '十几人');

const fields = normalizeCustomCharacterFields({
  name: '考核少年少女群像',
  role: '',
  identity: '',
  entityType: 'human',
  appearance: '十几名少年少女，站位有前后层次，神态紧张又期待',
  clothing: '统一灰蓝练功服，细节略有差异',
  temperament: '紧张,期待,克制',
  actionTraits: '低声交谈,队列等待',
  imagePrompt: '十几名少年少女组成的考核群像，统一灰蓝练功服，表情和站姿自然多样',
}, params);

assert.equal(fields.isCrowd, true);
assert.equal(fields.crowdSize, '十几人');
assert.equal(fields.role, '匿名群体');
assert.equal(fields.entityType, 'human');

const { prompt } = buildCustomCharacterImagePrompt({
  fields,
  styleBible: { castingProfile: { ethnicityType: 'han_chinese' } },
  script: '少年少女们在广场等待考核。',
  sourceType: 'prompt',
});

assert.match(prompt, /ANONYMOUS CROWD CASTING RULES/);
assert.match(prompt, /Current group appearance/);
assert.match(prompt, /Approximate crowd size: 十几人/);
assert.doesNotMatch(prompt, /CHARACTER CASTING LOCK \(authoritative ethnicity\/face baseline\)/);
assert.doesNotMatch(prompt, /same face/i);

console.log('test-custom-character-crowd passed');
