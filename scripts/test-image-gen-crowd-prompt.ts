import assert from 'node:assert/strict';
import { composeFinalImagePrompt } from '../lib/image-gen';

{
  const prompt = composeFinalImagePrompt({
    prompt: '考核少年少女群像，十几人，统一灰蓝练功服，神态紧张又期待',
    style: 'natural',
    kind: 'character',
    entityType: 'human',
    characterAssetMode: 'anonymous_crowd',
  });
  assert.match(prompt, /ANONYMOUS CROWD/);
  assert.match(prompt, /ONE single continuous image/);
  assert.match(prompt, /face shape/i);
  assert.match(prompt, /jawline/i);
  assert.match(prompt, /eye shape/i);
  assert.match(prompt, /repeated face templates/i);
  assert.doesNotMatch(prompt, /SAME PERSON/);
  assert.doesNotMatch(prompt, /FOUR panels/);
}

{
  const prompt = composeFinalImagePrompt({
    prompt: '一排帝王蟹群像，多个个体，硬壳湿亮，餐台陈列',
    style: 'natural',
    kind: 'character',
    entityType: 'non-human',
    characterAssetMode: 'anonymous_crowd',
  });
  assert.match(prompt, /ANONYMOUS NON-HUMAN CROWD/);
  assert.match(prompt, /multiple individuals of the same non-human species/i);
  assert.match(prompt, /Do NOT clone one identical subject/i);
  assert.doesNotMatch(prompt, /SAME subject/);
  assert.doesNotMatch(prompt, /THREE panels/);
  assert.doesNotMatch(prompt, /Han Chinese person/);
}

console.log('test-image-gen-crowd-prompt passed');
