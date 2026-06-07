import assert from 'node:assert/strict';
import {
  mutateCharacterLock,
  syncWorldCharactersIntoConsistency,
  type CharacterLock,
} from '../lib/character-consistency';

const now = '2026-06-05T00:00:00.000Z';

function worldCharacter(overrides: Record<string, any> = {}) {
  return {
    id: 'world-hero',
    characterId: 'world-hero',
    name: '林舟',
    role: '海港巡逻员',
    identity: '负责守住潮汐城入口的年轻巡逻员',
    entityType: 'human',
    appearance: '短发，左眉有旧伤',
    clothing: '深绿色巡逻制服',
    equipment: '铜制潮汐罗盘',
    temperament: '谨慎',
    actionTraits: '进入陌生地点前先确认出口',
    referencePanels: {
      sheetUrl: '/api/edit/media/world-hero-sheet.png',
    },
    ...overrides,
  };
}

function findLock(project: any, name = '林舟'): CharacterLock {
  const lock = project.consistency.characters.find((item: CharacterLock) => item.canonicalName === name || item.characterId === 'world-hero');
  assert.ok(lock, `missing lock for ${name}`);
  return lock;
}

function testInitialWorldBindCreatesConsistencyLock() {
  const project = {
    id: 'proj-world-sync',
    selectedWorldTemplateId: 'tpl-world',
    worldTemplateSnapshot: {
      id: 'tpl-world',
      characters: [worldCharacter()],
    },
  };
  const result = syncWorldCharactersIntoConsistency(project, { now });
  assert.equal(result.changed, true);
  assert.deepEqual(result.conflictReasons, []);
  const lock = findLock(result.project);
  assert.equal(lock.status, 'draft');
  assert.equal(lock.identityLock.role, '海港巡逻员');
  assert.equal(lock.visualLock.appearance, '短发,左眉有旧伤');
  assert.equal(lock.visualLock.clothing, '深绿色巡逻制服');
  assert.equal(lock.visualLock.equipment, '铜制潮汐罗盘');
  assert.equal(lock.referenceLock.referenceStatus, 'ready');
}

function testLockedCharacterKeepsUserConfirmedFieldsAndReportsConflict() {
  let project: any = {
    id: 'proj-locked-conflict',
    assets: { characters: [{ id: 'world-hero', name: '林舟', role: '巡逻员', appearance: '短发，左眉无伤' }] },
  };
  project = mutateCharacterLock(
    project,
    'world-hero',
    {
      canonicalName: '林舟',
      identityLock: { role: '巡逻员', identity: '旧设定', entityType: 'human' },
      visualLock: { appearance: '短发，左眉无伤', clothing: '蓝色制服', equipment: '木哨' },
    },
    { source: 'user_confirm', userConfirmed: true, now },
  ).project;
  project.worldTemplateSnapshot = {
    id: 'tpl-world',
    characters: [worldCharacter()],
  };

  const result = syncWorldCharactersIntoConsistency(project, { now });
  const lock = findLock(result.project);
  assert.equal(lock.status, 'locked');
  assert.equal(lock.visualLock.appearance, '短发,左眉无伤');
  assert.equal(lock.visualLock.clothing, '蓝色制服');
  assert.equal(lock.visualLock.equipment, '木哨');
  assert.equal(result.project.consistency.meta.needsRoleSync, true);
  assert.ok(result.project.consistency.meta.roleSyncReasons.some((reason: string) => reason.includes('visualLock.appearance')));
}

function testDraftCharacterKeepsExistingNonEmptyFieldsAndFillsEmptyFields() {
  let project: any = {
    id: 'proj-draft-sync',
    assets: { characters: [{ id: 'world-hero', name: '林舟', role: '临时角色', appearance: '占位外观' }] },
  };
  project = mutateCharacterLock(
    project,
    'world-hero',
    {
      canonicalName: '林舟',
      identityLock: { role: '临时角色', identity: '', entityType: 'human' },
      visualLock: { appearance: '占位外观' },
    },
    { source: 'asset_extract', now },
  ).project;
  project.worldTemplateSnapshot = {
    id: 'tpl-world',
    characters: [worldCharacter()],
  };

  const result = syncWorldCharactersIntoConsistency(project, { now });
  const lock = findLock(result.project);
  assert.equal(lock.status, 'draft');
  assert.equal(lock.identityLock.role, '临时角色');
  assert.equal(lock.identityLock.identity, '负责守住潮汐城入口的年轻巡逻员');
  assert.equal(lock.visualLock.appearance, '占位外观');
  assert.equal(lock.visualLock.clothing, '深绿色巡逻制服');
  assert.equal(lock.visualLock.equipment, '铜制潮汐罗盘');
  assert.equal(result.project.consistency.meta.needsRoleSync, true);
  assert.ok(result.project.consistency.meta.roleSyncReasons.some((reason: string) => reason.includes('identityLock.role')));
}

function testRepeatedWorldSyncDoesNotMarkChangedWhenNothingChanged() {
  const first = syncWorldCharactersIntoConsistency({
    id: 'proj-repeat-sync',
    selectedWorldTemplateId: 'tpl-world',
    worldTemplateSnapshot: {
      id: 'tpl-world',
      characters: [worldCharacter()],
    },
  }, { now });
  const second = syncWorldCharactersIntoConsistency(first.project, { now });
  assert.equal(second.changed, false);
  assert.deepEqual(second.conflictReasons, []);
}

function testWorldCharacterMatchDoesNotUseSharedRole() {
  let project: any = {
    id: 'proj-role-match',
  };
  project = mutateCharacterLock(
    project,
    'char-a',
    {
      canonicalName: '甲',
      identityLock: { role: '巡逻员', identity: '甲身份', entityType: 'human' },
      visualLock: { appearance: '甲外观' },
    },
    { source: 'asset_extract', now },
  ).project;
  project.worldTemplateSnapshot = {
    id: 'tpl-world',
    characters: [worldCharacter({
      id: 'char-b',
      characterId: 'char-b',
      name: '乙',
      role: '巡逻员',
      identity: '乙身份',
      appearance: '乙外观',
    })],
  };
  const result = syncWorldCharactersIntoConsistency(project, { now });
  assert.equal(result.project.consistency.characters.length, 2);
  assert.ok(result.project.consistency.characters.some((lock: CharacterLock) => lock.canonicalName === '甲'));
  assert.ok(result.project.consistency.characters.some((lock: CharacterLock) => lock.canonicalName === '乙'));
}

function testWorldIdentityCollisionDoesNotBackfillSoftHumanFieldsIntoNonHumanAsset() {
  let project: any = {
    id: 'proj-nonhuman-collision',
    assets: {
      characters: [{
        id: 'c4',
        characterId: 'c4',
        name: '坠落飞鸟',
        role: '被钟声震落的远处飞鸟',
        identity: '一只普通飞鸟',
        entityType: 'non-human',
        appearance: '灰褐小型山野飞鸟，羽翼半张，身体僵直下坠',
        clothing: '',
        equipment: '',
      }],
    },
  };
  project = mutateCharacterLock(
    project,
    'c4',
    {
      sourceAssetId: 'c4',
      canonicalName: '坠落飞鸟',
      aliases: ['坠落飞鸟'],
      identityLock: { role: '被钟声震落的远处飞鸟', identity: '一只普通飞鸟', entityType: 'non-human' },
      visualLock: {
        appearance: '灰褐小型山野飞鸟，羽翼半张，身体僵直下坠',
        clothing: '',
        equipment: '',
      },
    },
    { source: 'asset_extract', now },
  ).project;
  project.worldTemplateSnapshot = {
    id: 'tpl-old-hotpot',
    characters: [{
      id: 'c4',
      characterId: 'c4',
      name: '沉默同桌顾客',
      role: '与其他食客同桌却不交流的年轻顾客',
      identity: '坐在后景中维持仪式感用餐节奏的群像代表',
      entityType: 'human',
      appearance: '二十多岁，短发整齐，表情平直',
      clothing: '炭黑色夹克内搭暖灰T恤，袖口卷起，围纸质餐巾',
      equipment: '筷子',
    }],
  };

  const result = syncWorldCharactersIntoConsistency(project, { now });
  const lock = result.project.consistency.characters.find((item: CharacterLock) => item.characterId === 'c4');
  assert.ok(lock, 'missing c4 lock');
  assert.equal(lock.canonicalName, '坠落飞鸟');
  assert.equal(lock.identityLock.entityType, 'non-human');
  assert.equal(lock.visualLock.clothing, '');
  assert.equal(lock.visualLock.equipment, '');
  assert.ok(!lock.aliases.includes('沉默同桌顾客'));
  assert.ok(result.project.consistency.meta.roleSyncReasons.some((reason: string) => reason.includes('canonicalName')));
  assert.ok(result.project.consistency.meta.roleSyncReasons.some((reason: string) => reason.includes('identityLock.entityType')));
}

function testWorldSyncDoesNotReuseClaimedExistingLock() {
  let project: any = {
    id: 'proj-claimed-lock',
  };
  project = mutateCharacterLock(
    project,
    'old-lock',
    {
      sourceAssetId: 'shared-asset',
      canonicalName: '旧名',
      identityLock: { role: '旧角色', identity: '旧身份', entityType: 'human' },
      visualLock: { appearance: '旧外观' },
    },
    { source: 'asset_extract', now },
  ).project;
  project.worldTemplateSnapshot = {
    id: 'tpl-world',
    characters: [
      worldCharacter({
        id: 'world-a',
        characterId: 'world-a',
        sourceAssetId: 'shared-asset',
        name: '新名A',
        role: '巡逻员A',
        identity: 'A身份',
        appearance: 'A外观',
      }),
      worldCharacter({
        id: 'world-b',
        characterId: 'world-b',
        sourceAssetId: 'shared-asset',
        name: '新名B',
        role: '巡逻员B',
        identity: 'B身份',
        appearance: 'B外观',
      }),
    ],
  };
  const result = syncWorldCharactersIntoConsistency(project, { now });
  assert.equal(result.project.consistency.characters.length, 2);
  assert.ok(result.project.consistency.characters.some((lock: CharacterLock) => lock.characterId === 'old-lock'));
  assert.ok(result.project.consistency.characters.some((lock: CharacterLock) => lock.characterId === 'world-b' && lock.canonicalName === '新名B'));
}

function testWorldReferenceBackfillPromotesMissingToReady() {
  let project: any = {
    id: 'proj-reference-ready',
  };
  project = mutateCharacterLock(
    project,
    'world-hero',
    {
      canonicalName: '林舟',
      identityLock: { role: '海港巡逻员', identity: '旧身份', entityType: 'human' },
      visualLock: { appearance: '短发' },
      referenceLock: { referenceStatus: 'missing' },
    },
    { source: 'asset_extract', now },
  ).project;
  project.worldTemplateSnapshot = {
    id: 'tpl-world',
    characters: [worldCharacter()],
  };
  const result = syncWorldCharactersIntoConsistency(project, { now });
  const lock = findLock(result.project);
  assert.equal(lock.referenceLock.sheetUrl, '/api/edit/media/world-hero-sheet.png');
  assert.equal(lock.referenceLock.referenceStatus, 'ready');
}

testInitialWorldBindCreatesConsistencyLock();
testLockedCharacterKeepsUserConfirmedFieldsAndReportsConflict();
testDraftCharacterKeepsExistingNonEmptyFieldsAndFillsEmptyFields();
testRepeatedWorldSyncDoesNotMarkChangedWhenNothingChanged();
testWorldCharacterMatchDoesNotUseSharedRole();
testWorldIdentityCollisionDoesNotBackfillSoftHumanFieldsIntoNonHumanAsset();
testWorldSyncDoesNotReuseClaimedExistingLock();
testWorldReferenceBackfillPromotesMissingToReady();

console.log('[test-world-consistency-sync] all assertions passed');
