/**
 * VevDemo 导出完成回调 API
 * 接收 VevDemo iframe 的导出完成通知，记录到 exports 表
 * 
 * 输入: { taskId, outputUrl, duration, format }
 * 输出: { success: true, exportId }
 */

import '@/lib/init-executors';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { OnlineEditorExportRecordError, saveVevDemoExportRecord } from '@/lib/online-editor-export-records';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseOptionalJson(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function callbackSecrets() {
  return [
    process.env.VEVDEMO_CALLBACK_SECRET,
    process.env.VEVDEMO_CALLBACK_SECRET_PREV,
  ].map((s) => String(s || '').trim()).filter(Boolean);
}

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function safeEqualHex(a: string, b: string) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function verifyCallbackSignature(req: NextRequest, rawBody: string) {
  const secrets = callbackSecrets();
  const requireHmac = process.env.NODE_ENV === 'production' || envFlag('REQUIRE_VEVDEMO_HMAC', false);
  if (!secrets.length) {
    return requireHmac
      ? { ok: false as const, reason: 'callback secret not configured' }
      : { ok: true as const, enforced: false };
  }

  const timestamp = req.headers.get('x-vevdemo-timestamp') || '';
  const signatureRaw = req.headers.get('x-vevdemo-signature') || '';
  const signature = signatureRaw.replace(/^sha256=/i, '').trim();
  if (!timestamp || !signature) return { ok: false as const, reason: 'missing signature' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false as const, reason: 'invalid timestamp' };
  const tsMs = ts > 1_000_000_000_000 ? ts : ts * 1000;
  if (Math.abs(Date.now() - tsMs) > 5 * 60_000) {
    return { ok: false as const, reason: 'timestamp outside tolerance' };
  }

  for (const secret of secrets) {
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    try {
      if (safeEqualHex(signature, expected)) return { ok: true as const, enforced: true };
    } catch {
      return { ok: false as const, reason: 'invalid signature encoding' };
    }
  }
  return { ok: false as const, reason: 'signature mismatch' };
}

function parseBody(rawBody: string) {
  try {
    const parsed = JSON.parse(rawBody || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveWebhookOwnerId(body: Record<string, any>) {
  const explicitOwnerId =
    readPositiveInt(body.ownerId) ||
    readPositiveInt(body.owner_id) ||
    readPositiveInt(body.originOwnerId) ||
    readPositiveInt(body.origin_owner_id);
  const projectId = typeof body.projectId === 'string' && body.projectId.trim()
    ? body.projectId.trim()
    : null;

  if (!projectId) {
    if (explicitOwnerId) return explicitOwnerId;
    throw new OnlineEditorExportRecordError('webhook requires ownerId or projectId', 400);
  }

  const row = getDb()
    .prepare<{ id: string }, { owner_id: number }>('SELECT owner_id FROM projects WHERE id = @id')
    .get({ id: projectId });
  if (!row) {
    throw new OnlineEditorExportRecordError('webhook project not found', 404);
  }
  if (explicitOwnerId && Number(row.owner_id) !== Number(explicitOwnerId)) {
    throw new OnlineEditorExportRecordError('webhook ownerId does not match project owner', 409);
  }
  return Number(row.owner_id);
}

function saveCallbackBodyForUser(body: Record<string, any>, userId: number) {
  return saveVevDemoExportRecord({
    userId: Number(userId),
    projectId: body.projectId,
    taskId: body.taskId,
    outputUrl: body.outputUrl,
    duration: body.duration,
    format: body.format || 'mp4',
    edlJson: body.edlJson,
  });
}

/**
 * POST /api/volcengine/export-callback
 * 外部 VevDemo/火山 webhook 回调入口。生产环境强制 HMAC。
 * 浏览器会话回写请使用 /api/online-editor/export-complete。
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = verifyCallbackSignature(req, rawBody);
  const body = parseBody(rawBody);
  try {
    if (signature.ok && signature.enforced) {
      const payload = saveCallbackBodyForUser(body, resolveWebhookOwnerId(body));
      return jsonOk(payload);
    }

    const user = await getCurrentUser(req);
    if (!user) {
      return jsonError(`unauthorized: ${signature.ok ? 'no user session' : signature.reason}`, 401);
    }
    if (!signature.ok && (process.env.NODE_ENV === 'production' || envFlag('REQUIRE_VEVDEMO_HMAC', false))) {
      return jsonError(`invalid callback signature: ${signature.reason}`, 401);
    }

    const payload = saveCallbackBodyForUser(body, Number(user.id));
    return jsonOk(payload);
  } catch (err: any) {
    console.error('[ExportCallback] Failed to save export:', err);
    if (err instanceof OnlineEditorExportRecordError) {
      return jsonError(err.message, err.status);
    }
    return jsonError('保存导出记录失败: ' + (err?.message || 'unknown error'), 500);
  }
}

/**
 * GET /api/volcengine/export-callback
 * 获取导出状态
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const exportId = url.searchParams.get('id');

  if (!exportId) {
    return jsonError('缺少导出 ID', 400);
  }

  const db = getDb();
  const row = db.prepare<{ id: string; uid: number }, any>(
    'SELECT * FROM exports WHERE id = @id AND owner_id = @uid',
  ).get({ id: exportId, uid: user.id });

  if (!row) {
    return jsonError('导出记录不存在', 404);
  }

  return jsonOk({
    exportId: row.id,
    status: row.status,
    progress: row.progress,
    filename: row.filename,
    localDownloadStatus: row.local_download_status || parseOptionalJson(row.edl_json).vevDemo?.localDownloadStatus || null,
    vevDemo: parseOptionalJson(row.edl_json).vevDemo || null,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    done: row.status === 'completed' || row.status === 'failed',
  });
}
