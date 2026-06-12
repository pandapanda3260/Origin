import assert from 'node:assert/strict';
import { createCipheriv, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  buildWechatPayAuthorization,
  decryptWechatPayResource,
  generateWechatOutTradeNo,
  normalizeWechatPayPublicKeyId,
  verifyWechatPayHttpSignature,
} from '../lib/wechat-pay';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const outTradeNo = generateWechatOutTradeNo();
assert.match(outTradeNo, /^[A-Za-z0-9_-]{6,32}$/);
assert.equal(normalizeWechatPayPublicKeyId('0117468170123456789012345678901234'), 'PUB_KEY_ID_0117468170123456789012345678901234');
assert.equal(normalizeWechatPayPublicKeyId('PUB_KEY_ID_0117468170123456789012345678901234'), 'PUB_KEY_ID_0117468170123456789012345678901234');

const auth = buildWechatPayAuthorization({
  mchId: '1230000109',
  serialNo: 'serial-no',
  privateKeyPem: privateKey,
  method: 'POST',
  pathWithQuery: '/v3/pay/transactions/native',
  body: '{"amount":{"total":1}}',
  nonce: 'fixednonce',
  timestamp: '1760000000',
});
assert.match(auth, /^WECHATPAY2-SHA256-RSA2048 /);
assert.match(auth, /mchid="1230000109"/);
assert.match(auth, /serial_no="serial-no"/);
assert.match(auth, /^WECHATPAY2-SHA256-RSA2048 mchid="1230000109",nonce_str="fixednonce",timestamp="1760000000",serial_no="serial-no",signature="[^"]+"$/);
assert.doesNotMatch(auth, /" nonce_str=/);

const body = JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=test' });
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = 'notify-nonce';
const sign = createSign('RSA-SHA256');
sign.update(`${timestamp}\n${nonce}\n${body}\n`);
sign.end();
const signature = sign.sign(privateKey, 'base64');
verifyWechatPayHttpSignature({
  publicKeyPem: publicKey,
  expectedSerial: 'PUB_KEY_ID_TEST',
  headers: { timestamp, nonce, signature, serial: 'PUB_KEY_ID_TEST' },
  body,
});
assert.throws(() =>
  verifyWechatPayHttpSignature({
    publicKeyPem: publicKey,
    expectedSerial: 'PUB_KEY_ID_TEST',
    headers: { timestamp, nonce, signature, serial: 'WRONG_SERIAL' },
    body,
  }),
);

const apiV3Key = '12345678901234567890123456789012';
const resourcePayload = { out_trade_no: outTradeNo, trade_state: 'SUCCESS', amount: { total: 1 } };
const resource = encryptResource(resourcePayload, apiV3Key);
assert.deepEqual(decryptWechatPayResource(resource, apiV3Key), resourcePayload);

console.log('wechat pay tests passed');

function encryptResource(payload: unknown, apiV3Key: string) {
  const nonce = randomBytes(12).toString('base64url').slice(0, 12);
  const associatedData = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    algorithm: 'AEAD_AES_256_GCM',
    associated_data: associatedData,
    nonce,
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
  };
}
