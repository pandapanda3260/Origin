import { isBlockingReferenceStatus, resolveAssetReferenceState } from './visual-reference-state';

export type SceneViewRole = 'establishing' | 'reverse' | 'alt' | 'topdown';
export type SceneImageUrlStrategy = 'selection' | 'framePlan' | 'videoManifest';

export type SceneRefLike = {
  role?: string;
  viewRole?: SceneViewRole | string;
};

export type SceneView = {
  role: SceneViewRole;
  angleHint?: string;
  imageUrl?: string;
  rawUrl?: string;
  imagePrompt?: string;
  submittedImagePrompt?: string;
  reference?: any;
  generatedAt?: string;
};

export const SCENE_VIEW_ROLES: SceneViewRole[] = ['establishing', 'reverse', 'alt', 'topdown'];
const MAX_SCENE_VIEW_HISTORY = 5;

function compactText(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeSceneViewRole(value: unknown): SceneViewRole | null {
  const role = compactText(value);
  return SCENE_VIEW_ROLES.includes(role as SceneViewRole) ? (role as SceneViewRole) : null;
}

export function isTopdownSceneRef(ref: SceneRefLike | null | undefined): boolean {
  return !!ref && ref.role === 'scene' && normalizeSceneViewRole(ref.viewRole) === 'topdown';
}

export function isPrimarySceneRef(ref: SceneRefLike | null | undefined): boolean {
  return !!ref && ref.role === 'scene' && !isTopdownSceneRef(ref);
}

export function sceneViewStaleKey(idx: number, viewRole?: SceneViewRole | string | null): string {
  const role = normalizeSceneViewRole(viewRole);
  return role ? `asset_img_scene_${idx}_${role}` : `asset_img_scene_${idx}`;
}

function sceneViewAngleHint(role: SceneViewRole): string {
  if (role === 'establishing') return 'primary establishing view';
  if (role === 'reverse') return 'reverse 180-degree view';
  if (role === 'alt') return 'alternate side/detail view';
  return 'top-down spatial layout anchor';
}

function orderSceneViews(views: any[]): any[] {
  return views
    .filter((view) => normalizeSceneViewRole(view?.role))
    .sort((a, b) => (
      SCENE_VIEW_ROLES.indexOf(normalizeSceneViewRole(a.role) || 'establishing') -
      SCENE_VIEW_ROLES.indexOf(normalizeSceneViewRole(b.role) || 'establishing')
    ));
}

function upsertSceneView(existing: any, role: SceneViewRole, view: any): any[] {
  const prior = Array.isArray(existing?.views) ? existing.views : [];
  return orderSceneViews([
    ...prior.filter((item: any) => normalizeSceneViewRole(item?.role) !== role),
    view,
  ]);
}

function appendSceneViewHistory(existing: any): any[] {
  const priorHistory = Array.isArray(existing?.viewHistory) ? existing.viewHistory : [];
  const priorViews = Array.isArray(existing?.views) ? existing.views : [];
  if (!priorViews.length) return priorHistory.slice(0, MAX_SCENE_VIEW_HISTORY);
  const viewImageIds = priorViews
    .map((view: any) => view?.imageUrl || view?.rawUrl || view?.reference?.currentUrl || view?.reference?.lastKnownGoodUrl)
    .filter(Boolean);
  if (!viewImageIds.length) return priorHistory.slice(0, MAX_SCENE_VIEW_HISTORY);
  return [
    {
      version: Number(existing?.viewsVersion || 0),
      viewImageIds,
      deprecatedAt: new Date().toISOString(),
    },
    ...priorHistory,
  ].slice(0, MAX_SCENE_VIEW_HISTORY);
}

export function applySceneViewWrite(existing: any, args: {
  role: SceneViewRole;
  imageUrl: string;
  rawUrl?: string;
  imagePrompt?: string;
  submittedImagePrompt?: string;
  referenceStatus?: string;
  generatedAt?: string;
  assetId?: string;
  imageSafetyAudit?: any;
  effectiveVisualDescription?: any;
  styleBibleSignature?: string;
  styleLockVersion?: number;
  resolvedBackdropColor?: string;
  invalidateOtherViews?: boolean;
}): any {
  const now = args.generatedAt || new Date().toISOString();
  const priorViews = Array.isArray(existing?.views) ? existing.views : [];
  const priorView = priorViews.find((view: any) => normalizeSceneViewRole(view?.role) === args.role);
  const keptViews = args.invalidateOtherViews && args.role === 'establishing'
    ? priorViews.filter((view: any) => normalizeSceneViewRole(view?.role) === 'establishing')
    : priorViews;
  const reference = {
    ...((priorView && priorView.reference) || existing?.reference || {}),
    currentUrl: args.imageUrl,
    lastKnownGoodUrl: args.imageUrl,
    status: args.referenceStatus || 'ready',
    updatedAt: now,
    styleBibleSignature: args.styleBibleSignature,
    styleLockVersion: args.styleLockVersion,
    resolvedBackdropColor: args.resolvedBackdropColor,
  };
  const currentView: any = {
    ...(priorView || {}),
    role: args.role,
    angleHint: sceneViewAngleHint(args.role),
    imageUrl: args.imageUrl,
    rawUrl: args.rawUrl || args.imageUrl,
    imagePrompt: args.imagePrompt === undefined ? (priorView?.imagePrompt ?? existing?.imagePrompt) : args.imagePrompt,
    submittedImagePrompt: args.submittedImagePrompt === undefined ? priorView?.submittedImagePrompt : args.submittedImagePrompt,
    reference,
    generatedAt: now,
  };
  if (args.assetId) currentView.assetId = args.assetId;

  const baseForViews = { ...(existing || {}), views: keptViews };
  const next = {
    ...(existing || {}),
    imagePrompt: args.imagePrompt === undefined ? existing?.imagePrompt : args.imagePrompt,
    imageSafetyAudit: args.imageSafetyAudit === undefined ? existing?.imageSafetyAudit : args.imageSafetyAudit,
    effectiveVisualDescription: args.effectiveVisualDescription === undefined ? existing?.effectiveVisualDescription : args.effectiveVisualDescription,
    views: upsertSceneView(baseForViews, args.role, currentView),
    viewsVersion: Number(existing?.viewsVersion || 0) + 1,
    viewHistory: appendSceneViewHistory(existing),
  };
  if (args.role === 'establishing') {
    next.imageUrl = args.imageUrl;
    next.rawUrl = args.rawUrl || args.imageUrl;
    if (args.assetId) next.assetId = args.assetId;
    if (args.submittedImagePrompt !== undefined) next.submittedImagePrompt = args.submittedImagePrompt;
    next.reference = reference;
    next.imageGeneratedAt = now;
  }
  delete next.imageLastError;
  delete next.imageFailedAt;
  if (next.reference) {
    delete next.reference.lastError;
    delete next.reference.lastAttemptUrl;
    delete next.reference.lastFailedAt;
  }
  return next;
}

function firstUrl(...values: unknown[]): string {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return '';
}

export function normalizeSceneViews(scene: any): SceneView[] {
  const explicit = Array.isArray(scene?.views)
    ? scene.views
        .map((view: any) => {
          const role = normalizeSceneViewRole(view?.role);
          if (!role) return null;
          const imageUrl = firstUrl(
            view?.reference?.currentUrl,
            view?.reference?.lastKnownGoodUrl,
            view?.imageUrl,
            view?.rawUrl,
          );
          return {
            ...view,
            role,
            imageUrl: imageUrl || compactText(view?.imageUrl),
            rawUrl: compactText(view?.rawUrl),
          } as SceneView;
        })
        .filter(Boolean) as SceneView[]
    : [];

  if (explicit.some((view) => view.role === 'establishing')) return explicit;

  const establishingUrl = firstUrl(
    scene?.reference?.currentUrl,
    scene?.reference?.lastKnownGoodUrl,
    scene?.imageUrl,
    scene?.rawUrl,
    scene?.currentUrl,
    scene?.realPhotoUrl,
    scene?.coverUrl,
  );
  if (!establishingUrl) return explicit;
  return [
    {
      role: 'establishing',
      angleHint: 'primary establishing view',
      imageUrl: establishingUrl,
      rawUrl: compactText(scene?.rawUrl),
      imagePrompt: scene?.imagePrompt,
      submittedImagePrompt: scene?.submittedImagePrompt,
      reference: scene?.reference,
      generatedAt: scene?.imageGeneratedAt,
    },
    ...explicit,
  ];
}

function resolveSceneViewUrl(scene: any, viewRole: SceneViewRole, gate: boolean): string {
  const views = normalizeSceneViews(scene);
  const view = views.find((item) => item.role === viewRole);
  if (!view) return viewRole === 'establishing' ? resolveSceneImageUrl(scene, { strategy: 'videoManifest', gate }) : '';
  const reference = resolveAssetReferenceState(view);
  if (gate && isBlockingReferenceStatus(reference.status)) return '';
  return firstUrl(
    reference.currentUrl,
    reference.lastKnownGoodUrl,
    view.imageUrl,
    view.rawUrl,
  );
}

export function resolveSceneImageUrl(
  scene: any,
  opts: {
    strategy?: SceneImageUrlStrategy;
    gate?: boolean;
    viewRole?: SceneViewRole | string | null;
  } = {},
): string {
  if (!scene) return '';
  const viewRole = normalizeSceneViewRole(opts.viewRole);
  if (viewRole) return resolveSceneViewUrl(scene, viewRole, opts.gate !== false);

  const strategy = opts.strategy || 'videoManifest';
  if (strategy === 'selection') {
    return firstUrl(
      scene?.imageUrl,
      scene?.rawUrl,
      scene?.currentUrl,
      scene?.realPhotoUrl,
      scene?.coverUrl,
    );
  }

  const reference = resolveAssetReferenceState(scene);
  if (opts.gate !== false && isBlockingReferenceStatus(reference.status)) return '';

  if (strategy === 'framePlan') {
    return firstUrl(
      reference.currentUrl,
      reference.lastKnownGoodUrl,
      scene?.imageUrl,
      scene?.rawUrl,
      scene?.pencilUrl,
      scene?.realPhotoUrl,
    );
  }

  return firstUrl(
    reference.currentUrl,
    reference.lastKnownGoodUrl,
    scene?.imageUrl,
    scene?.rawUrl,
    scene?.realPhotoUrl,
    scene?.coverUrl,
  );
}

function shotAngleText(shot: any): string {
  return [
    shot?.angle,
    shot?.shotType,
    shot?.camera,
    shot?.composition,
    shot?.visual,
    shot?.description,
    shot?.desc,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function pickSceneView(scene: any, primaryShot?: any): { role: SceneViewRole; url: string; view?: SceneView } {
  const views = normalizeSceneViews(scene);
  const text = shotAngleText(primaryShot);
  const preferred: SceneViewRole =
    /反打|reverse|180|over[-\s]?shoulder|背面|回看/.test(text)
      ? 'reverse'
      : /侧面|侧角|side|profile|detail|close[-\s]?up|特写|近景|细节/.test(text)
        ? 'alt'
        : 'establishing';
  const roles: SceneViewRole[] = [preferred, 'establishing', 'alt', 'reverse'];
  for (const role of roles) {
    const url = resolveSceneImageUrl(scene, { strategy: 'videoManifest', gate: true, viewRole: role });
    if (url) return { role, url, view: views.find((view) => view.role === role) };
  }
  return { role: 'establishing', url: resolveSceneImageUrl(scene, { strategy: 'videoManifest', gate: true }) };
}

export function pickSceneTopdownAnchor(scene: any): { role: 'topdown'; url: string; view?: SceneView } | null {
  const views = normalizeSceneViews(scene);
  const url = resolveSceneImageUrl(scene, { strategy: 'videoManifest', gate: true, viewRole: 'topdown' });
  if (!url) return null;
  return { role: 'topdown', url, view: views.find((view) => view.role === 'topdown') };
}
