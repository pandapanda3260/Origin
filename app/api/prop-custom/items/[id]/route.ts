import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  deleteCustomPropForUser,
  getCustomPropForUser,
  getCurrentCustomPropVersion,
  listCustomPropVersions,
  serializeCustomProp,
  serializeCustomPropVersion,
  updateCustomPropVersionData,
} from '@/lib/custom-prop-db';
import { normalizeCustomPropEditableFields } from '@/lib/custom-prop-prompt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const prop = getCustomPropForUser(params.id, user.id);
  if (!prop) return jsonError('道具不存在', 404);
  const versions = listCustomPropVersions(prop.id, user.id);
  const current = versions.find((item: any) => item.id === prop.current_version_id)?.propData || null;
  return jsonOk(signCustomCharacterImageUrls({
    ok: true,
    prop: serializeCustomProp(prop, current ? JSON.stringify(current) : null),
    versions,
  }, user.id));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const prop = getCustomPropForUser(params.id, user.id);
  if (!prop) return jsonError('道具不存在', 404);
  const deleted = deleteCustomPropForUser(user.id, prop.id);
  if (!deleted) return jsonError('道具删除失败，请刷新页面后再试', 409);
  return jsonOk({ ok: true, propId: prop.id });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const prop = getCustomPropForUser(params.id, user.id);
  if (!prop) return jsonError('道具不存在', 404);
  const currentVersion = getCurrentCustomPropVersion(prop);
  if (!currentVersion) return jsonError('道具还没有可编辑的当前版本', 409);
  const body = await req.json().catch(() => ({} as any));
  const previous = JSON.parse(currentVersion.prop_data_json || '{}');
  const propData = normalizeCustomPropEditableFields(previous, body.fields || body);
  const updated = updateCustomPropVersionData(currentVersion.id, user.id, propData, propData.name || prop.title);
  return jsonOk(signCustomCharacterImageUrls({
    ok: true,
    propId: prop.id,
    version: serializeCustomPropVersion(updated),
  }, user.id));
}
