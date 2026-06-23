#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.ORIGIN_ENV_FILE;
process.env.ORIGIN_ENV_FILES = '/tmp/origin-missing-test-env-file';
process.env.TEXT_API_KEY = 'dummy-key';
process.env.TEXT_PROVIDER = 'openai_responses';
process.env.TEXT_API_BASE = 'https://example.invalid/v1';
process.env.TEXT_MODEL = 'gpt-test';
process.env.TEXT_REASONING_EFFORT = 'xhigh';
delete process.env.STRUCTURED_REASONING_EFFORT;
delete process.env.VISION_EXTRACT_REASONING_EFFORT;

require('./_ts-require-hook.js');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function count(source, needle) {
  return (source.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} exists`);
  const markers = ['\nasync function ', '\nfunction ', '\nexport async function ', '\nexport function '];
  const end = markers
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((idx) => idx > start)
    .sort((a, b) => a - b)[0];
  return source.slice(start, end || source.length);
}

function assertVisionPromptContract(file, functionName) {
  const source = read(file);
  assert.equal(
    count(source, "resolveTextModelConfig(user, 'structured')"),
    1,
    `${file} keeps exactly one structured text branch`,
  );
  assert.equal(
    count(source, "resolveTextModelConfig(user, 'visionExtract')"),
    1,
    `${file} keeps exactly one visionExtract vision branch`,
  );
  const body = functionBody(source, functionName);
  assert.match(body, /resolveTextModelConfig\(user,\s*'visionExtract'\)/, `${functionName} uses visionExtract config`);
  assert.match(body, /modelRole:\s*'visionExtract'\s+as const/, `${functionName} tags usage as visionExtract`);
  assert.match(body, /maxTokens:\s*1600/, `${functionName} requests 1600 tokens`);
  assert.match(body, /\?\?\s*1600/, `${functionName} fallback max output is 1600`);
  assert.doesNotMatch(body, /modelRole:\s*'structured'/, `${functionName} must not tag structured`);
  assert.doesNotMatch(body, /maxTokens:\s*8192/, `${functionName} must not keep old 8192 budget`);
}

function assertStaticContracts() {
  const modelRouting = read('lib/model-routing.ts');
  assert.match(modelRouting, /\|\s*'visionExtract'/, 'TextModelRole includes visionExtract');
  assert.match(
    modelRouting,
    /role === 'frameConsistencyCheck'\s*\|\|\s*role === 'visionExtract'\s*\?\s*'none'/,
    'visionExtract is anchored in the reasoningEffort none branch',
  );
  assert.match(
    modelRouting,
    /visionExtract:\s*redactConfig\(resolveTextModelConfig\(user,\s*'visionExtract'\)\)/,
    'model routing status exposes visionExtract',
  );
  assert.match(modelRouting, /VISION_EXTRACT_\$\{suffix\}/, 'capacity env names include VISION_EXTRACT');
  assert.match(modelRouting, /return 'VISION_EXTRACT'/, 'roleEnvPrefix maps visionExtract to VISION_EXTRACT');

  const governance = read('docs/model-config-governance.md');
  assert.match(governance, /`visionExtract`/, 'governance docs list visionExtract');
  assert.match(
    governance,
    /does not inherit `TEXT_REASONING_EFFORT`/,
    'governance docs state visionExtract does not inherit TEXT_REASONING_EFFORT',
  );

  assertVisionPromptContract('lib/custom-scene-prompt.ts', 'structureVisionScene');
  assertVisionPromptContract('lib/custom-character-prompt.ts', 'structureVisionCharacter');
}

function assertRuntimeContracts() {
  const { resolveTextModelConfig, getModelRoutingStatus } = require('../lib/model-routing.ts');
  const structured = resolveTextModelConfig(null, 'structured');
  const visionExtract = resolveTextModelConfig(null, 'visionExtract');
  assert.equal(structured.mode, 'real', 'structured resolves to configured text model');
  assert.equal(visionExtract.mode, 'real', 'visionExtract resolves to configured text model');
  assert.equal(structured.reasoningEffort, 'xhigh', 'structured still inherits TEXT_REASONING_EFFORT');
  assert.equal(visionExtract.reasoningEffort, 'none', 'visionExtract defaults to none even when TEXT_REASONING_EFFORT=xhigh');
  assert.equal(visionExtract.model, 'gpt-test', 'visionExtract falls back to TEXT_MODEL');
  assert.equal(visionExtract.provider, 'openai_responses', 'visionExtract falls back to TEXT_PROVIDER');
  assert.equal(visionExtract.apiKey, 'dummy-key', 'visionExtract falls back to TEXT_API_KEY');

  const status = getModelRoutingStatus(null);
  assert.equal(status.structured.reasoningEffort, 'xhigh', 'status keeps structured xhigh');
  assert.equal(status.visionExtract.reasoningEffort, 'none', 'status exposes visionExtract none');
  assert.equal(status.visionExtract.apiKey, '[configured]', 'status redacts configured API key');
}

function main() {
  assertStaticContracts();
  assertRuntimeContracts();
  console.log('custom vision model role contracts passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
