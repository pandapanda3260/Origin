import { createDecipheriv, createSign, createVerify, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { getExternalEnvValue, loadExternalEnv } from './env';

const WECHAT_PAY_API_BASE = 'https://api.mch.weixin.qq.com';
const NATIVE_PAY_PATH = '/v3/pay/transactions/native';
const CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export class WechatPayConfigError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.status = status;
  }
}

export class WechatPayGatewayError extends Error {
  status: number;
  code?: string;
  body?: unknown;
  constructor(message: string, status = 502, code?: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type WechatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: string;
  merchantCertSerialNo: string;
  merchantPrivateKeyPath: string;
  merchantPrivateKeyPem: string;
  publicKeyId: string;
  publicKeyPath: string;
  publicKeyPem: string;
  notifyUrl: string;
};

export type WechatNativePayment = {
  codeUrl: string;
  qrCode: string;
  responseVerified: boolean;
};

export type WechatTransaction = {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  trade_state_desc?: string;
  success_time?: string;
  amount?: {
    total?: number;
    currency?: string;
    payer_total?: number;
    payer_currency?: string;
  };
};

type NativePaymentInput = {
  orderId: string;
  description: string;
  amountCents: number;
};

type WechatPayHeaders = {
  timestamp: string;
  nonce: string;
  signature: string;
  serial: string;
};

export function generateWechatOutTradeNo(): string {
  return `wx${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

export function getWechatPayPublicKeyState() {
  loadExternalEnv();
  const publicKeyPath = env('WECHAT_PAY_PUBLIC_KEY_PATH');
  const publicKeyId = normalizeWechatPayPublicKeyId(env('WECHAT_PAY_PUBLIC_KEY_ID'));
  return {
    publicKeyId,
    publicKeyPath,
    ready: Boolean(publicKeyPath && existsSync(publicKeyPath)),
    reason: publicKeyPath ? 'missing_file' : 'empty_path',
  };
}

export function getWechatPayConfig(): WechatPayConfig {
  loadExternalEnv();
  const notifyUrl = resolveNotifyUrl();
  const raw = {
    mchId: env('WECHAT_PAY_MCH_ID'),
    appId: env('WECHAT_PAY_APP_ID'),
    apiV3Key: env('WECHAT_PAY_API_V3_KEY'),
    merchantCertSerialNo: env('WECHAT_PAY_MERCHANT_CERT_SERIAL_NO'),
    merchantPrivateKeyPath: env('WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH'),
    publicKeyId: normalizeWechatPayPublicKeyId(env('WECHAT_PAY_PUBLIC_KEY_ID')),
    publicKeyPath: env('WECHAT_PAY_PUBLIC_KEY_PATH'),
    notifyUrl,
  };

  const missing = Object.entries(raw)
    .filter(([key, value]) => {
      if (key === 'publicKeyPath') return !value || !existsSync(value);
      if (key === 'merchantPrivateKeyPath') return !value || !existsSync(value);
      return !value;
    })
    .map(([key]) => key);
  if (missing.length) {
    throw new WechatPayConfigError(
      `微信支付配置未完整：${missing.join(', ')}。已暂停展示付款二维码，避免用户付款后无法自动到账。`,
    );
  }
  if (Buffer.byteLength(raw.apiV3Key, 'utf8') !== 32) {
    throw new WechatPayConfigError('WECHAT_PAY_API_V3_KEY 必须是 32 字节。');
  }
  if (!/^PUB_KEY_ID_[A-Za-z0-9_-]+$/.test(raw.publicKeyId)) {
    throw new WechatPayConfigError('WECHAT_PAY_PUBLIC_KEY_ID 必须是 PUB_KEY_ID_ 开头的微信支付公钥 ID。');
  }
  return {
    ...raw,
    merchantPrivateKeyPem: readFileSync(raw.merchantPrivateKeyPath, 'utf8'),
    publicKeyPem: readFileSync(raw.publicKeyPath, 'utf8'),
  };
}

export async function createWechatNativePayment(input: NativePaymentInput): Promise<WechatNativePayment> {
  const cfg = getWechatPayConfig();
  const body = JSON.stringify({
    appid: cfg.appId,
    mchid: cfg.mchId,
    description: trimForWechatDescription(input.description),
    out_trade_no: input.orderId,
    notify_url: cfg.notifyUrl,
    amount: {
      total: input.amountCents,
      currency: 'CNY',
    },
  });
  const authorization = buildWechatPayAuthorization({
    mchId: cfg.mchId,
    serialNo: cfg.merchantCertSerialNo,
    privateKeyPem: cfg.merchantPrivateKeyPem,
    method: 'POST',
    pathWithQuery: NATIVE_PAY_PATH,
    body,
  });
  const resp = await fetch(`${WECHAT_PAY_API_BASE}${NATIVE_PAY_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Wechatpay-Serial': cfg.publicKeyId,
    },
    body,
    cache: 'no-store',
  });
  const text = await resp.text();
  if (!resp.ok) {
    const payload = safeJson(text);
    throw new WechatPayGatewayError(
      (payload && typeof payload === 'object' && 'message' in payload ? String((payload as any).message) : '') ||
        `微信支付下单失败（${resp.status}）`,
      resp.status,
      payload && typeof payload === 'object' && 'code' in payload ? String((payload as any).code) : undefined,
      payload || text,
    );
  }
  verifyWechatPayHttpSignature({
    publicKeyPem: cfg.publicKeyPem,
    expectedSerial: cfg.publicKeyId,
    headers: readWechatPayHeaders(resp.headers),
    body: text,
  });
  const data = safeJson(text) as { code_url?: string } | null;
  const codeUrl = String(data?.code_url || '').trim();
  if (!codeUrl) throw new WechatPayGatewayError('微信支付未返回 code_url。', 502, undefined, data);
  const qrCode = await QRCode.toDataURL(codeUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
    color: { dark: '#0B1320', light: '#FFFFFF' },
  });
  return { codeUrl, qrCode, responseVerified: true };
}

export async function queryWechatPaymentByOutTradeNo(orderId: string): Promise<{
  transaction: WechatTransaction;
  responseVerified: boolean;
}> {
  const cfg = getWechatPayConfig();
  const pathWithQuery = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(cfg.mchId)}`;
  const resp = await fetch(`${WECHAT_PAY_API_BASE}${pathWithQuery}`, {
    method: 'GET',
    headers: {
      Authorization: buildWechatPayAuthorization({
        mchId: cfg.mchId,
        serialNo: cfg.merchantCertSerialNo,
        privateKeyPem: cfg.merchantPrivateKeyPem,
        method: 'GET',
        pathWithQuery,
        body: '',
      }),
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  const text = await resp.text();
  const payload = safeJson(text);
  if (!resp.ok) {
    throw new WechatPayGatewayError(
      (payload && typeof payload === 'object' && 'message' in payload ? String((payload as any).message) : '') ||
        `微信支付订单查询失败（${resp.status}）`,
      resp.status,
      payload && typeof payload === 'object' && 'code' in payload ? String((payload as any).code) : undefined,
      payload || text,
    );
  }
  verifyWechatPayHttpSignature({
    publicKeyPem: cfg.publicKeyPem,
    expectedSerial: cfg.publicKeyId,
    headers: readWechatPayHeaders(resp.headers),
    body: text,
  });
  if (!payload || typeof payload !== 'object') {
    throw new WechatPayGatewayError('微信支付订单查询响应无效。', 502, undefined, text);
  }
  return { transaction: payload as WechatTransaction, responseVerified: true };
}

export function verifyWechatPayCallback(headers: Headers, rawBody: string): void {
  const cfg = getWechatPayConfig();
  verifyWechatPayHttpSignature({
    publicKeyPem: cfg.publicKeyPem,
    expectedSerial: cfg.publicKeyId,
    headers: readWechatPayHeaders(headers),
    body: rawBody,
  });
}

export function decryptWechatPayResource<T = any>(resource: any, apiV3Key?: string): T {
  const key = Buffer.from(apiV3Key || getWechatPayConfig().apiV3Key, 'utf8');
  if (key.length !== 32) throw new WechatPayConfigError('WECHAT_PAY_API_V3_KEY 必须是 32 字节。');
  if (!resource || resource.algorithm !== 'AEAD_AES_256_GCM') {
    throw new WechatPayGatewayError('微信支付回调加密算法不支持。', 400);
  }
  const ciphertext = Buffer.from(String(resource.ciphertext || ''), 'base64');
  if (ciphertext.length <= 16) throw new WechatPayGatewayError('微信支付回调密文无效。', 400);
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(resource.nonce || ''), 'utf8'));
  decipher.setAuthTag(authTag);
  const aad = String(resource.associated_data || '');
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as T;
}

export function buildWechatPayAuthorization(args: {
  mchId: string;
  serialNo: string;
  privateKeyPem: string;
  method: string;
  pathWithQuery: string;
  body: string;
  nonce?: string;
  timestamp?: string;
}): string {
  const nonce = args.nonce || randomBytes(16).toString('hex');
  const timestamp = args.timestamp || String(Math.floor(Date.now() / 1000));
  const signature = signWechatPayMessage(
    `${args.method.toUpperCase()}\n${args.pathWithQuery}\n${timestamp}\n${nonce}\n${args.body || ''}\n`,
    args.privateKeyPem,
  );
  const params = [
    `mchid="${escapeAuthValue(args.mchId)}"`,
    `nonce_str="${escapeAuthValue(nonce)}"`,
    `timestamp="${escapeAuthValue(timestamp)}"`,
    `serial_no="${escapeAuthValue(args.serialNo)}"`,
    `signature="${escapeAuthValue(signature)}"`,
  ].join(',');
  return `WECHATPAY2-SHA256-RSA2048 ${params}`;
}

export function verifyWechatPayHttpSignature(args: {
  publicKeyPem: string;
  expectedSerial?: string;
  headers: WechatPayHeaders;
  body: string;
}): void {
  const timestampNum = Number(args.headers.timestamp);
  if (!Number.isFinite(timestampNum)) throw new WechatPayGatewayError('微信支付签名时间戳无效。', 400);
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestampNum);
  if (age > CALLBACK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new WechatPayGatewayError('微信支付签名已过期。', 400);
  }
  if (args.expectedSerial && args.headers.serial !== args.expectedSerial) {
    throw new WechatPayGatewayError('微信支付公钥 ID 与回调签名序列号不匹配。', 400);
  }
  const verify = createVerify('RSA-SHA256');
  verify.update(`${args.headers.timestamp}\n${args.headers.nonce}\n${args.body}\n`);
  verify.end();
  if (!verify.verify(args.publicKeyPem, args.headers.signature, 'base64')) {
    throw new WechatPayGatewayError('微信支付签名验证失败。', 400);
  }
}

function signWechatPayMessage(message: string, privateKeyPem: string): string {
  const sign = createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(privateKeyPem, 'base64');
}

function readWechatPayHeaders(headers: Headers): WechatPayHeaders {
  const out = {
    timestamp: headers.get('wechatpay-timestamp') || '',
    nonce: headers.get('wechatpay-nonce') || '',
    signature: headers.get('wechatpay-signature') || '',
    serial: headers.get('wechatpay-serial') || '',
  };
  const missing = Object.entries(out)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) throw new WechatPayGatewayError(`微信支付签名头缺失：${missing.join(', ')}`, 400);
  return out;
}

function resolveNotifyUrl(): string {
  const explicit = env('WECHAT_PAY_NOTIFY_URL');
  if (explicit) return explicit;
  const base = env('ORIGIN_PUBLIC_BASE_URL').replace(/\/+$/, '');
  return base ? `${base}/api/billing/wechat/notify` : '';
}

function env(name: string): string {
  return String(getExternalEnvValue(name) ?? process.env[name] ?? '').trim();
}

export function normalizeWechatPayPublicKeyId(value: string): string {
  const id = String(value || '').trim();
  if (!id) return '';
  if (id.startsWith('PUB_KEY_ID_')) return id;
  if (/^[0-9]{20,}$/.test(id)) return `PUB_KEY_ID_${id}`;
  return id;
}

function trimForWechatDescription(input: string): string {
  const s = String(input || 'ORIGIN 订单').replace(/\s+/g, ' ').trim() || 'ORIGIN 订单';
  return Array.from(s).slice(0, 42).join('');
}

function escapeAuthValue(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
