/**
 * VevDemo 素材导入 API
 * 将项目素材同步到 VevDemo 可访问的位置
 *
 * 输入: { resourceIds: string[] }
 * 输出: { materials: [{ id, url, type, title }] }
 */

import { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedImageUrl, buildSignedVideoUrl } from '@/lib/signed-asset-url';
import { getVevDemoMaterialBinding } from '@/lib/vevdemo-material-bindings';
import { ensureVevDemoBindingForBgmTrack, ensureVevDemoBindingForUpload, ensureVevDemoBindingForVideoTask } from '@/lib/vevdemo-material-registration';
import { getVevDemoProjectBinding } from '@/lib/vevdemo-project-bindings';
import { dataPath } from '@/lib/runtime-paths';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BGM_DIR = dataPath('bgm');
const BGM_META_FILE = join(BGM_DIR, '_meta.json');

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
    title,
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
  const names = buildVideoSegmentNamesForRow(v);
  return {
    id: v.id,
    url: toAbsoluteUrl(req, signed.url) || signed.url,
    type: 'video',
    title: names.downloadFilename,
    durationSec: v.duration_sec,
    // 封面给签名 URL：VevDemo 跨域 iframe 的 <img> 海报带不了 Bearer，未签名会 401。
    coverUrl: v.cover_image_id
      ? (toAbsoluteUrl(req, buildSignedImageUrl(v.cover_image_id, userId).url) || undefined)
      : undefined,
    expiresAt: signed.expiresAt,
    browserReachable: true,
    cloudReachable: false,
  };
}

function uploadMaterialBase(req: NextRequest, u: any): MaterialItem {
  return {
    id: u.id,
    url: toAbsoluteUrl(req, `/api/volcengine/file/${u.id}`) || `/api/volcengine/file/${u.id}`,
    type: u.kind,
    title: u.filename,
    durationSec: u.duration_sec,
    // Origin 直链需 Bearer 登录态，跨域 iframe 的 <video> 带不了 → 浏览器侧不可达。
    // 注册 VOD 成功后由 withVevDemoBinding 补上 vevSource（云端可播）。
    browserReachable: false,
    cloudReachable: false,
    requiresOriginAuth: true,
  };
}

function isImageUpload(u: any): boolean {
  const ext = String(u?.filename || '').split('.').pop()?.toLowerCase() || '';
  return u?.kind === 'image' || /^(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/.test(ext);
}

function assertSafeBgmTrackId(trackId: string): string {
  const value = String(trackId || '').trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid BGM track id: ${trackId}`);
  }
  if (!/\.(mp3|wav|m4a|aac|ogg)$/i.test(value)) {
    throw new Error(`Unsupported BGM audio extension: ${trackId}`);
  }
  return value;
}

function readBgmTitle(trackId: string): string {
  try {
    if (!existsSync(BGM_META_FILE)) return trackId.replace(/\.[^.]+$/, '');
    const meta = JSON.parse(readFileSync(BGM_META_FILE, 'utf-8') || '{}');
    const entry = meta && typeof meta === 'object' ? meta[trackId] : null;
    return String(entry?.name || trackId.replace(/\.[^.]+$/, '')).trim();
  } catch {
    return trackId.replace(/\.[^.]+$/, '');
  }
}

function bgmMaterialBase(req: NextRequest, trackId: string): MaterialItem {
  const safeId = assertSafeBgmTrackId(trackId);
  const url = `/api/edit/bgm/${encodeURIComponent(safeId)}`;
  return {
    id: safeId,
    url: toAbsoluteUrl(req, url) || url,
    type: 'audio',
    title: readBgmTitle(safeId),
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
  const bgmIdsParam = url.searchParams.get('bgmIds');
  const bgmTrackIds = bgmIdsParam ? bgmIdsParam.split(',').filter(Boolean) : [];
  const originProjectId = String(url.searchParams.get('projectId') || '').trim();

  const db = getDb();
  const materials: MaterialItem[] = [];

  // 查询视频任务（生成的片段）
  if (resourceIds.length > 0) {
    const placeholders = resourceIds.map(() => '?').join(',');
	    const videoRows = db.prepare(
	      `SELECT vt.id, vt.project_id, vt.group_idx, vt.prompt, vt.filename, vt.duration_sec, vt.cover_image_id,
	              p.title AS project_title, p.data_json AS project_data_json
	         FROM video_tasks vt
	         LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
	        WHERE vt.owner_id = ? AND vt.id IN (${placeholders}) AND vt.status = 'completed'`,
    ).all(user.id, ...resourceIds) as any[];

    for (const v of videoRows) {
      materials.push(withVevDemoBinding(
        videoMaterialBase(req, v, user.id),
        getVevDemoMaterialBinding('video_task', v.id, getTargetVevProjectId(v.project_id)),
      ));
    }

    // 查询上传素材
    const uploadRows = db.prepare(
      `SELECT id, project_id, kind, filename, mime, duration_sec
       FROM uploads
       WHERE owner_id = ? AND id IN (${placeholders})`,
    ).all(user.id, ...resourceIds) as any[];

    for (const u of uploadRows) {
      if (isImageUpload(u)) {
        materials.push(withUnsupportedVevRegistration(
          uploadMaterialBase(req, u),
          'image_upload_not_supported_for_vevdemo_timeline',
        ));
        continue;
      }
      // GET 仅做列举：复用已注册的 binding，不在这里触发上传/转码（重操作留给 POST）。
      const binding = getVevDemoMaterialBinding('upload', u.id, getTargetVevProjectId(u.project_id || originProjectId));
      materials.push(binding
        ? withVevDemoBinding(uploadMaterialBase(req, u), binding)
        : withUnsupportedVevRegistration(uploadMaterialBase(req, u), 'origin_auth_file_requires_vod_or_tos_source'));
    }
  }

  for (const trackIdRaw of bgmTrackIds) {
    try {
      const trackId = assertSafeBgmTrackId(trackIdRaw);
      const sourcePath = join(BGM_DIR, trackId);
      if (!existsSync(sourcePath)) continue;
      materials.push(withVevDemoBinding(
        bgmMaterialBase(req, trackId),
        getVevDemoMaterialBinding('bgm', trackId, getTargetVevProjectId(originProjectId)),
      ));
    } catch (err) {
      console.warn('[volcengine/import] skip invalid bgm track:', trackIdRaw, err);
    }
  }

  return jsonOk({ materials, total: materials.length });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({}));
  const resourceIds: string[] = Array.isArray(body.resourceIds) ? body.resourceIds : [];
  const bgmTrackIds: string[] = Array.isArray(body.bgmTrackIds) ? body.bgmTrackIds : [];
  const originProjectId = String(body.projectId || '').trim();
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

  if (resourceIds.length === 0 && bgmTrackIds.length === 0) {
    return jsonError('resourceIds 和 bgmTrackIds 为空', 400);
  }

  const db = getDb();
  const materials: MaterialItem[] = [];

  // 查询视频任务
  const placeholders = resourceIds.map(() => '?').join(',');
  const videoRows = resourceIds.length > 0
	    ? db.prepare(
	      `SELECT vt.id, vt.project_id, vt.group_idx, vt.prompt, vt.filename, vt.duration_sec, vt.cover_image_id,
	              p.title AS project_title, p.data_json AS project_data_json
	         FROM video_tasks vt
	         LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
	        WHERE vt.owner_id = ? AND vt.id IN (${placeholders}) AND vt.status = 'completed'`,
    ).all(user.id, ...resourceIds) as any[]
    : [];

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
  const uploadRows = resourceIds.length > 0
    ? db.prepare(
      `SELECT id, project_id, kind, filename, mime, duration_sec
       FROM uploads
       WHERE owner_id = ? AND id IN (${placeholders})`,
    ).all(user.id, ...resourceIds) as any[]
    : [];

  for (const u of uploadRows) {
    // 图片不进 VOD 剪辑时间线，保持 unsupported（与时间线只支持视频/图片暂拦截口径一致）。
    if (isImageUpload(u)) {
      materials.push(withUnsupportedVevRegistration(
        uploadMaterialBase(req, u),
        'image_upload_not_supported_for_vevdemo_timeline',
      ));
      continue;
    }

    let binding = getVevDemoMaterialBinding('upload', u.id, getTargetVevProjectId(originProjectId || u.project_id));
    let autoRegisterStatus: MaterialItem['vevAutoRegisterStatus'] = binding ? 'bound' : 'unsupported';
    let registrationError = '';

    if (autoRegister) {
      try {
        const result = await ensureVevDemoBindingForUpload({
          uploadId: u.id,
          ownerId: user.id,
          originProjectId: originProjectId || u.project_id || null,
          forceUpload: forceRegister,
          timeoutMs: registerTimeoutMs,
          pollMs: registerPollMs,
        });
        binding = result.binding;
        autoRegisterStatus = result.uploaded ? 'registered' : 'bound';
      } catch (error: any) {
        autoRegisterStatus = 'registration_failed';
        registrationError = error?.message || String(error);
        console.warn(`[volcengine/import] VevDemo upload registration failed upload=${u.id}: ${registrationError}`);
      }
    }

    const material = withVevDemoBinding(uploadMaterialBase(req, u), binding);
    material.vevAutoRegisterStatus = autoRegisterStatus;
    if (registrationError) material.vevRegistrationError = registrationError;
    materials.push(material);
  }

  for (const trackIdRaw of bgmTrackIds) {
    let trackId = '';
    try {
      trackId = assertSafeBgmTrackId(trackIdRaw);
      const sourcePath = join(BGM_DIR, trackId);
      if (!existsSync(sourcePath)) {
        materials.push(withUnsupportedVevRegistration(
          bgmMaterialBase(req, trackId),
          'bgm_file_not_found',
        ));
        continue;
      }

      let binding = getVevDemoMaterialBinding('bgm', trackId, getTargetVevProjectId(originProjectId));
      let autoRegisterStatus: MaterialItem['vevAutoRegisterStatus'] = binding ? 'bound' : 'unsupported';
      let registrationError = '';

      if (autoRegister) {
        try {
          const result = await ensureVevDemoBindingForBgmTrack({
            bgmTrackId: trackId,
            ownerId: user.id,
            originProjectId: originProjectId || null,
            forceUpload: forceRegister,
            timeoutMs: registerTimeoutMs,
            pollMs: registerPollMs,
          });
          binding = result.binding;
          autoRegisterStatus = result.uploaded ? 'registered' : 'bound';
        } catch (error: any) {
          autoRegisterStatus = 'registration_failed';
          registrationError = error?.message || String(error);
          console.warn(`[volcengine/import] VevDemo BGM registration failed track=${trackId}: ${registrationError}`);
        }
      }

      const material = withVevDemoBinding(bgmMaterialBase(req, trackId), binding);
      material.vevAutoRegisterStatus = autoRegisterStatus;
      if (registrationError) material.vevRegistrationError = registrationError;
      materials.push(material);
    } catch (err: any) {
      console.warn('[volcengine/import] invalid bgm track:', trackIdRaw, err?.message || err);
    }
  }

  return jsonOk({ materials, total: materials.length, count: materials.length });
}
