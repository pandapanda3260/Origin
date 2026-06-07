import assert from 'node:assert/strict';
import {
  buildAssetAuthoritativeCharacterLock,
  resolveCharacterAssetForEntity,
} from '../lib/character-lock-authority';
import { renderCharacterLockRosterLine, type CharacterLock } from '../lib/character-consistency';
import { buildCharacterLockRoster } from '../lib/frame-prompt-helpers';
import { buildVideoPromptAudit } from '../lib/video-prompt-audit';
import {
  buildWorldTemplateFromProject,
  buildWorldTemplateFromProjectSnapshot,
} from '../lib/world-templates-db';

function lock(overrides: Partial<CharacterLock> = {}): CharacterLock {
  return {
    characterId: 'c1',
    sourceAssetId: 'c1',
    canonicalName: '坠落飞鸟',
    aliases: ['坠落飞鸟'],
    versions: {
      identityVersion: 1,
      visualVersion: 1,
      performanceVersion: 1,
      voiceVersion: 1,
      resolverVersion: 1,
      referenceVersion: 1,
    },
    status: 'locked',
    identityLock: {
      role: '被钟声震落的远处飞鸟',
      identity: '远处小型飞鸟',
      entityType: 'non-human',
      species: '飞鸟',
    },
    visualLock: {
      appearance: '灰褐小型飞鸟',
      clothing: '炭黑色夹克内搭暖灰T恤,围纸质餐巾',
      equipment: '筷子',
      negativeRules: ['no wardrobe drift', '保持服装', 'no extra limbs'],
      signatureColors: [],
      canonicalPrompt: '灰褐飞鸟，围纸质餐巾，拿筷子',
      visualSignatureHash: '',
    },
    performanceLock: {
      temperament: '呆滞',
      actionTraits: '僵直下坠',
      gestureRules: [],
      performanceSignatureHash: '',
    },
    voiceLock: {
      confidence: 0,
      negativeRules: [],
      voiceSignatureHash: '',
    },
    referenceLock: {
      referenceStatus: 'missing',
    },
    ...overrides,
  };
}

function testNonHumanExplicitEmptyFieldsClearDirtyLock() {
  const projected = buildAssetAuthoritativeCharacterLock(lock(), {
    id: 'c1',
    name: '坠落飞鸟',
    entityType: 'non-human',
    species: '飞鸟',
    appearance: '灰褐小型飞鸟，羽翼半张',
    clothing: '',
    equipment: '',
  });
  const roster = renderCharacterLockRosterLine(projected, 'zh');
  assert.equal(projected.visualLock.clothing, '');
  assert.equal(projected.visualLock.equipment, '');
  assert.equal(projected.visualLock.canonicalPrompt, '');
  assert.ok(!projected.visualLock.negativeRules.some((rule) => /wardrobe|服装/i.test(rule)));
  assert.ok(!/餐巾|筷子/.test(roster), roster);
}

function testHumanExplicitEmptyEquipmentClearsDirtyLock() {
  const projected = buildAssetAuthoritativeCharacterLock(lock({
    characterId: 'c2',
    sourceAssetId: 'c2',
    canonicalName: '接引长老',
    identityLock: { role: '宗门长老', identity: '主持考核', entityType: 'human' },
    visualLock: {
      appearance: '长老外貌',
      clothing: '灰色长袍',
      equipment: '筷子',
      negativeRules: [],
      signatureColors: [],
      canonicalPrompt: '长老拿筷子',
      visualSignatureHash: '',
    },
  }), {
    id: 'c2',
    name: '接引长老',
    entityType: 'human',
    appearance: '长老外貌',
    clothing: '灰色宽袖长袍',
    equipment: '',
  });
  const roster = renderCharacterLockRosterLine(projected, 'zh');
  assert.equal(projected.visualLock.equipment, '');
  assert.ok(!/筷子/.test(roster), roster);
}

function testMissingAssetFieldKeepsWorldTemplateEquipment() {
  const projected = buildAssetAuthoritativeCharacterLock(lock({
    visualLock: {
      appearance: '候选弟子群体',
      clothing: '青灰修行袍',
      equipment: '腰牌',
      negativeRules: [],
      signatureColors: [],
      canonicalPrompt: '候选弟子群体，腰牌',
      visualSignatureHash: '',
    },
  }), {
    id: 'c3',
    name: '考核人群',
    entityType: 'human',
    appearance: '候选弟子群体',
    clothing: '青灰修行袍',
  });
  assert.equal(projected.visualLock.equipment, '腰牌');
}

function testResolverDoesNotUseSharedRole() {
  const project = {
    assets: {
      characters: [
        { id: 'a', name: '甲', role: '巡逻员', equipment: '木哨' },
        { id: 'b', name: '乙', role: '巡逻员', equipment: '罗盘' },
      ],
    },
  };
  const resolved = resolveCharacterAssetForEntity(project, {
    characterId: 'missing-id',
    canonicalName: '巡逻员',
    aliases: [],
  });
  assert.equal(resolved.asset, null);
  assert.equal(resolved.reason, 'no_match');
}

function testAmbiguousAliasDoesNotPickArbitraryAsset() {
  const project = {
    assets: {
      characters: [
        { id: 'a', name: '同名角色' },
        { id: 'b', name: '同名角色' },
      ],
    },
  };
  const resolved = resolveCharacterAssetForEntity(project, {
    characterId: 'missing-id',
    canonicalName: '不存在',
    aliases: ['同名角色'],
  });
  assert.equal(resolved.asset, null);
  assert.equal(resolved.reason, 'ambiguous');
}

function testResolverReadsBothCharacterShapes() {
  const project = {
    characters: [{ id: 'top-only', name: '顶层角色', equipment: '' }],
  };
  const resolved = resolveCharacterAssetForEntity(project, {
    characterId: 'top-only',
    canonicalName: '顶层角色',
  });
  assert.equal(resolved.asset?.name, '顶层角色');
  assert.equal(resolved.reason, 'characterId');
}

function testBuildCharacterLockRosterUsesProjectedLock() {
  const project = {
    assets: {
      characters: [{
        id: 'c1',
        name: '坠落飞鸟',
        entityType: 'non-human',
        species: '飞鸟',
        appearance: '灰褐小型飞鸟',
        clothing: '',
        equipment: '',
      }],
    },
    consistency: {
      schema: 'origin-consistency-v1',
      updatedAt: '2026-06-06T00:00:00.000Z',
      meta: { needsRoleSync: false, roleSyncReasons: [], resolverCaseVersion: 1 },
      characters: [lock()],
    },
  };
  const roster = buildCharacterLockRoster(project, new Set(['坠落飞鸟']), 'zh', '坠落飞鸟被钟声震落');
  assert.ok(roster.includes('坠落飞鸟'), roster);
  assert.ok(!/餐巾|筷子/.test(roster), roster);
}

function testVideoPromptAuditUsesProjectedRoster() {
  const user = {
    id: 1,
    username: 'tester',
    email: null,
    phone: null,
    display_name: 'tester',
    password_hash: '',
    email_verified: 1,
    disabled_at: null,
    token_revoked_at: null,
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
  };
  const project = {
    id: 'proj-audit',
    title: '审计测试',
    styleBible: {},
    assets: {
      characters: [{
        id: 'c1',
        name: '坠落飞鸟',
        entityType: 'non-human',
        species: '飞鸟',
        appearance: '灰褐小型飞鸟',
        clothing: '',
        equipment: '',
      }],
    },
    consistency: {
      schema: 'origin-consistency-v1',
      updatedAt: '2026-06-06T00:00:00.000Z',
      meta: { needsRoleSync: false, roleSyncReasons: [], resolverCaseVersion: 1 },
      characters: [lock()],
    },
    shots: [{
      characters: ['坠落飞鸟'],
      visual: '坠落飞鸟被钟声震落',
      duration: 4,
    }],
    storyboards: [{
      shotIndices: [0],
      videoPrompt: '坠落飞鸟被钟声震落',
    }],
  };
  const audit = buildVideoPromptAudit(user, project, 0, { ratio: '9:16' });
  const serialized = JSON.stringify(audit);
  assert.ok(serialized.includes('坠落飞鸟'), serialized);
  assert.ok(!/餐巾|筷子/.test(serialized), serialized);
}

function testSnapshotFirstWorldExportUsesRuntimeOverlay() {
  const project = {
    id: 'proj-snapshot-export',
    title: '导出测试',
    assets: {
      characters: [{
        id: 'c4',
        name: '坠落飞鸟',
        role: '被钟声震落的远处飞鸟',
        identity: '一只被钟声震落的小型飞鸟',
        description: '小型飞鸟受到钟声影响下坠',
        entityType: 'non-human',
        species: '飞鸟',
        appearance: '灰褐小型飞鸟',
        clothing: '',
        equipment: '',
        temperament: '受惊',
        actionTraits: '直线坠落',
      }],
    },
    worldTemplateSnapshot: {
      id: 'tpl-dirty',
      name: '脏快照',
      characters: [{
        id: 'c4',
        characterId: 'c4',
        name: '沉默同桌顾客',
        aliases: ['沉默同桌顾客', '涮肉顾客'],
        role: '与其他食客同桌却不交流的年轻顾客',
        identity: '坐在后景中维持火锅店用餐节奏的群像代表',
        description: '坐在火锅店后景中反复夹肉的顾客',
        entityType: 'human',
        appearance: '年轻顾客',
        clothing: '炭黑色夹克内搭暖灰T恤,围纸质餐巾',
        equipment: '筷子',
        temperament: '平直、压抑',
        actionTraits: '反复夹肉',
        canonicalPrompt: '年轻顾客，围纸质餐巾，拿筷子',
      }],
    },
  };
  const template = buildWorldTemplateFromProjectSnapshot(project, { mode: 'create' });
  const character = template?.characters?.[0];
  assert.ok(character, 'missing exported snapshot character');
  assert.equal(character.name, '坠落飞鸟');
  assert.deepEqual(character.aliases, ['坠落飞鸟', '被钟声震落的远处飞鸟']);
  assert.equal(character.role, '被钟声震落的远处飞鸟');
  assert.equal(character.identity, '一只被钟声震落的小型飞鸟');
  assert.equal(character.description, '小型飞鸟受到钟声影响下坠');
  assert.equal(character.entityType, 'non-human');
  assert.equal(character.species, '飞鸟');
  assert.equal(character.appearance, '灰褐小型飞鸟');
  assert.equal(character.clothing, '');
  assert.equal(character.equipment, '');
  assert.equal(character.temperament, '受惊');
  assert.equal(character.actionTraits, '直线坠落');
  assert.equal(character.canonicalPrompt, '');
  assert.ok(!/餐巾|餐布|筷子|火锅|涮肉|顾客/.test(JSON.stringify(character)), JSON.stringify(character));
}

function testProjectWorldExportUsesAssetsCharactersWhenTopMissing() {
  const project = {
    id: 'proj-assets-only-export',
    title: 'assets only',
    assets: {
      characters: [{
        id: 'c2',
        name: '接引长老',
        entityType: 'human',
        appearance: '长老外貌',
        clothing: '灰色宽袖长袍',
        equipment: '',
      }],
    },
    consistency: {
      schema: 'origin-consistency-v1',
      updatedAt: '2026-06-06T00:00:00.000Z',
      meta: { needsRoleSync: false, roleSyncReasons: [], resolverCaseVersion: 1 },
      characters: [lock({
        characterId: 'c2',
        sourceAssetId: 'c2',
        canonicalName: '接引长老',
        aliases: ['沉默涮肉顾客甲'],
        identityLock: { role: '宗门长老', identity: '主持考核', entityType: 'human' },
        visualLock: {
          appearance: '长老外貌',
          clothing: '灰色长袍',
          equipment: '筷子',
          negativeRules: [],
          signatureColors: [],
          canonicalPrompt: '长老拿筷子',
          visualSignatureHash: '',
        },
      })],
    },
  };
  const template = buildWorldTemplateFromProject(project);
  const character = template.characters?.[0];
  assert.ok(character, 'missing exported project character');
  assert.equal(character.name, '接引长老');
  assert.ok(!JSON.stringify(character.aliases || []).includes('涮肉'), JSON.stringify(character.aliases));
  assert.equal(character.clothing, '灰色宽袖长袍');
  assert.equal(character.equipment, '');
  assert.equal(character.canonicalPrompt, '');
}

testNonHumanExplicitEmptyFieldsClearDirtyLock();
testHumanExplicitEmptyEquipmentClearsDirtyLock();
testMissingAssetFieldKeepsWorldTemplateEquipment();
testResolverDoesNotUseSharedRole();
testAmbiguousAliasDoesNotPickArbitraryAsset();
testResolverReadsBothCharacterShapes();
testBuildCharacterLockRosterUsesProjectedLock();
testVideoPromptAuditUsesProjectedRoster();
testSnapshotFirstWorldExportUsesRuntimeOverlay();
testProjectWorldExportUsesAssetsCharactersWhenTopMissing();

console.log('character lock authority assertions passed');
