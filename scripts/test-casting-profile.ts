import assert from 'node:assert/strict';
import { appendCharacterCastingPrompt, formatCharacterCastingPromptBlock, isNonHumanCharacter } from '../lib/casting-profile';

const styleBible = { castingProfile: { ethnicityType: 'han_chinese' } };

{
  const prompt = appendCharacterCastingPrompt('Base prompt', {
    name: '活螃蟹',
    entityType: 'non-human',
    appearance: '真实青蟹，硬壳湿亮',
  }, styleBible, { script: '中文剧本' });
  assert.match(prompt, /NON-HUMAN CHARACTER CASTING LOCK/);
  assert.match(prompt, /no human/);
  assert.doesNotMatch(prompt, /Han Chinese person/);
  assert.doesNotMatch(prompt, /Chinese facial features/);
  assert.equal(isNonHumanCharacter({ entityType: '非人' }), true);
}

{
  const block = formatCharacterCastingPromptBlock({ name: '老板', entityType: 'human' }, styleBible, { script: '中文剧本' });
  assert.match(block, /CHARACTER CASTING LOCK/);
  assert.match(block, /Han Chinese person/);
  assert.doesNotMatch(block, /NON-HUMAN/);
}

{
  const once = appendCharacterCastingPrompt('Base prompt', { entityType: 'non-human' }, styleBible);
  const twice = appendCharacterCastingPrompt(once, { entityType: 'non-human' }, styleBible);
  assert.equal(twice, once, 'non-human casting block should be idempotent');
}

console.log('[test-casting-profile] all assertions passed');
