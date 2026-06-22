import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const llmSource = readFileSync(new URL('../lib/llm.ts', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const deployEnvExample = readFileSync(new URL('../deploy/origin.env.example', import.meta.url), 'utf8');
const retryClassifierStart = llmSource.indexOf('function classifyJsonRetryError');
const retryClassifierEnd = llmSource.indexOf('/* ============================================================', retryClassifierStart);
assert(retryClassifierStart >= 0 && retryClassifierEnd > retryClassifierStart, 'classifyJsonRetryError block should be found');
const retryClassifierSource = llmSource.slice(retryClassifierStart, retryClassifierEnd);

assert.match(
  llmSource,
  /function isBackgroundSubmitTimeoutMessage\(message: string\): boolean \{[\s\S]*?background submit 超时[\s\S]*?submit 超时[\s\S]*?未确认入队[\s\S]*?\}/,
  'background submit timeout classifier should be anchored to submit-specific messages',
);

assert.match(
  retryClassifierSource,
  /isBackgroundSubmitTimeoutMessage\(message\)[\s\S]*?return \{ retryable: false, reason: 'submit_timeout' \};/,
  'submit_timeout must remain non-retryable in P0 to avoid duplicate provider submissions',
);

assert.doesNotMatch(
  retryClassifierSource,
  /lower\.includes\('超时'\)/,
  'generic Chinese timeout matching must not be used in the JSON retry classifier',
);

assert.match(
  envExample,
  /^LLM_BACKGROUND_SUBMIT_TIMEOUT_MS=90000$/m,
  '.env.example should document the 90s submit timeout',
);
assert.match(
  deployEnvExample,
  /^LLM_BACKGROUND_SUBMIT_TIMEOUT_MS=90000$/m,
  'deploy/origin.env.example should document the 90s submit timeout',
);

console.log('test-llm-submit-timeout-contract: ok');
