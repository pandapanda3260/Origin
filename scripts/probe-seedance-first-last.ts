import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { buildSeedanceFirstLastFrameBody, stringifySeedanceRequestBody } from '../lib/video-gen';
import { resolveSlotModelConfig } from '../lib/model-routing';
import { listRegisteredVideoModelIds, resolveVideoModelCapability } from '../lib/video-provider-capabilities';

type ProbeResult =
  | { model: string; status: 'runtime_verified'; taskId: string; videoUrl: string; lastFrameUrl: string }
  | { model: string; status: 'unsupported'; reason: string }
  | { model: string; status: 'operator_retry_required'; reason: string };

function hasArg(name: string) {
  return process.argv.includes(name);
}

function argValue(name: string, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? String(process.argv[idx + 1] || fallback) : fallback;
}

function paintImage(path: string, color: string, label: string) {
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = color === '#ffffff' ? '#111111' : '#ffffff';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, 256, 276);
  writeFileSync(path, canvas.toBuffer('image/png'));
}

function defaultModels(): string[] {
  return listRegisteredVideoModelIds()
    .filter((model) => resolveVideoModelCapability(model).firstLastFrameMode === 'supported')
    .sort();
}

async function postJson(url: string, apiKey: string, body: any) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: stringifySeedanceRequestBody(body),
  });
  const text = await resp.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!resp.ok) {
    const err: any = new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    err.status = resp.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function getJson(url: string, apiKey: string) {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await resp.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!resp.ok) {
    const err: any = new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    err.status = resp.status;
    err.payload = json;
    throw err;
  }
  return json;
}

function classifyProbeError(error: any): 'unsupported' | 'operator_retry_required' {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '');
  if (status >= 500 || status === 401 || status === 403 || /network|fetch failed|timeout|ECONNRESET|余额|quota|rate/i.test(message)) {
    return 'operator_retry_required';
  }
  return 'unsupported';
}

async function probeModel(model: string, firstFramePath: string, lastFramePath: string): Promise<ProbeResult> {
  const cfg = resolveSlotModelConfig(null, 'video');
  if (cfg.mode !== 'real' || !cfg.apiKey) {
    return { model, status: 'operator_retry_required', reason: 'VIDEO_API_KEY is not configured' };
  }
  try {
    const body = await buildSeedanceFirstLastFrameBody({
      model,
      prompt: 'A minimal test video from a white first frame to a black last frame. Smooth camera motion.',
      firstFramePath,
      lastFramePath,
      ratio: '1:1',
      durationSec: 5,
      resolution: '720p',
      watermark: false,
      generateAudio: false,
      returnLastFrame: true,
    });
    delete body.__submittedImages;
    const submit = await postJson(`${cfg.baseUrl}/contents/generations/tasks`, cfg.apiKey, body);
    const taskId = String(submit.id || '');
    if (!taskId) return { model, status: 'unsupported', reason: 'submit response did not include id' };

    const deadline = Date.now() + Number(argValue('--timeout-ms', '900000'));
    let status = String(submit.status || '').toLowerCase();
    let videoUrl = '';
    let lastFrameUrl = '';
    while (!['succeeded', 'failed', 'cancelled'].includes(status)) {
      if (Date.now() > deadline) return { model, status: 'operator_retry_required', reason: `timeout waiting for task ${taskId}` };
      await new Promise((resolve) => setTimeout(resolve, Number(argValue('--poll-ms', '6000'))));
      const polled = await getJson(`${cfg.baseUrl}/contents/generations/tasks/${taskId}`, cfg.apiKey);
      status = String(polled.status || '').toLowerCase();
      videoUrl = String(polled?.content?.video_url || videoUrl);
      lastFrameUrl = String(polled?.content?.last_frame_url || lastFrameUrl);
      if (status === 'failed' || status === 'cancelled') {
        return { model, status: 'unsupported', reason: JSON.stringify(polled.error || polled).slice(0, 300) };
      }
    }
    if (!videoUrl || !lastFrameUrl) {
      return { model, status: 'unsupported', reason: `missing returned fields video_url=${!!videoUrl} last_frame_url=${!!lastFrameUrl}` };
    }
    return { model, status: 'runtime_verified', taskId, videoUrl, lastFrameUrl };
  } catch (error: any) {
    return { model, status: classifyProbeError(error), reason: String(error?.message || error).slice(0, 300) };
  }
}

async function main() {
  const models = argValue('--models')
    ? argValue('--models').split(',').map((item) => item.trim()).filter(Boolean)
    : defaultModels();

  if (!hasArg('--run')) {
    console.log('probe-seedance-first-last: dry mode');
    console.log(`Models: ${models.join(', ') || '(none)'}`);
    console.log('Pass --run to submit real provider tasks. This costs provider credits.');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'origin-seedance-probe-'));
  try {
    const firstFramePath = join(dir, 'first.png');
    const lastFramePath = join(dir, 'last.png');
    paintImage(firstFramePath, '#ffffff', 'FIRST');
    paintImage(lastFramePath, '#000000', 'LAST');
    const results: ProbeResult[] = [];
    for (const model of models) {
      results.push(await probeModel(model, firstFramePath, lastFramePath));
    }
    const hasUnsupported = results.some((item) => item.status === 'unsupported');
    const hasRetryRequired = results.some((item) => item.status === 'operator_retry_required');
    console.log(JSON.stringify({ ok: !hasUnsupported && !hasRetryRequired, results }, null, 2));
    if (results.some((item) => item.status === 'runtime_verified')) {
      console.log('Runtime-verified models must be recorded manually in lib/video-provider-capabilities.ts.');
    }
    if (hasUnsupported) process.exit(1);
    if (hasRetryRequired) process.exit(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
