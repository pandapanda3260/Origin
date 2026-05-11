#!/usr/bin/env node
/**
 * Probe Seedream multi-image reference transport.
 *
 * 目的: 在 lib/image-gen.ts 接多图前先实测 Seedream 的 body.image 到底接受什么形态 —
 * 文档虽然说支持单图和多图, 但具体 key 名 / 编码方式在不同版本 (4.0 / 4.5 / 5.0-lite)
 * 可能不一致。本脚本对 N 张本地图, 依次尝试 3 种 transport 候选, 成功的那个就是
 * 应该写进 model-routing.ts capabilities.image.transport 的值。
 *
 * 用法:
 *   node scripts/probe-multi-ref-seedream.js \
 *     --image /path/to/a.png --image /path/to/b.png [--image /path/to/c.png] \
 *     [--api-key KEY] [--base-url URL] [--model doubao-seedream-4-5-251128] [--dry-run]
 *
 * 会花真钱 (若未 --dry-run): 每个 transport 尝试一次, 3 个 transport 最多 3 次生成请求。
 * 建议先 --dry-run 确认请求体构造, 再跑真的。
 *
 * 预期输出:
 *   [probe][seedream][A image:string[]     ] HTTP 200 → image[0]=https://...
 *   [probe][seedream][B image:repeat       ] HTTP 400 {"error":"unsupported..."}
 *   [probe][seedream][C images:string[]    ] HTTP 400 {"error":"unknown field..."}
 *   → transport winner: A (写成 'seedream_array')
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

loadEnvFile(path.join(ROOT, '.env'), false);
loadEnvFile(path.join(ROOT, '.env.local'), true);
loadEnvFile(process.env.ORIGIN_ENV_FILE || '/Users/mark/Documents/key/origin.env.local', false);
loadEnvFile('/Users/mark/Documents/key/openai.env.local', false);

const args = parseArgs(process.argv.slice(2));
const images = Array.isArray(args.image) ? args.image : (args.image ? [args.image] : []);
if (images.length < 2 && !args.dryRun) {
  console.error('Need at least two --image paths. Use --dry-run to inspect request shape without real images.');
  process.exit(1);
}

const cfg = {
  baseUrl: trimTrailingSlash(
    args.baseUrl ||
      process.env.IMAGE_API_BASE ||
      process.env.IMAGE_BASE_URL ||
      'https://ark.cn-beijing.volces.com/api/v3',
  ),
  apiKey: args.apiKey || process.env.IMAGE_SEEDREAM_API_KEY || process.env.IMAGE_API_KEY || process.env.SEEDREAM_API_KEY || '',
  model: args.model || process.env.IMAGE_MODEL || 'doubao-seedream-4-5-251128',
  size: args.size || process.env.IMAGE_SEEDREAM_SIZE || process.env.IMAGE_SIZE || '2048x2048',
};

const prompt =
  args.prompt ||
  [
    'Probe image composed from the provided references.',
    'Image 1 locks the scene, Image 2 locks the character, Image 3 (if any) locks a prop.',
    'No text, no captions, no borders.',
  ].join(' ');

main().catch((err) => {
  console.error('[probe][seedream] fatal:', err?.message || err);
  process.exit(1);
});

async function main() {
  if (!args.dryRun && !cfg.apiKey) {
    throw new Error('IMAGE_API_KEY / SEEDREAM_API_KEY is missing. Add to .env.local or pass --api-key.');
  }
  console.log('[probe][seedream] endpoint:', `${cfg.baseUrl}/images/generations`);
  console.log('[probe][seedream] model:', cfg.model);
  console.log('[probe][seedream] images:', images.map((p) => path.relative(ROOT, p)).join(', '));

  const dataUrls = images.map(toDataUrl);

  const candidates = [
    {
      name: 'A image:string[]',
      transport: 'seedream_array',
      body: {
        model: cfg.model,
        prompt,
        image: dataUrls,
        size: cfg.size,
        response_format: 'url',
      },
    },
    {
      name: 'B image:repeat',
      transport: 'seedream_repeat',
      // Seedream 的文档写 image 支持 URL 字符串或数组, 有些转发层只认单字段 + 重复,
      // 这里模拟"一个顶层 image, 额外走 image_2/image_3" 作为备选 (冷门)。
      body: {
        model: cfg.model,
        prompt,
        image: dataUrls[0],
        image_2: dataUrls[1] || undefined,
        image_3: dataUrls[2] || undefined,
        size: cfg.size,
        response_format: 'url',
      },
    },
    {
      name: 'C images:string[]',
      transport: 'seedream_images_plural',
      body: {
        model: cfg.model,
        prompt,
        images: dataUrls,
        size: cfg.size,
        response_format: 'url',
      },
    },
  ];

  for (const c of candidates) {
    await runCandidate(c);
  }
  console.log('\n[probe][seedream] 跑完所有候选。请把 HTTP 200 的那一组 transport 填进 lib/model-routing.ts 的 capabilities.image.transport。');
}

async function runCandidate(c) {
  const label = `[probe][seedream][${c.name.padEnd(22)}]`;
  if (args.dryRun) {
    console.log(label, 'dry-run body keys:', Object.keys(c.body).filter((k) => c.body[k] !== undefined));
    return;
  }
  try {
    const resp = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(c.body),
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
    if (resp.ok && parsed && Array.isArray(parsed.data) && parsed.data[0]) {
      console.log(label, `HTTP ${resp.status} → url=${parsed.data[0].url || parsed.data[0].b64_json ? '[b64]' : '[empty]'} transport=${c.transport}`);
    } else {
      console.log(label, `HTTP ${resp.status}:`, (text || '').slice(0, 300));
    }
  } catch (e) {
    console.log(label, 'network error:', (e && e.message) || e);
  }
}

function toDataUrl(p) {
  const abs = path.resolve(p);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      if (out[key] === undefined) out[key] = next;
      else if (Array.isArray(out[key])) out[key].push(next);
      else out[key] = [out[key], next];
      i += 1;
    }
  }
  return out;
}

function trimTrailingSlash(s) { return String(s || '').replace(/\/+$/, ''); }

function loadEnvFile(filePath, override) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k] || override) process.env[k] = v;
  }
}
