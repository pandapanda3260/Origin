import { normalizeReferenceName } from './video-reference-manifest';
import { resolveSceneImageUrl } from './scene-views';

export type SceneSelectionSource = {
  project?: any;
  assets?: any;
};

export type NormalizedScene = {
  scene: any;
  id: string;
  name: string;
  normalizedId: string;
  normalizedName: string;
  isMain: boolean;
  index: number;
};

export type SceneSelectionResult = {
  scene: any | null;
  matchReason:
    | 'sceneId'
    | 'sceneName'
    | 'text'
    | 'main'
    | 'first'
    | 'none';
};

function compactText(value: unknown): string {
  return String(value || '').trim();
}

function sceneId(scene: any, fallback: string): string {
  return compactText(scene?.id || scene?.sceneId || scene?.assetId || scene?.uuid) || fallback;
}

function sceneName(scene: any, fallback: string): string {
  return compactText(scene?.name || scene?.sceneName || scene?.title || scene?.location) || fallback;
}

function sceneUrl(scene: any): string {
  return compactText(resolveSceneImageUrl(scene, { strategy: 'selection', gate: false }));
}

export function normalizeScenes(input: SceneSelectionSource, opts: { requireImage?: boolean } = {}): NormalizedScene[] {
  const assets = input.assets || input.project?.assets || {};
  const rawScenes: any[] = [
    ...(Array.isArray(assets?.scenes) ? assets.scenes : []),
    ...(Array.isArray(assets?.environments) ? assets.environments : []),
    ...(Array.isArray(input.project?.environments) ? input.project.environments : []),
  ];
  const seen = new Set<string>();
  const out: NormalizedScene[] = [];

  rawScenes.forEach((scene, rawIdx) => {
    if (!scene) return;
    if (opts.requireImage && !sceneUrl(scene)) return;
    const id = sceneId(scene, `scene_${rawIdx + 1}`);
    const name = sceneName(scene, `场景${rawIdx + 1}`);
    const normalizedId = normalizeReferenceName(id);
    const normalizedName = normalizeReferenceName(name);
    const key = normalizedId || normalizedName || `idx:${rawIdx}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      scene,
      id,
      name,
      normalizedId,
      normalizedName,
      isMain: !!scene?.isMain,
      index: out.length,
    });
  });

  return out;
}

export function buildSceneText(shots: any[] | undefined): string {
  return (Array.isArray(shots) ? shots : [])
    .map((sh: any) => [
      sh?.sceneId,
      sh?.sceneName,
      sh?.scene,
      sh?.location,
      sh?.visual,
      sh?.description,
      sh?.desc,
      sh?.scriptRef,
      sh?.keyInfo,
    ].filter(Boolean).join(' '))
    .join(' ');
}

export function pickSceneForShots(
  input: SceneSelectionSource & { shots?: any[]; text?: string },
  opts: { requireImage?: boolean; preferFirstShot?: boolean } = {},
): SceneSelectionResult {
  const scenes = normalizeScenes(input, { requireImage: opts.requireImage });
  if (!scenes.length) return { scene: null, matchReason: 'none' };

  const shots = Array.isArray(input.shots) ? input.shots : [];
  const findById = (value: unknown) => {
    const key = normalizeReferenceName(value);
    return key ? scenes.find((item) => item.normalizedId === key) : undefined;
  };
  const findByName = (value: unknown) => {
    const key = normalizeReferenceName(value);
    return key ? scenes.find((item) => item.normalizedName === key || item.normalizedId === key) : undefined;
  };

  if (opts.preferFirstShot && shots.length) {
    const first = shots[0];
    const byId = findById(first?.sceneId);
    if (byId) return { scene: byId.scene, matchReason: 'sceneId' };
    const byName = findByName(first?.sceneName || first?.scene);
    if (byName) return { scene: byName.scene, matchReason: 'sceneName' };
  }

  const idCounts = new Map<string, number>();
  for (const sh of shots) {
    const key = normalizeReferenceName(sh?.sceneId);
    if (!key) continue;
    idCounts.set(key, (idCounts.get(key) || 0) + 1);
  }
  const bestId = Array.from(idCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (bestId) {
    const byId = scenes.find((item) => item.normalizedId === bestId);
    if (byId) return { scene: byId.scene, matchReason: 'sceneId' };
  }

  for (const sh of shots) {
    const byName = findByName(sh?.sceneName || sh?.scene);
    if (byName) return { scene: byName.scene, matchReason: 'sceneName' };
  }

  const normText = normalizeReferenceName(input.text || buildSceneText(shots));
  if (normText) {
    const byText = scenes.find((item) => item.normalizedName && normText.includes(item.normalizedName));
    if (byText) return { scene: byText.scene, matchReason: 'text' };
  }

  const main = scenes.find((item) => item.isMain);
  if (main) return { scene: main.scene, matchReason: 'main' };
  return { scene: scenes[0].scene, matchReason: 'first' };
}
