export type ObsoleteAssetType = 'prop' | 'scene';

export type ObsoleteAssetReasonCode = 'owner_missing' | 'no_shot_reference';

export type ObsoleteAsset = {
  type: ObsoleteAssetType;
  idx: number;
  id?: string;
  name: string;
  reasons: string[];
  reasonCodes: ObsoleteAssetReasonCode[];
};

const REASON_TEXT: Record<ObsoleteAssetReasonCode, string> = {
  owner_missing: '归属角色不存在',
  no_shot_reference: '无分镜引用',
};

const SHOT_TEXT_FIELDS = ['visual', 'dialogue', 'keyInfo', 'scriptRef', 'description'] as const;

function cleanText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(' ');
  return String(value).trim();
}

function cleanOwner(value: unknown): string {
  const raw = cleanText(value);
  return raw && raw.toLowerCase() !== 'null' ? raw : '';
}

function searchableText(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function shotText(shot: any): string {
  return SHOT_TEXT_FIELDS.map((field) => cleanText(shot?.[field])).filter(Boolean).join(' ').toLowerCase();
}

function hasTextMention(text: string, name: string): boolean {
  const needle = searchableText(name);
  return !!needle && text.includes(needle);
}

function reasonTexts(codes: ObsoleteAssetReasonCode[]): string[] {
  return codes.map((code) => REASON_TEXT[code]);
}

function characterIdSet(project: any): Set<string> {
  const chars = Array.isArray(project?.assets?.characters) ? project.assets.characters : [];
  return new Set(chars.map((item: any) => cleanText(item?.id)).filter(Boolean));
}

function characterNameSet(project: any): Set<string> {
  const chars = Array.isArray(project?.assets?.characters) ? project.assets.characters : [];
  return new Set(chars.map((item: any) => cleanText(item?.name)).filter(Boolean));
}

function propCarriedByExistingCharacter(prop: any, existingNames: Set<string>): boolean {
  const carries = Array.isArray(prop?.carriesCharacter) ? prop.carriesCharacter : [];
  return carries.some((name: unknown) => {
    const cleaned = cleanText(name);
    return !!cleaned && existingNames.has(cleaned);
  });
}

function sceneReferencedByShots(scene: any, shots: any[]): boolean {
  const sceneId = cleanText(scene?.id);
  const sceneName = cleanText(scene?.name);
  return shots.some((shot) => {
    const shotSceneId = cleanText(shot?.sceneId);
    if (shotSceneId && sceneId && shotSceneId === sceneId) return true;
    const shotSceneName = cleanText(shot?.sceneName);
    if (shotSceneName && sceneName && shotSceneName === sceneName) return true;
    return hasTextMention(shotText(shot), sceneName);
  });
}

function propReferencedByShots(prop: any, shots: any[], existingCharacterNames: Set<string>): boolean {
  const propName = cleanText(prop?.name);
  if (propCarriedByExistingCharacter(prop, existingCharacterNames)) return true;
  return shots.some((shot) => hasTextMention(shotText(shot), propName));
}

function obsoleteAsset(type: ObsoleteAssetType, idx: number, item: any, reasonCodes: ObsoleteAssetReasonCode[]): ObsoleteAsset | null {
  if (!reasonCodes.length) return null;
  const id = cleanText(item?.id);
  const name = cleanText(item?.name) || (type === 'prop' ? `道具 ${idx + 1}` : `场景 ${idx + 1}`);
  return {
    type,
    idx,
    ...(id ? { id } : {}),
    name,
    reasonCodes,
    reasons: reasonTexts(reasonCodes),
  };
}

export function detectObsoleteAssets(project: any): ObsoleteAsset[] {
  const assets = project?.assets || {};
  const props = Array.isArray(assets.props) ? assets.props : [];
  const scenes = Array.isArray(assets.scenes) ? assets.scenes : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const hasShots = shots.length > 0;
  const characterIds = characterIdSet(project);
  const characterNames = characterNameSet(project);
  const obsolete: ObsoleteAsset[] = [];

  props.forEach((prop: any, idx: number) => {
    const reasonCodes: ObsoleteAssetReasonCode[] = [];
    const owner = cleanOwner(prop?.ownership);
    if (owner && !characterIds.has(owner)) reasonCodes.push('owner_missing');
    if (hasShots && !propReferencedByShots(prop, shots, characterNames)) reasonCodes.push('no_shot_reference');
    const item = obsoleteAsset('prop', idx, prop, reasonCodes);
    if (item) obsolete.push(item);
  });

  scenes.forEach((scene: any, idx: number) => {
    const reasonCodes: ObsoleteAssetReasonCode[] = [];
    if (hasShots && !sceneReferencedByShots(scene, shots)) reasonCodes.push('no_shot_reference');
    const item = obsoleteAsset('scene', idx, scene, reasonCodes);
    if (item) obsolete.push(item);
  });

  return obsolete;
}
