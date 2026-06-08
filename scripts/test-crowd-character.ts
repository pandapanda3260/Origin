import assert from 'node:assert/strict';
import {
  characterAssetModeFor,
  isAnonymousCrowdAsset,
  normalizeCrowdFlag,
  normalizeCrowdFlagForCompare,
  normalizeCrowdSize,
} from '../lib/crowd-character';

assert.equal(normalizeCrowdFlag(true), true);
assert.equal(normalizeCrowdFlag(false), false);
assert.equal(normalizeCrowdFlag('群像'), true);
assert.equal(normalizeCrowdFlag('普通'), false);
assert.equal(normalizeCrowdFlag(undefined), undefined);

assert.equal(isAnonymousCrowdAsset({ name: '考核少年少女群像' }), true);
assert.equal(isAnonymousCrowdAsset({ name: '考核少年少女群像', isCrowd: false }), false);
assert.equal(isAnonymousCrowdAsset({ name: '林峰', isCrowd: true }), true);
assert.equal(isAnonymousCrowdAsset({ name: '林峰', role: '主角' }), false);
assert.equal(isAnonymousCrowdAsset({ name: '赵镖头', role: '率领一群镖师走南闯北的硬汉' }), false);
assert.equal(isAnonymousCrowdAsset({ name: '陈统领', appearance: '多人混战中临危不乱的指挥' }), false);
assert.equal(isAnonymousCrowdAsset({ name: '夜叉王', identity: '成群结队的影卫之首' }), false);

assert.equal(characterAssetModeFor({ name: '围观弟子群像' }), 'anonymous_crowd');
assert.equal(characterAssetModeFor({ name: '围观弟子群像', isCrowd: false }), 'identity');

assert.equal(normalizeCrowdFlagForCompare(undefined), 'false');
assert.equal(normalizeCrowdFlagForCompare(false), 'false');
assert.equal(normalizeCrowdFlagForCompare(true), 'true');
assert.equal(normalizeCrowdSize('  十几人  '), '十几人');

console.log('test-crowd-character passed');
