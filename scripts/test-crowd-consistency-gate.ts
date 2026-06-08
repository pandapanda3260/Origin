import assert from 'node:assert/strict';
import { validateCharacterConsistencyForGroup } from '../lib/character-consistency-gate';
import { buildCharacterLockRoster } from '../lib/frame-prompt-helpers';

const crowdProject = {
  id: 'project-crowd-gate',
  assets: {
    characters: [{
      id: 'c4',
      characterId: 'c4',
      name: '考核少年少女群像',
      role: '考核现场的匿名少年少女群体',
      identity: '没有具名成员的匿名群体',
      isCrowd: true,
      crowdSize: '十几人',
      entityType: 'human',
      appearance: '十几名少年少女，神态紧张又期待',
      clothing: '统一灰蓝练功服，细节略有差异',
    }],
    scenes: [],
    props: [],
  },
  shots: [{
    characters: ['考核少年少女群像'],
    visual: '考核少年少女群像聚集在广场边缘，主角从人群前方经过',
    description: 'crowd in the background',
  }],
  storyboards: [{
    shotIndices: [0],
    videoPrompt: '考核少年少女群像聚集在广场边缘',
  }],
};

{
  const result = validateCharacterConsistencyForGroup(crowdProject, {
    groupIdx: 0,
    shotIndices: [0],
    target: 'videoSegment',
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.characterUsages.length, 0, 'crowd locks should not enter usedIds or snapshots');

  const roster = buildCharacterLockRoster(
    crowdProject,
    new Set(['考核少年少女群像']),
    'zh',
    '考核少年少女群像聚集在广场边缘',
  );
  assert.equal(roster, '', 'crowd should not be rendered as a single-character lock roster line');
}

{
  const explicitIdentityProject = {
    ...crowdProject,
    assets: {
      characters: [{
        ...(crowdProject.assets.characters[0] as any),
        isCrowd: false,
      }],
      scenes: [],
      props: [],
    },
  };
  const result = validateCharacterConsistencyForGroup(explicitIdentityProject, {
    groupIdx: 0,
    shotIndices: [0],
    target: 'videoSegment',
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.some((item) => item.code === 'character_status_not_locked'));
  assert.ok(result.blockers.some((item) => item.code === 'critical_reference_missing'));
}

console.log('test-crowd-consistency-gate passed');
