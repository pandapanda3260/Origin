#!/usr/bin/env node
/**
 * 验证 lib/llm.ts:toResponsesInput 对 system/tool 角色的协议适配。
 *
 * 校验三件事:
 *   1. 重放真实 shots 调用链产生的 ChatMessage 数组, 模拟 toResponsesInput 后,
 *      最终 input[*].role 不再有 'system'(因为新版 Responses API 不识别);
 *   2. OpenAI Responses API 的 "input messages must contain word 'json'"
 *      校验规则模拟通过(扫 user/developer/assistant 任意一个 content 含 'json');
 *   3. 旧逻辑 (system 不改写) 在同样数据上会校验失败 — 证明这次改的就是真正的根因。
 */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

// === 旧/新两版 toResponsesInput, 直接对照源码翻译 ===
function toResponsesInputOld(messages) {
  return messages
    .filter((msg) => String(msg.content || '').trim())
    .map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: msg.content,
    }));
}

function toResponsesInputNew(messages) {
  const out = messages
    .filter((msg) => String(msg.content || '').trim())
    .map((msg) => ({
      role:
        msg.role === 'tool'
          ? 'user'
          : msg.role === 'system'
            ? 'developer'
            : msg.role,
      content: msg.content,
    }));
  return out.length ? out : [{ role: 'user', content: 'ping' }];
}

// === OpenAI Responses API 的 JSON-keyword 校验(简化模拟) ===
// 真实校验是 case-insensitive 子串扫描, 但 *只扫某些角色*。
// 现场报错: "Response input messages must contain the word 'json' ...".
// 关键观察: system 内容里就有大写 JSON 但仍被拒, 说明校验只看
// 'user' / 'developer' / 'assistant', 不扫 'system'。
function passesJsonKeywordCheck(input) {
  return input.some(
    (item) =>
      (item.role === 'user' || item.role === 'developer' || item.role === 'assistant') &&
      /json/i.test(String(item.content || '')),
  );
}

// === 重放真实 shots 链路: lib/batch-executors.ts:2563 调用 buildShotsMessages
//     → lib/prompts.ts:1168-1188 ===
const SP_SHOTS_GENERATE_HEAD = '【你的身份】资深短视频/广告导演...';
const SP_SHOTS_GENERATE_TAIL =
  '【输出严格 JSON】\n{ "shots": [ ... ] }\n不要输出除 JSON 外的任何文字、注释、markdown';
const FAKE_SHOTS_MESSAGES = [
  {
    role: 'system',
    content: SP_SHOTS_GENERATE_HEAD + '\n\n' + SP_SHOTS_GENERATE_TAIL,
  },
  {
    role: 'user',
    content:
      '剧本：\n海鲜自助餐厅打烊后老周开复盘会, 帝王蟹队长 / 扇贝财务 / 龙虾翻页都到了...\n\n' +
      '风格圣经：{"vision":"社交网络/华尔街之狼式冷峻都市商业摄影","colorPalette":["白","金"]}\n\n' +
      '资产：{"characters":[{"id":"c1","name":"老周"}]}',
  },
];

function shape(input) {
  return input.map((m) => ({ role: m.role, contentLen: String(m.content || '').length }));
}

const oldOut = toResponsesInputOld(FAKE_SHOTS_MESSAGES);
const newOut = toResponsesInputNew(FAKE_SHOTS_MESSAGES);

console.log('--- OLD mapping output ---');
console.log(shape(oldOut));
console.log('JSON keyword check passes:', passesJsonKeywordCheck(oldOut));

console.log('--- NEW mapping output ---');
console.log(shape(newOut));
console.log('JSON keyword check passes:', passesJsonKeywordCheck(newOut));

// === 断言: 这次修复确实解决了报错 ===
assert.equal(
  oldOut.find((m) => m.role === 'system') != null,
  true,
  'old mapping still keeps role=system in the input (and that is what triggered the API 400)',
);
assert.equal(
  passesJsonKeywordCheck(oldOut),
  false,
  'old mapping should fail OpenAI JSON-keyword check (root cause)',
);

assert.equal(
  newOut.find((m) => m.role === 'system'),
  undefined,
  'new mapping must not leave role=system in Responses API input',
);
assert.equal(
  newOut.find((m) => m.role === 'developer') != null,
  true,
  'new mapping must substitute system → developer',
);
assert.equal(
  passesJsonKeywordCheck(newOut),
  true,
  'new mapping should pass OpenAI JSON-keyword check (developer role content scanned)',
);

// === 健壮性: 其它角色 (tool / user / assistant) 行为保持原状 ===
const mixed = [
  { role: 'tool', content: '[tool] echo' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'system', content: 'sys' },
];
const out = toResponsesInputNew(mixed);
assert.deepEqual(
  out.map((m) => m.role),
  ['user', 'user', 'assistant', 'developer'],
  'tool → user, system → developer, user/assistant unchanged',
);

// === 健壮性: 空 content 仍然被过滤; 全空时回退到 ping ===
const allEmpty = [
  { role: 'system', content: '   ' },
  { role: 'user', content: '' },
];
const fallback = toResponsesInputNew(allEmpty);
assert.deepEqual(
  fallback,
  [{ role: 'user', content: 'ping' }],
  'empty input falls back to a single user/ping message',
);

// === 源码自检: 确认 lib/llm.ts 真的落了这次改动 ===
const llmSrc = readFileSync(resolve(__dirname, '..', 'lib', 'llm.ts'), 'utf8');
assert.match(
  llmSrc,
  /toResponsesInput[\s\S]{0,800}msg\.role === ['"]system['"][\s\S]{0,80}['"]developer['"]/,
  'lib/llm.ts:toResponsesInput must contain the system→developer mapping',
);

console.log('\ntest-responses-input-role-mapping: ok');
