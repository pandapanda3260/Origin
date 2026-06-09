import { getDb } from '../lib/db';
import { resolveLLMConfig } from '../lib/llm';
import { resolveTextModelConfig, type ResolvedModelConfig, type TextModelRole } from '../lib/model-routing';

type Finding = {
  source: string;
  model: string;
  consumptionType: string;
  reason: string;
};

const textRoles: TextModelRole[] = [
  'brain',
  'structured',
  'styleBible',
  'projectClassifier',
  'styleClassifier',
  'profileDerive',
  'continuity',
  'frameConsistencyCheck',
];

const requiredActiveRows = [
  ['claude-opus-4-8', 'text_input'],
  ['claude-opus-4-8', 'text_output'],
  ['gpt-5.5', 'text_input'],
  ['gpt-5.5', 'text_output'],
  ['gpt-5.5', 'text_cached'],
  ['gpt-5.4', 'text_input'],
  ['gpt-5.4', 'text_output'],
  ['doubao-seed-2-0-pro-260215', 'text_input'],
  ['doubao-seed-2-0-pro-260215', 'text_output'],
  ['doubao-seed-2-0-pro-260215', 'text_cached'],
  ['doubao-seedream-4-5-251128', 'image_count'],
  ['doubao-seedance-2-0-260128', 'video_second'],
] as const;

const requiredProbeRows = [
  ['gpt-image-2', 'image_text_input'],
  ['gpt-image-2', 'image_input'],
  ['gpt-image-2', 'image_output'],
] as const;

const db = getDb();
const findings: Finding[] = [];
const checkedConfigured: string[] = [];

for (const [model, consumptionType] of requiredActiveRows) {
  if (!hasPrice(model, consumptionType, 'active')) {
    findings.push({ source: 'api_price_catalog seed', model, consumptionType, reason: 'missing active v0 price row' });
  }
}

for (const [model, consumptionType] of requiredProbeRows) {
  if (!hasPrice(model, consumptionType, 'requires_probe')) {
    findings.push({ source: 'api_price_catalog seed', model, consumptionType, reason: 'missing requires_probe v0 price row' });
  }
}

for (const role of textRoles) {
  const cfg = resolveTextModelConfig(null, role);
  checkTextConfig(`default text role:${role}`, cfg);
}

checkImageConfig('default image slot', resolveLLMConfig(null, 'image'));
checkVideoConfig('default video slot', resolveLLMConfig(null, 'video'));

if (findings.length) {
  console.error('FAIL: usage price coverage gaps found.');
  for (const item of findings) {
    console.error(`- ${item.source}: ${item.model}/${item.consumptionType} ${item.reason}`);
  }
  process.exit(1);
}

console.log(`OK: usage price coverage passed. checkedConfigured=${checkedConfigured.length ? checkedConfigured.join(', ') : 'none-real-configured'}`);

function checkTextConfig(source: string, cfg: ResolvedModelConfig) {
  if (cfg.mode !== 'real') return;
  const model = String(cfg.model || '').trim();
  if (!model) return;
  checkedConfigured.push(`${source}:${model}`);
  for (const consumptionType of ['text_input', 'text_output']) {
    if (!hasPrice(model, consumptionType, 'active')) {
      findings.push({ source, model, consumptionType, reason: 'configured real text model has no active price' });
    }
  }
}

function checkImageConfig(source: string, cfg: ResolvedModelConfig) {
  if (cfg.mode !== 'real') return;
  const model = String(cfg.model || '').trim();
  if (!model) return;
  checkedConfigured.push(`${source}:${model}`);
  if (/^gpt-image-2$/i.test(model)) {
    for (const consumptionType of ['image_text_input', 'image_input', 'image_output']) {
      if (!hasPrice(model, consumptionType, 'requires_probe')) {
        findings.push({ source, model, consumptionType, reason: 'gpt-image-2 must remain requires_probe until live usage probe' });
      }
    }
    return;
  }
  if (!hasPrice(model, 'image_count', 'active')) {
    findings.push({ source, model, consumptionType: 'image_count', reason: 'configured real image model has no active per-image price' });
  }
}

function checkVideoConfig(source: string, cfg: ResolvedModelConfig) {
  if (cfg.mode !== 'real') return;
  const model = String(cfg.model || '').trim();
  if (!model) return;
  checkedConfigured.push(`${source}:${model}`);
  if (!hasPrice(model, 'video_second', 'active')) {
    findings.push({ source, model, consumptionType: 'video_second', reason: 'configured real video model has no active per-second price' });
  }
}

function hasPrice(model: string, consumptionType: string, status: 'active' | 'requires_probe') {
  const row = db.prepare(
    `SELECT id
       FROM api_price_catalog
      WHERE model = @model
        AND consumption_type = @consumptionType
        AND status = @status
      LIMIT 1`,
  ).get({ model, consumptionType, status });
  return !!row;
}
