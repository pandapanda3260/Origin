#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const ts = require('typescript');

require.extensions['.ts'] = function compileTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const {
  buildMentionResolverBenchmarkFixture,
  evaluateMentionResolver,
  resolveCharacterMentions,
} = require(path.join(process.cwd(), 'lib', 'character-mention-resolver.ts'));

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  const value = hit.slice(prefix.length);
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const fullScan = process.argv.includes('--full-scan');
const evaluateResolver = process.argv.includes('--evaluate-resolver');
const budget = {
  days: fullScan ? 3650 : argValue('days', 30),
  maxProjects: fullScan ? Number.POSITIVE_INFINITY : argValue('projects', 30),
  maxCharactersPerProject: fullScan ? Number.POSITIVE_INFINITY : argValue('characters', 20),
  maxGroupsPerProject: fullScan ? Number.POSITIVE_INFINITY : argValue('groups', 8),
  groupSampleRate: fullScan ? 1 : Math.max(0.01, Math.min(1, argValue('sample', 0.2))),
  maxVisionCalls: fullScan ? Number.POSITIVE_INFINITY : argValue('max-vision-calls', 500),
};

function bump(map, key, n = 1) {
  map[key || 'unknown'] = (map[key || 'unknown'] || 0) + n;
}

function parseProject(row) {
  let data = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch (_) {}
  return { id: row.id, title: row.title, updatedAt: row.updated_at, ...data };
}

function sampleGroups(storyboards) {
  const groups = Array.isArray(storyboards) ? storyboards : [];
  const entries = groups.map((group, groupIdx) => ({ group, groupIdx }));
  if (fullScan || groups.length <= 3) return entries.slice(0, budget.maxGroupsPerProject);
  const wanted = Math.min(budget.maxGroupsPerProject, Math.max(3, Math.ceil(groups.length * budget.groupSampleRate)));
  const step = Math.max(1, Math.floor(groups.length / wanted));
  const out = [];
  for (let i = 0; i < entries.length && out.length < wanted; i += step) out.push(entries[i]);
  return out;
}

function resolverLockFromCharacter(character, index) {
  if (character && character.characterId && character.canonicalName && Array.isArray(character.aliases)) return character;
  const name = character?.canonicalName || character?.name || character?.role || `character_${index + 1}`;
  const aliases = [name, character?.role, ...(Array.isArray(character?.aliases) ? character.aliases : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return {
    characterId: character?.characterId || character?.id || `character_${index + 1}`,
    canonicalName: name,
    aliases: Array.from(new Set(aliases)),
  };
}

function resolverLocks(project) {
  const locks = Array.isArray(project.consistency?.characters) ? project.consistency.characters : [];
  const assetCharacters = Array.isArray(project.assets?.characters) ? project.assets.characters : [];
  return (locks.length ? locks : assetCharacters)
    .slice(0, budget.maxCharactersPerProject)
    .map(resolverLockFromCharacter);
}

function groupText(project, group, groupIdx) {
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const shotIndices = Array.isArray(group?.shotIndices) && group.shotIndices.length ? group.shotIndices : [groupIdx];
  const shotText = shotIndices.map((idx) => {
    const sh = shots[idx] || {};
    return [
      sh.characters,
      sh.speaker,
      sh.visual,
      sh.description,
      sh.desc,
      sh.dialogue,
      sh.scriptRef,
      sh.keyInfo,
    ].flat().filter(Boolean).join(' ');
  });
  return [
    group?.videoPrompt,
    group?.firstFramePrompt,
    group?.imagePrompt,
    group?.description,
    group?.dialogue,
    ...shotText,
  ].filter(Boolean).join('\n');
}

function recommendOrder(byDriftType) {
  const weights = {
    D0: Number.POSITIVE_INFINITY,
    A: Number.POSITIVE_INFINITY - 1,
    B: byDriftType.mention_ambiguous || 0,
    C: (byDriftType.status_not_locked || 0) + (byDriftType.nonhuman_species_missing || 0),
    D: byDriftType.missing_character_lock_block || 0,
    E: (byDriftType.reference_missing || 0) + (byDriftType.stale_snapshot_missing || 0),
    F: byDriftType.diagnostic_conflict || 0,
  };
  const dependsOn = {
    D0: [],
    A: ['D0'],
    B: ['A'],
    C: ['A', 'B'],
    D: ['A'],
    E: ['A'],
    F: ['C'],
  };
  const wanted = new Set(['D0', 'A']);
  for (const [wp, score] of Object.entries(weights)) {
    if (score > 0 && Number.isFinite(score)) wanted.add(wp);
  }
  function includeDeps(wp) {
    for (const dep of dependsOn[wp] || []) {
      if (!wanted.has(dep)) {
        wanted.add(dep);
        includeDeps(dep);
      }
    }
  }
  Array.from(wanted).forEach(includeDeps);

  const emitted = [];
  const pending = new Set(wanted);
  while (pending.size) {
    const available = Array.from(pending)
      .filter((wp) => (dependsOn[wp] || []).every((dep) => !wanted.has(dep) || emitted.includes(dep)))
      .sort((a, b) => (weights[b] - weights[a]) || a.localeCompare(b));
    if (!available.length) throw new Error(`Invalid work package DAG: ${Array.from(pending).join(',')}`);
    const next = available[0];
    emitted.push(next);
    pending.delete(next);
  }
  return emitted;
}

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'qd.sqlite');
const db = new Database(dbPath, { readonly: true, fileMustExist: false });
const since = new Date(Date.now() - budget.days * 24 * 60 * 60 * 1000).toISOString();
const limitClause = Number.isFinite(budget.maxProjects) ? `LIMIT ${Math.max(1, Math.floor(budget.maxProjects))}` : '';
const rows = db.prepare(
  `SELECT id, title, updated_at, data_json FROM projects WHERE updated_at >= ? ORDER BY updated_at DESC ${limitClause}`,
).all(since);

const byStage = {};
const byDriftType = {};
const byEntityType = {};
const topCharacters = [];
let characterCount = 0;
let groupCount = 0;
let resolverEvaluatedGroups = 0;
let projectsWithoutConsistency = 0;
let resolverFallbackProjects = 0;
let resolverFallbackCharacters = 0;

let resolverEvaluation = null;
if (evaluateResolver) {
  const fixture = buildMentionResolverBenchmarkFixture();
  resolverEvaluation = evaluateMentionResolver(fixture.cases, fixture.characters);
}

for (const row of rows) {
  const project = parseProject(row);
  const locks = Array.isArray(project.consistency?.characters) ? project.consistency.characters : [];
  const assetCharacters = Array.isArray(project.assets?.characters) ? project.assets.characters : [];
  if (!locks.length) {
    projectsWithoutConsistency++;
    if (assetCharacters.length) {
      resolverFallbackProjects++;
      resolverFallbackCharacters += Math.min(assetCharacters.length, budget.maxCharactersPerProject);
    }
  }
  const characters = locks.length ? locks : assetCharacters;
  characters.slice(0, budget.maxCharactersPerProject).forEach((character, index) => {
    characterCount++;
    const name = character.canonicalName || character.name || character.role || `character_${index + 1}`;
    const entityType = character.identityLock?.entityType || character.entityType || 'human';
    const status = character.status || (locks.length ? 'unknown' : 'missing_lock');
    bump(byEntityType, entityType);
    if (status !== 'locked') {
      bump(byStage, 'CharacterLock');
      bump(byDriftType, 'status_not_locked');
      topCharacters.push({ projectId: project.id, name, driftType: 'status_not_locked', status });
    }
    if (entityType === 'non-human' && !(character.identityLock?.species || character.species)) {
      bump(byStage, 'CharacterLock');
      bump(byDriftType, 'nonhuman_species_missing');
      topCharacters.push({ projectId: project.id, name, driftType: 'nonhuman_species_missing' });
    }
    const refStatus = character.referenceLock?.referenceStatus || (character.imageUrl || character.rawUrl ? 'ready' : 'missing');
    if (refStatus !== 'ready') {
      bump(byStage, 'Reference');
      bump(byDriftType, 'reference_missing');
    }
  });

  const projectResolverLocks = resolverLocks(project);
  sampleGroups(project.storyboards).forEach(({ group, groupIdx }) => {
    groupCount++;
    const text = groupText(project, group, groupIdx);
    if (text && projectResolverLocks.length) {
      resolverEvaluatedGroups++;
      const hits = resolveCharacterMentions({ text, characters: projectResolverLocks });
      const ambiguousHits = hits.filter((hit) => hit.source === 'ambiguous' || hit.confidence < 0.9);
      if (ambiguousHits.length) {
        bump(byStage, 'resolver', ambiguousHits.length);
        bump(byDriftType, 'mention_ambiguous', ambiguousHits.length);
        topCharacters.push({
          projectId: project.id,
          name: ambiguousHits[0].canonicalName || ambiguousHits[0].textSpan,
          driftType: 'mention_ambiguous',
          confidence: ambiguousHits[0].confidence,
          source: ambiguousHits[0].source,
          groupIdx,
        });
      }
    }
    if (group?.videoPrompt && !group?.consistency?.videoPrompt?.characterUsages) {
      bump(byStage, 'videoPrompt');
      bump(byDriftType, 'stale_snapshot_missing');
    }
  });
  const videoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  videoTasks.slice(0, budget.maxGroupsPerProject).forEach((task) => {
    if (task && !task?.consistency?.videoSegment?.characterLockBlockHash) {
      bump(byStage, 'videoSegment');
      bump(byDriftType, 'missing_character_lock_block');
    }
  });
}

const summary = {
  byStage,
  byDriftType,
  byEntityType,
  topCharacters: topCharacters.slice(0, 20),
  recommendedWorkPackageOrder: recommendOrder(byDriftType),
  budgetUsed: {
    projects: rows.length,
    characters: characterCount,
    groups: groupCount,
    visionLlmCalls: 0,
    faceEmbeddingPairs: 0,
    resolverEvaluatedGroups,
    projectsWithoutConsistency,
    resolverFallbackProjects,
    resolverFallbackCharacters,
    fullScan,
    budget,
  },
  resolverEvaluation,
};

console.log(JSON.stringify(summary, null, 2));

if (resolverEvaluation && (resolverEvaluation.precision < 0.95 || resolverEvaluation.recall < 0.85)) {
  console.error(
    `Resolver evaluation failed: precision=${resolverEvaluation.precision.toFixed(3)}, recall=${resolverEvaluation.recall.toFixed(3)}`,
  );
  process.exit(1);
}
