import assert from 'node:assert/strict';
import { injectWorldTemplateIntoAssets, normalizeAssetMatchKey } from '../lib/world-asset-injection';

const worldTemplateSnapshot = {
  id: 'world-injection-test',
  characters: [],
  characterCandidates: [
    {
      characterId: 'world-xiao-yun',
      name: '萧云',
      role: '神子候选',
      identity: '混沌圣地入门考核的少年主角',
      entityType: 'human',
      species: '人类',
      gender: 'male',
      ageBand: 'teen',
      appearance: '眉眼清亮，神色平静',
      clothing: '世界观服装不应覆盖',
      equipment: '世界观装备不应覆盖',
      description: '连响神迹后成为候选的少年',
      temperament: '沉静',
      actionTraits: '缓步上前',
      realPhotoUrl: '/api/images/file/11111111-1111-1111-1111-111111111111',
      referencePanels: {
        sheetUrl: '/api/images/file/22222222-2222-2222-2222-222222222222',
        headshotUrl: '/api/images/file/33333333-3333-3333-3333-333333333333',
        frontUrl: '/api/images/file/44444444-4444-4444-4444-444444444444',
      },
    },
    {
      characterId: 'world-elder',
      name: '接引长老',
      role: '考核长老',
      identity: '混沌圣地负责接引的高台长老',
      entityType: 'human',
      appearance: '灰白须发',
      imageUrl: '/world/elder.png',
    },
    {
      name: '重名角色',
      role: '第一条',
      entityType: 'human',
      appearance: '甲',
    },
    {
      name: '重名角色',
      role: '第二条',
      entityType: 'human',
      appearance: '乙',
    },
    {
      name: '非人守卫',
      entityType: 'human',
      appearance: '人形守卫',
      imageUrl: '/world/guard.png',
    },
    {
      name: '考核少年群像',
      role: '考核者群体',
      entityType: 'human',
      appearance: '密集聚集的少年群像',
      referencePanels: {
        sheetUrl: '/world/crowd-sheet.png',
      },
    },
    {
      // 退化路径：模板角色只有特写预览，没有真三视图（referencePanels.sheetUrl）。
      // 期望：文本照常注入，但绝不把特写伪造成 sheetUrl/卡面图，也不标 ready，
      // 让角色留在"待生成"走正常生成链。
      characterId: 'world-preview-only',
      name: '特写候选',
      role: '预览角色',
      entityType: 'human',
      appearance: '只有特写的候选',
      previewUrl: '/world/preview-headshot.png',
      realPhotoUrl: '/world/preview-headshot.png',
      referencePanels: {
        headshotUrl: '/world/preview-headshot.png',
      },
    },
  ],
  locations: [
    {
      name: '混沌圣地山门',
      description: '云海高台与青灰石阶',
      atmosphere: '肃穆宏大',
      imageUrl: '/world/gate.png',
    },
  ],
  props: [
    {
      name: '青灰石板',
      function: '用于入门考核判定神迹',
      visualFeatures: '高台前的青灰色古石板',
      imageUrl: '/world/slate.png',
    },
  ],
};

const assets = {
  characters: [
    {
      id: 'c1',
      characterId: 'local-xiao',
      name: ' 萧 云 ',
      role: '少年',
      identity: '本集临时身份',
      entityType: 'human',
      appearance: 'LLM 外观',
      clothing: '本集青色短袍',
      equipment: '本集无装备',
      temperament: 'LLM 气质',
      actionTraits: 'LLM 动作',
    },
    {
      id: 'c2',
      name: '接引长老',
      role: '长老',
      identity: '旧身份',
      entityType: 'human',
      imageUrl: '/project/elder-existing.png',
      reference: {
        currentUrl: '/project/elder-existing.png',
        lastKnownGoodUrl: '/project/elder-existing.png',
        status: 'ready',
      },
    },
    {
      id: 'c3',
      name: '重名角色',
      role: '保持原样',
      entityType: 'human',
      appearance: '不应植入',
    },
    {
      id: 'c4',
      name: '非人守卫',
      entityType: 'non-human',
      appearance: '非人资产',
    },
    {
      id: 'c5',
      name: '考核少年群像',
      entityType: 'human',
      isCrowd: true,
      appearance: 'LLM 群像',
    },
    {
      id: 'c6',
      name: '特写候选',
      role: 'LLM 角色',
      entityType: 'human',
      appearance: 'LLM 外观',
    },
  ],
  scenes: [
    {
      id: 'e1',
      name: '混沌圣地山门',
      description: 'LLM 场景',
      atmosphere: 'LLM 氛围',
      weather: '晴',
      lighting: '晨光',
      elements: '山门、石阶',
    },
  ],
  props: [
    {
      id: 'p1',
      name: '青灰石板',
      propType: '标志物',
      features: 'LLM 石纹',
      material: '石材',
      ownership: 'c1',
    },
  ],
};

assert.equal(normalizeAssetMatchKey(' 萧 云 '), normalizeAssetMatchKey('萧云'));

const result = injectWorldTemplateIntoAssets({
  assets,
  worldTemplateSnapshot,
});

assert.equal(result.assets.characters.length, assets.characters.length);
assert.equal(result.assets.scenes.length, assets.scenes.length);
assert.equal(result.assets.props.length, assets.props.length);

const xiao = result.assets.characters[0];
assert.equal(xiao.characterId, 'local-xiao');
assert.equal(xiao.role, '神子候选');
assert.equal(xiao.identity, '混沌圣地入门考核的少年主角');
assert.equal(xiao.appearance, '眉眼清亮，神色平静');
assert.equal(xiao.description, '连响神迹后成为候选的少年');
assert.equal(xiao.temperament, '沉静');
assert.equal(xiao.actionTraits, '缓步上前');
assert.equal(xiao.clothing, '本集青色短袍');
assert.equal(xiao.equipment, '本集无装备');
// 资产契约：imageUrl/rawUrl/realPhotoUrl 三字段同源 = 三视图原图（不再把模板的特写预览写进 realPhotoUrl）
assert.equal(xiao.realPhotoUrl, '/api/images/file/22222222-2222-2222-2222-222222222222');
assert.equal(xiao.rawUrl, '/api/images/file/22222222-2222-2222-2222-222222222222');
assert.equal(xiao.imageUrl, '/api/images/file/22222222-2222-2222-2222-222222222222');
assert.equal(xiao.previewUrl, undefined);
assert.equal(xiao.reference.status, 'ready');
assert.equal(xiao.panels.schema, 'human-character-sheet-v1');
assert.equal(xiao.panels.sheetUrl, '/api/images/file/22222222-2222-2222-2222-222222222222');
assert.equal(xiao.panels.headshotUrl, '/api/images/file/33333333-3333-3333-3333-333333333333');
assert.equal(xiao.panels.sourceImageId, '22222222-2222-2222-2222-222222222222');
assert.equal(xiao.panels.cropMethod, undefined);

const elder = result.assets.characters[1];
assert.equal(elder.identity, '混沌圣地负责接引的高台长老');
assert.equal(elder.imageUrl, '/project/elder-existing.png');
assert.equal(elder.reference.currentUrl, '/project/elder-existing.png');

const duplicate = result.assets.characters[2];
assert.equal(duplicate.role, '保持原样');
assert.equal(duplicate.appearance, '不应植入');

const guard = result.assets.characters[3];
assert.equal(guard.appearance, '非人资产');
assert.equal(guard.imageUrl, undefined);

const crowd = result.assets.characters[4];
assert.equal(crowd.role, '考核者群体');
assert.equal(crowd.panels.schema, 'anonymous-crowd-reference-v1');
assert.equal(crowd.panels.sheetUrl, '/world/crowd-sheet.png');

// 退化路径：模板只有特写预览（无真三视图）→ 文本注入、图保持待生成
const previewOnly = result.assets.characters[5];
assert.equal(previewOnly.role, '预览角色');
assert.equal(previewOnly.appearance, '只有特写的候选');
assert.equal(previewOnly.imageUrl, undefined);
assert.equal(previewOnly.rawUrl, undefined);
assert.equal(previewOnly.realPhotoUrl, undefined);
assert.equal(previewOnly.previewUrl, undefined);
assert.equal(previewOnly.panels, undefined);
assert.equal(previewOnly.reference, undefined);

const scene = result.assets.scenes[0];
assert.equal(scene.description, '云海高台与青灰石阶');
assert.equal(scene.atmosphere, '肃穆宏大');
assert.equal(scene.weather, '晴');
assert.equal(scene.lighting, '晨光');
assert.equal(scene.imageUrl, '/world/gate.png');
assert.equal(scene.reference.status, 'ready');

const prop = result.assets.props[0];
assert.equal(prop.propType, '标志物');
assert.equal(prop.material, '石材');
assert.equal(prop.ownership, 'c1');
assert.match(prop.features, /高台前的青灰色古石板/);
assert.match(prop.features, /用于入门考核判定神迹/);
assert.match(prop.features, /LLM 石纹/);
assert.equal(prop.imageUrl, '/world/slate.png');

assert.equal(result.stats.characters.injected, 4);
assert.equal(result.stats.characters.imageFilled, 2);
assert.equal(result.stats.scenes.injected, 1);
assert.equal(result.stats.props.injected, 1);
assert.ok(result.logs.some((item) => item.reason === 'ambiguous_world_match'));
assert.ok(result.logs.some((item) => item.reason === 'entity_type_mismatch'));

console.log('[test-asset-world-injection] all assertions passed');
