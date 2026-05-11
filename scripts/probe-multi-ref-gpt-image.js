#!/usr/bin/env node
/**
 * Probe OpenAI/GPT Image Models edit multi-image transport.
 *
 * 目的: OpenAI edit 接口的 multipart 规范在不同 SDK 版本和第三方中转站差异很大,
 * 代码里不能硬写死 'image' 或 'image[]' 字段名。本脚本对 N 张本地图, 依次尝试
 * 3 种 transport 候选, 成功的那个就是应该写进 lib/model-routing.ts 的 transport。
 *
 * 用法:
 *   node scripts/probe-multi-ref-gpt-image.js \
 *     --image /path/to/a.png --image /path/to/b.png [--image /path/to/c.png] \
 *     [--api-key KEY] [--base-url URL] [--model gpt-image-1] [--dry-run]
 *
 * 会花真钱 (若未 --dry-run): 最多 3 次 edit 请求。建议先 --dry-run。
 *
 * 预期输出:
 *   [probe][gpt-image][A image repeat      ] HTTP 200 → url=...
 *   [probe][gpt-image][B image[] explicit  ] HTTP 400 Unknown field
 *   [probe][gpt-image][C image_files[]     ] HTTP 400 Unknown field
 *   → transport winner: A (写成 'openai_multipart_repeat')
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

loadEnvFile(path.join(ROOT, '.env'), false);
loadEnvFile(path.join(ROOT, '.env.local'), true);

const args = parseArgs(process.argv.slice(2));
const images = Array.isArray(args.image) ? args.image : (args.image ? [args.image] : []);
if (images.length < 2 && !args.dryRun) {
  console.error('Need at least two --image paths. Use --dry-run to inspect request shape without real images.');
  process.exit(1);
}

const cfg = {
  baseUrl: trimTrailingSlash(
    args.baseUrl ||
      process.env.OPENAI_API_BASE ||
      process.env.IMAGE_API_BASE ||
      process.env.IMAGE_BASE_URL ||
      'https://api.openai.com/v1',
  ),
  apiKey: args.apiKey || process.env.OPENAI_API_KEY || process.env.IMAGE_API_KEY || '',
  model: args.model || process.env.IMAGE_MODEL || 'gpt-image-1',
  size: args.size || '1024x1024',
};

const prompt =
  args.prompt ||
  [
    'Probe image. Combine the provided references into one cohesive scene.',
    'Image 1 = scene, Image 2 = character. Keep photorealism and natural lighting.',
  ].join(' ');

main().catch((err) => {
  console.error('[probe][gpt-image] fatal:', err?.message || err);
  process.exit(1);
});

async function main() {
  if (!args.dryRun && !cfg.apiKey) {
    throw new Error('OPENAI_API_KEY / IMAGE_API_KEY is missing. Add to .env.local or pass --api-key.');
  }
  console.log('[probe][gpt-image] endpoint:', `${cfg.baseUrl}/images/edits`);
  console.log('[probe][gpt-image] model:', cfg.model);
  console.log('[probe][gpt-image] images:', images.map((p) => path.relative(ROOT, p)).join(', '));

  const fileBlobs = images.map((p) => ({
    name: path.basename(p),
    buf: fs.readFileSync(path.resolve(p)),
    type: guessMime(p),
  }));

  const candidates = [
    {
      name: 'A image repeat',
      transport: 'openai_multipart_repeat',
      build(form) {
        fileBlobs.forEach((f) => form.append('image', new Blob([f.buf], { type: f.type }), f.name));
      },
    },
    {
      name: 'B image[] explicit',
      transport: 'openai_multipart_bracket',
      build(form) {
        fileBlobs.forEach((f) => form.append('image[]', new Blob([f.buf], { type: f.type }), f.name));
      },
    },
    {
      name: 'C image_files[]',
      transport: 'openai_multipart_image_files',
      build(form) {
        fileBlobs.forEach((f) => form.append('image_files[]', new Blob([f.buf], { type: f.type }), f.name));
      },
    },
  ];

  for (const c of candidates) {
    await runCandidate(c);
  }
  console.log('\n[probe][gpt-image] 跑完所有候选。把 HTTP 200 的那一组 transport 填进 lib/model-routing.ts capabilities.image.transport。');
}

async function runCandidate(c) {
  const label = `[probe][gpt-image][${c.name.padEnd(22)}]`;
  if (args.dryRun) {
    console.log(label, 'dry-run: (transport=' + c.transport + ') multipart field layout ok');
    return;
  }
  const form = new FormData();
  form.append('model', cfg.model);
  form.append('prompt', prompt);
  form.append('size', cfg.size);
  c.build(form);
  try {
    const resp = await fetch(`${cfg.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* keep raw */ }
    if (resp.ok && parsed && Array.isArray(parsed.data) && parsed.data[0]) {
      const first = parsed.data[0];
      const locator = first.url ? first.url : (first.b64_json ? '[b64:len=' + String(first.b64_json).length + ']' : '[empty]');
      console.log(label, `HTTP ${resp.status} → ${locator} transport=${c.transport}`);
    } else {
      console.log(label, `HTTP ${resp.status}:`, (text || '').slice(0, 300));
    }
  } catch (e) {
    console.log(label, 'network error:', (e && e.message) || e);
  }
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
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
