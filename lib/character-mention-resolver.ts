import type { CharacterLock } from './character-consistency';

export type MentionSource = 'canonical' | 'alias' | 'speaker' | 'pronoun' | 'ambiguous';
export type MentionExpectedMode = 'auto' | 'warn' | 'ambiguous' | 'none';

export type MentionResolution = {
  textSpan: string;
  start: number;
  end: number;
  characterId?: string;
  canonicalName?: string;
  confidence: number;
  source: MentionSource;
  reason: string;
};

export type ResolveCharacterMentionsInput = {
  text: string;
  characters: CharacterLock[];
  contextText?: string;
};

export type MentionCase = {
  id: string;
  text: string;
  expectedCharacterId?: string;
  expectedCanonicalName?: string;
  expectedTextSpan?: string;
  expectedSource?: MentionSource;
  expectedMode?: MentionExpectedMode;
  minConfidence?: number;
  maxConfidence?: number;
  shouldResolve: boolean;
};

export type MentionResolverEvaluation = {
  total: number;
  resolved: number;
  correct: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  failures: Array<{ id: string; reason: string }>;
};

type AliasCandidate = {
  alias: string;
  lock: CharacterLock;
  source: 'canonical' | 'alias';
};

const PRONOUN_RECENCY_WINDOW_CHARS = 60;
const PRONOUN_AMBIGUITY_WINDOW_CHARS = 24;
export const AUTO_RESOLVE_CONFIDENCE = 0.9;
const WARN_RESOLVE_CONFIDENCE = 0.65;
const BOUNDARY_PUNCT = new Set('：:，。！？、；;（）()【】[] \t\n\r"“”\'‘’'.split(''));
const BOUNDARY_WORDS_BEFORE = new Set('由被把让和跟与对向给在从后才着随天刚'.split(''));
const BOUNDARY_WORDS_AFTER = new Set('说问看听告把被让对向给跟和与在从将就又也都正去来要已随的很好刚还先过转冲起笑气拿走跑到摇拍站坐想'.split(''));
const COMPOUND_SUFFIX_BLOCKLIST = ['末日', '一族', '末', '代', '们', '家', '族'];

function cleanText(value: any): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function cleanKey(value: any): string {
  return cleanText(value).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function isCjk(value: string): boolean {
  return !!value && /[\u3400-\u9fff]/.test(value);
}

function isChineseAliasBoundary(text: string, start: number, end: number): boolean {
  const prev = start > 0 ? text[start - 1] : '';
  const next = end < text.length ? text[end] : '';
  const suffix = text.slice(end, end + 2);
  if (COMPOUND_SUFFIX_BLOCKLIST.some((blocked) => suffix.startsWith(blocked))) return false;
  const beforeOk = !prev || !isCjk(prev) || BOUNDARY_PUNCT.has(prev) || BOUNDARY_WORDS_BEFORE.has(prev);
  const afterOk = !next || !isCjk(next) || BOUNDARY_PUNCT.has(next) || BOUNDARY_WORDS_AFTER.has(next);
  return beforeOk && afterOk;
}

function isAliasBoundaryMatch(text: string, alias: string, start: number, end: number): boolean {
  if (hasCjk(alias)) return isChineseAliasBoundary(text, start, end);
  const prev = start > 0 ? text[start - 1] : '';
  const next = end < text.length ? text[end] : '';
  return (!prev || !/[A-Za-z0-9_]/.test(prev)) && (!next || !/[A-Za-z0-9_]/.test(next));
}

function buildAliasCandidates(characters: CharacterLock[]): AliasCandidate[] {
  const out: AliasCandidate[] = [];
  for (const lock of characters) {
    const canonical = cleanText(lock.canonicalName);
    if (canonical) out.push({ alias: canonical, lock, source: 'canonical' });
    for (const alias of lock.aliases || []) {
      const cleaned = cleanText(alias);
      if (!cleaned || cleaned === canonical) continue;
      out.push({ alias: cleaned, lock, source: 'alias' });
    }
  }
  out.sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  return out;
}

function candidateConflicts(candidates: AliasCandidate[], alias: string): CharacterLock[] {
  const key = cleanKey(alias);
  const locks = new Map<string, CharacterLock>();
  for (const candidate of candidates) {
    if (cleanKey(candidate.alias) === key) locks.set(candidate.lock.characterId, candidate.lock);
  }
  return [...locks.values()];
}

function overlaps(existing: MentionResolution[], start: number, end: number): boolean {
  return existing.some((hit) => start < hit.end && end > hit.start);
}

function addResolution(out: MentionResolution[], hit: MentionResolution) {
  if (overlaps(out, hit.start, hit.end)) return;
  out.push(hit);
}

function findSpeakerMentions(text: string, candidates: AliasCandidate[]): MentionResolution[] {
  const out: MentionResolution[] = [];
  for (const candidate of candidates) {
    if (!candidate.alias) continue;
    const re = new RegExp(`${escapeRegExp(candidate.alias)}\\s*[：:]`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const conflicts = candidateConflicts(candidates, candidate.alias);
      const ambiguous = conflicts.length > 1;
      addResolution(out, {
        textSpan: candidate.alias,
        start: match.index,
        end: match.index + candidate.alias.length,
        characterId: ambiguous ? undefined : candidate.lock.characterId,
        canonicalName: ambiguous ? undefined : candidate.lock.canonicalName,
        confidence: ambiguous ? 0.6 : 0.98,
        source: ambiguous ? 'ambiguous' : 'speaker',
        reason: ambiguous ? `speaker alias matches ${conflicts.length} characters` : 'speaker anchor',
      });
    }
  }
  return out;
}

function findAliasMentions(text: string, candidates: AliasCandidate[], existing: MentionResolution[]): MentionResolution[] {
  const out = [...existing];
  for (const candidate of candidates) {
    if (!candidate.alias) continue;
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(candidate.alias, offset);
      if (index < 0) break;
      const end = index + candidate.alias.length;
      if (!isAliasBoundaryMatch(text, candidate.alias, index, end)) {
        offset = end;
        continue;
      }
      const conflicts = candidateConflicts(candidates, candidate.alias);
      const ambiguous = conflicts.length > 1;
      addResolution(out, {
        textSpan: candidate.alias,
        start: index,
        end,
        characterId: ambiguous ? undefined : candidate.lock.characterId,
        canonicalName: ambiguous ? undefined : candidate.lock.canonicalName,
        confidence: ambiguous ? 0.62 : candidate.source === 'canonical' ? 0.95 : 0.9,
        source: ambiguous ? 'ambiguous' : candidate.source,
        reason: ambiguous ? `alias matches ${conflicts.length} characters` : `${candidate.source} match`,
      });
      offset = end;
    }
  }
  return out;
}

function recentResolvedCharacter(hits: MentionResolution[], index: number): MentionResolution | null {
  // 中文短句常在 10-20 字内结束；60 字约等于最近 3 句上下文。
  // 若 24 字内出现多个候选 antecedent，则降级为 ambiguous，避免"多人对白后他/她/它"误归一。
  const recent = hits
    .filter((hit) => hit.characterId && hit.end <= index && index - hit.end <= PRONOUN_RECENCY_WINDOW_CHARS)
    .sort((a, b) => b.end - a.end);
  if (!recent.length) return null;
  const nearest = recent[0];
  const sameWindow = recent.filter((hit) => nearest.end - hit.end <= PRONOUN_AMBIGUITY_WINDOW_CHARS);
  const unique = new Set(sameWindow.map((hit) => hit.characterId));
  if (unique.size > 1) return null;
  return nearest;
}

function addPronounMentions(text: string, hits: MentionResolution[]): MentionResolution[] {
  const out = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const pronounRe = /[他她它]/g;
  let match: RegExpExecArray | null;
  while ((match = pronounRe.exec(text))) {
    if (overlaps(out, match.index, match.index + 1)) continue;
    const recent = recentResolvedCharacter(out, match.index);
    addResolution(out, {
      textSpan: match[0],
      start: match.index,
      end: match.index + 1,
      characterId: recent?.characterId,
      canonicalName: recent?.canonicalName,
      confidence: recent ? 0.72 : 0.45,
      source: recent ? 'pronoun' : 'ambiguous',
      reason: recent ? `local pronoun resolved to ${recent.canonicalName}` : 'pronoun has no confident local antecedent',
    });
  }
  return out;
}

export function resolveCharacterMentions(input: ResolveCharacterMentionsInput): MentionResolution[] {
  const text = cleanText([input.contextText, input.text].filter(Boolean).join('\n'));
  if (!text || !input.characters.length) return [];
  const candidates = buildAliasCandidates(input.characters);
  const speakerHits = findSpeakerMentions(text, candidates);
  const aliasHits = findAliasMentions(text, candidates, speakerHits);
  return addPronounMentions(text, aliasHits)
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

function hitMatchesExpectedMode(hit: MentionResolution, mode: MentionExpectedMode): boolean {
  if (mode === 'auto') return !!hit.characterId && hit.confidence >= AUTO_RESOLVE_CONFIDENCE;
  if (mode === 'warn') return hit.confidence >= WARN_RESOLVE_CONFIDENCE && hit.confidence < AUTO_RESOLVE_CONFIDENCE;
  if (mode === 'ambiguous') return hit.source === 'ambiguous' && hit.confidence < AUTO_RESOLVE_CONFIDENCE;
  return false;
}

export function evaluateMentionResolver(cases: MentionCase[], characters: CharacterLock[]): MentionResolverEvaluation {
  const failures: MentionResolverEvaluation['failures'] = [];
  let correct = 0;
  let resolved = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const item of cases) {
    const allHits = resolveCharacterMentions({ text: item.text, characters });
    const expectedMode = item.expectedMode || (item.shouldResolve ? 'auto' : 'none');
    const minConfidence = typeof item.minConfidence === 'number' ? item.minConfidence : 0;
    const maxConfidence = typeof item.maxConfidence === 'number' ? item.maxConfidence : 1;
    const candidateHits = allHits
      .filter((hit) => hit.confidence >= minConfidence && hit.confidence <= maxConfidence)
      .filter((hit) => item.expectedSource ? hit.source === item.expectedSource : true)
      .filter((hit) => item.expectedTextSpan ? hit.textSpan === item.expectedTextSpan : true);
    const expectedId = item.expectedCharacterId ||
      characters.find((lock) => cleanKey(lock.canonicalName) === cleanKey(item.expectedCanonicalName))?.characterId;
    const hits = expectedMode === 'none'
      ? []
      : candidateHits.filter((hit) => hitMatchesExpectedMode(hit, expectedMode));
    const matched = expectedId ? hits.some((hit) => hit.characterId === expectedId) : hits.length > 0;
    const unexpectedHits = item.expectedTextSpan || item.expectedSource ? candidateHits : allHits;

    if (hits.length) resolved++;
    if (item.shouldResolve && matched) correct++;
    else if (item.shouldResolve && !matched) {
      falseNegative++;
      failures.push({ id: item.id, reason: 'expected mention was not resolved' });
    } else if (!item.shouldResolve && unexpectedHits.length) {
      falsePositive++;
      failures.push({ id: item.id, reason: 'unexpected mention resolved' });
    }
  }

  const precisionDenom = correct + falsePositive;
  const recallDenom = correct + falseNegative;
  return {
    total: cases.length,
    resolved,
    correct,
    falsePositive,
    falseNegative,
    precision: precisionDenom ? correct / precisionDenom : 1,
    recall: recallDenom ? correct / recallDenom : 1,
    failures,
  };
}

export function buildMentionCaseSet(characters: CharacterLock[]): MentionCase[] {
  const cases: MentionCase[] = [];
  for (const lock of characters) {
    const aliases = [lock.canonicalName, ...(lock.aliases || [])].map(cleanText).filter(Boolean);
    for (const alias of aliases.slice(0, 4)) {
      cases.push({
        id: `${lock.characterId}:speaker:${alias}`,
        text: `${alias}：今天先复盘。`,
      expectedCharacterId: lock.characterId,
      expectedTextSpan: alias,
      expectedSource: 'speaker',
      expectedMode: 'auto',
      shouldResolve: true,
      });
    }
    if (aliases[1]) {
      cases.push({
        id: `${lock.characterId}:alias-in-action:${aliases[1]}`,
        text: `旁白：${aliases[1]}把资料放到桌上，转身看向镜头。`,
        expectedCharacterId: lock.characterId,
        expectedTextSpan: aliases[1],
        expectedMode: 'auto',
        shouldResolve: true,
      });
    }
  }
  return cases;
}

function benchmarkLock(input: {
  characterId: string;
  canonicalName: string;
  aliases: string[];
  entityType?: 'human' | 'non-human';
  species?: string;
}): CharacterLock {
  return {
    characterId: input.characterId,
    sourceAssetId: input.characterId,
    canonicalName: input.canonicalName,
    aliases: input.aliases,
    versions: {
      identityVersion: 1,
      visualVersion: 1,
      performanceVersion: 1,
      voiceVersion: 1,
      resolverVersion: 1,
      referenceVersion: 1,
    },
    status: 'locked',
    identityLock: {
      role: input.aliases[0] || input.canonicalName,
      identity: input.canonicalName,
      entityType: input.entityType || 'human',
      species: input.species,
    },
    visualLock: {
      appearance: `${input.canonicalName} fixed appearance`,
      clothing: '',
      equipment: '',
      negativeRules: [],
      canonicalPrompt: '',
      visualSignatureHash: '',
    },
    performanceLock: {
      temperament: '',
      actionTraits: '',
      gestureRules: [],
      performanceSignatureHash: '',
    },
    voiceLock: {
      confidence: 1,
      negativeRules: [],
      voiceSignatureHash: '',
    },
    referenceLock: {
      referenceStatus: 'ready',
    },
  };
}

export function buildMentionResolverBenchmarkFixture(): { characters: CharacterLock[]; cases: MentionCase[] } {
  const characters = [
    benchmarkLock({ characterId: 'char_laozhou', canonicalName: '老周', aliases: ['老板', '周哥'] }),
    benchmarkLock({ characterId: 'char_xiaowang', canonicalName: '小王', aliases: ['王助理'] }),
    benchmarkLock({ characterId: 'char_crab_captain', canonicalName: '帝王蟹队长', aliases: ['队长', '蟹队'], entityType: 'non-human', species: 'crab' }),
    benchmarkLock({ characterId: 'char_oyster_intern', canonicalName: '生蚝实习生', aliases: ['实习生', '小蚝'], entityType: 'non-human', species: 'oyster' }),
    benchmarkLock({ characterId: 'char_zhao_a', canonicalName: '赵甲', aliases: ['赵总'] }),
    benchmarkLock({ characterId: 'char_zhao_b', canonicalName: '赵乙', aliases: ['赵总'] }),
  ];
  const cases: MentionCase[] = [
    ...buildMentionCaseSet(characters.slice(0, 4)),
    {
      id: 'title-only-boss-resolves-laozhou',
      text: '旁白：老板把账本拍在桌上，要求今天先复盘。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老板',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'seafood-short-name-captain',
      text: '帝王蟹队长举起钳子。队长让大家保持队形，蟹队随后冲向冷库。',
      expectedCharacterId: 'char_crab_captain',
      expectedTextSpan: '蟹队',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'pronoun-nearest-single-antecedent',
      text: '老周把账本递给镜头外的人。两秒后，他转身关掉仓库灯。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '他',
      expectedSource: 'pronoun',
      expectedMode: 'warn',
      shouldResolve: true,
    },
    {
      id: 'pronoun-after-two-speakers-warning',
      text: '老周看向小王，小王把钥匙交给老周。他站在门口沉默。',
      expectedTextSpan: '他',
      expectedSource: 'ambiguous',
      expectedMode: 'ambiguous',
      shouldResolve: true,
    },
    {
      id: 'same-alias-conflict-not-auto',
      text: '赵总：今天所有账目重查一遍。',
      expectedTextSpan: '赵总',
      expectedSource: 'ambiguous',
      expectedMode: 'ambiguous',
      shouldResolve: true,
    },
    {
      id: 'substring-false-positive-laozhoumo',
      text: '旁白：老周末的盘点计划已经贴在公告栏。',
      expectedTextSpan: '老周',
      expectedMode: 'none',
      shouldResolve: false,
    },
    {
      id: 'boundary-de-laozhou',
      text: '旁白：老周的账本被放在桌上。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-hen-laozhou',
      text: '旁白：老周很生气，镜头推到他的手背。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-hao-laozhou',
      text: '旁白：老周好像发现了账本里的漏洞。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-gang-laozhou',
      text: '旁白：老周刚进门，小王立刻站起来。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-action-zhuanshen',
      text: '旁白：老周转身关上冷库门。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-action-chong',
      text: '旁白：老周冲出去拦住小王。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-action-qishen',
      text: '旁白：老周起身拿起账本。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-action-gaosu',
      text: '旁白：老周告诉大家今晚先复盘。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-action-xian',
      text: '旁白：老周先走，小王留在仓库里。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-before-ranhou',
      text: '旁白：然后老周拿起账本走向门口。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-before-gangcai',
      text: '旁白：刚才老周还站在冷库门口。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'boundary-before-jiezhe',
      text: '旁白：接着老周转身看向小王。',
      expectedCharacterId: 'char_laozhou',
      expectedTextSpan: '老周',
      expectedMode: 'auto',
      shouldResolve: true,
    },
    {
      id: 'pronoun-too-far-not-auto',
      text: '老周把账本放下。这里是一段很长的环境描述，用来填充超过六十个中文字符，镜头扫过墙面、货架、灯光、地面、窗户、门把手和灰尘，然后他转身。',
      expectedTextSpan: '他',
      expectedSource: 'ambiguous',
      expectedMode: 'ambiguous',
      shouldResolve: true,
    },
  ];
  return { characters, cases };
}
