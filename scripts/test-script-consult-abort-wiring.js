const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const utilsSource = readFileSync(join(root, 'public/modules/utils.js'), 'utf8');
const scriptSource = readFileSync(join(root, 'public/modules/script.js'), 'utf8');

// 注：前端超时改造后 apiPostStream 不再把 options.signal 直接塞进 fetch options，
// 而是 externalSignal → 内部 AbortController 联动（外部 abort 转发进内部 ctl）。
// 契约改锁这套接线，保护意图不变：外部 AbortController 必须能中断流式请求。
assert.match(
  utilsSource,
  /const externalSignal = options\.signal;/,
  'apiPostStream must read the external AbortController signal from options',
);
assert.match(
  utilsSource,
  /function onExternalAbort\(\)/,
  'apiPostStream must forward external aborts into its internal controller',
);

assert.match(
  scriptSource,
  /new AbortController\(\)/,
  'script consult requests must create an AbortController',
);

assert.match(
  scriptSource,
  /apiPostStream\("\/api\/script\/workflow\/consult\/turn"[\s\S]{0,800}?\{ signal: guard\.controller\.signal \}/,
  'consult turn stream must pass the active guard signal to apiPostStream',
);

assert.match(
  scriptSource,
  /apiPostStream\("\/api\/script\/workflow\/consult\/confirm"[\s\S]{0,800}?\{ signal: guard\.controller\.signal \}/,
  'consult confirm stream must pass the active guard signal to apiPostStream',
);

console.log('[test-script-consult-abort-wiring] ok');
