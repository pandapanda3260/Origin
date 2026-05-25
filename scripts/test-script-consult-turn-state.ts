import assert from 'node:assert/strict';
import {
  normalizeConsultTurnHistoryPayload,
  selectConsultTurnHistory,
} from '../lib/script-consult-turn-state';

const dbMessages = [
  { role: 'user', content: 'db user message' },
  { role: 'assistant', content: 'db assistant message', readyToDraft: true },
];
const bodyWithMessages = {
  messages: [
    { role: 'user', content: 'request user history' },
    { role: 'assistant', content: 'request assistant history', readyToDraft: true },
  ],
};

const guarded = selectConsultTurnHistory(dbMessages, bodyWithMessages, true);
assert.equal(guarded.requestIncludedHistory, true);
assert.equal(guarded.usedRequestHistory, false);
assert.equal(guarded.source, 'db_existing_plus_current_turn');
assert.deepEqual(guarded.history.map((m) => m.content), ['db user message', 'db assistant message']);

const rollback = selectConsultTurnHistory(dbMessages, bodyWithMessages, false);
assert.equal(rollback.requestIncludedHistory, true);
assert.equal(rollback.usedRequestHistory, true);
assert.equal(rollback.source, 'request_history_plus_current_turn');
assert.deepEqual(rollback.history.map((m) => m.content), ['request user history', 'request assistant history']);
assert.equal(rollback.history[1].readyToDraft, true);

const historyAlias = normalizeConsultTurnHistoryPayload({
  history: [
    { role: 'user', message: 'message field fallback' },
    { role: 'other', text: 'text field fallback' },
    { role: 'assistant', content: '   ' },
    null,
  ],
});
assert.deepEqual(historyAlias, [
  { role: 'user', content: 'message field fallback' },
  { role: 'assistant', content: 'text field fallback' },
]);

const malformed = selectConsultTurnHistory(dbMessages, { messages: [{ role: 'user', content: '' }] }, false);
assert.equal(malformed.requestIncludedHistory, true);
assert.equal(malformed.usedRequestHistory, false);
assert.equal(malformed.source, 'db_existing_plus_current_turn');
assert.deepEqual(malformed.history.map((m) => m.content), ['db user message', 'db assistant message']);

console.log('[test-script-consult-turn-state] ok');
