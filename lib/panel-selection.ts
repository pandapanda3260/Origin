import { resolveLocalImagePath } from './image-gen';
import {
  inferEntityTypeFromCharacter,
  resolveCharacterPanelPaths,
  type CharacterEntityType,
  type PanelName,
} from './character-panels';
import { isBlockingReferenceStatus, resolveAssetReferenceState } from './visual-reference-state';

export type ShotPanelIntent = 'face' | 'body' | 'profile' | 'back' | 'group';

export type CharacterReferencePanel = {
  assetId?: string;
  characterName: string;
  panel: PanelName | 'sheet';
  entityType?: CharacterEntityType;
  url?: string;
  path: string;
  intent: ShotPanelIntent;
  priority: number;
  reason: string;
  focusPair?: boolean;
};

type IntentHit = { intent: ShotPanelIntent; index: number; priority: number };
type ScoredCharacter = {
  character: any;
  name: string;
  score: number;
  firstMention: number;
};

const VISUAL_KEYWORDS: Array<{ intent: ShotPanelIntent; words: string[] }> = [
  { intent: 'face', words: ['大特写', '特写', '近景', '脸部', '面部', '表情', '眼神', '头像', '头部', 'close-up', 'closeup', 'face', 'facial', 'eyes'] },
  { intent: 'profile', words: ['侧脸', '侧面', '侧身', '侧头', '90度', 'profile', 'side view', 'sideways'] },
  { intent: 'back', words: ['背影', '背面', '背对', '转身', '背向', 'from behind', 'back view', 'rear view'] },
  { intent: 'group', words: ['群像', '合影', '多人', '所有角色', '全员', 'group shot', 'ensemble', 'crowd', 'all characters'] },
  { intent: 'body', words: ['全身', '中景', '全景', '远景', '动作', '奔跑', '行走', '跳', '打斗', 'full body', 'medium shot', 'wide shot', 'action', 'movement'] },
];

const SHOT_TYPE_KEYWORDS: Array<{ intent: ShotPanelIntent; words: string[] }> = [
  { intent: 'face', words: ['大特写', '特写', '近景', 'close-up', 'closeup', 'close shot', 'portrait'] },
  { intent: 'profile', words: ['侧面', '侧脸', 'profile', 'side'] },
  { intent: 'back', words: ['背面', '背影', 'back', 'behind'] },
  { intent: 'group', words: ['群像', '双人', '多人', 'group', 'two shot', 'ensemble'] },
  { intent: 'body', words: ['中景', '中近景', '全景', '远景', '大全景', 'medium', 'wide', 'long shot', 'full shot'] },
];

function normalizeText(value: any): string {
  return String(value || '').toLowerCase();
}

function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 5), index);
  return /不|没|別|别|未|无|非/.test(before);
}

function findIntentHits(text: string, rules: Array<{ intent: ShotPanelIntent; words: string[] }>, priority: number): IntentHit[] {
  const hits: IntentHit[] = [];
  for (const rule of rules) {
    for (const rawWord of rule.words) {
      const word = rawWord.toLowerCase();
      let offset = 0;
      while (offset < text.length) {
        const index = text.indexOf(word, offset);
        if (index < 0) break;
        if (!isNegated(text, index)) hits.push({ intent: rule.intent, index, priority });
        offset = index + Math.max(1, word.length);
      }
    }
  }
  return hits;
}

export function normalizeShotPanelIntent(shots: any[]): ShotPanelIntent {
  const safeShots = Array.isArray(shots) ? shots : [];
  const visualText = normalizeText(safeShots.map((shot) => [shot?.visual, shot?.camera, shot?.description].filter(Boolean).join(' ')).join(' '));
  const visualHits = findIntentHits(visualText, VISUAL_KEYWORDS, 3);
  if (visualHits.length) {
    visualHits.sort((a, b) => a.priority - b.priority || a.index - b.index);
    return visualHits[visualHits.length - 1].intent;
  }

  const shotTypeText = normalizeText(safeShots.map((shot) => [shot?.shotType, shot?.cameraType, shot?.composition].filter(Boolean).join(' ')).join(' '));
  const shotTypeHits = findIntentHits(shotTypeText, SHOT_TYPE_KEYWORDS, 2);
  if (shotTypeHits.length) {
    shotTypeHits.sort((a, b) => a.priority - b.priority || a.index - b.index);
    return shotTypeHits[shotTypeHits.length - 1].intent;
  }

  const characters = new Set<string>();
  for (const shot of safeShots) {
    if (!Array.isArray(shot?.characters)) continue;
    for (const name of shot.characters) {
      const normalized = normalizeCharacterName(name);
      if (normalized) characters.add(normalized);
    }
  }
  return characters.size >= 2 ? 'group' : 'body';
}

function normalizeCharacterName(value: any): string {
  return String(value || '').trim();
}

function characterDisplayName(ch: any): string {
  return normalizeCharacterName(ch?.name || ch?.role || ch?.id || ch?.label);
}

function characterAssetId(ch: any, fallbackName: string): string | undefined {
  const id = normalizeCharacterName(ch?.characterId || ch?.materialId || ch?.id || ch?.assetId);
  return id || fallbackName || undefined;
}

function collectCharacters(project: any): any[] {
  const all: any[] = [
    ...((project as any)?.assets?.characters || []),
    ...((project as any)?.characters || []),
  ];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const ch of all) {
    const name = characterDisplayName(ch);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ch);
  }
  return out;
}

function dialogueSpeakers(shot: any, knownNames: string[]): string[] {
  const dialogue = String(shot?.dialogue || shot?.dialog || '');
  const hits: string[] = [];
  for (const name of knownNames) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\n\\r\\s"'“”‘’「」『』。！？，、；;,.!?])${escaped}\\s*[：:]`);
    if (re.test(dialogue)) hits.push(name);
  }
  return hits;
}

function shotText(shot: any): string {
  return String([
    shot?.visual,
    shot?.description,
    shot?.camera,
    shot?.shotType,
    shot?.cameraType,
    shot?.composition,
    shot?.focus,
  ].filter(Boolean).join(' '));
}

function shotContainsCharacter(shot: any, name: string): boolean {
  const normalized = normalizeCharacterName(name).toLowerCase();
  if (!normalized) return false;
  if (Array.isArray(shot?.characters)) {
    if (shot.characters.some((item: any) => normalizeCharacterName(item).toLowerCase() === normalized)) return true;
  }
  return shotText(shot).toLowerCase().includes(normalized);
}

function isPrimaryShotCharacter(shot: any, name: string): boolean {
  const normalized = normalizeCharacterName(name).toLowerCase();
  const firstCharacter = Array.isArray(shot?.characters) ? normalizeCharacterName(shot.characters[0]).toLowerCase() : '';
  if (firstCharacter && firstCharacter === normalized) return true;
  return dialogueSpeakers(shot, [name]).some((speaker) => speaker.toLowerCase() === normalized);
}

function closeUpStrengthForCharacter(shots: any[], name: string): number {
  let best = 0;
  for (const shot of shots) {
    if (!shotContainsCharacter(shot, name)) continue;
    const raw = shotText(shot).toLowerCase();
    const withoutWeak = raw.replace(/中近景/g, '').replace(/半身/g, '');
    if (/大特写|特写|近景|脸部|面部|表情|眼神|头像|头部|close-up|closeup|close shot|portrait|face|facial|eyes/.test(withoutWeak)) {
      best = Math.max(best, 2);
    } else if (/中近景|半身/.test(raw) && isPrimaryShotCharacter(shot, name)) {
      best = Math.max(best, 1);
    }
  }
  return best;
}

function scoreCharacters(shots: any[], characters: any[]): ScoredCharacter[] {
  const knownNames = characters.map(characterDisplayName).filter(Boolean);
  const byName = new Map<string, ScoredCharacter>();
  characters.forEach((character, i) => {
    const name = characterDisplayName(character);
    byName.set(name.toLowerCase(), { character, name, score: 0, firstMention: 10_000 + i });
  });

  shots.forEach((shot, shotIndex) => {
    const shotChars: string[] = Array.isArray(shot?.characters)
      ? shot.characters.map(normalizeCharacterName).filter(Boolean)
      : [];
    shotChars.forEach((name, order) => {
      const hit = byName.get(name.toLowerCase());
      if (!hit) return;
      hit.score += order === 0 ? 3 : 2;
      hit.firstMention = Math.min(hit.firstMention, shotIndex * 100 + order);
    });

    const visual = String([shot?.visual, shot?.description, shot?.camera].filter(Boolean).join(' '));
    knownNames.forEach((name) => {
      const index = visual.indexOf(name);
      if (index < 0) return;
      const hit = byName.get(name.toLowerCase());
      if (!hit) return;
      hit.score += 4;
      hit.firstMention = Math.min(hit.firstMention, shotIndex * 100 + index);
    });

    for (const name of dialogueSpeakers(shot, knownNames)) {
      const hit = byName.get(name.toLowerCase());
      if (!hit) continue;
      hit.score += 5;
      hit.firstMention = Math.min(hit.firstMention, shotIndex * 100 - 1);
    }
  });

  const scored = [...byName.values()].filter((item) => item.score > 0);
  if (!scored.length && characters.length === 1) {
    const ch = characters[0];
    scored.push({ character: ch, name: characterDisplayName(ch), score: 1, firstMention: 0 });
  }
  scored.sort((a, b) => b.score - a.score || a.firstMention - b.firstMention || a.name.localeCompare(b.name));
  return scored;
}

function slotAllocation(characterCount: number, intent: ShotPanelIntent, maxSlots: number): number[] {
  if (characterCount <= 0 || maxSlots <= 0) return [];
  if (characterCount === 1) return [Math.min(maxSlots, intent === 'face' ? 2 : 3)];
  if (characterCount === 2) return [Math.min(2, maxSlots), Math.max(0, Math.min(2, maxSlots - 2))];
  if (characterCount === 3) return [Math.min(2, maxSlots), maxSlots >= 3 ? 1 : 0, maxSlots >= 4 ? 1 : 0];
  return Array.from({ length: Math.min(characterCount, maxSlots) }, () => 1);
}

function frameSlotAllocation(characterCount: number, intent: ShotPanelIntent, maxSlots: number): number[] {
  if (characterCount <= 0 || maxSlots <= 0) return [];
  if (characterCount === 1) return [Math.min(maxSlots, intent === 'face' ? 3 : 3)];
  if (characterCount === 2) return [Math.min(3, maxSlots), Math.max(0, Math.min(2, maxSlots - 3))];
  if (characterCount === 3) return [Math.min(3, maxSlots), maxSlots >= 4 ? 1 : 0, maxSlots >= 5 ? 1 : 0];
  return Array.from({ length: Math.min(characterCount, maxSlots) }, (_, index) => (index === 0 ? Math.min(3, maxSlots) : 1));
}

function panelsForIntent(intent: ShotPanelIntent, entityType: CharacterEntityType): PanelName[] {
  if (entityType === 'non-human') {
    if (intent === 'profile') return ['side', 'front', 'back'];
    if (intent === 'back') return ['back', 'side', 'front'];
    return ['front', 'side', 'back'];
  }
  if (intent === 'face') return ['headshot', 'front', 'side', 'back'];
  if (intent === 'profile') return ['side', 'headshot', 'front', 'back'];
  if (intent === 'back') return ['back', 'side', 'front', 'headshot'];
  return ['front', 'side', 'back', 'headshot'];
}

function framePanelsForIntent(intent: ShotPanelIntent, entityType: CharacterEntityType): Array<PanelName | 'sheet'> {
  if (entityType === 'non-human') {
    if (intent === 'profile') return ['sheet', 'side', 'front', 'back'];
    if (intent === 'back') return ['sheet', 'back', 'side', 'front'];
    return ['sheet', 'front', 'side', 'back'];
  }
  if (intent === 'face') return ['sheet', 'headshot', 'front', 'side', 'back'];
  if (intent === 'profile') return ['sheet', 'side', 'headshot', 'front', 'back'];
  if (intent === 'back') return ['sheet', 'back', 'side', 'front', 'headshot'];
  if (intent === 'group') return ['sheet', 'front', 'headshot', 'side', 'back'];
  return ['sheet', 'front', 'side', 'back', 'headshot'];
}

function fallbackSheetPath(character: any, ownerId: number): string | undefined {
  const reference = resolveAssetReferenceState(character);
  if (isBlockingReferenceStatus(reference.status)) return undefined;
  const url = reference.currentUrl || reference.lastKnownGoodUrl || character?.realPhotoUrl || character?.pencilUrl;
  return resolveLocalImagePath(url, ownerId) || undefined;
}

function fallbackSheetUrl(character: any): string {
  const reference = resolveAssetReferenceState(character);
  if (isBlockingReferenceStatus(reference.status)) return '';
  return String(
    reference.currentUrl ||
      reference.lastKnownGoodUrl ||
      character?.rawUrl ||
      character?.imageUrl ||
      character?.realPhotoUrl ||
      character?.pencilUrl ||
      '',
  ).trim();
}

function panelUrlForPath(character: any, panel: PanelName | 'sheet', path: string, ownerId: number): string {
  const panels = character?.panels || {};
  const key = panel === 'sheet' ? 'sheetUrl' : `${panel}Url`;
  const urls = [
    panels?.[key],
    panel === 'sheet' ? fallbackSheetUrl(character) : '',
  ].filter(Boolean);
  for (const url of urls) {
    if (resolveLocalImagePath(url, ownerId) === path) return String(url);
  }
  return String(urls[0] || '');
}

function selectFocusPairNames(
  scored: ScoredCharacter[],
  shots: any[],
  ownerId: number,
): Set<string> {
  const eligible = scored
    .map((item) => {
      const reference = resolveAssetReferenceState(item.character);
      if (isBlockingReferenceStatus(reference.status)) return null;
      if (inferEntityTypeFromCharacter(item.character) !== 'human') return null;
      const paths = resolveCharacterPanelPaths(item.character?.panels, ownerId);
      if (!paths.sheet || !paths.headshot) return null;
      const closeUpStrength = closeUpStrengthForCharacter(shots, item.name);
      if (closeUpStrength <= 0) return null;
      return { item, closeUpStrength };
    })
    .filter(Boolean) as Array<{ item: ScoredCharacter; closeUpStrength: number }>;

  eligible.sort((a, b) =>
    (b.closeUpStrength - a.closeUpStrength) ||
    (b.item.score - a.item.score) ||
    (a.item.firstMention - b.item.firstMention)
  );

  const selected = new Set<string>();
  if (!eligible.length) return selected;
  selected.add(eligible[0].item.name.toLowerCase());
  const topScore = Math.max(1, eligible[0].item.score);
  const second = eligible[1];
  if (second && second.item.score >= topScore * 0.8 && second.closeUpStrength >= eligible[0].closeUpStrength) {
    selected.add(second.item.name.toLowerCase());
  }
  return selected;
}

export function selectCharacterReferencePanels(opts: {
  project: any;
  ownerId: number;
  groupShotIndices?: number[];
  shots?: any[];
  maxSlots?: number;
  perCharacterLimit?: number;
  enableFocusCharacterPair?: boolean;
  mode?: 'video' | 'frame';
}): CharacterReferencePanel[] {
  const maxSlots = Math.max(0, Math.min(9, Number(opts.maxSlots ?? 4)));
  if (!maxSlots) return [];
  const perCharacterLimit = Number.isFinite(Number(opts.perCharacterLimit))
    ? Math.max(1, Math.floor(Number(opts.perCharacterLimit)))
    : null;

  const allShots = Array.isArray(opts.project?.shots) ? opts.project.shots : [];
  const shots = Array.isArray(opts.shots)
    ? opts.shots
    : (opts.groupShotIndices || []).map((idx) => allShots[idx]).filter(Boolean);
  const characters = collectCharacters(opts.project);
  const scored = scoreCharacters(shots, characters).slice(0, maxSlots);
  if (!scored.length) return [];

  const intent = normalizeShotPanelIntent(shots);
  const frameMode = opts.mode === 'frame';
  const focusPairNames = opts.enableFocusCharacterPair
    ? selectFocusPairNames(scored, shots, opts.ownerId)
    : new Set<string>();
  const panelBudget = Math.min(9, maxSlots + focusPairNames.size);
  const allocations = (frameMode ? frameSlotAllocation(scored.length, intent, maxSlots) : slotAllocation(scored.length, intent, maxSlots)).map((slots) =>
    perCharacterLimit == null ? slots : Math.min(slots, perCharacterLimit),
  );
  const selected: CharacterReferencePanel[] = [];

  for (let i = 0; i < scored.length && selected.length < panelBudget; i++) {
    const item = scored[i];
    const focusPair = focusPairNames.has(item.name.toLowerCase());
    const slots = focusPair ? Math.max(2, allocations[i] || 0) : (allocations[i] || 0);
    if (!slots) continue;
    const reference = resolveAssetReferenceState(item.character);
    if (isBlockingReferenceStatus(reference.status)) continue;

    const entityType = inferEntityTypeFromCharacter(item.character);
    const paths = resolveCharacterPanelPaths(item.character?.panels, opts.ownerId);
    const wantedPanels: Array<PanelName | 'sheet'> = frameMode
      ? framePanelsForIntent(intent, entityType)
      : focusPair
        ? ['sheet', 'headshot', ...panelsForIntent(intent, entityType).filter((panel) => panel !== 'headshot')]
        : panelsForIntent(intent, entityType);
    let addedForCharacter = 0;

    for (const panel of wantedPanels) {
      if (addedForCharacter >= slots || selected.length >= panelBudget) break;
      const path = paths[panel];
      if (!path) continue;
      selected.push({
        assetId: characterAssetId(item.character, item.name),
        characterName: item.name,
        panel,
        entityType,
        url: panelUrlForPath(item.character, panel, path, opts.ownerId),
        path,
        intent,
        priority: item.score,
        reason: frameMode ? `frame:${intent}:${panel}` : focusPair ? `focus-pair:${intent}:${panel}` : `${intent}:${panel}`,
        focusPair,
      });
      addedForCharacter++;
    }

    if (!addedForCharacter && selected.length < panelBudget) {
      const path = paths.sheet || fallbackSheetPath(item.character, opts.ownerId);
      if (!path) continue;
      selected.push({
        assetId: characterAssetId(item.character, item.name),
        characterName: item.name,
        panel: 'sheet',
        entityType,
        url: panelUrlForPath(item.character, 'sheet', path, opts.ownerId),
        path,
        intent,
        priority: item.score,
        reason: frameMode ? `frame:${intent}:sheet-fallback` : `${intent}:sheet-fallback`,
        focusPair: false,
      });
    }
  }

  return selected;
}
