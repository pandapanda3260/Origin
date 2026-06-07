export const SHOT_TYPES = [
  "大全景",
  "远景",
  "全景",
  "中景",
  "中近景",
  "近景",
  "特写",
  "大特写",
];

export const ANGLES = [
  "平视",
  "略俯",
  "俯拍",
  "略仰",
  "仰拍",
  "鸟瞰",
  "倾斜",
  "过肩",
  "主观",
];

export const LENSES = [
  "超广角16-24",
  "广角35",
  "标准50",
  "中长焦85",
  "长焦135+",
  "微距",
];

export const FOCUS_OPTIONS = [
  "深焦",
  "中等景深",
  "浅景深",
  "移焦",
];

export const LIGHT_AXES = {
  direction: ["顺光", "侧光", "侧逆光", "逆光", "顶光", "底光"],
  quality: ["硬光", "柔光"],
  temperature: ["暖色", "中性", "冷色"],
  contrast: ["高反差", "低反差"],
};

export const LIGHT_PRESETS = [
  "侧光·柔光·中性·低反差",
  "侧逆光·硬光·冷色·高反差",
  "逆光·柔光·暖色·低反差",
  "顶光·硬光·冷色·高反差",
  "顺光·柔光·暖色·低反差",
  "底光·硬光·中性·高反差",
];

export const COMPOSITION_OPTIONS = [
  "三分法",
  "中心对称",
  "前景框架",
  "引导线",
  "留白",
  "视线方向",
  "景深分层",
];

export const COMPOSITION_PRESETS = [
  "三分法",
  "中心对称",
  "三分法、视线方向",
  "前景框架、景深分层",
  "引导线、留白",
  "中心对称、留白",
];

export const CAMERA_MOVES = [
  "固定镜头",
  "缓慢推进",
  "轻微推近",
  "推近",
  "快速推进",
  "缓慢拉远",
  "拉远",
  "快速拉远",
  "左移",
  "右移",
  "上移",
  "下移",
  "跟随",
  "环绕",
  "摇镜头",
  "手持轻晃",
  "升降",
  "甩镜头",
];

export const CAMERA_COMPAT_GROUPS = {
  A: ["固定镜头", "缓慢推进", "轻微推近"],
  B: ["推近", "快速推进", "缓慢拉远", "拉远", "快速拉远"],
  C: ["左移", "右移", "上移", "下移", "跟随", "升降"],
  D: ["环绕", "摇镜头", "手持轻晃", "甩镜头"],
};

export const SHOT_TYPE_ALIASES = {
  "广角全景": "大全景",
  "广角": "大全景",
};

export const ANGLE_ALIASES = {
  "俯拍": "俯拍",
  "俯视": "俯拍",
  "高角度": "俯拍",
  "略俯": "略俯",
  "仰拍": "仰拍",
  "低角度": "仰拍",
  "略仰": "略仰",
  "主观": "主观",
  "主观镜头": "主观",
  "主观POV": "主观",
  "POV": "主观",
  "过肩": "过肩",
  "过肩镜头": "过肩",
  "肩后": "过肩",
  "鸟瞰": "鸟瞰",
  "平视": "平视",
  "倾斜": "倾斜",
  "Dutch角": "倾斜",
};

export const CAMERA_ALIASES = {
  "固定机位": "固定镜头",
  "推": "推近",
  "推镜头": "推近",
  "拉": "拉远",
  "拉镜头": "拉远",
  "摇": "摇镜头",
  "跟": "跟随",
  "航拍": "升降",
  "轨道": "跟随",
  "手持": "手持轻晃",
};

const DEFAULT_LIGHT = "侧光·柔光·中性·低反差";
const DEFAULT_COMPOSITION = "三分法";

function firstText(...values) {
  for (const value of values) {
    const text = cleanShotText(value);
    if (text) return text;
  }
  return "";
}

function sortByLengthDesc(values) {
  return values.slice().sort((a, b) => b.length - a.length);
}

function textIncludesOption(text, options) {
  const raw = String(text || "");
  return sortByLengthDesc(options).find((option) => raw.includes(option)) || "";
}

export function cleanShotText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cleanShotText).filter(Boolean).join("、").trim();
  return String(value).trim();
}

export function pickOption(value, options, fallback) {
  const text = cleanShotText(value);
  return options.includes(text) ? text : fallback;
}

export function legacyShotTypeToAngle(value) {
  const text = cleanShotText(value);
  if (!text) return "";
  return ANGLE_ALIASES[text] || (ANGLES.includes(text) ? text : "");
}

export function normalizeShotType(value, fallback = "中景") {
  const text = cleanShotText(value);
  const mapped = SHOT_TYPE_ALIASES[text] || text;
  return SHOT_TYPES.includes(mapped) ? mapped : fallback;
}

export function normalizeAngle(value, fallback = "平视") {
  const text = cleanShotText(value);
  const mapped = ANGLE_ALIASES[text] || text;
  return ANGLES.includes(mapped) ? mapped : fallback;
}

export function normalizeCamera(value, fallback = "固定镜头") {
  const text = cleanShotText(value);
  const mapped = CAMERA_ALIASES[text] || text;
  return CAMERA_MOVES.includes(mapped) ? mapped : fallback;
}

export function normalizeLens(value, fallback = "标准50") {
  return pickOption(value, LENSES, fallback);
}

export function deriveFocus(lens, shotType) {
  const normalizedLens = normalizeLens(lens);
  const normalizedShotType = normalizeShotType(shotType);
  if (["中长焦85", "长焦135+", "微距"].includes(normalizedLens)) return "浅景深";
  if (["近景", "特写", "大特写"].includes(normalizedShotType)) return "浅景深";
  if (["超广角16-24", "广角35"].includes(normalizedLens)) return "深焦";
  if (["大全景", "远景", "全景"].includes(normalizedShotType)) return "深焦";
  return "中等景深";
}

export function normalizeFocus(value, fallback = "中等景深") {
  return pickOption(value, FOCUS_OPTIONS, fallback);
}

export function normalizeLight(value, fallback = DEFAULT_LIGHT) {
  const text = firstText(value);
  if (!text) return fallback;
  if (LIGHT_PRESETS.includes(text)) return text;

  const direction = textIncludesOption(text, LIGHT_AXES.direction) || fallback.split("·")[0] || "侧光";
  const quality = textIncludesOption(text, LIGHT_AXES.quality) || fallback.split("·")[1] || "柔光";
  const temperature = textIncludesOption(text, LIGHT_AXES.temperature) || fallback.split("·")[2] || "中性";
  const contrast = textIncludesOption(text, LIGHT_AXES.contrast) || fallback.split("·")[3] || "低反差";
  return [direction, quality, temperature, contrast].join("·");
}

export function normalizeComposition(value, fallback = DEFAULT_COMPOSITION) {
  const text = firstText(value);
  if (!text) return fallback;
  const found = [];
  for (const option of COMPOSITION_OPTIONS) {
    if (text.includes(option) && !found.includes(option)) found.push(option);
  }
  if (!found.length && COMPOSITION_OPTIONS.includes(text)) found.push(text);
  return found.length ? found.slice(0, 3).join("、") : fallback;
}

export function formatShotPlanEnumList(values) {
  return values.join(" / ");
}

export function formatCameraCompatGroups(groups = CAMERA_COMPAT_GROUPS) {
  return Object.entries(groups)
    .map(([key, values]) => `${key}: ${values.join(" / ")}`)
    .join("; ");
}
