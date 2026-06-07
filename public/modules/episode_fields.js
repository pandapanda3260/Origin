export const EPISODE_FIELDS = Object.freeze([
  "idea",
  "script",
  "scriptDraft",
  "scriptTargetDurationSec",
  "scriptApproved",
  "scriptReviewState",
  "assets",
  "assetsApproved",
  "shots",
  "shotsApproved",
  "storyboards",
  "imagesApproved",
  "videoPrompts",
  "videoPromptsApproved",
  "narrations",
  "emotionSegments",
  "currentStep",
]);

function cleanId(value) {
  var text = String(value == null ? "" : value).trim();
  if (!text || text.length > 200) return null;
  return text;
}

function finiteDuration(value) {
  var n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(60 * 60, Math.round(n));
}

export function createEmptyEpisode(input) {
  input = input && typeof input === "object" ? input : {};
  return {
    id: cleanId(input.id) || ("ep_" + Date.now()),
    title: String(input.title || "第 1 集").slice(0, 80),
    idea: "",
    script: "",
    scriptDraft: "",
    scriptTargetDurationSec: finiteDuration(input.scriptTargetDurationSec),
    scriptApproved: false,
    scriptReviewState: "",
    emotionSegments: null,
    assets: null,
    assetsApproved: false,
    shots: [],
    shotsApproved: false,
    storyboards: [],
    imagesApproved: false,
    videoPrompts: [],
    videoPromptsApproved: false,
    narrations: [],
    currentStep: 1,
  };
}

export function mirrorEpisodeFields(target, episode) {
  var out = target && typeof target === "object" ? { ...target } : {};
  EPISODE_FIELDS.forEach(function (field) {
    out[field] = episode && Object.prototype.hasOwnProperty.call(episode, field) ? episode[field] : null;
  });
  return out;
}
