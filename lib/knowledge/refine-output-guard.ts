export type ImmutableFactsSnapshot = {
  dialogueTexts: string[];
  timeRangeTitles: string[];
  imageNumbers: number[];
  characterNamesOrIds: string[];
  referenceLabels: string[];
};

export type RefineGuardMode = 'strict' | 'off';

export type RefineViolation = {
  type:
    | 'dialogue_missing'
    | 'time_range_changed'
    | 'image_number_changed'
    | 'character_identity_missing'
    | 'reference_label_missing';
  message: string;
  expected?: unknown;
  actual?: unknown;
};

export function normalizeRefineGuardMode(value: unknown): RefineGuardMode {
  const mode = String(value || '').trim();
  if (mode === 'off') return mode;
  return 'strict';
}

export function factsForRefineGuardMode(
  facts: ImmutableFactsSnapshot,
  mode: RefineGuardMode,
): ImmutableFactsSnapshot {
  if (mode === 'strict') return facts;
  return {
    dialogueTexts: [],
    timeRangeTitles: [],
    imageNumbers: [],
    characterNamesOrIds: [],
    referenceLabels: [],
  };
}

const CLOCK_TIME_RANGE_PATTERN = String.raw`\d+(?:\.\d+)?\s*秒\s*[（(]\s*\d+:\d{2}(?:\.\d+)?\s*[-–~]\s*\d+:\d{2}(?:\.\d+)?\s*[）)]`;
const LEGACY_TIME_RANGE_PATTERN = String.raw`\b\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*s\b`;
const CLOCK_TIME_RANGE_RE = new RegExp(CLOCK_TIME_RANGE_PATTERN, 'g');
const LEGACY_TIME_RANGE_RE = new RegExp(LEGACY_TIME_RANGE_PATTERN, 'g');
const CLOCK_TIME_RANGE_SINGLE_RE = new RegExp(CLOCK_TIME_RANGE_PATTERN);
const LEGACY_TIME_RANGE_SINGLE_RE = new RegExp(LEGACY_TIME_RANGE_PATTERN);
const IMAGE_RE = /\bImage\s*(\d+)\b/gi;
const ROLE_COLON_RE = /([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,20})[：:]/g;
const QUOTED_TEXT_RE = /[“"‘']([^“”"‘’'\n]{1,240})[”"’']/g;
const COMMON_LABELS = new Set([
  '当前提示词',
  '修改意图',
  '运镜系统',
  '计划时间段',
  '角色',
  '场景',
  '基调',
  '约束',
  '音障',
  '镜头',
  '景别',
  '运镜',
  '台词',
  '旁白',
  'duration',
  'Image',
]);

function uniqueStrings(values: unknown[], max = 80): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= max) break;
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function extractQuotedTexts(text: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  QUOTED_TEXT_RE.lastIndex = 0;
  while ((match = QUOTED_TEXT_RE.exec(text)) !== null) {
    const value = String(match[1] || '').trim();
    if (value && !isTimeRangeText(value) && !/\bImage\s*\d+\b/i.test(value)) out.push(value);
  }
  return uniqueStrings(out, 40);
}

function normalizeTimeRangeTitle(value: string): string {
  const text = String(value || '').trim();
  const clock = text.match(CLOCK_TIME_RANGE_SINGLE_RE);
  if (clock) {
    return clock[0]
      .replace(/\(/g, '（')
      .replace(/\)/g, '）')
      .replace(/[–~]/g, '-')
      .replace(/\s+/g, '');
  }
  const legacy = text.match(LEGACY_TIME_RANGE_SINGLE_RE);
  if (legacy) return legacy[0].replace(/\s+/g, '').replace(/[–~]/g, '-');
  return text;
}

function isTimeRangeText(value: string): boolean {
  return CLOCK_TIME_RANGE_SINGLE_RE.test(value) || LEGACY_TIME_RANGE_SINGLE_RE.test(value);
}

function extractDialogueLineTexts(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!/(台词|对白|开口|说道|说|沉声|低声|喊|问)[^：:]{0,20}[：:]/.test(line)) continue;
    const quoted = extractQuotedTexts(line);
    if (quoted.length) {
      out.push(...quoted);
      continue;
    }
    const idx = Math.max(line.lastIndexOf('：'), line.lastIndexOf(':'));
    const value = idx >= 0 ? line.slice(idx + 1).trim() : '';
    if (value && value.length <= 240) out.push(value);
  }
  return uniqueStrings(out, 40);
}

export function extractTimeRangeTitles(text: string): string[] {
  const value = String(text || '');
  const matches = [
    ...(value.match(CLOCK_TIME_RANGE_RE) || []),
    ...(value.match(LEGACY_TIME_RANGE_RE) || []),
  ];
  return uniqueStrings(matches.map(normalizeTimeRangeTitle), 80);
}

export function extractImageNumbers(text: string): number[] {
  const out: number[] = [];
  let match: RegExpExecArray | null;
  IMAGE_RE.lastIndex = 0;
  while ((match = IMAGE_RE.exec(String(text || ''))) !== null) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

export function normalizeDialogueText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”"‘’'「」『』]/g, '')
    .replace(/[：:]/g, '')
    .replace(/[\s，,。.!！?？、；;（）()[\]【】《》<>…·]/g, '')
    .trim();
}

function extractRoleNames(text: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  ROLE_COLON_RE.lastIndex = 0;
  while ((match = ROLE_COLON_RE.exec(String(text || ''))) !== null) {
    const name = String(match[1] || '').trim();
    if (!name || /^镜头\d*$/.test(name) || COMMON_LABELS.has(name)) continue;
    out.push(name);
  }
  return uniqueStrings(out, 40);
}

function normalizeReferenceManifest(value: unknown): Array<{ imageNo?: number; label?: string; assetId?: string; assetName?: string }> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as any[] : [];
}

function isPromptMatchedLockName(value: unknown, currentPrompt: string): boolean {
  const text = String(value || '').trim();
  return text.length >= 2 && currentPrompt.includes(text);
}

export function buildImmutableFactsSnapshot(input: {
  currentPrompt: string;
  project?: any;
  groupIdx?: number | null;
  referenceManifest?: unknown;
}): ImmutableFactsSnapshot {
  const currentPrompt = String(input.currentPrompt || '');
  const manifest = normalizeReferenceManifest(
    input.referenceManifest
    || input.project?.storyboards?.[Number(input.groupIdx)]?.videoReferenceManifest
    || [],
  );
  const storyboards = Array.isArray(input.project?.storyboards) ? input.project.storyboards : [];
  const sb = Number.isInteger(input.groupIdx) ? storyboards[Number(input.groupIdx)] : null;
  const shots = Array.isArray(input.project?.shots) ? input.project.shots : [];
  const shotIndices: number[] = Array.isArray(sb?.shotIndices)
    ? sb.shotIndices.filter((idx: any) => Number.isInteger(idx))
    : Number.isInteger(input.groupIdx)
      ? [Number(input.groupIdx)]
      : [];
  const shotCharacters = shotIndices.flatMap((idx) => (
    Array.isArray(shots[idx]?.characters) ? shots[idx].characters : []
  ));
  const lockNames = Array.isArray(input.project?.consistency?.characters)
    ? input.project.consistency.characters.flatMap((lock: any) => [
        lock?.characterId,
        lock?.canonicalName,
        ...(Array.isArray(lock?.aliases) ? lock.aliases : []),
      ])
    : [];
  return {
    dialogueTexts: uniqueStrings([
      ...extractDialogueLineTexts(currentPrompt),
      ...extractQuotedTexts(currentPrompt),
    ], 60),
    timeRangeTitles: extractTimeRangeTitles(currentPrompt),
    imageNumbers: uniqueStrings([
      ...extractImageNumbers(currentPrompt),
      ...manifest.map((item) => item.imageNo),
    ], 40).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    characterNamesOrIds: uniqueStrings([
      ...shotCharacters,
      ...lockNames.filter((name: any) => isPromptMatchedLockName(name, currentPrompt)),
      ...extractRoleNames(currentPrompt),
    ], 60),
    referenceLabels: uniqueStrings(manifest.flatMap((item) => [item.label, item.assetName, item.assetId]), 60),
  };
}

function sameOrderedArray(a: unknown[], b: unknown[]) {
  if (a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}

function sameNumberSet(a: number[], b: number[]) {
  const aa = [...new Set(a)].sort((x, y) => x - y);
  const bb = [...new Set(b)].sort((x, y) => x - y);
  return sameOrderedArray(aa, bb);
}

export function validateRefineOutput(input: {
  originalPrompt: string;
  refinedPrompt: string;
  facts: ImmutableFactsSnapshot;
}): { accepted: boolean; violations: RefineViolation[] } {
  const refined = String(input.refinedPrompt || '');
  const normalizedRefined = normalizeDialogueText(refined);
  const violations: RefineViolation[] = [];

  for (const dialogue of input.facts.dialogueTexts) {
    const normalized = normalizeDialogueText(dialogue);
    if (normalized && !normalizedRefined.includes(normalized)) {
      violations.push({
        type: 'dialogue_missing',
        message: `台词未被完整保留：${dialogue}`,
        expected: dialogue,
      });
    }
  }

  const nextTimeRanges = extractTimeRangeTitles(refined);
  if (input.facts.timeRangeTitles.length && !sameOrderedArray(input.facts.timeRangeTitles, nextTimeRanges)) {
    violations.push({
      type: 'time_range_changed',
      message: '时间段标题顺序或文本被改动',
      expected: input.facts.timeRangeTitles,
      actual: nextTimeRanges,
    });
  }

  const nextImageNumbers = extractImageNumbers(refined);
  if (input.facts.imageNumbers.length && !sameNumberSet(input.facts.imageNumbers, nextImageNumbers)) {
    violations.push({
      type: 'image_number_changed',
      message: '参考图 Image N 编号集合被改动',
      expected: input.facts.imageNumbers,
      actual: nextImageNumbers,
    });
  }

  for (const name of input.facts.characterNamesOrIds) {
    const normalized = normalizeDialogueText(name);
    if (normalized && !normalizedRefined.includes(normalized)) {
      violations.push({
        type: 'character_identity_missing',
        message: `角色/ID 未被保留：${name}`,
        expected: name,
      });
    }
  }

  for (const label of input.facts.referenceLabels) {
    if (label.length > 80) continue;
    const normalized = normalizeDialogueText(label);
    if (normalized && input.originalPrompt.includes(label) && !normalizedRefined.includes(normalized)) {
      violations.push({
        type: 'reference_label_missing',
        message: `参考图标签未被保留：${label}`,
        expected: label,
      });
    }
  }

  return { accepted: violations.length === 0, violations };
}

export function formatImmutableFactsForPrompt(facts: ImmutableFactsSnapshot): string {
  const lines = ['【本次必须逐字保留的事实】'];
  if (facts.timeRangeTitles.length) lines.push(`时间段标题（顺序不可变）：${facts.timeRangeTitles.join(' / ')}`);
  if (facts.dialogueTexts.length) {
    lines.push('台词原文（允许引号/冒号样式变化，但文字内容不可改）：');
    facts.dialogueTexts.slice(0, 40).forEach((text, idx) => lines.push(`${idx + 1}. ${text}`));
  }
  if (facts.imageNumbers.length) lines.push(`参考图编号集合：${facts.imageNumbers.map((n) => `Image ${n}`).join(', ')}`);
  if (facts.characterNamesOrIds.length) lines.push(`角色名/角色 ID：${facts.characterNamesOrIds.join('、')}`);
  if (facts.referenceLabels.length) lines.push(`参考图标签：${facts.referenceLabels.slice(0, 30).join('、')}`);
  return lines.join('\n');
}
