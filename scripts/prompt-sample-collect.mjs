#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const P0_MODULES = [
  'scriptFullCreate',
  'styleBible',
  'assetCharactersExtract',
  'assetScenesExtract',
  'assetPropsExtract',
  'shotsGenerate',
  'videoPromptGenerate',
];

function parseArgs(argv) {
  const args = {
    db: process.env.DB_PATH || 'data/qd.sqlite',
    out: 'data/prompt-eval/samples/collected.jsonl',
    perModuleLimit: 30,
    write: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') args.db = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--per-module-limit') args.perModuleLimit = Number(argv[++i]) || args.perModuleLimit;
    else if (arg === '--write') args.write = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/prompt-sample-collect.mjs [--db data/qd.sqlite] [--write]

Default mode is read-only and prints a readiness report.
Use --write to write JSONL samples to data/prompt-eval/samples/collected.jsonl.
`);
}

function truncate(value, max = 2400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseProject(row) {
  try {
    return { ...JSON.parse(row.data_json || '{}'), id: row.id, title: row.title, ownerId: row.owner_id };
  } catch {
    return { id: row.id, title: row.title, ownerId: row.owner_id };
  }
}

function hasAnyHeading(script) {
  return /(铺垫|升温|高潮|回落|余韵)\s*[：:]/.test(String(script || ''));
}

function scriptHeadingsMissing(script) {
  const text = String(script || '');
  return ['铺垫', '升温', '高潮', '回落', '余韵'].filter((h) => !new RegExp(`${h}\\s*[：:]`).test(text));
}

function pushSample(samples, sample, perModuleLimit) {
  const count = samples.filter((s) => s.moduleId === sample.moduleId).length;
  if (count >= perModuleLimit) return;
  samples.push({
    promptVersion: 'legacy',
    schemaVersion: 'v0',
    createdAt: new Date().toISOString(),
    ...sample,
  });
}

function projectSamples(projects, perModuleLimit) {
  const samples = [];
  for (const project of projects) {
    const script = project.scriptDraft || project.script || project.finalScript || '';
    const scriptText = String(script || '');
    if (scriptText) {
      const missing = scriptHeadingsMissing(scriptText);
      if (missing.length || /^好的|下面是|我将|#\s/.test(scriptText.trim())) {
        pushSample(samples, {
          caseId: `script_${project.id}`,
          moduleId: 'scriptFullCreate',
          failureLevel: missing.length ? 'hard' : 'soft',
          failureTags: missing.length ? ['missing_five_part_structure'] : ['prompt_scaffold_leak'],
          inputSnapshot: {
            projectId: project.id,
            title: project.title,
            oneSentence: truncate(project.oneSentence || project.brief || project.description || '', 800),
          },
          oldOutput: truncate(scriptText),
          humanFixSummary: '',
        }, perModuleLimit);
      }
    }

    if (scriptText) {
      const sb = project.styleBible || {};
      const missing = ['visualStyle', 'colorPalette', 'cameraStyle', 'mood'].filter((key) => {
        const val = sb[key] ?? sb.vision;
        return val == null || (Array.isArray(val) ? val.length === 0 : String(val).trim() === '');
      });
      if (missing.length) {
        pushSample(samples, {
          caseId: `style_${project.id}`,
          moduleId: 'styleBible',
          failureLevel: missing.length >= 2 ? 'hard' : 'soft',
          failureTags: missing.map((key) => `missing_${key}`),
          inputSnapshot: { projectId: project.id, script: truncate(scriptText) },
          oldOutput: sb,
          humanFixSummary: '',
          requiredFields: ['visualStyle', 'colorPalette', 'cameraStyle', 'mood'],
        }, perModuleLimit);
      }
    }

    const assets = project.assets || {};
    const characters = asArray(assets.characters || project.characters);
    const scenes = asArray(assets.scenes || project.environments);
    const props = asArray(assets.props || project.props);

    characters.forEach((ch, idx) => {
      const missing = ['name', 'entityType', 'appearance', 'imagePrompt'].filter((key) => !String(ch?.[key] || '').trim());
      if (missing.length) {
        pushSample(samples, {
          caseId: `asset_char_${project.id}_${idx}`,
          moduleId: 'assetCharactersExtract',
          failureLevel: missing.includes('name') || missing.includes('entityType') ? 'hard' : 'soft',
          failureTags: missing.map((key) => `missing_${key}`),
          inputSnapshot: { projectId: project.id, script: truncate(scriptText) },
          oldOutput: ch,
          humanFixSummary: '',
        }, perModuleLimit);
      }
    });

    scenes.forEach((scene, idx) => {
      const missing = ['name', 'location', 'timeSetting', 'weather', 'lighting', 'atmosphere', 'imagePrompt'].filter((key) => !String(scene?.[key] || '').trim());
      if (missing.length) {
        pushSample(samples, {
          caseId: `asset_scene_${project.id}_${idx}`,
          moduleId: 'assetScenesExtract',
          failureLevel: missing.length >= 3 ? 'hard' : 'soft',
          failureTags: missing.map((key) => `missing_${key}`),
          inputSnapshot: { projectId: project.id, script: truncate(scriptText), styleBible: project.styleBible || null },
          oldOutput: scene,
          humanFixSummary: '',
        }, perModuleLimit);
      }
    });

    props.forEach((prop, idx) => {
      const missing = ['name', 'propType', 'function', 'features', 'imagePrompt'].filter((key) => !String(prop?.[key] || '').trim());
      if (missing.length) {
        pushSample(samples, {
          caseId: `asset_prop_${project.id}_${idx}`,
          moduleId: 'assetPropsExtract',
          failureLevel: missing.includes('name') ? 'hard' : 'soft',
          failureTags: missing.map((key) => `missing_${key}`),
          inputSnapshot: { projectId: project.id, script: truncate(scriptText) },
          oldOutput: prop,
          humanFixSummary: '',
        }, perModuleLimit);
      }
    });

    const shots = asArray(project.shots);
    if (shots.length) {
      const badShots = shots.filter((shot) => {
        const dialogue = String(shot?.dialogue || '');
        return !shot?.visual || !shot?.shotType || !shot?.camera || dialogue.length > 45;
      });
      if (shots.length < 6 || shots.length > 14 || badShots.length) {
        pushSample(samples, {
          caseId: `shots_${project.id}`,
          moduleId: 'shotsGenerate',
          failureLevel: shots.length < 6 || shots.length > 14 ? 'hard' : 'soft',
          failureTags: [
            shots.length < 6 || shots.length > 14 ? 'shot_count_out_of_range' : '',
            badShots.length ? 'shot_fields_or_dialogue_budget' : '',
          ].filter(Boolean),
          inputSnapshot: { projectId: project.id, script: truncate(scriptText), assets: truncate(assets, 1600) },
          oldOutput: shots,
          humanFixSummary: '',
        }, perModuleLimit);
      }
    }

    asArray(project.storyboards).forEach((sb, idx) => {
      const prompt = String(sb?.videoPrompt || '');
      const missingSections = ['运镜系统', '角色', '场景', '基调', '约束', '音障'].filter((s) => !prompt.includes(s));
      const leaksRef = /(https?:\/\/|Image\s*\d|reference image\s*\d|ref\s*\d|参考图\s*\d|参考图片|参考图像|对照图)/i.test(prompt);
      if (prompt && (missingSections.length || leaksRef)) {
        pushSample(samples, {
          caseId: `video_prompt_${project.id}_${idx}`,
          moduleId: 'videoPromptGenerate',
          failureLevel: missingSections.length >= 2 ? 'hard' : 'soft',
          failureTags: [
            missingSections.length ? 'missing_video_prompt_sections' : '',
            leaksRef ? 'reference_leak' : '',
          ].filter(Boolean),
          inputSnapshot: { projectId: project.id, groupIdx: idx, shots: truncate(project.shots || [], 1600) },
          oldOutput: prompt,
          humanFixSummary: '',
        }, perModuleLimit);
      }
    });
  }
  return samples;
}

function failedBatchSamples(db, perModuleLimit) {
  const samples = [];
  const rows = db.prepare(`
    SELECT b.project_id, b.batch_type, bt.id AS task_id, bt.seq, bt.target_json, bt.error_msg, bt.created_at
    FROM batch_tasks bt
    JOIN batches b ON b.id = bt.batch_id
    WHERE bt.status = 'failed'
    ORDER BY bt.updated_at DESC
    LIMIT 200
  `).all();
  const map = {
    video_prompts: 'videoPromptGenerate',
    storyboard_prompts: 'storyboardImagePrompt',
  };
  for (const row of rows) {
    const moduleId = map[row.batch_type];
    if (!moduleId) continue;
    pushSample(samples, {
      caseId: `batch_${row.task_id}`,
      moduleId,
      failureLevel: 'hard',
      failureTags: ['batch_failed'],
      inputSnapshot: {
        projectId: row.project_id,
        target: safeJson(row.target_json),
        batchType: row.batch_type,
      },
      oldOutput: row.error_msg || '',
      humanFixSummary: '',
      createdAt: row.created_at || new Date().toISOString(),
    }, perModuleLimit);
  }
  return samples;
}

function safeJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return raw || ''; }
}

function summarize(samples) {
  const byModule = Object.fromEntries(P0_MODULES.map((m) => [m, { total: 0, hard: 0, soft: 0, preference: 0 }]));
  for (const sample of samples) {
    byModule[sample.moduleId] ||= { total: 0, hard: 0, soft: 0, preference: 0 };
    byModule[sample.moduleId].total += 1;
    if (sample.failureLevel in byModule[sample.moduleId]) byModule[sample.moduleId][sample.failureLevel] += 1;
  }
  const exitReadiness = Object.fromEntries(P0_MODULES.map((m) => [m, {
    sampleCount: byModule[m]?.total || 0,
    hasMinimumSamples: (byModule[m]?.total || 0) >= 20,
    humanLabelsKnown: false,
  }]));
  return {
    generatedAt: new Date().toISOString(),
    total: samples.length,
    byModule,
    exitReadiness,
    canStartP0_1: false,
    reason: 'Human labels are not collected by this script; complete labels before P0-1.',
  };
}

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db);
if (!existsSync(dbPath)) {
  console.error(JSON.stringify({ error: `DB not found: ${dbPath}` }, null, 2));
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const projects = db.prepare('SELECT id, owner_id, title, data_json FROM projects ORDER BY updated_at DESC LIMIT 200').all().map(parseProject);
const samples = [
  ...projectSamples(projects, args.perModuleLimit),
  ...failedBatchSamples(db, args.perModuleLimit),
];
const deduped = Array.from(new Map(samples.map((sample) => [sample.caseId, sample])).values());
const report = summarize(deduped);
console.log(JSON.stringify(report, null, 2));

if (args.write) {
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, deduped.map((sample) => JSON.stringify(sample)).join('\n') + (deduped.length ? '\n' : ''));
  console.log(JSON.stringify({ wrote: outPath, samples: deduped.length }, null, 2));
}
