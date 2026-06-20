#!/usr/bin/env node
/**
 * probe-seedream-control-param.js
 *
 * 目的：100% 实锤火山方舟 doubao-seedream 图像 API 到底有没有
 *       ControlNet 式"结构控制"参数（control_image / controlnet / condition / mask ...）。
 *
 * 做法：对 /images/generations 依次发若干请求——
 *   - 一个 baseline（不带任何控制字段）：证明 key/endpoint 正常、拿到正常响应形状。
 *   - 多个变体：每个塞一个"臆造的控制字段"（自带一张合成控制图）。
 *   观察每个变体的 HTTP 状态 + 响应体：
 *     · 4xx 且报 InvalidParameter / unknown / unexpected → 该字段不存在（强证据）。
 *     · 200 且正常出图 → 字段被"静默忽略"（也说明没有这个控制通道，只是没报错）。
 *   两种情况都指向"无控制通道"。若出现"被识别且改变行为"的迹象（需肉眼比图），脚本会提示单独人工核。
 *
 * 沙箱跑不了（无 key、egress 封）。请在本机仓库根目录运行：
 *   node scripts/probe-seedream-control-param.js --dry-run          # 先看请求体，不发网络
 *   node scripts/probe-seedream-control-param.js                    # 真跑（读 .env.local / DB 的 image key）
 *   node scripts/probe-seedream-control-param.js --api-key sk-xxx   # 直接给 Ark key
 *   node scripts/probe-seedream-control-param.js --full             # 跑全部候选字段（更费积分）
 *
 * 注意：每个返回 200 的请求 = 真出一张图 = 消耗一次额度；返回 4xx 不消耗。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'), false);
loadEnvFile(path.join(ROOT, '.env.local'), true);

const args = parseArgs(process.argv.slice(2));
// 真 key 源：优先 --env-file；否则默认尝试仓库同级的 key/origin.env.local
// （= /Users/mark/Documents/key/origin.env.local，Vasily 本机真实 env）。文件不存在则静默跳过。
if (args.envFile) {
  loadEnvFile(path.resolve(args.envFile), true);
} else {
  // 真 key 可能在仓库根 origin.env.local，或同级 key/origin.env.local —— 两处都试。
  loadEnvFile(path.join(ROOT, 'origin.env.local'), true);
  loadEnvFile(path.join(ROOT, '..', 'key', 'origin.env.local'), true);
}
const dbCfg = readDbImageConfig(args.userId || 1);

// 本探针专测 Seedream(火山 ark)。优先用 Seedream/fallback 渠道变量，避开 primary
// (你的 IMAGE_* primary 很可能是 Zerail/gpt-image-2，用它会打错门/key 不匹配)。
const cfg = {
  baseUrl: trimTrailingSlash(
    args.baseUrl ||
      process.env.IMAGE_FALLBACK_API_BASE ||
      'https://ark.cn-beijing.volces.com/api/v3',
  ),
  apiKey:
    args.apiKey ||
    process.env.IMAGE_SEEDREAM_API_KEY ||
    process.env.IMAGE_FALLBACK_API_KEY ||
    process.env.ARK_API_KEY ||
    dbCfg.apiKey ||
    '',
  model:
    args.model ||
    process.env.IMAGE_FALLBACK_MODEL ||
    'doubao-seedream-4-5-251128',
  size: args.size || '1024x1024',
};
const keySource = args.apiKey
  ? '--api-key'
  : process.env.IMAGE_SEEDREAM_API_KEY
    ? 'IMAGE_SEEDREAM_API_KEY'
    : process.env.IMAGE_FALLBACK_API_KEY
      ? 'IMAGE_FALLBACK_API_KEY'
      : process.env.ARK_API_KEY
        ? 'ARK_API_KEY'
        : dbCfg.apiKey
          ? 'DB'
          : '(none)';
const endpoint = `${cfg.baseUrl}/images/generations`;

// 一张合成的 64×64 灰底"控制图"（深度/线稿占位用，纯为测试字段是否被接受）。
const CONTROL_IMG = makePngDataUrl(64, 64, 128);

const basePrompt =
  args.prompt ||
  'A simple empty room interior, one window on the left wall, one wooden door on the right wall, a table in the center. Photorealistic.';

function baseBody(extra) {
  return Object.assign(
    {
      model: cfg.model,
      prompt: basePrompt,
      size: cfg.size,
      response_format: 'url',
      watermark: false,
    },
    extra || {},
  );
}

// 候选"结构控制"字段（全部是臆造的，就是要看 API 认不认）。
const CASES = [
  { name: 'baseline (no control field)', body: baseBody() },
  { name: 'control_image: <string dataURL>', body: baseBody({ control_image: CONTROL_IMG }) },
  { name: 'control_image: {type:depth,image}', body: baseBody({ control_image: { type: 'depth', image: CONTROL_IMG } }) },
  { name: 'controlnet: {type:depth,image,strength}', body: baseBody({ controlnet: { type: 'depth', image: CONTROL_IMG, strength: 0.8 } }) },
];
const FULL_EXTRA = [
  { name: 'condition_image: <string dataURL>', body: baseBody({ condition_image: CONTROL_IMG }) },
  { name: 'condition: {type:canny,image}', body: baseBody({ condition: { type: 'canny', image: CONTROL_IMG } }) },
  { name: 'controls: [{type:depth,image}]', body: baseBody({ controls: [{ type: 'depth', image: CONTROL_IMG }] }) },
  { name: 'structure_image + control_strength', body: baseBody({ structure_image: CONTROL_IMG, control_strength: 0.8 }) },
  { name: 'image:[control] + control_mode (native-path style)', body: baseBody({ image: [CONTROL_IMG], control_mode: 'depth' }) },
];
const cases = args.full ? CASES.concat(FULL_EXTRA) : CASES;

main().catch((err) => {
  console.error('[probe] fatal:', err?.message || err);
  process.exit(1);
});

async function main() {
  console.log('[probe] endpoint:', endpoint);
  console.log('[probe] model   :', cfg.model, '| size:', cfg.size);
  console.log('[probe] key src :', keySource);
  console.log('[probe] cases   :', cases.length, args.full ? '(--full)' : '(default subset; use --full for all)');
  console.log('[probe] control image: synthetic 64x64 png data-url\n');

  if (args.dryRun) {
    for (const c of cases) {
      console.log('— case:', c.name);
      console.log('  injected keys:', Object.keys(c.body).filter((k) => !['model', 'prompt', 'size', 'response_format', 'watermark'].includes(k)).join(', ') || '(none)');
    }
    console.log('\n[probe] dry-run only; no network calls made.');
    return;
  }

  if (!cfg.apiKey) {
    throw new Error(
      'No image API key found in env (.env.local: IMAGE_SEEDREAM_API_KEY / IMAGE_API_KEY) or DB. ' +
        'Pass it explicitly: --api-key <ark-key>  (optionally --base-url / --model).',
    );
  }

  const results = [];
  for (const c of cases) {
    const r = await sendOnce(c.body);
    results.push({ name: c.name, ...r });
    console.log(`— ${c.name}\n    HTTP ${r.status}  →  ${classify(c.name, r)}`);
    console.log('    body:', JSON.stringify(r.json).slice(0, 360));
    await sleep(800);
  }

  // 汇总裁决
  console.log('\n================ 裁决 ================');
  const baseline = results[0];
  if (baseline && baseline.status === 200) {
    console.log('baseline 200 ✅  key/endpoint 正常，下面变体的差异才有意义。');
  } else {
    console.log('⚠️ baseline 非 200，先解决鉴权/endpoint，再看控制字段结论。');
  }
  let anyAcceptedSilently = false;
  let anyRejected = false;
  for (const r of results.slice(1)) {
    if (r.status === 200) anyAcceptedSilently = true;
    else if (r.status >= 400) anyRejected = true;
  }
  console.log('- 被 4xx 拒绝(InvalidParameter/unknown) 的控制字段：' + (anyRejected ? '有 → 这些字段不存在（强证据：无控制通道）' : '无'));
  console.log('- 被 200 静默接受(出图但无报错) 的控制字段：' + (anyAcceptedSilently ? '有 → 字段名被容忍但无文档化控制语义；需肉眼比对该图是否真受控（多半没有）' : '无'));
  console.log('结论倾向：若以上变体全是"拒绝"或"静默忽略"，即实锤 doubao-seedream API 无 ControlNet 式控制通道，与文档证据一致。');
  console.log('=====================================');
}

async function sendOnce(body) {
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, json: { networkError: e?.message || String(e) } };
  }
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text.slice(0, 600) };
  }
  return { status: resp.status, json: redactJson(json) };
}

function classify(name, r) {
  if (name.startsWith('baseline')) return r.status === 200 ? 'OK (正常出图)' : '基线异常';
  if (r.status === 200) return '字段被静默接受/忽略（出图，无报错）';
  if (r.status >= 400) {
    const blob = JSON.stringify(r.json).toLowerCase();
    if (/invalid|unknown|unexpected|not.*(allow|support|recogn)|多余|未知|不支持/.test(blob)) return '字段被拒绝（不存在该控制参数）';
    return '4xx（看 body 判断原因）';
  }
  return '其他';
}

// ---------- helpers ----------
function makePngDataUrl(w, h, gray) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = gray;
    row[1 + x * 3 + 1] = gray;
    row[1 + x * 3 + 2] = gray;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function loadEnvFile(file, override) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!override && process.env[m[1]] != null) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

function readDbImageConfig(userId) {
  try {
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH && fs.existsSync(process.env.DB_PATH) ? process.env.DB_PATH : path.join(ROOT, 'data', 'qd.sqlite');
    if (!fs.existsSync(dbPath)) return {};
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row =
      db.prepare('SELECT data_json FROM user_settings WHERE user_id = ?').get(Number(userId)) ||
      db.prepare('SELECT data_json FROM user_settings ORDER BY user_id ASC LIMIT 1').get();
    db.close();
    if (!row) return {};
    const s = JSON.parse(row.data_json || '{}');
    const img = (s && s.models && s.models.image) || {};
    return {
      baseUrl: String(img.baseUrl || img.base || '').trim(),
      apiKey: String(img.apiKey || img.key || '').trim(),
      model: String(img.model || '').trim(),
    };
  } catch (e) {
    console.warn('[probe] DB image config read skipped:', e?.message || e);
    return {};
  }
}

function parseArgs(argv) {
  const p = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') p.dryRun = true;
    else if (a === '--full') p.full = true;
    else if (a === '--api-key') p.apiKey = argv[++i];
    else if (a === '--base-url') p.baseUrl = argv[++i];
    else if (a === '--model') p.model = argv[++i];
    else if (a === '--size') p.size = argv[++i];
    else if (a === '--env-file') p.envFile = argv[++i];
    else if (a === '--prompt') p.prompt = argv[++i];
    else if (a === '--user-id') p.userId = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('node scripts/probe-seedream-control-param.js [--dry-run] [--full] [--env-file PATH] [--api-key K] [--base-url U] [--model M] [--size 1024x1024]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return p;
}

function trimTrailingSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}
function redactJson(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => {
      if (/api[_-]?key|authorization|token|secret/i.test(key)) return '[redacted]';
      if (typeof val === 'string' && val.length > 200) return `${val.slice(0, 200)}...`;
      return val;
    }),
  );
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
