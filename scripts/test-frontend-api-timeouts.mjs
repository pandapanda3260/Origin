import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/utils.js', import.meta.url), 'utf8');

assert.match(source, /const DEFAULT_API_TIMEOUT_MS = 45_000;/);
assert.match(source, /const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;/);
assert.match(source, /async function _fetchWithTimeout/);
assert.match(source, /export async function apiPost\(path, body, method, options\)/);
assert.match(source, /export async function apiGet\(path, options\)/);
assert.match(source, /_fetchWithTimeout\(\s*path,\s*\{\s*method, headers: getAuthHeaders\(\), body: JSON\.stringify\(body\), signal: options\.signal \}/s);
assert.match(source, /_fetchWithTimeout\(\s*path,\s*\{\s*headers: getAuthHeaders\(\), cache: 'no-store', signal: options\.signal \}/s);
assert.match(source, /function resetTimer\(\)/);
assert.match(source, /if \(timedOut\) throw _timeoutError\(path, timeoutMs\);/);

console.log('[frontend-api-timeouts] static contract passed');
