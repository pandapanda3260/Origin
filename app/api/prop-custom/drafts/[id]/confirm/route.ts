import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  confirmCustomPropDraft,
  getCustomPropForUser,
  listCustomPropVersions,
  serializeCustomProp,
} from '@/lib/custom-prop-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const versionId = String(body.versionId || '').trim();
  if (!versionId) return jsonError('请选择要添加的道具版本', 400);
  const titleOverride = String(body.title || body.name || '').trim();
  try {
    const prop = confirmCustomPropDraft(user.id, params.id, versionId, titleOverride);
    const versions = listCustomPropVersions(prop.id, user.id);
    const current = versions.find((item: any) => item.id === prop.current_version_id)?.propData || null;
    return jsonOk(signCustomCharacterImageUrls({
      ok: true,
      prop: serializeCustomProp(prop, current ? JSON.stringify(current) : null),
      versions,
    }, user.id));
  } catch (error: any) {
    const existing = getCustomPropForUser(params.id, user.id);
    const status = existing && existing.lifecycle_status === 'confirmed' ? 409 : 400;
    return jsonError(error?.message || '确认添加失败，请重新生成后再试', status);
  }
}
