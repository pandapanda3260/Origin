/**
 * VevDemo 素材导入 API
 * 将项目素材同步到 VevDemo 可访问的位置
 *
 * 输入: { resourceIds: string[] }
 * 输出: { materials: [{ id, url, type, title }] }
 */

import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedVideoUrl } from '@/lib/signed-asset-url';
import { getVevDemoMaterialBinding } from '@/lib/vevdemo-material-bindings';
import { ensureVevDemoBindingForVideoTask } from '@/lib/vevdemo-material-registration';
import { getVevDemoProjectBinding } from '@/lib/vevdemo-project-bindings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MaterialItem {
  id: string;
  url: string;
  type: string;
  title: string;
  durationSec?: number;
  coverUrl?: string;
  // Unix timestamp in seconds. Signed Origin URLs must be refreshed after this.
  expiresAt?: number;
  browserReachable?: boolean;
  cloudReachable?: boolean;
  requiresOriginAuth?: boolean;
  /**
   * Source accepted by VevDemo CreateEditMaterial, e.g. vid://, directurl:// or tos://.
   * Origin signed HTTP URLs are intentionally not treated as VevDemo sources.
   */
  vevSource?: string | null;
  vevCreatePayload?: Record<string, unknown> | null;
  vevProjectId?: string;
  vevSpace?: string;
  vevEditMid?: string;
  vevRegistrationReady?: boolean;
  vevRegistrationReason?: string;
  vevAutoRegisterStatus?: 'bound' | 'registered' | 'registration_failed' | 'unsupported';
  vevRegistrationError?: string;
}

function withUnsupportedVevRegistration<T extends MaterialItem>(item: T, reason: string): T {
  return {
    ...item,
    vevSource: null,
    vevRegistrationReady: false,
    vevRegistrationReason: reason,
  };
}

function withVevDemoBinding<T extends MaterialItem>(
  item: T,
  binding: ReturnType<typeof getVevDemoMaterialBinding>,
): T {
  if (!binding) return withUnsupportedVevRegistration(item, 'origin_signed_url_requires_vod_or_tos_source');
  const title = binding.title || item.title || item.id;
  const vevSpace = binding.vevSpace || 'origin';
  return {
    ...item,
    cloudReachable: true,
    vevSource: binding.vevSource,
    vevProjectId: binding.vevProjectId,
    vevSpace,
    vevEditMid: binding.vevEditMid,
    // Normal script-written bindings always include vevEditMid. This payload is
    // a defensive fallback for manually seeded bindings that only provide vid://.
    vevCreatePayload: binding.vevEditMid ? null : {
      ProjectId: binding.vevProjectId,
      Space: vevSpace,
      Name: title,
      Type: String(item.type || 'video').toLowerCase(),
      Source: binding.vevSource,
    },
    vevRegistrationReady: true,
    vevRegistrationReason: binding.vevEditMid ? 'vevdemo_edit_material_registered' : 'vevdemo_source_ready',
  };
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function videoMaterialBase(req: NextRequest, v: any, userId: number): MaterialItem {
  const signed = buildSignedVideoUrl(v.id, userId);
  return {
    id: v.id,
    url: toAbsoluteUrl(req, signed.url) || signed.url,
    type: 'video',
    title: `片段 ${v.group_idx ?? ''}`,
    durationSec: v.duration_sec,
    coverUrl: toAbsoluteUrl(req, v.cover_image_id ? `/api/images/file/${v.cover_image_id}` : undefined),
    expiresAt: signed.expiresAt,
    browserReachable: true,
    cloudReachable: false,
  };
}

function toAbsoluteUrl(req: NextRequest, value: string | null | undefined): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, req.url).toString();
}

function getTargetVevProjectId(originProjectId: string | null | undefined): string | undefined {
  const binding = originProjectId ? getVevDemoProjectBinding(originProjectId) : null;
  return binding?.vevProjectId || undefined;
}

/**
 * GET /api/volcengine/import
 * 获取素材列表（支持 ?ids=id1,id2 或查询所有）
 *
 * POST /api/volcengine/import
 * 批量导入素材到 VevDemo
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const idsParam = url.searchParams.get('ids');
  const resourceIds = idsParam ? idsParam.split(',').filter(Boolean) : [];

  const db = getDb();
  const materials: MaterialItem[] = [];

  // 查询视频任务（生成的片段）
  if (resourceIds.length > 0) {
    const placeholders = resourceIds.map(() => '?').join(',');
    const videoRows = db.prepare(
      `SELECT id, project_id, group_idx, prompt, duration_sec, cover_image_id
       FROM video_tasks
       WHERE owner_id = ? AND id IN (${placeholders}) AND status = 'completed'`,
    ).all(user.id, ...resourceIds) as any[];

    for (const v of videoRows) {
      materials.push(withVevDemoBinding(
        videoMaterialBase(req, v, user.id),
        getVevDemoMaterialBinding('video_task', v.id, getTargetVevProjectId(v.project_id)),
      ));
    }

    // 查询上传素材
    const uploadRows = db.prepare(
      `SELECT id, kind, filename, mime, duration_sec
       FROM uploads
       WHERE owner_id = ? AND id IN (${placeholders})`,
    ).all(user.id, ...resourceIds) as any[];

    for (const u of uploadRows) {
      materials.push(withUnsupportedVevRegistration({
        id: u.id,
        url: toAbsoluteUrl(req, `/api/volcengine/file/${u.id}`) || `/api/volcengine/file/${u.id}`,
        type: u.kind,
        title: u.filename,
        durationSec: u.duration_sec,
        browserReachable: false,
        cloudReachable: false,
        requiresOriginAuth: true,
      }, 'origin_auth_file_requires_vod_or_tos_source'));
    }
  }

  return jsonOk({ materials, total: materials.length });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({}));
  const resourceIds: string[] = Array.isArray(body.resourceIds) ? body.resourceIds : [];
  const autoRegister = body.autoRegister !== false;
  const forceRegister = body.forceRegister === true;
  const registerTimeoutMs = readPositiveNumber(
    body.registerTimeoutMs,
    readPositiveNumber(process.env.VEVDEMO_AUTO_REGISTER_TIMEOUT_MS, 12 * 60 * 1000),
  );
  const registerPollMs = readPositiveNumber(
    body.registerPollMs,
    readPositiveNumber(process.env.VEVDEMO_AUTO_REGISTER_POLL_MS, 15 * 1000),
  );

  if (resourceIds.length === 0) {
    return jsonError('resourceIds 为空', 400);
  }

  const db = getDb();
  const materials: MaterialItem[] = [];

  // 查询视频任务
  const placeholders = resourceIds.map(() => '?').join(',');
  const videoRows = db.prepare(
    `SELECT id, project_id, group_idx, prompt, duration_sec, cover_image_id
     FROM video_tasks
     WHERE owner_id = ? AND id IN (${placeholders}) AND status = 'completed'`,
  ).all(user.id, ...resourceIds) as any[];

  for (const v of videoRows) {
    let binding = getVevDemoMaterialBinding('video_task', v.id, getTargetVevProjectId(v.project_id));
    let autoRegisterStatus: MaterialItem['vevAutoRegisterStatus'] = binding ? 'bound' : 'unsupported';
    let registrationError = '';

    if (autoRegister) {
      try {
        const result = await ensureVevDemoBindingForVideoTask({
          videoTaskId: v.id,
          ownerId: user.id,
          forceUpload: forceRegister,
          timeoutMs: registerTimeoutMs,
          pollMs: registerPollMs,
        });
        binding = result.binding;
        autoRegisterStatus = result.uploaded ? 'registered' : 'bound';
      } catch (error: any) {
        autoRegisterStatus = 'registration_failed';
        registrationError = error?.message || String(error);
        console.warn(`[volcengine/import] VevDemo auto registration failed videoTask=${v.id}: ${registrationError}`);
      }
    }

    const material = withVevDemoBinding(videoMaterialBase(req, v, user.id), binding);
    material.vevAutoRegisterStatus = autoRegisterStatus;
    if (registrationError) material.vevRegistrationError = registrationError;
    materials.push(material);
  }

  // 查询上传素材
  const uploadRows = db.prepare(
    `SELECT id, kind, filename, mime, duration_sec
     FROM uploads
     WHERE owner_id = ? AND id IN (${placeholders})`,
  ).all(user.id, ...resourceIds) as any[];

  for (const u of uploadRows) {
    materials.push(withUnsupportedVevRegistration({
      id: u.id,
      url: toAbsoluteUrl(req, `/api/volcengine/file/${u.id}`) || `/api/volcengine/file/${u.id}`,
      type: u.kind,
      title: u.filename,
      durationSec: u.duration_sec,
      browserReachable: false,
      cloudReachable: false,
      requiresOriginAuth: true,
    }, 'origin_auth_file_requires_vod_or_tos_source'));
  }

  return jsonOk({ materials, total: materials.length, count: materials.length });
}
