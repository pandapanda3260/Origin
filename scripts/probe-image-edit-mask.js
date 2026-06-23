#!/usr/bin/env node
/**
 * Probe OpenAI-compatible /images/edits mask handling for Zerail gpt-image-2.
 *
 * Scope:
 *   - read IMAGE_* env only; never print API keys
 *   - write generated probe fixtures/results only under tmp/probe-image-edit/
 *   - do not touch product code or database
 */

const fs = require('node:fs');
const path = require('node:path');

require('./_ts-require-hook');

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { loadExternalEnv } = require('../lib/env');
const { fetchViaProxy } = require('../lib/proxy-fetch');

const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'tmp', 'probe-image-edit');
const DEFAULT_PROMPT = '把可编辑区域改成一只黄色鸭子，其余保持不变。';

loadEnvFile(path.join(ROOT, '.env'), false);
loadEnvFile(path.join(ROOT, '.env.local'), true);
loadExternalEnv();

const args = parseArgs(process.argv.slice(2));
const runId = timestampId();
const outDir = path.join(OUT_ROOT, runId);

const cfg = resolveImageEditConfig(args);
const prompt = String(args.prompt || process.env.IMAGE_EDIT_MASK_PROBE_PROMPT || DEFAULT_PROMPT);
const baseSize = String(args.size || '1024x1024');
const portraitSize = String(args.portraitSize || '1024x1536');

main().catch((err) => {
  console.error('[probe][image-edit-mask] fatal:', err?.message || err);
  process.exit(1);
});

async function main() {
  if (!cfg.endpointUrl.endsWith('/images/edits')) {
    console.warn('[probe][image-edit-mask] warning: edit endpoint is not /images/edits:', redactUrl(cfg.endpointUrl));
  }

  fs.mkdirSync(outDir, { recursive: true });

  const baseDims = parseSize(baseSize);
  const portraitDims = parseSize(portraitSize);
  const sourcePath = path.join(outDir, `source-${baseDims.width}x${baseDims.height}.png`);
  const maskAPath = path.join(outDir, `mask-A-alpha-transparent-right-${baseDims.width}x${baseDims.height}.png`);
  const maskBPath = path.join(outDir, `mask-B-white-right-opaque-${baseDims.width}x${baseDims.height}.png`);
  const portraitSourcePath = path.join(outDir, `source-${portraitDims.width}x${portraitDims.height}.png`);
  const portraitMaskAPath = path.join(outDir, `mask-A-alpha-transparent-right-${portraitDims.width}x${portraitDims.height}.png`);

  writeSourceImage(sourcePath, baseDims.width, baseDims.height);
  writeMaskA(maskAPath, baseDims.width, baseDims.height);
  writeMaskB(maskBPath, baseDims.width, baseDims.height);
  writeSourceImage(portraitSourcePath, portraitDims.width, portraitDims.height);
  writeMaskA(portraitMaskAPath, portraitDims.width, portraitDims.height);

  console.log('[probe][image-edit-mask] endpoint:', redactUrl(cfg.endpointUrl));
  console.log('[probe][image-edit-mask] model:', cfg.model);
  console.log('[probe][image-edit-mask] image field:', cfg.imageField);
  console.log('[probe][image-edit-mask] quality:', cfg.quality || '(omitted)');
  console.log('[probe][image-edit-mask] has api key:', cfg.apiKey ? 'yes' : 'no');
  console.log('[probe][image-edit-mask] out:', path.relative(ROOT, outDir));

  if (args.dryRun) {
    console.log('[probe][image-edit-mask] dry-run: fixtures generated; no HTTP requests sent.');
    return;
  }

  if (!cfg.apiKey) {
    throw new Error('IMAGE_API_KEY is missing in env/external env.');
  }

  const groups = [
    {
      id: 'A',
      label: 'mask A: right alpha=0, left opaque',
      sourcePath,
      maskPath: maskAPath,
      size: baseSize,
    },
    {
      id: 'B',
      label: 'mask B: right white opaque, left black opaque',
      sourcePath,
      maskPath: maskBPath,
      size: baseSize,
    },
    {
      id: 'C',
      label: 'control: no mask',
      sourcePath,
      maskPath: null,
      size: baseSize,
    },
  ];

  const results = [];
  for (const group of groups) {
    const result = await runGroup(group);
    if (result.outputPath) {
      result.diff = await diffHalves(group.sourcePath, result.outputPath);
    }
    results.push(result);
    printGroupResult(result);
  }

  let sizeProbe = null;
  if (!args.skipSizeProbe) {
    sizeProbe = await runGroup({
      id: 'S',
      label: 'size probe: source/mask 1024x1536 with mask A',
      sourcePath: portraitSourcePath,
      maskPath: portraitMaskAPath,
      size: portraitSize,
    });
    if (sizeProbe.outputPath) {
      sizeProbe.diff = await diffHalves(portraitSourcePath, sizeProbe.outputPath);
    }
    printGroupResult(sizeProbe);
  }

  const report = buildReport({
    runId,
    endpoint: redactUrl(cfg.endpointUrl),
    model: cfg.model,
    imageField: cfg.imageField,
    quality: cfg.quality || null,
    prompt,
    baseSize,
    portraitSize,
    groups: results,
    sizeProbe,
    outDir,
  });

  const reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_ROOT, 'latest-report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log('\n[probe][image-edit-mask] summary');
  for (const line of report.summaryLines) console.log(line);
  console.log('[probe][image-edit-mask] report:', path.relative(ROOT, reportPath));
}

async function runGroup(group) {
  const startedAt = new Date().toISOString();
  const form = new FormData();
  form.append('model', cfg.model);
  form.append('prompt', prompt);
  form.append('size', group.size);
  form.append('n', '1');
  if (cfg.quality) form.append('quality', cfg.quality);

  const sourceBuf = fs.readFileSync(group.sourcePath);
  form.append(cfg.imageField, new Blob([sourceBuf], { type: 'image/png' }), path.basename(group.sourcePath));

  if (group.maskPath) {
    const maskBuf = fs.readFileSync(group.maskPath);
    form.append('mask', new Blob([maskBuf], { type: 'image/png' }), path.basename(group.maskPath));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`probe timeout after ${cfg.timeoutMs}ms`)), cfg.timeoutMs);

  let resp;
  let text = '';
  let parsed = null;
  const result = {
    id: group.id,
    label: group.label,
    size: group.size,
    hasMask: Boolean(group.maskPath),
    source: path.relative(ROOT, group.sourcePath),
    mask: group.maskPath ? path.relative(ROOT, group.maskPath) : null,
    startedAt,
    finishedAt: null,
    durationMs: null,
    status: null,
    ok: false,
    apiError: null,
    unknownParameter: false,
    maskMentionedInError: false,
    outputPath: null,
    outputBytes: null,
    outputWidth: null,
    outputHeight: null,
    responseKind: null,
    responseSnippet: null,
    diff: null,
  };

  const t0 = Date.now();
  try {
    resp = await fetchViaProxy(cfg.endpointUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    result.status = resp.status;
    text = await resp.text();
    parsed = parseJson(text);
    const errorText = extractErrorText(parsed, text);
    result.apiError = errorText || null;
    result.unknownParameter = isUnknownParameterError(errorText || text);
    result.maskMentionedInError = /\bmask\b/i.test(errorText || text);

    if (resp.ok && !result.apiError) {
      const saved = await saveImageFromResponse(parsed, group.id);
      if (saved) {
        result.ok = true;
        result.outputPath = path.relative(ROOT, saved.path);
        result.outputBytes = saved.bytes;
        result.outputWidth = saved.width;
        result.outputHeight = saved.height;
        result.responseKind = saved.kind;
      } else {
        result.responseKind = 'no-image';
        result.responseSnippet = safeResponseSnippet(text);
      }
    } else {
      result.responseSnippet = safeResponseSnippet(errorText || text);
    }
  } catch (err) {
    result.apiError = err?.message || String(err);
    result.responseSnippet = safeResponseSnippet(result.apiError);
  } finally {
    clearTimeout(timeout);
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - t0;
  }

  fs.writeFileSync(
    path.join(outDir, `group-${group.id}-response-summary.json`),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}

async function saveImageFromResponse(parsed, groupId) {
  const first = parsed?.data?.[0];
  if (!first || typeof first !== 'object') return null;

  let buffer = null;
  let kind = null;
  if (typeof first.b64_json === 'string' && first.b64_json) {
    buffer = Buffer.from(first.b64_json, 'base64');
    kind = 'b64_json';
  } else if (typeof first.url === 'string' && first.url) {
    const dl = await fetchViaProxy(first.url);
    if (!dl.ok) {
      throw new Error(`image download failed HTTP ${dl.status}`);
    }
    buffer = Buffer.from(await dl.arrayBuffer());
    kind = 'url';
  }
  if (!buffer) return null;

  const image = await loadImage(buffer);
  const ext = 'png';
  const outputPath = path.join(outDir, `group-${groupId}-output.${ext}`);
  fs.writeFileSync(outputPath, buffer);
  return {
    path: outputPath,
    bytes: buffer.length,
    width: image.width,
    height: image.height,
    kind,
  };
}

function printGroupResult(result) {
  const base = `[probe][image-edit-mask][${result.id}] HTTP ${result.status || 'ERR'} duration=${result.durationMs}ms`;
  if (result.ok) {
    const diff = result.diff
      ? ` leftDiff=${fmt(result.diff.left.meanRgbAbsDiff)} rightDiff=${fmt(result.diff.right.meanRgbAbsDiff)}`
      : '';
    console.log(`${base} ok output=${result.outputPath} ${result.outputWidth}x${result.outputHeight}${diff}`);
  } else {
    const unknown = result.unknownParameter ? ' unknown-parameter=true' : '';
    const mask = result.maskMentionedInError ? ' mask-mentioned=true' : '';
    console.log(`${base} failed${unknown}${mask} error=${result.responseSnippet || result.apiError || '(empty)'}`);
  }
}

function buildReport(input) {
  const byId = Object.fromEntries(input.groups.map((g) => [g.id, g]));
  const controlLeft = byId.C?.diff?.left?.meanRgbAbsDiff ?? null;
  const evaluated = input.groups.map((g) => {
    const left = g.diff?.left?.meanRgbAbsDiff ?? null;
    const right = g.diff?.right?.meanRgbAbsDiff ?? null;
    return {
      id: g.id,
      accepted: Boolean(g.ok),
      status: g.status,
      unknownParameter: g.unknownParameter,
      maskMentionedInError: g.maskMentionedInError,
      leftDiff: left,
      rightDiff: right,
      leftVsControlRatio: left != null && controlLeft ? left / controlLeft : null,
      likelyMaskEffective: g.id !== 'C' && Boolean(g.ok) && left != null && right != null
        ? right >= Math.max(12, left * 2) && (!controlLeft || left <= Math.max(12, controlLeft * 0.45))
        : null,
    };
  });

  const a = evaluated.find((g) => g.id === 'A');
  const b = evaluated.find((g) => g.id === 'B');
  const c = evaluated.find((g) => g.id === 'C');
  const effective = [a, b].filter((g) => g?.likelyMaskEffective);
  let conclusion = 'inconclusive';
  if (effective.length > 0) conclusion = effective.length === 1 ? 'usable' : 'partially-effective';
  else if ([a, b].some((g) => g?.accepted)) conclusion = 'accepted-but-likely-ignored';
  else if ([a, b].some((g) => g?.unknownParameter)) conclusion = 'rejected';

  const summaryLines = [
    `- A accepted=${bool(a?.accepted)} status=${a?.status || 'ERR'} leftDiff=${fmt(a?.leftDiff)} rightDiff=${fmt(a?.rightDiff)} left/C=${fmt(a?.leftVsControlRatio)}`,
    `- B accepted=${bool(b?.accepted)} status=${b?.status || 'ERR'} leftDiff=${fmt(b?.leftDiff)} rightDiff=${fmt(b?.rightDiff)} left/C=${fmt(b?.leftVsControlRatio)}`,
    `- C control status=${c?.status || 'ERR'} leftDiff=${fmt(c?.leftDiff)} rightDiff=${fmt(c?.rightDiff)}`,
    `- alpha winner=${effective.map((g) => g.id).join(',') || '(none by heuristic)'}`,
    `- conclusion=${conclusion}`,
  ];
  if (input.sizeProbe) {
    summaryLines.push(
      `- portrait 1024x1536 status=${input.sizeProbe.status || 'ERR'} ok=${bool(input.sizeProbe.ok)} error=${input.sizeProbe.responseSnippet || input.sizeProbe.apiError || '(none)'}`,
    );
  }

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    endpoint: input.endpoint,
    model: input.model,
    imageField: input.imageField,
    quality: input.quality,
    prompt: input.prompt,
    sizes: {
      base: input.baseSize,
      portrait: input.portraitSize,
    },
    outDir: path.relative(ROOT, input.outDir),
    evaluated,
    sizeProbe: input.sizeProbe,
    conclusion,
    summaryLines,
    groups: input.groups,
  };
}

async function diffHalves(sourceRelOrAbs, outputRel) {
  const sourcePath = path.isAbsolute(sourceRelOrAbs) ? sourceRelOrAbs : path.join(ROOT, sourceRelOrAbs);
  const outputPath = path.isAbsolute(outputRel) ? outputRel : path.join(ROOT, outputRel);
  const source = await pixelsFor(sourcePath);
  const output = await pixelsFor(outputPath, source.width, source.height);
  const left = meanRgbAbsDiff(source.data, output.data, source.width, source.height, 0, 0, Math.floor(source.width / 2), source.height);
  const right = meanRgbAbsDiff(
    source.data,
    output.data,
    source.width,
    source.height,
    Math.floor(source.width / 2),
    0,
    source.width - Math.floor(source.width / 2),
    source.height,
  );
  return {
    comparedWidth: source.width,
    comparedHeight: source.height,
    outputWasResizedForComparison: output.originalWidth !== source.width || output.originalHeight !== source.height,
    left,
    right,
  };
}

async function pixelsFor(filePath, targetWidth, targetHeight) {
  const image = await loadImage(fs.readFileSync(filePath));
  const width = targetWidth || image.width;
  const height = targetHeight || image.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  return {
    width,
    height,
    originalWidth: image.width,
    originalHeight: image.height,
    data: ctx.getImageData(0, 0, width, height).data,
  };
}

function meanRgbAbsDiff(a, b, width, height, x, y, regionWidth, regionHeight) {
  let sum = 0;
  let count = 0;
  for (let yy = y; yy < y + regionHeight; yy += 1) {
    for (let xx = x; xx < x + regionWidth; xx += 1) {
      const idx = (yy * width + xx) * 4;
      sum += Math.abs(a[idx] - b[idx]);
      sum += Math.abs(a[idx + 1] - b[idx + 1]);
      sum += Math.abs(a[idx + 2] - b[idx + 2]);
      count += 3;
    }
  }
  return {
    meanRgbAbsDiff: count ? sum / count : null,
    pixels: regionWidth * regionHeight,
  };
}

function writeSourceImage(filePath, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(18, 94, 202)';
  ctx.fillRect(0, 0, Math.floor(width / 2), height);
  ctx.fillStyle = 'rgb(226, 42, 92)';
  ctx.fillRect(Math.floor(width / 2), 0, width - Math.floor(width / 2), height);
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function writeMaskA(filePath, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.fillRect(0, 0, Math.floor(width / 2), height);
  ctx.clearRect(Math.floor(width / 2), 0, width - Math.floor(width / 2), height);
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function writeMaskB(filePath, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(0, 0, 0)';
  ctx.fillRect(0, 0, Math.floor(width / 2), height);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(Math.floor(width / 2), 0, width - Math.floor(width / 2), height);
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function resolveImageEditConfig(parsedArgs) {
  const provider = inferProvider(process.env.IMAGE_PROVIDER || '', 'image');
  const isSeedream = provider === 'volcengine_seedream';
  const baseUrl = trimTrailingSlash(
    process.env.IMAGE_API_BASE ||
      (isSeedream ? 'https://ark.cn-beijing.volces.com/api/v3' : 'https://gateway.zerail.com/v1'),
  );
  const model = process.env.IMAGE_MODEL || process.env.MODEL_IMAGE_PRIMARY || (isSeedream ? 'doubao-seedream-4-5-251128' : 'gpt-image-2');
  const endpoint = normalizeEndpoint(process.env.IMAGE_EDITS_ENDPOINT || '/images/edits');
  const transport = defaultImageTransport(provider);
  const imageField = parsedArgs.imageField || fieldNameForTransport(transport);
  const quality = pickQuality(model, parsedArgs.quality || process.env.IMAGE_QUALITY || undefined);
  const timeoutSec = Number(process.env.IMAGE_TIMEOUT_SECONDS || parsedArgs.timeoutSeconds || '');
  return {
    provider,
    baseUrl,
    apiKey: isSeedream
      ? (process.env.IMAGE_SEEDREAM_API_KEY || process.env.IMAGE_API_KEY || '')
      : (process.env.IMAGE_API_KEY || ''),
    model,
    endpoint,
    endpointUrl: `${baseUrl}${endpoint}`,
    imageField,
    quality,
    timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.floor(timeoutSec * 1000) : 240_000,
  };
}

function inferProvider(provider, slot) {
  const p = String(provider || '').toLowerCase();
  if (p.includes('seedream') || (slot === 'image' && p.includes('volcengine'))) return 'volcengine_seedream';
  if (p.includes('packy') && p.includes('image')) return 'packy_images';
  if (p.includes('code80') && p.includes('image')) return 'code80_images';
  if (p.includes('image')) return 'zerail_images';
  if (slot === 'image') return 'zerail_images';
  return 'openai_chat';
}

function defaultImageTransport(provider) {
  if (provider === 'volcengine_seedream') return 'verified_seedream_array';
  if (provider === 'zerail_images' || provider === 'code80_images' || provider === 'packy_images') {
    return 'verified_openai_multipart_bracket';
  }
  return 'single_image';
}

function fieldNameForTransport(transport) {
  if (transport === 'verified_openai_multipart_bracket') return 'image[]';
  if (transport === 'verified_openai_multipart_image_files') return 'image_files[]';
  return 'image';
}

function pickQuality(model, requested) {
  const m = String(model || '').toLowerCase();
  const req = String(requested || '').toLowerCase();
  if (m.includes('gpt-image')) {
    if (['low', 'medium', 'high', 'auto'].includes(req)) return req;
    return 'low';
  }
  if (m.includes('dall-e-3')) {
    if (['standard', 'hd'].includes(req)) return req;
    return 'standard';
  }
  return undefined;
}

function parseSize(size) {
  const m = /^(\d+)x(\d+)$/i.exec(String(size || ''));
  if (!m) throw new Error(`invalid size: ${size}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

function extractErrorText(parsed, text) {
  const error = parsed?.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || error.detail || error.code || JSON.stringify(error).slice(0, 500) || text.slice(0, 500);
}

function isUnknownParameterError(text) {
  const s = String(text || '').toLowerCase();
  return /(unknown|unrecognized|unsupported|unexpected|invalid).{0,80}(parameter|param|field|argument|mask)|\bunknown\b.{0,80}\bmask\b/.test(s);
}

function safeResponseSnippet(text) {
  if (!text) return '';
  return String(text)
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g, '[redacted-token]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch (_) {
    return String(url || '');
  }
}

function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function trimTrailingSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function bool(value) {
  return value ? 'yes' : 'no';
}

function fmt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

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
