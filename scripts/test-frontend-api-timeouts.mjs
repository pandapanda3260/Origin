import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/utils.js', import.meta.url), 'utf8');
const toolboxSource = readFileSync(new URL('../public/modules/toolbox.js', import.meta.url), 'utf8');

assert.match(source, /const DEFAULT_API_TIMEOUT_MS = 45_000;/);
assert.match(source, /const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;/);
assert.match(source, /async function _fetchWithTimeout/);
assert.match(source, /export async function apiPost\(path, body, method, options\)/);
assert.match(source, /export async function apiGet\(path, options\)/);
assert.match(source, /_fetchWithTimeout\(\s*path,\s*\{\s*method, headers: getAuthHeaders\(\), body: JSON\.stringify\(body\), signal: options\.signal \}/s);
assert.match(source, /_fetchWithTimeout\(\s*path,\s*\{\s*headers: getAuthHeaders\(\), cache: 'no-store', signal: options\.signal \}/s);
assert.match(source, /function resetTimer\(\)/);
assert.match(source, /if \(timedOut\) throw _timeoutError\(path, timeoutMs\);/);

assert.match(toolboxSource, /var TOOLBOX_IMAGE_REQUEST_TIMEOUT_MS = 15 \* 60 \* 1000;/);
assert.match(toolboxSource, /_jsonFetch\('\/api\/toolbox\/image\/generate', \{\s*method: 'POST',\s*timeoutMs: TOOLBOX_IMAGE_REQUEST_TIMEOUT_MS,/s);
assert.match(toolboxSource, /_jsonFetch\('\/api\/toolbox\/items\/' \+ encodeURIComponent\(_selected\.id\) \+ '\/enhance', \{\s*method: 'POST',\s*timeoutMs: isVideoEnhance \? undefined : TOOLBOX_IMAGE_REQUEST_TIMEOUT_MS,/s);
assert.match(toolboxSource, /var _pollTimers = \{ image: null, video: null \};/);
assert.match(toolboxSource, /function _startImageStatusPolling\(\)/);

console.log('[frontend-api-timeouts] static contract passed');
