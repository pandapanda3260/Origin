import { createHash } from 'node:crypto';

export type CharacterLockStatus = 'draft' | 'locked' | 'needs_review';
export type CharacterEntityType = 'human' | 'non-human';
export type VersionKey =
  | 'identityVersion'
  | 'visualVersion'
  | 'performanceVersion'
  | 'voiceVersion'
  | 'resolverVersion'
  | 'referenceVersion';

export type CharacterVersions = Record<VersionKey, number>;

export type CharacterIdentityLock = {
  role: string;
  identity: string;
  entityType: CharacterEntityType;
  species?: string;
  gender?: string;
  ageBand?: string;
};

export type CharacterVisualLock = {
  appearance: string;
  clothing: string;
  equipment: string;
  scaleRule?: string;
  negativeRules: string[];
  signatureColors?: string[];
  canonicalPrompt: string;
  visualSignatureHash: string;
};

export type CharacterPerformanceLock = {
  temperament: string;
  actionTraits: string;
  gestureRules: string[];
  performanceSignatureHash: string;
};

export type CharacterVoiceLock = {
  voiceGender?: string;
  voiceAge?: string;
  timbre?: string;
  speechStyle?: string;
  accent?: string;
  confidence: number;
  negativeRules: string[];
  voiceSignatureHash: string;
};

export type CharacterReferenceStatus = 'missing' | 'ready' | 'degraded' | 'failed';

export type CharacterReferenceLock = {
  sheetUrl?: string;
  headshotUrl?: string;
  frontUrl?: string;
  sideUrl?: string;
  backUrl?: string;
  sourceImageId?: string;
  referenceStatus: CharacterReferenceStatus;
  qualityScore?: number;
};

export type CharacterLock = {
  characterId: string;
  sourceAssetId?: string;
  canonicalName: string;
  aliases: string[];
  versions: CharacterVersions;
  status: CharacterLockStatus;
  identityLock: CharacterIdentityLock;
  visualLock: CharacterVisualLock;
  performanceLock: CharacterPerformanceLock;
  voiceLock: CharacterVoiceLock;
  referenceLock: CharacterReferenceLock;
};

export type ProjectConsistencyMeta = {
  needsRoleSync: boolean;
  roleSyncReasons: string[];
  resolverCaseVersion: number;
  lastDiagnosisRunId?: string;
};

export type ProjectConsistency = {
  schema: 'origin-consistency-v1';
  updatedAt: string;
  meta: ProjectConsistencyMeta;
  characters: CharacterLock[];
};

export type CharacterLockPatch = {
  sourceAssetId?: string;
  canonicalName?: string;
  aliases?: string[];
  identityLock?: Partial<CharacterIdentityLock>;
  visualLock?: Partial<Omit<CharacterVisualLock, 'visualSignatureHash'>>;
  performanceLock?: Partial<Omit<CharacterPerformanceLock, 'performanceSignatureHash'>>;
  voiceLock?: Partial<Omit<CharacterVoiceLock, 'voiceSignatureHash'>>;
  referenceLock?: Partial<CharacterReferenceLock>;
  status?: CharacterLockStatus;
};

export type MutateCharacterLockContext = {
  source:
    | 'asset_extract'
    | 'asset_edit'
    | 'asset_image'
    | 'panel_split'
    | 'user_upload'
    | 'resolver_update'
    | 'migration'
    | 'user_confirm'
    | 'world_template'
    | 'world_backfill'
    | 'world_edit'
    | 'system';
  now?: string;
  userConfirmed?: boolean;
};

export type VersionBumps = Partial<Record<VersionKey, { from: number; to: number }>>;

export type CharacterDiff = {
  identityChanged: boolean;
  visualChanged: boolean;
  performanceChanged: boolean;
  voiceChanged: boolean;
  resolverChanged: boolean;
  referenceChanged: boolean;
  changedPaths: string[];
};

export type StatusTransition = {
  from: CharacterLockStatus;
  to: CharacterLockStatus;
  reason: string;
};

export type CharacterStaleHint = {
  characterId: string;
  dimension: VersionKey;
  reason: string;
};

export type MutateCharacterLockResult<TProject extends Record<string, any> = Record<string, any>> = {
  project: TProject & { consistency: ProjectConsistency };
  character: CharacterLock;
  characterDiff: CharacterDiff;
  versionBumps: VersionBumps;
  statusTransition?: StatusTransition;
  staleHints: CharacterStaleHint[];
};

export type SyncWorldCharactersResult<TProject extends Record<string, any> = Record<string, any>> = {
  project: TProject & { consistency: ProjectConsistency };
  changed: boolean;
  syncedCharacterIds: string[];
  conflictReasons: string[];
};

const SCHEMA: ProjectConsistency['schema'] = 'origin-consistency-v1';
export const READY_QUALITY_THRESHOLD = 0.65;

const DEFAULT_META: ProjectConsistencyMeta = {
  needsRoleSync: false,
  roleSyncReasons: [],
  resolverCaseVersion: 1,
};

const DEFAULT_VERSIONS: CharacterVersions = {
  identityVersion: 1,
  visualVersion: 1,
  performanceVersion: 1,
  voiceVersion: 1,
  resolverVersion: 1,
  referenceVersion: 1,
};

function nowIso(input?: string) {
  return input || new Date().toISOString();
}

function cleanText(value: any): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanEnglishToken(value: any): string {
  return cleanText(value).toLowerCase();
}

function cleanList(value: any): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[，,、/]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const s = cleanText(item);
    if (!s) continue;
    const key = cleanEnglishToken(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => cleanEnglishToken(a).localeCompare(cleanEnglishToken(b)));
}

function stableCanonical(value: any): any {
  if (Array.isArray(value)) return cleanList(value).map(stableCanonical);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined || v === null || v === '') continue;
      out[key] = stableCanonical(v);
    }
    return out;
  }
  if (typeof value === 'string') return cleanText(value);
  return value;
}

function stableHash(value: any): string {
  const canonical = JSON.stringify(stableCanonical(value));
  return createHash('sha256').update(canonical).digest('hex');
}

function hashVisual(lock: Omit<CharacterVisualLock, 'visualSignatureHash'>): string {
  return stableHash({
    appearance: lock.appearance,
    clothing: lock.clothing,
    equipment: lock.equipment,
    scaleRule: lock.scaleRule,
    signatureColors: lock.signatureColors,
    negativeRules: lock.negativeRules,
  });
}

function hashPerformance(lock: Omit<CharacterPerformanceLock, 'performanceSignatureHash'>): string {
  return stableHash({
    temperament: lock.temperament,
    actionTraits: lock.actionTraits,
    gestureRules: lock.gestureRules,
  });
}

function hashVoice(lock: Omit<CharacterVoiceLock, 'voiceSignatureHash'>): string {
  return stableHash({
    voiceGender: lock.voiceGender,
    voiceAge: lock.voiceAge,
    timbre: lock.timbre,
    speechStyle: lock.speechStyle,
    accent: lock.accent,
    negativeRules: lock.negativeRules,
  });
}

function inferEntityType(asset: any): CharacterEntityType {
  return asset?.entityType === 'non-human' ? 'non-human' : 'human';
}

function inferSpecies(asset: any): string | undefined {
  const explicit = cleanText(asset?.species);
  if (explicit) return explicit;
  const text = [asset?.name, asset?.identity, asset?.appearance, asset?.imagePrompt].map(cleanText).join(' ');
  const hits: Array<[RegExp, string]> = [
    [/帝王蟹|螃蟹|蟹|crab/i, 'crab'],
    [/龙虾|lobster/i, 'lobster'],
    [/生蚝|牡蛎|oyster/i, 'oyster'],
    [/扇贝|scallop/i, 'scallop'],
    [/三文鱼|salmon/i, 'salmon'],
    [/虾|shrimp/i, 'shrimp'],
    [/章鱼|octopus/i, 'octopus'],
    [/机甲|mech|robot/i, 'mech'],
  ];
  for (const [re, species] of hits) {
    if (re.test(text)) return species;
  }
  return undefined;
}

function defaultNegativeRules(entityType: CharacterEntityType): string[] {
  return entityType === 'non-human'
    ? [
        'do not turn into a human',
        'preserve actual species anatomy',
        'no human face or human body replacement',
        'keep realistic scale',
      ]
    : [
        'keep same face identity',
        'keep same wardrobe unless explicitly changed',
        'no age or body-type drift',
      ];
}

function buildCanonicalPrompt(lock: {
  canonicalName: string;
  identityLock: CharacterIdentityLock;
  visualLock: Pick<CharacterVisualLock, 'appearance' | 'clothing' | 'equipment' | 'scaleRule' | 'negativeRules'>;
}): string {
  const parts = [
    `Character: ${lock.canonicalName}`,
    `Identity: ${lock.identityLock.role}; ${lock.identityLock.identity}`,
    `Entity type: ${lock.identityLock.entityType}${lock.identityLock.species ? `; species: ${lock.identityLock.species}` : ''}`,
    `Appearance: ${lock.visualLock.appearance}`,
    lock.visualLock.clothing ? `Clothing: ${lock.visualLock.clothing}` : '',
    lock.visualLock.equipment ? `Equipment: ${lock.visualLock.equipment}` : '',
    lock.visualLock.scaleRule ? `Scale: ${lock.visualLock.scaleRule}` : '',
    lock.visualLock.negativeRules.length ? `Negative rules: ${lock.visualLock.negativeRules.join('; ')}` : '',
  ];
  return parts.map(cleanText).filter(Boolean).join('\n');
}

export function deriveVoiceLock(input: {
  entityType?: CharacterEntityType;
  species?: string;
  gender?: string;
  ageBand?: string;
  role?: string;
  identity?: string;
  temperament?: string;
}): Omit<CharacterVoiceLock, 'voiceSignatureHash'> {
  const entityType = input.entityType || 'human';
  const species = cleanEnglishToken(input.species);
  const temperament = cleanText(input.temperament);
  const gender = cleanText(input.gender);
  const ageBand = cleanText(input.ageBand);
  let voiceGender = gender || 'neutral';
  let voiceAge = ageBand || 'adult';
  let timbre = 'clear';
  let speechStyle = 'calm';
  let accent = 'standard Mandarin';
  let confidence = 0.5;

  if (/男|male|man/.test(gender)) voiceGender = 'male';
  if (/女|female|woman/.test(gender)) voiceGender = 'female';
  if (/老|elder|senior|50|60/.test(ageBand + ' ' + input.identity)) voiceAge = 'older adult';
  if (/青年|young|20|30/.test(ageBand + ' ' + input.identity)) voiceAge = 'young adult';
  if (/威严|队长|老板|leader|boss|captain/.test(temperament + ' ' + input.role + ' ' + input.identity)) {
    timbre = 'firm';
    speechStyle = 'authoritative';
    confidence = 0.7;
  }
  if (/怯|紧张|实习|intern|timid/.test(temperament + ' ' + input.identity)) {
    timbre = 'light';
    speechStyle = 'hesitant';
    confidence = 0.7;
  }

  if (entityType === 'non-human') {
    confidence = Math.max(confidence, 0.75);
    if (/crab|lobster|shrimp/.test(species)) {
      voiceGender = voiceGender === 'neutral' ? 'male' : voiceGender;
      voiceAge = voiceAge || 'adult';
      timbre = 'low and coarse';
      speechStyle = 'shell-creature textured';
    } else if (/oyster|scallop/.test(species)) {
      timbre = 'thin and soft';
      speechStyle = 'hesitant, small creature';
    } else if (/salmon/.test(species)) {
      timbre = 'smooth';
      speechStyle = 'quick and alert';
    } else if (/mech|robot/.test(species)) {
      timbre = 'metallic';
      speechStyle = 'precise';
    } else {
      timbre = 'slightly creature-like';
      speechStyle = 'non-human but intelligible';
    }
  }

  return {
    voiceGender,
    voiceAge,
    timbre,
    speechStyle,
    accent,
    confidence,
    negativeRules: ['do not change voice identity across segments', 'do not read speaker names aloud'],
  };
}

function normalizeIdentityLock(input: Partial<CharacterIdentityLock> | undefined, fallback: CharacterIdentityLock): CharacterIdentityLock {
  const entityType = input?.entityType === 'non-human' ? 'non-human' : input?.entityType === 'human' ? 'human' : fallback.entityType;
  return {
    role: cleanText(input?.role ?? fallback.role),
    identity: cleanText(input?.identity ?? fallback.identity),
    entityType,
    species: cleanText(input?.species ?? fallback.species) || undefined,
    gender: cleanText(input?.gender ?? fallback.gender) || undefined,
    ageBand: cleanText(input?.ageBand ?? fallback.ageBand) || undefined,
  };
}

function normalizeVisualLock(input: Partial<Omit<CharacterVisualLock, 'visualSignatureHash'>> | undefined, fallback: CharacterVisualLock, ctx: { canonicalName: string; identityLock: CharacterIdentityLock }): CharacterVisualLock {
  const base = {
    appearance: cleanText(input?.appearance ?? fallback.appearance),
    clothing: cleanText(input?.clothing ?? fallback.clothing),
    equipment: cleanText(input?.equipment ?? fallback.equipment),
    scaleRule: cleanText(input?.scaleRule ?? fallback.scaleRule) || undefined,
    negativeRules: input?.negativeRules ? cleanList(input.negativeRules) : cleanList(fallback.negativeRules),
    signatureColors: input?.signatureColors ? cleanList(input.signatureColors) : cleanList(fallback.signatureColors),
    canonicalPrompt: '',
  };
  const canonicalPromptInput = input?.canonicalPrompt ? cleanText(input.canonicalPrompt) : '';
  base.canonicalPrompt = canonicalPromptInput || buildCanonicalPrompt({ ...ctx, visualLock: base });
  return { ...base, visualSignatureHash: hashVisual(base) };
}

function normalizePerformanceLock(input: Partial<Omit<CharacterPerformanceLock, 'performanceSignatureHash'>> | undefined, fallback: CharacterPerformanceLock): CharacterPerformanceLock {
  const base = {
    temperament: cleanText(input?.temperament ?? fallback.temperament),
    actionTraits: cleanText(input?.actionTraits ?? fallback.actionTraits),
    gestureRules: input?.gestureRules ? cleanList(input.gestureRules) : cleanList(fallback.gestureRules),
  };
  return { ...base, performanceSignatureHash: hashPerformance(base) };
}

function normalizeVoiceLock(input: Partial<Omit<CharacterVoiceLock, 'voiceSignatureHash'>> | undefined, fallback: CharacterVoiceLock): CharacterVoiceLock {
  const base = {
    voiceGender: cleanText(input?.voiceGender ?? fallback.voiceGender) || undefined,
    voiceAge: cleanText(input?.voiceAge ?? fallback.voiceAge) || undefined,
    timbre: cleanText(input?.timbre ?? fallback.timbre) || undefined,
    speechStyle: cleanText(input?.speechStyle ?? fallback.speechStyle) || undefined,
    accent: cleanText(input?.accent ?? fallback.accent) || undefined,
    confidence: Number.isFinite(Number(input?.confidence)) ? Number(input?.confidence) : fallback.confidence,
    negativeRules: input?.negativeRules ? cleanList(input.negativeRules) : cleanList(fallback.negativeRules),
  };
  return { ...base, voiceSignatureHash: hashVoice(base) };
}

function referenceQualityBucket(lock: CharacterReferenceLock): CharacterReferenceStatus {
  if (lock.referenceStatus === 'missing') return 'missing';
  if (lock.referenceStatus === 'failed') return 'failed';
  if (typeof lock.qualityScore === 'number' && lock.qualityScore < READY_QUALITY_THRESHOLD) return 'degraded';
  return lock.referenceStatus === 'degraded' ? 'degraded' : 'ready';
}

function normalizeReferenceLock(input: Partial<CharacterReferenceLock> | undefined, fallback: CharacterReferenceLock): CharacterReferenceLock {
  const replaceWithSheetOnlyDegraded = !!(
    input &&
    input.referenceStatus === 'degraded' &&
    cleanText(input.sheetUrl) &&
    !cleanText(input.headshotUrl) &&
    !cleanText(input.frontUrl) &&
    !cleanText(input.sideUrl) &&
    !cleanText(input.backUrl)
  );
  const next: CharacterReferenceLock = {
    sheetUrl: cleanText(input?.sheetUrl ?? fallback.sheetUrl) || undefined,
    headshotUrl: replaceWithSheetOnlyDegraded ? undefined : cleanText(input?.headshotUrl ?? fallback.headshotUrl) || undefined,
    frontUrl: replaceWithSheetOnlyDegraded ? undefined : cleanText(input?.frontUrl ?? fallback.frontUrl) || undefined,
    sideUrl: replaceWithSheetOnlyDegraded ? undefined : cleanText(input?.sideUrl ?? fallback.sideUrl) || undefined,
    backUrl: replaceWithSheetOnlyDegraded ? undefined : cleanText(input?.backUrl ?? fallback.backUrl) || undefined,
    sourceImageId: cleanText(input?.sourceImageId ?? (replaceWithSheetOnlyDegraded ? undefined : fallback.sourceImageId)) || undefined,
    referenceStatus: input?.referenceStatus || fallback.referenceStatus || 'missing',
    qualityScore: replaceWithSheetOnlyDegraded && !Number.isFinite(Number(input?.qualityScore))
      ? undefined
      : Number.isFinite(Number(input?.qualityScore)) ? Number(input?.qualityScore) : fallback.qualityScore,
  };
  const hasAnyRef = !!(next.sheetUrl || next.headshotUrl || next.frontUrl || next.sideUrl || next.backUrl || next.sourceImageId);
  if (!hasAnyRef) next.referenceStatus = next.referenceStatus === 'failed' ? 'failed' : 'missing';
  else if (next.referenceStatus === 'missing') next.referenceStatus = 'ready';
  else next.referenceStatus = referenceQualityBucket(next);
  return next;
}

function defaultIdentityFromAsset(asset: any): CharacterIdentityLock {
  const entityType = inferEntityType(asset);
  return {
    role: cleanText(asset?.role || asset?.intro || ''),
    identity: cleanText(asset?.identity || asset?.intro || ''),
    entityType,
    species: entityType === 'non-human' ? inferSpecies(asset) : undefined,
    gender: cleanText(asset?.gender) || undefined,
    ageBand: cleanText(asset?.ageBand || asset?.age || '') || undefined,
  };
}

function defaultLockFromAsset(asset: any, context: MutateCharacterLockContext): CharacterLock {
  const canonicalName = cleanText(asset?.name || asset?.role || asset?.id || 'Unnamed Character');
  const identityLock = defaultIdentityFromAsset(asset);
  const visualFallback = {
    appearance: cleanText(asset?.appearance || asset?.detail || asset?.description || asset?.intro || ''),
    clothing: cleanText(asset?.clothing || ''),
    equipment: cleanText(asset?.equipment || ''),
    scaleRule: cleanText(asset?.scaleRule || '') || undefined,
    negativeRules: cleanList(asset?.negativeRules || defaultNegativeRules(identityLock.entityType)),
    signatureColors: cleanList(asset?.signatureColors || []),
    canonicalPrompt: '',
    visualSignatureHash: '',
  };
  const performanceFallback = {
    temperament: cleanText(asset?.temperament || ''),
    actionTraits: cleanText(asset?.actionTraits || ''),
    gestureRules: cleanList(asset?.gestureRules || []),
    performanceSignatureHash: '',
  };
  const voice = deriveVoiceLock({
    entityType: identityLock.entityType,
    species: identityLock.species,
    gender: identityLock.gender,
    ageBand: identityLock.ageBand,
    role: identityLock.role,
    identity: identityLock.identity,
    temperament: performanceFallback.temperament,
  });
  const referenceLock = normalizeReferenceLock({
    sheetUrl: asset?.panels?.sheetUrl || asset?.imageUrl || asset?.rawUrl || asset?.realPhotoUrl || asset?.pencilUrl,
    headshotUrl: asset?.panels?.headshotUrl,
    frontUrl: asset?.panels?.frontUrl,
    sideUrl: asset?.panels?.sideUrl,
    backUrl: asset?.panels?.backUrl,
    sourceImageId: asset?.panels?.sourceImageId,
    referenceStatus: asset?.imageUrl || asset?.rawUrl ? 'ready' : 'missing',
    qualityScore: asset?.panels?.confidence,
  }, { referenceStatus: 'missing' });
  const lock: CharacterLock = {
    characterId: cleanText(asset?.characterId || asset?.id) || stableCharacterId(asset),
    sourceAssetId: cleanText(asset?.id) || undefined,
    canonicalName,
    aliases: cleanList([canonicalName, asset?.role, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])]),
    versions: { ...DEFAULT_VERSIONS },
    status: context.source === 'migration' ? 'needs_review' : 'draft',
    identityLock,
    visualLock: normalizeVisualLock(visualFallback, { ...visualFallback, visualSignatureHash: '' }, { canonicalName, identityLock }),
    performanceLock: normalizePerformanceLock(performanceFallback, { ...performanceFallback, performanceSignatureHash: '' }),
    voiceLock: normalizeVoiceLock(voice, { ...voice, voiceSignatureHash: '' }),
    referenceLock,
  };
  return lock;
}

function stableCharacterId(asset: any): string {
  const seed = [
    asset?.id,
    asset?.name,
    asset?.role,
    asset?.identity,
    asset?.appearance,
  ].map(cleanText).filter(Boolean).join('|') || 'character';
  return `char_${stableHash(seed).slice(0, 16)}`;
}

function defaultConsistency(now: string): ProjectConsistency {
  return {
    schema: SCHEMA,
    updatedAt: now,
    meta: { ...DEFAULT_META },
    characters: [],
  };
}

export function ensureProjectConsistency<TProject extends Record<string, any>>(
  project: TProject,
  context: MutateCharacterLockContext = { source: 'migration' },
): TProject & { consistency: ProjectConsistency } {
  const now = nowIso(context.now);
  const existing = project?.consistency;
  const hasExistingConsistency = existing && existing.schema === SCHEMA;
  const consistency: ProjectConsistency = hasExistingConsistency
    ? {
        schema: SCHEMA,
        updatedAt: cleanText(existing.updatedAt) || now,
        meta: { ...DEFAULT_META, ...(existing.meta || {}) },
        characters: Array.isArray(existing.characters) ? existing.characters : [],
      }
    : defaultConsistency(now);

  const projectWithConsistency = { ...project, consistency };
  if (!consistency.characters.length) {
    const initContext = hasExistingConsistency || context.source === 'asset_extract'
      ? context
      : { ...context, source: 'migration' as const };
    const assets = Array.isArray(project?.assets?.characters)
      ? project.assets.characters
      : Array.isArray(project?.characters)
        ? project.characters
        : [];
    consistency.characters = assets.map((asset: any) => defaultLockFromAsset(asset, initContext));
    consistency.updatedAt = now;
  }

  return projectWithConsistency;
}

function emptyDiff(): CharacterDiff {
  return {
    identityChanged: false,
    visualChanged: false,
    performanceChanged: false,
    voiceChanged: false,
    resolverChanged: false,
    referenceChanged: false,
    changedPaths: [],
  };
}

function bumpVersion(versions: CharacterVersions, key: VersionKey, bumps: VersionBumps) {
  const from = versions[key] || 1;
  const to = from + 1;
  versions[key] = to;
  bumps[key] = { from, to };
}

function compareJson(a: any, b: any) {
  return JSON.stringify(stableCanonical(a)) === JSON.stringify(stableCanonical(b));
}

function hasOwn(obj: any, key: string) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function requiredFieldsComplete(lock: CharacterLock): boolean {
  if (!lock.canonicalName || !lock.identityLock.entityType || !lock.visualLock.appearance) return false;
  if (lock.identityLock.entityType === 'non-human' && !lock.identityLock.species) return false;
  return true;
}

function nextStatus(prev: CharacterLock, next: CharacterLock, diff: CharacterDiff, context: MutateCharacterLockContext): StatusTransition | undefined {
  if (context.userConfirmed || context.source === 'user_confirm' || next.status === 'locked') {
    if (requiredFieldsComplete(next)) {
      return prev.status === 'locked' ? undefined : { from: prev.status, to: 'locked', reason: 'user_confirmed' };
    }
    return prev.status === 'needs_review' ? undefined : { from: prev.status, to: 'needs_review', reason: 'missing_required_fields' };
  }
  if (prev.status === 'locked') {
    if (diff.identityChanged || diff.visualChanged) {
      return { from: prev.status, to: 'needs_review', reason: diff.identityChanged ? 'identity_changed' : 'visual_changed' };
    }
    if (prev.referenceLock.referenceStatus !== 'degraded' && next.referenceLock.referenceStatus === 'degraded') {
      return { from: prev.status, to: 'needs_review', reason: 'reference_degraded' };
    }
  }
  if (context.source === 'migration' && prev.status !== 'needs_review') {
    return { from: prev.status, to: 'needs_review', reason: 'migration_requires_review' };
  }
  return undefined;
}

function staleHintsFor(characterId: string, bumps: VersionBumps): CharacterStaleHint[] {
  return Object.keys(bumps).map((dimension) => ({
    characterId,
    dimension: dimension as VersionKey,
    reason: `character_${dimension}_changed`,
  }));
}

export function mutateCharacterLock<TProject extends Record<string, any>>(
  project: TProject,
  characterId: string,
  patch: CharacterLockPatch,
  context: MutateCharacterLockContext,
): MutateCharacterLockResult<TProject> {
  const now = nowIso(context.now);
  const nextProject = ensureProjectConsistency(project, context);
  const consistency = {
    ...nextProject.consistency,
    meta: { ...DEFAULT_META, ...(nextProject.consistency.meta || {}) },
    characters: [...nextProject.consistency.characters],
    updatedAt: now,
  };
  const idx = consistency.characters.findIndex((c) => c.characterId === characterId || c.sourceAssetId === characterId);
  const existing = idx >= 0
    ? consistency.characters[idx]
    : defaultLockFromAsset({ id: characterId, name: patch.canonicalName || characterId }, context);

  const canonicalName = cleanText(patch.canonicalName ?? existing.canonicalName);
  const identityLock = normalizeIdentityLock(patch.identityLock, existing.identityLock);
  const visualLock = normalizeVisualLock(patch.visualLock, existing.visualLock, { canonicalName, identityLock });
  const performanceLock = normalizePerformanceLock(patch.performanceLock, existing.performanceLock);
  const voicePatch = patch.voiceLock || deriveVoiceLock({
    entityType: identityLock.entityType,
    species: identityLock.species,
    gender: identityLock.gender,
    ageBand: identityLock.ageBand,
    role: identityLock.role,
    identity: identityLock.identity,
    temperament: performanceLock.temperament,
  });
  const voiceLock = normalizeVoiceLock(voicePatch, existing.voiceLock);
  const referenceLock = normalizeReferenceLock(patch.referenceLock, existing.referenceLock);
  const aliases = patch.aliases ? cleanList([canonicalName, ...patch.aliases]) : cleanList(existing.aliases.length ? existing.aliases : [canonicalName]);

  const next: CharacterLock = {
    ...existing,
    sourceAssetId: cleanText(patch.sourceAssetId ?? existing.sourceAssetId) || undefined,
    canonicalName,
    aliases,
    identityLock,
    visualLock,
    performanceLock,
    voiceLock,
    referenceLock,
    versions: { ...existing.versions },
    status: patch.status || existing.status,
  };

  const diff = emptyDiff();
  const bumps: VersionBumps = {};
  if (!compareJson(existing.identityLock, next.identityLock) || existing.canonicalName !== next.canonicalName) {
    diff.identityChanged = true;
    diff.changedPaths.push('identity');
    bumpVersion(next.versions, 'identityVersion', bumps);
  }
  if (!compareJson(existing.visualLock, next.visualLock)) {
    diff.visualChanged = true;
    diff.changedPaths.push('visual');
    bumpVersion(next.versions, 'visualVersion', bumps);
  }
  if (!compareJson(existing.performanceLock, next.performanceLock)) {
    diff.performanceChanged = true;
    diff.changedPaths.push('performance');
    bumpVersion(next.versions, 'performanceVersion', bumps);
  }
  if (!compareJson(existing.voiceLock, next.voiceLock)) {
    diff.voiceChanged = true;
    diff.changedPaths.push('voice');
    bumpVersion(next.versions, 'voiceVersion', bumps);
  }
  if (!compareJson(existing.aliases, next.aliases)) {
    diff.resolverChanged = true;
    diff.changedPaths.push('resolver');
    bumpVersion(next.versions, 'resolverVersion', bumps);
    consistency.meta = {
      ...consistency.meta,
      resolverCaseVersion: (consistency.meta.resolverCaseVersion || 1) + 1,
    };
  }
  if (!compareJson(existing.referenceLock, next.referenceLock)) {
    diff.referenceChanged = true;
    diff.changedPaths.push('reference');
    bumpVersion(next.versions, 'referenceVersion', bumps);
  }

  const transition = nextStatus(existing, next, diff, context);
  if (transition) next.status = transition.to;

  if (idx >= 0) consistency.characters[idx] = next;
  else consistency.characters.push(next);

  return {
    project: { ...nextProject, consistency },
    character: next,
    characterDiff: diff,
    versionBumps: bumps,
    statusTransition: transition,
    staleHints: staleHintsFor(next.characterId, bumps),
  };
}

function stripEmptyObject<T extends Record<string, any>>(value: T): Partial<T> | undefined {
  const out: Record<string, any> = {};
  for (const [key, raw] of Object.entries(value || {})) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      const list = cleanList(raw);
      if (list.length) out[key] = list;
      continue;
    }
    if (typeof raw === 'object') {
      const nested = stripEmptyObject(raw as Record<string, any>);
      if (nested && Object.keys(nested).length) out[key] = nested;
      continue;
    }
    const text = cleanText(raw);
    if (text) out[key] = text;
  }
  return Object.keys(out).length ? out as Partial<T> : undefined;
}

type WorldCharacterPatchInput = {
  characterId: string;
  patch: CharacterLockPatch;
  hardPaths: Set<string>;
};

function worldCharacterKey(character: any, index: number): string {
  const key = cleanText(character?.characterId || character?.id || character?.sourceAssetId || character?.name);
  return key || `world_character_${index + 1}`;
}

function templateFieldStrength(character: any, field: string, fallback: 'hard' | 'soft') {
  const meta = character?.fieldMeta && typeof character.fieldMeta === 'object' ? character.fieldMeta[field] : null;
  const strength = cleanText(meta?.strength).toLowerCase();
  if (strength === 'hard') return 'hard';
  if (strength === 'soft') return 'soft';
  return fallback;
}

const WORLD_VISUAL_HARD_FIELDS = new Set(['appearance', 'detail', 'description', 'desc', 'scaleRule', 'negativeRules', 'signatureColors', 'canonicalPrompt']);

function worldVisualFieldFallback(field: string): 'hard' | 'soft' {
  return WORLD_VISUAL_HARD_FIELDS.has(field) ? 'hard' : 'soft';
}

function worldCharacterPatchFromTemplate(character: any, index: number): WorldCharacterPatchInput | null {
  if (!character || typeof character !== 'object') return null;
  const characterId = worldCharacterKey(character, index);
  const hardPaths = new Set<string>(['canonicalName']);
  const panels = character.referencePanels || character.panels || {};
  // 参考图只认真三视图（panels.sheetUrl）。预览/特写（previewUrl/realPhotoUrl/headshot）
  // 不能伪造成 sheetUrl、也不能撑起 referenceStatus=ready，否则假三视图会经角色锁
  // 流进选角/首尾帧/视频参考链。
  const sheetUrl = cleanText(panels.sheetUrl);
  const voiceHint = character.voiceHint || {};
  // 字段只取本字段：role/identity 不再用 description 回填（塌缩会把整段简介灌进角色锁），
  // appearance 同理不再吃简介（description/intro 是剧情文案，不是视觉硬锁）。
  const identityLock = stripEmptyObject({
    role: character.role,
    identity: character.identity,
    entityType: character.entityType === 'non-human' ? 'non-human' : character.entityType === 'human' ? 'human' : undefined,
    species: character.species,
    gender: character.gender,
    ageBand: character.ageBand || character.age,
  }) as Partial<CharacterIdentityLock> | undefined;
  for (const key of Object.keys(identityLock || {})) hardPaths.add(`identityLock.${key}`);
  const visualLock = stripEmptyObject({
    appearance: character.appearance || character.detail,
    clothing: character.clothing,
    equipment: character.equipment,
    scaleRule: character.scaleRule,
    negativeRules: character.negativeRules,
    signatureColors: character.signatureColors,
    canonicalPrompt: character.canonicalPrompt || character.imagePrompt,
  }) as CharacterLockPatch['visualLock'];
  for (const key of Object.keys(visualLock || {})) {
    if (templateFieldStrength(character, key, worldVisualFieldFallback(key)) === 'hard') hardPaths.add(`visualLock.${key}`);
  }
  const performanceLock = stripEmptyObject({
    temperament: character.temperament,
    actionTraits: character.actionTraits,
    gestureRules: character.gestureRules,
  }) as CharacterLockPatch['performanceLock'];
  const voiceLock = stripEmptyObject({
    voiceGender: voiceHint.voiceGender || character.voiceGender,
    voiceAge: voiceHint.voiceAge || character.voiceAge,
    timbre: voiceHint.timbre || character.timbre,
    speechStyle: voiceHint.speechStyle || character.speechStyle,
    accent: voiceHint.accent || character.accent,
    negativeRules: voiceHint.negativeRules || character.voiceNegativeRules,
  }) as CharacterLockPatch['voiceLock'];
  // 没有真三视图就不写 referenceLock：headshot/front 等散图不构成可用参考，
  // 写进锁里会被前端兜底链当卡面展示（特写又回来了），也会误导下游引用。
  const referenceLock = sheetUrl
    ? stripEmptyObject({
        sheetUrl,
        headshotUrl: panels.headshotUrl,
        frontUrl: panels.frontUrl,
        sideUrl: panels.sideUrl,
        backUrl: panels.backUrl,
        sourceImageId: panels.sourceImageId,
        referenceStatus: 'ready',
        qualityScore: Number.isFinite(Number(panels.confidence)) ? Number(panels.confidence) : undefined,
      }) as CharacterLockPatch['referenceLock']
    : undefined;
  const patch: CharacterLockPatch = {
    sourceAssetId: cleanText(character.sourceAssetId || character.assetId) || undefined,
    canonicalName: cleanText(character.name || character.title || characterId) || characterId,
    aliases: cleanList([character.name, character.title, ...(Array.isArray(character.aliases) ? character.aliases : [])]),
    ...(identityLock ? { identityLock } : {}),
    ...(visualLock ? { visualLock } : {}),
    ...(performanceLock ? { performanceLock } : {}),
    ...(voiceLock ? { voiceLock } : {}),
    ...(referenceLock ? { referenceLock } : {}),
  };
  return { characterId, patch, hardPaths };
}

function findCharacterLockForWorldCharacter(locks: CharacterLock[], characterId: string, patch: CharacterLockPatch, claimedLockIds = new Set<string>()): CharacterLock | undefined {
  const keys = cleanList([
    characterId,
    patch.sourceAssetId,
    patch.canonicalName,
  ]).map(cleanEnglishToken);
  if (!keys.length) return undefined;
  return locks.find((lock) => {
    if (claimedLockIds.has(lock.characterId)) return false;
    const lockKeys = cleanList([
      lock.characterId,
      lock.sourceAssetId,
      lock.canonicalName,
    ]).map(cleanEnglishToken);
    return lockKeys.some((key) => keys.includes(key));
  });
}

function uniqueWorldCharacterLockId(base: string, locks: CharacterLock[], claimedLockIds: Set<string>) {
  const root = cleanText(base) || 'world_character';
  const used = new Set([
    ...locks.map((lock) => lock.characterId).filter(Boolean),
    ...Array.from(claimedLockIds),
  ]);
  if (!used.has(root)) return root;
  let index = 2;
  while (used.has(`${root}_${index}`)) index += 1;
  return `${root}_${index}`;
}

function mergeAliases(existing: CharacterLock, patch: CharacterLockPatch) {
  return cleanList([
    ...(existing.aliases || []),
    patch.canonicalName,
    ...(Array.isArray(patch.aliases) ? patch.aliases : []),
  ]);
}

function hasWorldTemplateIdentityCollision(existing: CharacterLock, patch: CharacterLockPatch, hardPaths: Set<string>) {
  const existingName = cleanEnglishToken(existing.canonicalName);
  const incomingName = cleanEnglishToken(patch.canonicalName);
  const canonicalNameConflict = !!(
    hardPaths.has('canonicalName') &&
    existingName &&
    incomingName &&
    existingName !== incomingName
  );
  const existingEntityType = cleanText(existing.identityLock?.entityType);
  const incomingEntityType = cleanText(patch.identityLock?.entityType);
  const entityTypeConflict = !!(
    hardPaths.has('identityLock.entityType') &&
    existingEntityType &&
    incomingEntityType &&
    existingEntityType !== incomingEntityType
  );
  return canonicalNameConflict || entityTypeConflict;
}

function filterReviewedNestedPatch(
  entityLabel: string,
  domain: string,
  existing: Record<string, any>,
  incoming: Record<string, any> | undefined,
  keys: string[],
  arrayKeys: Set<string>,
  hardPaths: Set<string>,
  conflictReasons: string[],
) {
  const out: Record<string, any> = {};
  for (const key of keys) {
    if (!incoming || !hasOwn(incoming, key)) continue;
    const incomingValue = arrayKeys.has(key) ? cleanList(incoming[key]) : cleanText(incoming[key]);
    const hasIncoming = Array.isArray(incomingValue) ? incomingValue.length > 0 : !!incomingValue;
    if (!hasIncoming) continue;
    const existingValue = arrayKeys.has(key) ? cleanList(existing?.[key]) : cleanText(existing?.[key]);
    const hasExisting = Array.isArray(existingValue) ? existingValue.length > 0 : !!existingValue;
    if (!hasExisting) {
      out[key] = incomingValue;
    } else if (hardPaths.has(`${domain}.${key}`) && !compareJson(existingValue, incomingValue)) {
      conflictReasons.push(`world_template_conflict:${entityLabel}:${domain}.${key}`);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function filterPatchForExistingLock(existing: CharacterLock, input: WorldCharacterPatchInput): { patch: CharacterLockPatch; conflictReasons: string[] } {
  const patch = input.patch;
  const hardPaths = input.hardPaths;
  const entityLabel = cleanText(existing.canonicalName || patch.canonicalName || existing.characterId);
  const conflictReasons: string[] = [];
  const filtered: CharacterLockPatch = {};
  const identityCollision = hasWorldTemplateIdentityCollision(existing, patch, hardPaths);
  if (!identityCollision) {
    const aliases = mergeAliases(existing, patch);
    if (!compareJson(existing.aliases, aliases)) filtered.aliases = aliases;
  }

  if (!existing.sourceAssetId && patch.sourceAssetId) filtered.sourceAssetId = patch.sourceAssetId;
  if (patch.canonicalName && !cleanText(existing.canonicalName)) {
    filtered.canonicalName = patch.canonicalName;
  } else if (hardPaths.has('canonicalName') && patch.canonicalName && cleanText(existing.canonicalName) && cleanEnglishToken(patch.canonicalName) !== cleanEnglishToken(existing.canonicalName)) {
    conflictReasons.push(`world_template_conflict:${entityLabel}:canonicalName`);
  }

  const identityLock = filterReviewedNestedPatch(
    entityLabel,
    'identityLock',
    existing.identityLock,
    patch.identityLock,
    ['role', 'identity', 'entityType', 'species', 'gender', 'ageBand'],
    new Set(),
    hardPaths,
    conflictReasons,
  );
  if (identityLock && !identityCollision) filtered.identityLock = identityLock;

  const visualLock = filterReviewedNestedPatch(
    entityLabel,
    'visualLock',
    existing.visualLock,
    patch.visualLock,
    ['appearance', 'clothing', 'equipment', 'scaleRule', 'negativeRules', 'signatureColors'],
    new Set(['negativeRules', 'signatureColors']),
    hardPaths,
    conflictReasons,
  );
  if (visualLock && !identityCollision) filtered.visualLock = visualLock;
  if (!identityCollision && patch.visualLock?.canonicalPrompt && !cleanText(existing.visualLock?.canonicalPrompt)) {
    filtered.visualLock = { ...(filtered.visualLock || {}), canonicalPrompt: patch.visualLock.canonicalPrompt };
  }

  const performanceLock = filterReviewedNestedPatch(
    entityLabel,
    'performanceLock',
    existing.performanceLock,
    patch.performanceLock,
    ['temperament', 'actionTraits', 'gestureRules'],
    new Set(['gestureRules']),
    hardPaths,
    conflictReasons,
  );
  if (performanceLock && !identityCollision) filtered.performanceLock = performanceLock;

  const voiceLock = filterReviewedNestedPatch(
    entityLabel,
    'voiceLock',
    existing.voiceLock,
    patch.voiceLock,
    ['voiceGender', 'voiceAge', 'timbre', 'speechStyle', 'accent', 'negativeRules'],
    new Set(['negativeRules']),
    hardPaths,
    conflictReasons,
  );
  if (voiceLock && !identityCollision) filtered.voiceLock = voiceLock;

  const referenceLock = filterReviewedNestedPatch(
    entityLabel,
    'referenceLock',
    existing.referenceLock,
    patch.referenceLock,
    ['sheetUrl', 'headshotUrl', 'frontUrl', 'sideUrl', 'backUrl', 'sourceImageId', 'referenceStatus'],
    new Set(),
    hardPaths,
    conflictReasons,
  );
  if (referenceLock && !identityCollision) filtered.referenceLock = referenceLock;

  return { patch: filtered, conflictReasons };
}

function clearWorldTemplateConflictReasons(consistency: ProjectConsistency): ProjectConsistency {
  const reasons = cleanList(consistency.meta?.roleSyncReasons || [])
    .filter((reason) => !String(reason).startsWith('world_template_conflict:'));
  const meta = {
    ...DEFAULT_META,
    ...(consistency.meta || {}),
    roleSyncReasons: reasons,
    needsRoleSync: reasons.length ? true : false,
  };
  return { ...consistency, meta };
}

function applyWorldTemplateConflictReasons<TProject extends Record<string, any>>(
  project: TProject & { consistency: ProjectConsistency },
  reasons: string[],
  now: string,
): TProject & { consistency: ProjectConsistency } {
  const existingReasons = cleanList(project.consistency.meta?.roleSyncReasons || [])
    .filter((reason) => !String(reason).startsWith('world_template_conflict:'));
  const nextReasons = cleanList([...existingReasons, ...reasons]);
  const currentReasons = cleanList(project.consistency.meta?.roleSyncReasons || []);
  if (
    compareJson(currentReasons, nextReasons)
    && (!!project.consistency.meta?.needsRoleSync) === (nextReasons.length > 0)
  ) {
    return project;
  }
  return {
    ...project,
    consistency: {
      ...project.consistency,
      updatedAt: now,
      meta: {
        ...DEFAULT_META,
        ...(project.consistency.meta || {}),
        roleSyncReasons: nextReasons,
        needsRoleSync: nextReasons.length > 0,
      },
    },
  };
}

export function syncWorldCharactersIntoConsistency<TProject extends Record<string, any>>(
  project: TProject,
  context: Omit<MutateCharacterLockContext, 'source'> & { source?: 'world_template' | 'world_backfill' | 'world_edit' } = {},
): SyncWorldCharactersResult<TProject> {
  const now = nowIso(context.now);
  const world = project?.worldTemplateSnapshot && typeof project.worldTemplateSnapshot === 'object'
    ? project.worldTemplateSnapshot
    : null;
  const characters = Array.isArray(world?.characters) ? world.characters : [];
  const originalConsistency = project?.consistency;
  let working = ensureProjectConsistency(project, { source: 'migration', now });
  let changed = !compareJson(originalConsistency, working.consistency);
  const clearedConsistency = clearWorldTemplateConflictReasons(working.consistency);
  if (!compareJson(working.consistency, clearedConsistency)) changed = true;
  working = { ...working, consistency: clearedConsistency };
  const syncedCharacterIds: string[] = [];
  const conflictReasons: string[] = [];
  const claimedLockIds = new Set<string>();

  characters.forEach((character: any, index: number) => {
    const input = worldCharacterPatchFromTemplate(character, index);
    if (!input) return;
    const existing = findCharacterLockForWorldCharacter(working.consistency.characters, input.characterId, input.patch, claimedLockIds);
    if (existing) claimedLockIds.add(existing.characterId);
    const targetId = existing?.characterId || uniqueWorldCharacterLockId(input.characterId, working.consistency.characters, claimedLockIds);
    const patchForMutation = existing
      ? filterPatchForExistingLock(existing, input)
      : { patch: input.patch, conflictReasons: [] };
    conflictReasons.push(...patchForMutation.conflictReasons);

    const patch = patchForMutation.patch;
    const hasMutation = Object.keys(patch).some((key) => {
      const value = (patch as any)[key];
      if (value === undefined || value === null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return cleanText(value);
    });
    if (!hasMutation) return;

    const result = mutateCharacterLock(
      working,
      targetId,
      patch,
      {
        source: context.source || 'world_template',
        now,
        userConfirmed: false,
      },
    );
    working = result.project;
    claimedLockIds.add(result.character.characterId);
    changed = changed || result.characterDiff.changedPaths.length > 0 || !!result.statusTransition || !existing;
    syncedCharacterIds.push(result.character.characterId);
  });

  const withReasons = applyWorldTemplateConflictReasons(working, conflictReasons, now);
  if (!compareJson(working.consistency, withReasons.consistency)) changed = true;
  if (!compareJson(originalConsistency, withReasons.consistency)) changed = true;

  return {
    project: withReasons,
    changed,
    syncedCharacterIds: cleanList(syncedCharacterIds),
    conflictReasons: cleanList(conflictReasons),
  };
}

export function characterLockSummary(lock: CharacterLock) {
  return {
    characterId: lock.characterId,
    canonicalName: lock.canonicalName,
    aliases: lock.aliases,
    status: lock.status,
    versions: lock.versions,
    entityType: lock.identityLock.entityType,
    species: lock.identityLock.species,
  };
}

export function renderCharacterLockRosterLine(lock: CharacterLock, language: 'en' | 'zh' = 'zh'): string {
  const identityParts = [
    lock.identityLock.role,
    lock.identityLock.identity,
    lock.identityLock.entityType === 'non-human' ? `non-human species=${lock.identityLock.species || 'missing'}` : 'human',
  ].map(cleanText).filter(Boolean);
  const visualPartsEn = [
    lock.visualLock.appearance && `appearance=${lock.visualLock.appearance}`,
    lock.visualLock.clothing && `clothing=${lock.visualLock.clothing}`,
    lock.visualLock.equipment && `equipment=${lock.visualLock.equipment}`,
    lock.visualLock.scaleRule && `scale=${lock.visualLock.scaleRule}`,
  ].filter(Boolean);
  const performancePartsEn = [
    lock.performanceLock.temperament && `temperament=${lock.performanceLock.temperament}`,
    lock.performanceLock.actionTraits && `actions=${lock.performanceLock.actionTraits}`,
  ].filter(Boolean);
  const visualPartsZh = [
    lock.visualLock.appearance && `外貌=${lock.visualLock.appearance}`,
    lock.visualLock.clothing && `服装=${lock.visualLock.clothing}`,
    lock.visualLock.equipment && `装备=${lock.visualLock.equipment}`,
    lock.visualLock.scaleRule && `比例=${lock.visualLock.scaleRule}`,
  ].filter(Boolean);
  const performancePartsZh = [
    lock.performanceLock.temperament && `气质=${lock.performanceLock.temperament}`,
    lock.performanceLock.actionTraits && `动作=${lock.performanceLock.actionTraits}`,
  ].filter(Boolean);
  const identityPartsZh = [
    lock.identityLock.role,
    lock.identityLock.identity,
    lock.identityLock.entityType === 'non-human' ? `非人角色，物种=${lock.identityLock.species || '未标注'}` : '真人角色',
  ].map(cleanText).filter(Boolean);
  const voiceParts = [
    lock.voiceLock.voiceGender,
    lock.voiceLock.voiceAge,
    lock.voiceLock.timbre,
    lock.voiceLock.speechStyle,
    lock.voiceLock.accent,
  ].map(cleanText).filter(Boolean);
  const negative = [
    ...lock.visualLock.negativeRules,
    ...lock.voiceLock.negativeRules,
  ].map(cleanText).filter(Boolean);

  if (language === 'en') {
    return [
      `- ${lock.canonicalName}:`,
      identityParts.length ? `Identity: ${identityParts.join('; ')}.` : '',
      visualPartsEn.length ? `Visual lock: ${visualPartsEn.join('; ')}.` : '',
      performancePartsEn.length ? `Performance lock: ${performancePartsEn.join('; ')}.` : '',
      voiceParts.length ? `Voice lock: ${voiceParts.join(', ')}.` : '',
      negative.length ? `Must not: ${negative.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
  }

  return [
    `- ${lock.canonicalName}${lock.identityLock.entityType === 'non-human' ? `【非人/${lock.identityLock.species || '物种未标注'}】` : ''}：`,
    identityPartsZh.length ? `身份=${identityPartsZh.join('；')}` : '',
    visualPartsZh.length ? `形象=${visualPartsZh.join('；')}` : '',
    performancePartsZh.length ? `表演=${performancePartsZh.join('；')}` : '',
    voiceParts.length ? `声音=${voiceParts.join('，')}` : '',
    negative.length ? `禁止=${negative.join('；')}` : '',
  ].filter(Boolean).join('');
}
