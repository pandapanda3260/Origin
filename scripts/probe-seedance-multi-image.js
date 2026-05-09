#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

loadEnvFile(path.join(ROOT, '.env'), false);
loadEnvFile(path.join(ROOT, '.env.local'), true);

const args = parseArgs(process.argv.slice(2));
const maxImages = Math.max(2, Math.min(Number(args.maxImages || 2), 9));
const dbVideoCfg = readDbVideoConfig(args.userId || 1);
const cfg = {
  baseUrl: trimTrailingSlash(args.baseUrl || process.env.VIDEO_API_BASE || 'https://ark.cn-beijing.volces.com/api/v3'),
  apiKey: args.apiKey || process.env.VIDEO_API_KEY || dbVideoCfg.apiKey || '',
  model: args.model || process.env.VIDEO_MODEL || process.env.MODEL_VIDEO_PRIMARY || dbVideoCfg.model || 'doubao-seedance-2-0-260128',
};
if (!args.baseUrl && !process.env.VIDEO_API_BASE && dbVideoCfg.baseUrl) cfg.baseUrl = trimTrailingSlash(dbVideoCfg.baseUrl);

const images = collectImages(args.image || [], maxImages);
const timeoutMs = Number(args.timeoutMs || 8 * 60 * 1000);
const pollMs = Number(args.pollMs || 6000);
const prompt =
  args.prompt ||
  [
    'This is a multi-image schema probe. Generate a short cinematic video.',
    'Image 1 is the first frame reference. Start from this composition and color palette.',
    'Image 2 is an additional visual reference. Preserve its most important subject details if compatible.',
    'Do not show UI, borders, thumbnails, grids, captions, labels, or subtitles.',
    '--ratio 16:9 --duration 5',
  ].join('\n');

main().catch((err) => {
  console.error('[probe] failed:', err?.message || err);
  process.exit(1);
});

async function main() {
  if (!args.dryRun && !cfg.apiKey) {
    throw new Error('VIDEO_API_KEY is missing. Add it to .env.local or pass --api-key.');
  }
  if (images.length < 2) {
    throw new Error('Need at least two local images. Pass --image /path/a.png --image /path/b.png.');
  }

  console.log('[probe] endpoint:', `${cfg.baseUrl}/contents/generations/tasks`);
  console.log('[probe] model:', cfg.model);
  console.log('[probe] images:', images.map((p) => path.relative(ROOT, p)).join(', '));

  const content = [{ type: 'text', text: prompt }];
  for (const imagePath of images.slice(0, maxImages)) {
    content.push({
      type: 'image_url',
      image_url: { url: toDataUrl(imagePath) },
      role: 'reference_image',
    });
  }

  if (args.dryRun) {
    console.log('[probe] dry run content parts:', content.map((part) => part.type).join(', '));
    console.log('[probe] dry run prompt chars:', prompt.length);
    return;
  }

  const submit = await fetchJson(`${cfg.baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, content }),
  });

  const taskId = submit.id || submit.task_id || submit?.data?.id;
  console.log('[probe] submit response:', redactJson(submit));
  if (!taskId) throw new Error('Submit succeeded but no task id was returned.');

  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    pollCount++;
    const statusResp = await fetchJson(`${cfg.baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    const status = String(statusResp.status || statusResp?.data?.status || '').toLowerCase();
    const videoUrl = statusResp?.content?.video_url || statusResp?.video_url || statusResp?.data?.content?.video_url || '';
    console.log(`[probe] poll #${pollCount}: status=${status || 'unknown'} videoUrl=${videoUrl ? 'yes' : 'no'}`);
    if (videoUrl) {
      console.log('[probe] success video_url:', String(videoUrl).slice(0, 180));
      return;
    }
    if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
      console.log('[probe] terminal response:', redactJson(statusResp));
      throw new Error(`Remote task ended with status=${status}`);
    }
  }

  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for remote task.`);
}

function collectImages(explicitImages, limit) {
  const out = explicitImages.map((p) => path.resolve(ROOT, p)).filter(Boolean);
  if (out.length) return out;
  const dir = path.join(ROOT, 'data', 'images');
  const found = [];
  walkImages(dir, found, limit);
  return found.slice(0, limit);
}

function walkImages(dir, out, limit) {
  if (!fs.existsSync(dir) || out.length >= limit) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkImages(full, out, limit);
    else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) out.push(full);
    if (out.length >= limit) return;
  }
}

function toDataUrl(imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
}

async function fetchJson(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text.slice(0, 1000) };
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${JSON.stringify(redactJson(json)).slice(0, 1200)}`);
  }
  return json;
}

function parseArgs(argv) {
  const parsed = { image: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--image') parsed.image.push(argv[++i]);
    else if (arg === '--base-url') parsed.baseUrl = argv[++i];
    else if (arg === '--api-key') parsed.apiKey = argv[++i];
    else if (arg === '--model') parsed.model = argv[++i];
    else if (arg === '--user-id') parsed.userId = argv[++i];
    else if (arg === '--max-images') parsed.maxImages = argv[++i];
    else if (arg === '--prompt') parsed.prompt = argv[++i];
    else if (arg === '--timeout-ms') parsed.timeoutMs = argv[++i];
    else if (arg === '--poll-ms') parsed.pollMs = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/probe-seedance-multi-image.js [--image pathA --image pathB] [--dry-run]

Env:
  VIDEO_API_KEY, VIDEO_API_BASE, VIDEO_MODEL

Options:
  --image PATH       Local image path. Pass twice; defaults to first two data/images files.
  --max-images N     Number of images to send, 2-9. Default 2.
  --user-id ID       Read video model config from user_settings when env is absent. Default 1.
  --dry-run          Build payload shape without sending remote request.
  --timeout-ms N     Poll timeout. Default 480000.
  --poll-ms N        Poll interval. Default 6000.
`);
}

function loadEnvFile(file, override) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!override && process.env[key] != null) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readDbVideoConfig(userId) {
  try {
    const Database = require('better-sqlite3');
    const configured = process.env.DB_PATH || '';
    const dbPath =
      configured && fs.existsSync(configured)
        ? configured
        : path.join(ROOT, 'data', 'qd.sqlite');
    if (!fs.existsSync(dbPath)) return {};
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row =
      db
        .prepare('SELECT data_json FROM user_settings WHERE user_id = ?')
        .get(Number(userId)) ||
      db
        .prepare('SELECT data_json FROM user_settings ORDER BY user_id ASC LIMIT 1')
        .get();
    db.close();
    if (!row) return {};
    const settings = JSON.parse(row.data_json || '{}');
    const video = settings?.models?.video || {};
    return {
      baseUrl: String(video.baseUrl || video.base || '').trim(),
      apiKey: String(video.apiKey || video.key || '').trim(),
      model: String(video.model || '').trim(),
    };
  } catch (e) {
    console.warn('[probe] could not read DB video settings:', e?.message || e);
    return {};
  }
}

function trimTrailingSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function redactJson(value) {
  return JSON.parse(JSON.stringify(value, (key, val) => {
    if (/api[_-]?key|authorization|token|secret/i.test(key)) return '[redacted]';
    if (typeof val === 'string' && val.length > 300) return `${val.slice(0, 300)}...`;
    return val;
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
