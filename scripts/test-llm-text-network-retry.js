#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-llm-network-retry-'));
process.env.ORIGIN_ENV_FILE = path.join(tempDir, 'empty.env');
delete process.env.ORIGIN_ENV_FILES;
fs.writeFileSync(process.env.ORIGIN_ENV_FILE, '');
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.TEXT_API_KEY = 'dummy-key';
process.env.TEXT_PROVIDER = 'openai_responses';
process.env.TEXT_API_BASE = 'https://example.invalid/v1';
process.env.TEXT_MODEL = 'gpt-test';
process.env.TEXT_REASONING_EFFORT = 'none';
process.env.LLM_TEXT_NETWORK_RETRY_ATTEMPTS = '2';
process.env.LLM_TEXT_NETWORK_RETRY_DELAY_MS = '0';
delete process.env.AI_API_PROXY;
delete process.env.OPENAI_API_PROXY;
delete process.env.AI_API_PROXY_HOSTS;
delete process.env.OPENAI_API_PROXY_HOSTS;

require('./_ts-require-hook.js');

const { chatComplete } = require('../lib/llm.ts');

function transientNetworkError() {
  const cause = new Error('read ETIMEDOUT');
  cause.code = 'ETIMEDOUT';
  cause.errno = -60;
  cause.syscall = 'read';
  const err = new TypeError('fetch failed');
  err.cause = cause;
  return err;
}

function okResponsesJson(outputText) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'completed',
      output_text: outputText,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }),
    text: async () => JSON.stringify({ output_text: outputText }),
  };
}

async function expectThrows(fn, matcher, message) {
  let thrown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assert(thrown, message);
  if (matcher) assert.match(String(thrown.message || thrown), matcher, message);
}

async function testRetriesTransientTextNetworkErrorOnce() {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body || '') });
    if (calls.length === 1) throw transientNetworkError();
    return okResponsesJson('retry ok');
  };

  const result = await chatComplete(null, [{ role: 'user', content: 'hello' }], {
    modelRole: 'structured',
    traceName: 'llm-network-retry-contract',
    maxTokens: 50,
  });

  assert.equal(result, 'retry ok');
  assert.equal(calls.length, 2, 'transient text network error should retry once');
}

async function testDoesNotRetryWhenOuterAttemptLoopOwnsRetry() {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw transientNetworkError();
  };

  await expectThrows(
    () => chatComplete(null, [{ role: 'user', content: 'hello' }], {
      modelRole: 'structured',
      traceName: 'llm-network-retry-owned-by-outer-loop',
      maxTokens: 50,
      traceAttempt: 1,
      traceMaxAttempts: 3,
    }),
    /fetch failed/,
    'outer retry loop calls must not receive a hidden extra retry',
  );
  assert.equal(calls, 1, 'traceMaxAttempts disables internal network retry');
}

async function testDoesNotRetryApplicationTimeout() {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('LLM 请求超时（>900s 未返回）');
  };

  await expectThrows(
    () => chatComplete(null, [{ role: 'user', content: 'hello' }], {
      modelRole: 'structured',
      traceName: 'llm-network-retry-timeout-contract',
      maxTokens: 50,
    }),
    /LLM 请求超时/,
    'application-level timeout must not be retried by transient network retry',
  );
  assert.equal(calls, 1, 'application timeout is not a transient network retry');
}

async function main() {
  try {
    await testRetriesTransientTextNetworkErrorOnce();
    await testDoesNotRetryWhenOuterAttemptLoopOwnsRetry();
    await testDoesNotRetryApplicationTimeout();
    console.log('llm text network retry contract passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
