#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-brain-text-fallback-'));
process.env.ORIGIN_ENV_FILE = path.join(tempDir, 'empty.env');
delete process.env.ORIGIN_ENV_FILES;
fs.writeFileSync(process.env.ORIGIN_ENV_FILE, '');
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');

process.env.CLAUDE_API_KEY = 'claude-key';
process.env.CLAUDE_PROVIDER = 'zerail_messages';
process.env.CLAUDE_API_BASE = 'https://gateway.example/v1';
process.env.CLAUDE_API_ENDPOINT = '/messages';
process.env.CLAUDE_MODEL = 'claude-opus-4-8';
process.env.TEXT_API_KEY = 'text-key';
process.env.TEXT_PROVIDER = 'zerail_responses';
process.env.TEXT_API_BASE = 'https://gateway.example/v1';
process.env.TEXT_API_ENDPOINT = '/responses';
process.env.TEXT_MODEL = 'gpt-5.5';
process.env.TEXT_REASONING_EFFORT = 'none';
delete process.env.CODE80_API_KEY;
delete process.env.TEXT_FALLBACK_API_KEY;
delete process.env.AI_API_PROXY;
delete process.env.OPENAI_API_PROXY;
delete process.env.AI_API_PROXY_HOSTS;
delete process.env.OPENAI_API_PROXY_HOSTS;

require('./_ts-require-hook.js');

const { chatStream } = require('../lib/llm.ts');
const { resolveTextModelConfig } = require('../lib/model-routing.ts');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(text) {
  return new Response(text.endsWith('\n\n') ? text : `${text}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function testBrainConfigHasTextFallback() {
  const cfg = resolveTextModelConfig(null, 'brain');
  assert.equal(cfg.provider, 'zerail_messages');
  assert.equal(cfg.model, 'claude-opus-4-8');
  assert.equal(cfg.fallbackConfigs?.length, 1);
  assert.equal(cfg.fallbackConfigs[0].provider, 'zerail_responses');
  assert.equal(cfg.fallbackConfigs[0].model, 'gpt-5.5');
  assert.equal(cfg.fallbackConfigs[0].fallbackOf, 'zerail_messages:claude-opus-4-8');
}

async function testStreamFallsBackBeforeAnyChunk() {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url: String(url), body });
    if (calls.length === 1) {
      return jsonResponse({
        error: {
          message: 'No available channel for model claude-opus-4-8 under group intnl_sail',
        },
      }, 503);
    }
    return sseResponse([
      'data: {"type":"response.output_text.delta","delta":"pong"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'));
  };

  let output = '';
  const result = await chatStream(
    null,
    [{ role: 'user', content: 'Reply exactly: pong' }],
    { modelRole: 'brain', traceName: 'brain-fallback-contract', maxTokens: 32 },
    (chunk) => { output += chunk; },
  );

  assert.equal(result, 'pong');
  assert.equal(output, 'pong');
  assert.equal(calls.length, 2, 'stream should retry through text fallback');
  assert.match(calls[0].url, /\/messages$/);
  assert.match(calls[1].url, /\/responses$/);
  assert.equal(calls[0].body.model, 'claude-opus-4-8');
  assert.equal(calls[1].body.model, 'gpt-5.5');
}

async function testDoesNotFallbackAfterPartialChunk() {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ url: String(url), body });
    return sseResponse([
      'data: {"type":"content_block_delta","delta":{"text":"partial"}}',
      '',
      'data: {"error":{"message":"upstream closed"}}',
      '',
    ].join('\n'));
  };

  let output = '';
  let thrown = null;
  try {
    await chatStream(
      null,
      [{ role: 'user', content: 'Reply exactly: pong' }],
      { modelRole: 'brain', traceName: 'brain-fallback-partial-contract', maxTokens: 32 },
      (chunk) => { output += chunk; },
    );
  } catch (error) {
    thrown = error;
  }

  assert(thrown, 'partial primary output should not be hidden by fallback');
  assert.match(String(thrown.message || thrown), /upstream closed/);
  assert.equal(output, 'partial');
  assert.equal(calls.length, 1, 'fallback must not run after user-visible chunks');
}

async function main() {
  try {
    await testBrainConfigHasTextFallback();
    await testStreamFallsBackBeforeAnyChunk();
    await testDoesNotFallbackAfterPartialChunk();
    console.log('brain text fallback contract passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
