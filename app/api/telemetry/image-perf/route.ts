import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/api-helpers';
import { dataPath } from '@/lib/runtime-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 96 * 1024;

function dayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function telemetryPath(date = new Date()) {
  return dataPath('telemetry', `image-perf.${dayStamp(date)}.${process.pid}.ndjson`);
}

function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return jsonOk({ ok: false, skipped: true, reason: 'payload_too_large' });
  }
  const payload = safeJson(raw);
  if (!payload || typeof payload !== 'object') {
    return jsonOk({ ok: false, skipped: true, reason: 'invalid_payload' });
  }

  const record = {
    receivedAt: new Date().toISOString(),
    kind: 'image_perf',
    payload,
  };
  const file = telemetryPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (error) {
    console.warn('[image-perf] write failed:', error);
    return jsonOk({ ok: false, skipped: true, reason: 'write_failed' });
  }
  return jsonOk({ ok: true });
}
