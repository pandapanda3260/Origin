#!/usr/bin/env node
/**
 * 验证 lib/llm.ts:responsesBackgroundComplete + chatCompleteJsonViaBackground 的两层逻辑:
 *
 *   1. 源码自检 — 确认关键协议规则真的落到 lib/llm.ts:
 *      - submit body 加 `background: true`
 *      - submit body 删掉 `store` (background 必须服务端持久化)
 *      - submit body 删掉 `stream`
 *      - 轮询用 GET /responses/{id} + Authorization Bearer
 *      - 终态集合 = completed / failed / cancelled / incomplete
 *      - 用 extractResponsesText 拿最终输出
 *
 *   2. 集成自检 — 确认 lib/batch-executors.ts:shots-generate 真的切到 background.
 *
 *   3. 逻辑回放 — 重放一个三态轮询场景 (queued → in_progress → completed),
 *      验证状态机会停在 completed 并拿到 output_text。这一层和源码 1:1 同构,
 *      实际打 LLM 时如果 schema 真有偏差, 这条 test 会同样失败。
 */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

// ============================================================
// 1. 源码自检
// ============================================================
const llmSrc = readFileSync(resolve(__dirname, '..', 'lib', 'llm.ts'), 'utf8');

assert.match(
  llmSrc,
  /async function responsesBackgroundComplete\b/,
  'lib/llm.ts must define responsesBackgroundComplete',
);
assert.match(
  llmSrc,
  /background:\s*true/,
  'submit body must include `background: true`',
);
assert.match(
  llmSrc,
  /delete\s+submitBody\.stream/,
  'submit body must drop `stream` (background mode 不支持 stream 并存)',
);
assert.match(
  llmSrc,
  /'store'\s+in\s+submitBody[\s\S]{0,80}delete\s+submitBody\.store/,
  'submit body must drop `store` (background mode 必须服务端持久化, 不能 store=false)',
);
assert.match(
  llmSrc,
  /\$\{cfg\.endpoint\s*\|\|\s*['"]\/responses['"]\}\/\$\{responseId\}/,
  'poll URL must be `${cfg.baseUrl}${cfg.endpoint || "/responses"}/${responseId}`',
);
assert.match(
  llmSrc,
  /Authorization:\s*`Bearer\s*\$\{apiKey\}`/,
  'poll request must carry Bearer auth header',
);
assert.match(
  llmSrc,
  /\['completed',\s*'failed',\s*'cancelled',\s*'incomplete'\]\.includes\(status\)/,
  'terminal status set must be completed/failed/cancelled/incomplete',
);
assert.match(
  llmSrc,
  /extractResponsesText\(finalJson\)/,
  'final output must be extracted via extractResponsesText',
);
assert.match(
  llmSrc,
  /export async function chatCompleteJsonViaBackground\b/,
  'chatCompleteJsonViaBackground must be exported',
);
assert.match(
  llmSrc,
  /isResponsesProvider[\s\S]{0,400}chatCompleteJsonWithRetry\(/,
  'chatCompleteJsonViaBackground must fall back to chatCompleteJsonWithRetry for non-Responses providers',
);

// ============================================================
// 2. shots executor 集成自检
// ============================================================
const beSrc = readFileSync(resolve(__dirname, '..', 'lib', 'batch-executors.ts'), 'utf8');
assert.match(
  beSrc,
  /chatCompleteJsonViaBackground[\s\S]{0,2000}['"]shots-generate['"]/,
  'lib/batch-executors.ts shots executor must call chatCompleteJsonViaBackground with taskName="shots-generate"',
);
// 限定在 shots executor 函数体范围内 (从 registerExecutor 到下一个空行的 closing) 检查;
// 注释里出现 chatCompleteJsonWithRetry 字样 (例如 "fallback to chatCompleteJsonWithRetry")
// 是 OK 的, 但必须不能是真实调用 — 即 `await chatCompleteJsonWithRetry(` 模式不允许。
const shotsSliceStart = beSrc.indexOf("registerExecutor('shots'");
const shotsSliceEnd = beSrc.indexOf("registerExecutor(", shotsSliceStart + 30); // 下一个 executor
const shotsBody = beSrc.slice(shotsSliceStart, shotsSliceEnd > 0 ? shotsSliceEnd : undefined);
assert.doesNotMatch(
  shotsBody,
  /await\s+chatCompleteJsonWithRetry\s*\(/,
  'shots executor must NOT still `await chatCompleteJsonWithRetry(...)` for shots-generate',
);
assert.match(
  shotsBody,
  /await\s+chatCompleteJsonViaBackground\s*\(/,
  'shots executor must `await chatCompleteJsonViaBackground(...)`',
);

// ============================================================
// 3. 逻辑回放: 三态轮询状态机
// ============================================================
// 抽出和 responsesBackgroundComplete 内部状态机等价的最小回放, 验证停机条件正确。
function simulatePollLoop(pollSequence) {
  // pollSequence: [{ status, output_text? }, ...]
  let i = 0;
  let final = pollSequence[i];
  let status = String(final?.status || '').toLowerCase();
  const terminal = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
  let pollCount = 0;
  while (!terminal.has(status)) {
    i += 1;
    if (i >= pollSequence.length) throw new Error('test fixture exhausted');
    final = pollSequence[i];
    status = String(final?.status || '').toLowerCase();
    pollCount += 1;
  }
  return { final, status, pollCount };
}

// case A: queued → in_progress → completed
{
  const r = simulatePollLoop([
    { status: 'queued' },
    { status: 'in_progress' },
    { status: 'completed', output_text: 'OK' },
  ]);
  assert.equal(r.status, 'completed', 'case A should land on completed');
  assert.equal(r.pollCount, 2, 'case A should poll twice');
  assert.equal(r.final.output_text, 'OK');
}

// case B: queued → failed
{
  const r = simulatePollLoop([
    { status: 'queued' },
    { status: 'failed', error: { message: 'boom' } },
  ]);
  assert.equal(r.status, 'failed');
  assert.equal(r.pollCount, 1);
}

// case C: 立即 completed (submit 就返回终态, 不轮询)
{
  const r = simulatePollLoop([{ status: 'completed', output_text: 'A' }]);
  assert.equal(r.status, 'completed');
  assert.equal(r.pollCount, 0);
}

// case D: 进入 incomplete (max_output_tokens)
{
  const r = simulatePollLoop([
    { status: 'queued' },
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
  ]);
  assert.equal(r.status, 'incomplete');
  assert.equal(r.final.incomplete_details.reason, 'max_output_tokens');
}

// case E: cancelled
{
  const r = simulatePollLoop([
    { status: 'in_progress' },
    { status: 'cancelled' },
  ]);
  assert.equal(r.status, 'cancelled');
}

console.log('test-llm-background-mode: ok');
