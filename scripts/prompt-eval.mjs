#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const JSON_MODULES = new Set([
  'styleBible',
  'retagEmotions',
  'assetCharactersExtract',
  'assetScenesExtract',
  'assetPropsExtract',
  'shotsGenerate',
  'editAnalyze',
  'generateEdl',
  'continuityCheck',
]);

const SCRIPT_MODULES = new Set([
  'scriptConsult',
  'scriptFullCreate',
  'scriptRevise',
]);

const VIDEO_PROMPT_MODULES = new Set([
  'videoPromptGenerate',
  'videoPromptRefine',
]);

function parseArgs(argv) {
  const args = {
    samples: 'data/prompt-eval/samples',
    fixtures: 'fixtures/prompt-eval/leak-keywords.json',
    baseline: '',
    candidate: '',
    pretty: true,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--samples') args.samples = argv[++i];
    else if (arg === '--fixtures') args.fixtures = argv[++i];
    else if (arg === '--baseline') args.baseline = argv[++i];
    else if (arg === '--candidate') args.candidate = argv[++i];
    else if (arg === '--compact') args.pretty = false;
    else if (arg === '--self-test') args.selfTest = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/prompt-eval.mjs [--samples path] [--fixtures path] [--compact]
  node scripts/prompt-eval.mjs --baseline legacy-report.json --candidate v1-report.json

Samples can be a .jsonl file or a directory containing .jsonl files.
Each line should contain a prompt eval sample with at least:
  caseId, moduleId, failureLevel, oldOutput

Compare mode expects reports emitted by this script and joins results by caseId.
`);
}

function walkJsonl(inputPath) {
  const abs = resolve(inputPath);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return extname(abs) === '.jsonl' ? [abs] : [];
  const out = [];
  for (const name of readdirSync(abs)) {
    const child = join(abs, name);
    const childSt = statSync(child);
    if (childSt.isDirectory()) out.push(...walkJsonl(child));
    else if (extname(child) === '.jsonl') out.push(child);
  }
  return out.sort();
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadSamples(inputPath) {
  const files = walkJsonl(inputPath);
  const samples = [];
  const errors = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      try {
        samples.push({ ...JSON.parse(trimmed), _sourceFile: file, _sourceLine: idx + 1 });
      } catch (e) {
        errors.push({ file, line: idx + 1, error: e.message });
      }
    });
  }
  return { samples, errors, files };
}

function outputKindFor(sample) {
  if (sample.outputKind) return sample.outputKind;
  if (JSON_MODULES.has(sample.moduleId)) return 'json';
  if (SCRIPT_MODULES.has(sample.moduleId)) return 'script';
  if (VIDEO_PROMPT_MODULES.has(sample.moduleId)) return 'video-prompt';
  return 'plain-description';
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return { ok: true, value };
  const text = asText(value).trim();
  if (!text) return { ok: false, value: null };
  if (!/^[\[{]/.test(text)) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function getByPath(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function fieldCompleteness(sample, parsedOutput) {
  const required = Array.isArray(sample.requiredFields) ? sample.requiredFields : [];
  if (!required.length) return null;
  if (!parsedOutput || typeof parsedOutput !== 'object') return 0;
  let present = 0;
  for (const field of required) {
    const value = getByPath(parsedOutput, field);
    if (value !== undefined && value !== null && String(value).trim() !== '') present += 1;
  }
  return present / required.length;
}

function scriptLeakText(text) {
  const lines = text.split(/\r?\n/);
  const firstStoryLine = lines.findIndex((line) => /^(铺垫|升温|高潮|回落|余韵)\s*[：:]/.test(line.trim()));
  if (firstStoryLine < 0) return text;
  const before = lines.slice(0, firstStoryLine).join('\n');
  const lastStoryLine = lines.reduce((last, line, idx) => /^(铺垫|升温|高潮|回落|余韵)\s*[：:]/.test(line.trim()) ? idx : last, -1);
  const after = lastStoryLine >= 0 ? lines.slice(lastStoryLine + 1).filter((line) => /^[-#`]|^好的|^下面|^说明/.test(line.trim())).join('\n') : '';
  return [before, after].filter(Boolean).join('\n');
}

function fixtureApplies(fixture, moduleId, kind) {
  if (fixture.moduleId !== 'default' && fixture.moduleId !== moduleId) return false;
  return Array.isArray(fixture.appliesTo) && fixture.appliesTo.includes(kind);
}

function scanLeaks(sample, fixtures) {
  const moduleId = sample.moduleId;
  const kind = outputKindFor(sample);
  const rawText = asText(sample.candidateOutput ?? sample.oldOutput);
  const text = kind === 'script' ? scriptLeakText(rawText) : rawText;
  const active = fixtures.filter((fixture) => fixtureApplies(fixture, moduleId, kind));
  const matches = [];
  let high = false;
  for (const fixture of active) {
    const allowlist = Array.isArray(fixture.allowlist) ? fixture.allowlist : [];
    for (const keyword of fixture.highRisk || []) {
      if (allowlist.includes(keyword)) continue;
      const index = text.indexOf(keyword);
      if (index >= 0) {
        high = true;
        matches.push({ keyword, index });
      }
    }
    for (const keyword of fixture.lowRisk || []) {
      if (allowlist.includes(keyword)) continue;
      const index = text.indexOf(keyword);
      if (index >= 0) matches.push({ keyword, index });
    }
  }
  return {
    hasLeak: matches.length > 0,
    severity: high ? 'high' : matches.length ? 'low' : 'none',
    matches,
  };
}

function evaluateSample(sample, fixtures) {
  const targetOutput = sample.candidateOutput ?? sample.oldOutput;
  const parsed = parseMaybeJson(targetOutput);
  const jsonRequired = outputKindFor(sample) === 'json';
  return {
    caseId: sample.caseId || '',
    moduleId: sample.moduleId || 'unknown',
    failureLevel: sample.failureLevel || 'unknown',
    candidatePromptVersion: sample.candidatePromptVersion || sample.promptVersion || 'legacy',
    autoMetrics: {
      jsonOk: jsonRequired ? parsed.ok : undefined,
      requiredFieldCompleteness: fieldCompleteness(sample, parsed.value) ?? undefined,
      schemaOk: typeof sample.schemaOk === 'boolean' ? sample.schemaOk : undefined,
      outputCharCount: asText(targetOutput).length,
      latencyMs: typeof sample.latencyMs === 'number' ? sample.latencyMs : undefined,
      retryCount: typeof sample.retryCount === 'number' ? sample.retryCount : undefined,
      errorType: sample.errorType || undefined,
    },
    leakScan: scanLeaks(sample, fixtures),
    humanRating: sample.humanRating,
    notes: sample.notes,
  };
}

function pct(num, den) {
  return den ? Number((num / den).toFixed(4)) : 0;
}

function summarize(results, loadErrors, files) {
  const byModule = {};
  const byFailureLevel = {};
  for (const result of results) {
    const module = result.moduleId;
    const level = result.failureLevel || 'unknown';
    byModule[module] ||= { total: 0, jsonRequired: 0, jsonOk: 0, leakHigh: 0, leakAny: 0, outputCharTotal: 0 };
    byFailureLevel[level] ||= 0;
    byModule[module].total += 1;
    byFailureLevel[level] += 1;
    if (typeof result.autoMetrics.jsonOk === 'boolean') {
      byModule[module].jsonRequired += 1;
      if (result.autoMetrics.jsonOk) byModule[module].jsonOk += 1;
    }
    if (result.leakScan.hasLeak) byModule[module].leakAny += 1;
    if (result.leakScan.severity === 'high') byModule[module].leakHigh += 1;
    byModule[module].outputCharTotal += result.autoMetrics.outputCharCount || 0;
  }
  return {
    generatedAt: new Date().toISOString(),
    files,
    total: results.length,
    loadErrors,
    byModule: Object.fromEntries(Object.entries(byModule).map(([module, row]) => [
      module,
      {
        ...row,
        jsonOkRate: pct(row.jsonOk, row.jsonRequired),
        leakRate: pct(row.leakAny, row.total),
        highLeakRate: pct(row.leakHigh, row.total),
        avgOutputChars: row.total ? Math.round(row.outputCharTotal / row.total) : 0,
      },
    ])),
    byFailureLevel,
    results,
  };
}

function loadReport(path) {
  const report = loadJson(resolve(path), null);
  if (!report || !Array.isArray(report.results)) {
    throw new Error(`Invalid prompt eval report: ${path}`);
  }
  return report;
}

function isHardFailure(result) {
  if (!result) return true;
  const m = result.autoMetrics || {};
  if (m.jsonOk === false) return true;
  if (m.schemaOk === false) return true;
  if (result.leakScan?.severity === 'high') return true;
  if (result.humanRating?.failureLevel === 'hard') return true;
  return false;
}

function qualityScore(result) {
  if (!result) return -100;
  const m = result.autoMetrics || {};
  let score = 0;
  if (m.jsonOk === true) score += 2;
  if (m.jsonOk === false) score -= 4;
  if (m.schemaOk === true) score += 2;
  if (m.schemaOk === false) score -= 4;
  if (typeof m.requiredFieldCompleteness === 'number') score += m.requiredFieldCompleteness * 2;
  if (result.leakScan?.severity === 'high') score -= 5;
  else if (result.leakScan?.severity === 'low') score -= 1;
  if (result.humanRating?.canProceed === true) score += 4;
  if (result.humanRating?.canProceed === false) score -= 4;
  if (result.humanRating?.editAmount === 'rewrite') score -= 3;
  else if (result.humanRating?.editAmount === 'major') score -= 2;
  else if (result.humanRating?.editAmount === 'minor') score -= 0.5;
  return score;
}

function relativeDelta(candidateValue, baselineValue) {
  if (typeof candidateValue !== 'number' || typeof baselineValue !== 'number') return 0;
  if (baselineValue === 0) return candidateValue === 0 ? 0 : 1;
  return Number(((candidateValue - baselineValue) / baselineValue).toFixed(4));
}

function percentile(values, percentileRank) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(4));
}

function emptyCompareAccumulator() {
  return {
    rows: [],
    wins: 0,
    losses: 0,
    ties: 0,
    hardBase: 0,
    hardCand: 0,
    leakBase: 0,
    leakCand: 0,
    outputBase: 0,
    outputCand: 0,
    outputCharDeltas: [],
    latencyBase: 0,
    latencyCand: 0,
    latencyPairs: 0,
    latencyDeltas: [],
  };
}

function recordComparison(acc, base, cand, verdict, scoreDelta) {
  if (verdict === 'win') acc.wins += 1;
  else if (verdict === 'loss') acc.losses += 1;
  else acc.ties += 1;

  const baseHard = isHardFailure(base);
  const candHard = isHardFailure(cand);
  if (baseHard) acc.hardBase += 1;
  if (candHard) acc.hardCand += 1;
  if (base.leakScan?.severity === 'high') acc.leakBase += 1;
  if (cand.leakScan?.severity === 'high') acc.leakCand += 1;

  const baseOutputChars = base.autoMetrics?.outputCharCount || 0;
  const candOutputChars = cand.autoMetrics?.outputCharCount || 0;
  acc.outputBase += baseOutputChars;
  acc.outputCand += candOutputChars;
  acc.outputCharDeltas.push(relativeDelta(candOutputChars, baseOutputChars));

  if (typeof base.autoMetrics?.latencyMs === 'number' && typeof cand.autoMetrics?.latencyMs === 'number') {
    acc.latencyBase += base.autoMetrics.latencyMs;
    acc.latencyCand += cand.autoMetrics.latencyMs;
    acc.latencyPairs += 1;
    acc.latencyDeltas.push(relativeDelta(cand.autoMetrics.latencyMs, base.autoMetrics.latencyMs));
  }

  acc.rows.push({
    caseId: base.caseId,
    moduleId: base.moduleId,
    verdict,
    scoreDelta: Number(scoreDelta.toFixed(4)),
  });
}

function summarizeComparison(acc) {
  const total = acc.rows.length;
  return {
    comparableCases: total,
    winRate: pct(acc.wins, total),
    lossRate: pct(acc.losses, total),
    tieRate: pct(acc.ties, total),
    hardFailureDelta: pct(acc.hardCand, total) - pct(acc.hardBase, total),
    leakDelta: pct(acc.leakCand, total) - pct(acc.leakBase, total),
    outputCharDelta: relativeDelta(acc.outputCand, acc.outputBase),
    outputCharP95Delta: percentile(acc.outputCharDeltas, 95),
    latencyDelta: acc.latencyPairs ? relativeDelta(acc.latencyCand / acc.latencyPairs, acc.latencyBase / acc.latencyPairs) : 0,
    latencyP95Delta: percentile(acc.latencyDeltas, 95),
  };
}

function compareReports(baselineReport, candidateReport) {
  const baselineByCase = new Map(baselineReport.results.map((r) => [r.caseId, r]));
  const candidateByCase = new Map(candidateReport.results.map((r) => [r.caseId, r]));
  const all = emptyCompareAccumulator();
  const byModule = new Map();
  const missingCandidateCaseIds = [];
  const orphanCandidateCaseIds = candidateReport.results
    .map((r) => r.caseId)
    .filter((caseId) => !baselineByCase.has(caseId));

  for (const [caseId, base] of baselineByCase.entries()) {
    const cand = candidateByCase.get(caseId);
    if (!cand) {
      missingCandidateCaseIds.push(caseId);
      continue;
    }
    const baseScore = qualityScore(base);
    const candScore = qualityScore(cand);
    const scoreDelta = candScore - baseScore;
    const verdict = scoreDelta >= 1 ? 'win' : scoreDelta <= -1 ? 'loss' : 'tie';
    const moduleId = base.moduleId || cand.moduleId || 'unknown';
    if (!byModule.has(moduleId)) byModule.set(moduleId, emptyCompareAccumulator());
    recordComparison(all, base, cand, verdict, scoreDelta);
    recordComparison(byModule.get(moduleId), base, cand, verdict, scoreDelta);
  }

  return {
    generatedAt: new Date().toISOString(),
    baselineFiles: baselineReport.files || [],
    candidateFiles: candidateReport.files || [],
    comparableCases: all.rows.length,
    missingCandidateCases: missingCandidateCaseIds.length,
    missingCandidateCaseIds,
    orphanCandidates: orphanCandidateCaseIds.length,
    orphanCandidateCaseIds,
    comparison: summarizeComparison(all),
    byModule: Object.fromEntries(
      Array.from(byModule.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([moduleId, acc]) => [moduleId, summarizeComparison(acc)]),
    ),
    rows: all.rows,
  };
}

function selfTestSamples() {
  return [
    {
      caseId: 'self_json_ok',
      moduleId: 'styleBible',
      failureLevel: 'hard',
      oldOutput: { schemaVersion: 'v0', visualStyle: 'cinematic', colorPalette: [] },
      requiredFields: ['visualStyle', 'colorPalette'],
    },
    {
      caseId: 'self_leak',
      moduleId: 'videoPromptGenerate',
      failureLevel: 'soft',
      oldOutput: '请参考 Image 1，然后按以下步骤生成画面。',
    },
  ];
}

const args = parseArgs(process.argv.slice(2));
if (args.baseline || args.candidate) {
  if (!args.baseline || !args.candidate) {
    console.error('--baseline and --candidate must be provided together.');
    process.exit(1);
  }
  const report = compareReports(loadReport(args.baseline), loadReport(args.candidate));
  console.log(JSON.stringify(report, null, args.pretty ? 2 : 0));
  process.exit(0);
}

const fixtures = loadJson(resolve(args.fixtures), []);
const loaded = args.selfTest
  ? { samples: selfTestSamples(), errors: [], files: ['self-test'] }
  : loadSamples(args.samples);
const results = loaded.samples.map((sample) => evaluateSample(sample, fixtures));
const report = summarize(results, loaded.errors, loaded.files);
console.log(JSON.stringify(report, null, args.pretty ? 2 : 0));

if (loaded.errors.length) process.exitCode = 1;
