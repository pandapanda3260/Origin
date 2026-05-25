import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  emptyScriptConsultState,
  isEmptyScriptConsultState,
  normalizeScriptConsultState,
} from '../lib/script-consult-state';

async function loadClientModule() {
  return import(pathToFileURL(resolve('public/modules/script_consult_state.js')).href);
}

const cases: Array<[string, any, boolean]> = [
  ['missing state', undefined, true],
  ['empty object', {}, true],
  ['explicit empty', emptyScriptConsultState(), true],
  ['empty messages but stale outline', { messages: [], outline: 'old', ready: false }, false],
  ['empty messages but ready', { messages: [], outline: '', ready: true }, false],
  ['empty messages but startedAt', { messages: [], outline: '', ready: false, startedAt: '2026-05-21T00:00:00Z' }, false],
  ['one message', { messages: [{ role: 'user', content: 'hello' }], outline: '', ready: false }, false],
];

async function main() {
  const client = await loadClientModule();

  for (const [name, input, expected] of cases) {
    assert.equal(isEmptyScriptConsultState(input), expected, `server isEmpty: ${name}`);
    assert.equal(client.isEmptyScriptConsultState(input), expected, `client isEmpty: ${name}`);
    assert.deepEqual(
      client.normalizeScriptConsultState(input),
      normalizeScriptConsultState(input),
      `client/server normalize parity: ${name}`,
    );
  }

  const normalized = normalizeScriptConsultState({
    messages: [
      { role: 'user', content: '  hi  ' },
      { role: 'assistant', content: '' },
      null,
    ],
    outline: 123,
    ready: 1,
    startedAt: '',
    confirmedAt: 'done',
  });
  assert.equal(normalized.messages.length, 1);
  assert.equal(normalized.outline, '123');
  assert.equal(normalized.ready, true);
  assert.equal(normalized.startedAt, null);
  assert.equal(normalized.confirmedAt, 'done');

  console.log('[test-script-consult-state] ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
