export type StoryboardMaterialRole = 'scene' | 'character' | 'prop';
export type StoryboardMaterialUiType = 'scene' | 'char' | 'prop';
export type StoryboardMaterialImageKind = 'scene' | 'character' | 'prop';
export type StoryboardMaterialVideoRole = 'scene' | 'character' | 'prop';
export type StoryboardMaterialFrameRole = 'scene' | 'character' | 'prop';

export const STORYBOARD_MATERIAL_IMAGE_STYLE = 'storyboard_material_upload';
export const STORYBOARD_MATERIAL_UPLOAD_PROMPT = '[user_upload:storyboard_material]';

export function normalizeStoryboardMaterialRole(value: unknown): StoryboardMaterialRole | null {
  const raw = String(value || '').trim();
  if (raw === 'scene') return 'scene';
  if (raw === 'prop') return 'prop';
  if (raw === 'character' || raw === 'char') return 'character';
  return null;
}

export function uiTypeToStoryboardMaterialRole(value: unknown): StoryboardMaterialRole | null {
  return normalizeStoryboardMaterialRole(value);
}

export function storyboardMaterialRoleToUiType(value: unknown): StoryboardMaterialUiType | null {
  const role = normalizeStoryboardMaterialRole(value);
  if (role === 'character') return 'char';
  return role;
}

export function materialRoleToImageKind(value: unknown): StoryboardMaterialImageKind | null {
  return normalizeStoryboardMaterialRole(value);
}

export function materialRoleToVideoRole(value: unknown): StoryboardMaterialVideoRole | null {
  return normalizeStoryboardMaterialRole(value);
}

export function materialRoleToFrameRole(value: unknown): StoryboardMaterialFrameRole | null {
  return normalizeStoryboardMaterialRole(value);
}

export function storyboardMaterialAssetRef(
  groupIdx: number,
  role: unknown,
  materialId: unknown,
): string | null {
  const canonicalRole = normalizeStoryboardMaterialRole(role);
  const id = String(materialId || '').trim();
  if (!canonicalRole || !id || !Number.isInteger(groupIdx) || groupIdx < 0) return null;
  return `storyboardMaterial[${groupIdx}].${canonicalRole}.${id}`;
}
