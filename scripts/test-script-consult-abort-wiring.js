const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const utilsSource = readFileSync(join(root, 'public/modules/utils.js'), 'utf8');
const scriptSource = readFileSync(join(root, 'public/modules/script.js'), 'utf8');

assert.match(
  utilsSource,
  /if \(options && options\.signal\) fetchOptions\.signal = options\.signal;/,
  'apiPostStream must pass AbortController.signal into fetch options',
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
