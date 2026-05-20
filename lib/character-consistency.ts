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

const SCHEMA: ProjectConsistency['schema'] = 'origin-consistency-v1';
const READY_QUALITY_THRESHOLD = 0.65;

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
  const next: CharacterReferenceLock = {
    sheetUrl: cleanText(input?.sheetUrl ?? fallback.sheetUrl) || undefined,
    headshotUrl: cleanText(input?.headshotUrl ?? fallback.headshotUrl) || undefined,
    frontUrl: cleanText(input?.frontUrl ?? fallback.frontUrl) || undefined,
    sideUrl: cleanText(input?.sideUrl ?? fallback.sideUrl) || undefined,
    backUrl: cleanText(input?.backUrl ?? fallback.backUrl) || undefined,
    sourceImageId: cleanText(input?.sourceImageId ?? fallback.sourceImageId) || undefined,
    referenceStatus: input?.referenceStatus || fallback.referenceStatus || 'missing',
    qualityScore: Number.isFinite(Number(input?.qualityScore)) ? Number(input?.qualityScore) : fallback.qualityScore,
  };
  const hasAnyRef = !!(next.sheetUrl || next.headshotUrl || next.frontUrl || next.sideUrl || next.backUrl || next.sourceImageId);
  if (!hasAnyRef) next.referenceStatus = next.referenceStatus === 'failed' ? 'failed' : 'missing';
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
