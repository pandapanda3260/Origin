import { pickSceneForShots } from './scene-selection';
import { normalizeTailFrameSignals } from './shot-tail-frame-signals';
import {
  cleanShotText,
  deriveFocus,
  legacyShotTypeToAngle,
  normalizeAngle,
  normalizeCamera,
  normalizeComposition,
  normalizeFocus,
  normalizeLens,
  normalizeLight,
  normalizeShotType,
} from '../public/modules/shotSchema.js';

const INTERNAL_KEYS = new Set([
  'reasoning',
  '__thinking__',
  'thinking',
  'thoughts',
  'chainOfThought',
  'debug',
  'debugInfo',
  'debug_info',
  '_debug',
  'internal',
  'analysis',
]);

const PACES = ['slow', 'normal', 'fast', 'fast_forward'];
const EMOTIONS = ['setup', 'rising', 'climax', 'falling', 'resolution', 'transition'];

type NormalizeGeneratedShotOptions = {
  assets?: any;
  styleBible?: any;
};

type NormalizeGeneratedShotPlanOptions = NormalizeGeneratedShotOptions & {
  generatedAt?: string;
};

function cleanFirst(...values: any[]): string {
  for (const value of values) {
    const text = cleanShotText(value);
    if (text) return text;
  }
  return '';
}

function clampDuration(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(7, Math.round(n)));
}

function clampIntensity(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function stripInternalFields(input: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if (!INTERNAL_KEYS.has(key)) out[key] = input[key];
  }
  return out;
}

function normalizeCharacters(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanShotText(item)).filter(Boolean);
}

function deriveLightFallback(shot: any, styleBible?: any): string {
  const emotion = cleanFirst(shot?.emotion);
  const byEmotion: Record<string, string> = {
    setup: '顺光·柔光·中性·低反差',
    rising: '侧光·硬光·中性·高反差',
    climax: '侧逆光·硬光·冷色·高反差',
    falling: '侧光·柔光·暖色·低反差',
    resolution: '逆光·柔光·暖色·低反差',
    transition: '侧光·柔光·中性·低反差',
  };
  const fallback = byEmotion[emotion] || '侧光·柔光·中性·低反差';
  const styleLighting = cleanFirst(styleBible?.lighting, styleBible?.light, styleBible?.mood, styleBible?.visualStyle);
  return styleLighting ? normalizeLight(styleLighting, fallback) : fallback;
}

function deriveCompositionFallback(input: { shotType: string; angle: string; camera: string; emotion?: string }): string {
  if (input.angle === '过肩' || input.angle === '主观') return '前景框架、视线方向';
  if (['特写', '大特写', '近景', '中近景'].includes(input.shotType)) return '三分法、视线方向';
  if (['大全景', '远景', '全景'].includes(input.shotType)) return '引导线、留白';
  if (input.emotion === 'climax') return '中心对称、引导线';
  if (['左移', '右移', '上移', '下移', '跟随', '升降'].includes(input.camera)) return '引导线、景深分层';
  return '三分法';
}

function paletteAnchorFromStyleBible(styleBible: any): string {
  const palette = styleBible?.colorPalette || styleBible?.palette;
  if (Array.isArray(palette)) {
    return palette
      .map((item) => {
        if (!item || typeof item !== 'object') return cleanShotText(item);
        return cleanFirst(item.name, item.hex, item.color, item.value);
      })
      .filter(Boolean)
      .slice(0, 6)
      .join('、');
  }
  return cleanShotText(palette).slice(0, 120);
}

function normalizeScene(raw: any, visual: string, assets: any) {
  const pickedScene = pickSceneForShots({
    ...(assets || {}),
    shots: [raw],
    text: [
      raw?.sceneId,
      raw?.sceneName,
      raw?.scene,
      raw?.location,
      visual,
      raw?.description,
      raw?.desc,
      raw?.scriptRef,
    ].filter(Boolean).join(' '),
  });
  const sceneId = cleanFirst(pickedScene.scene?.id, pickedScene.scene?.sceneId, raw?.sceneId);
  const sceneName = cleanFirst(
    pickedScene.scene?.name,
    pickedScene.scene?.sceneName,
    pickedScene.scene?.location,
    raw?.sceneName,
    raw?.scene,
    raw?.location,
  );
  return { sceneId, sceneName };
}

export function resolveShotFieldsForPrompt(shot: any, styleBible?: any) {
  const rawShotType = cleanFirst(shot?.shotType);
  const rawFraming = cleanFirst(shot?.framing);
  const migratedAngle = legacyShotTypeToAngle(rawShotType);
  const shotType = normalizeShotType(migratedAngle ? rawFraming : cleanFirst(rawShotType, rawFraming), '中景');
  const angle = normalizeAngle(cleanFirst(shot?.angle, shot?.viewpoint, migratedAngle), migratedAngle || '平视');
  const lens = normalizeLens(cleanFirst(shot?.lens, shot?.focalLength, shot?.focal));
  const focus = normalizeFocus(cleanFirst(shot?.focus, shot?.depthOfField, shot?.dof), deriveFocus(lens, shotType));
  const camera = normalizeCamera(cleanFirst(shot?.camera, shot?.movement), '固定镜头');
  const light = normalizeLight(cleanFirst(shot?.light, shot?.lighting), deriveLightFallback(shot, styleBible));
  const composition = normalizeComposition(
    cleanFirst(shot?.composition, shot?.compositionalRule),
    deriveCompositionFallback({ shotType, angle, camera, emotion: cleanFirst(shot?.emotion) }),
  );
  return {
    shotType,
    framing: shotType,
    angle,
    lens,
    focus,
    light,
    composition,
    camera,
    movement: camera,
  };
}

export function normalizeGeneratedShot(raw: any, index: number, opts: NormalizeGeneratedShotOptions = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const visual = cleanFirst(source.visual, source.description, source.desc).slice(0, 300);
  const dialogue = cleanFirst(source.dialogue, source.dialog) || '——';
  const duration = clampDuration(source.duration ?? source.durationSec);
  const pace = PACES.includes(cleanFirst(source.pace, source.narrativePace))
    ? cleanFirst(source.pace, source.narrativePace)
    : 'normal';
  const emotion = EMOTIONS.includes(cleanFirst(source.emotion)) ? cleanFirst(source.emotion) : 'rising';
  const fields = resolveShotFieldsForPrompt({ ...source, emotion }, opts.styleBible);
  const { sceneId, sceneName } = normalizeScene(source, visual, opts.assets);
  const keyInfo = cleanFirst(source.keyInfo, source.key, source.stylePillar).slice(0, 30);
  const audio = cleanFirst(source.audio, source.sfx);
  const characters = normalizeCharacters(source.characters);
  const intensity = clampIntensity(source.intensity);

  return {
    ...stripInternalFields(source),
    idx: typeof source.idx === 'number' && source.idx > 0 ? source.idx : index + 1,
    sceneId,
    sceneName,
    scene: sceneName,
    duration,
    durationSec: duration,
    pace,
    shotType: fields.shotType,
    framing: fields.framing,
    angle: fields.angle,
    lens: fields.lens,
    focus: fields.focus,
    light: fields.light,
    composition: fields.composition,
    camera: fields.camera,
    movement: fields.movement,
    visual,
    description: visual,
    dialogue,
    dialog: dialogue,
    keyInfo,
    stylePillar: keyInfo,
    audio,
    emotion,
    intensity,
    scriptRef: cleanFirst(source.scriptRef),
    characters,
    tailFrameSignals: normalizeTailFrameSignals(source, {
      shotType: fields.shotType,
      camera: fields.camera,
      dialogue,
      durationSec: duration,
    }),
  };
}

export function buildPlanMeta(shots: any[], styleBible?: any, opts: { generatedAt?: string } = {}) {
  const shotCount = Array.isArray(shots) ? shots.length : 0;
  const plannedDurationSec = shots.reduce((sum, shot) => sum + (Number(shot?.durationSec ?? shot?.duration) || 0), 0);
  const styleTone = cleanFirst(
    styleBible?.mood,
    styleBible?.visualStyle,
    styleBible?.tone,
    styleBible?.visualTone,
    styleBible?.genre,
    styleBible?.style,
    styleBible?.summary,
  );
  const lightingAnchor = cleanFirst(styleBible?.lighting, styleBible?.light, styleBible?.lightingAnchor).slice(0, 120);
  return {
    version: 4,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    shotCount,
    plannedDurationSec,
    primaryShotTypes: Array.from(new Set(shots.map((shot) => shot?.shotType).filter(Boolean))).slice(0, 6),
    primaryAngles: Array.from(new Set(shots.map((shot) => shot?.angle).filter(Boolean))).slice(0, 6),
    cameraMoves: Array.from(new Set(shots.map((shot) => shot?.camera).filter(Boolean))).slice(0, 8),
    paletteAnchor: paletteAnchorFromStyleBible(styleBible),
    lightingAnchor,
    styleTone: styleTone.slice(0, 80),
  };
}

export function normalizeGeneratedShotPlan(rawShots: any[], opts: NormalizeGeneratedShotPlanOptions = {}) {
  const shots = (Array.isArray(rawShots) ? rawShots : [])
    .map((shot, index) => normalizeGeneratedShot(shot, index, opts))
    .filter((shot) => shot.visual || (shot.dialogue && shot.dialogue !== '——'))
    .map((shot, index) => ({ ...shot, idx: index + 1 }));
  return {
    shots,
    planMeta: buildPlanMeta(shots, opts.styleBible, { generatedAt: opts.generatedAt }),
  };
}

export function normalizePlanMetaForHash(planMeta: any) {
  if (!planMeta || typeof planMeta !== 'object') return null;
  return {
    version: Number(planMeta.version) || 4,
    generatedAt: cleanShotText(planMeta.generatedAt),
    shotCount: Number(planMeta.shotCount) || 0,
    plannedDurationSec: Number(planMeta.plannedDurationSec) || 0,
    primaryShotTypes: Array.isArray(planMeta.primaryShotTypes) ? planMeta.primaryShotTypes.map(cleanShotText).filter(Boolean) : [],
    primaryAngles: Array.isArray(planMeta.primaryAngles) ? planMeta.primaryAngles.map(cleanShotText).filter(Boolean) : [],
    cameraMoves: Array.isArray(planMeta.cameraMoves) ? planMeta.cameraMoves.map(cleanShotText).filter(Boolean) : [],
    paletteAnchor: cleanShotText(planMeta.paletteAnchor).slice(0, 120),
    lightingAnchor: cleanShotText(planMeta.lightingAnchor).slice(0, 120),
    styleTone: cleanShotText(planMeta.styleTone).slice(0, 80),
  };
}
