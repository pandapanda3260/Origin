import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/videoPrompts.js', import.meta.url), 'utf8');

assert.match(source, /function _vpSensitiveHitTerm\(hit\)/, 'video prompt UI should centralize sensitive hit term extraction');
assert.match(source, /hit\.term \|\| hit\.word/, 'sensitive hit term extraction must support new term and legacy word shapes');
assert.match(source, /var senWords = _vpSensitiveTerms\(sensitiveHits\);/, 'sensitive banner should use normalized terms');
assert.match(source, /var wordList = _vpSensitiveTerms\(hits\);/, 'AI sensitive replacement should pass normalized terms to LLM');
assert.doesNotMatch(source, /map\(function \(h\) \{ return h\.word; \}\)/, 'frontend must not read only h.word from sensitive hits');

console.log('[test-video-sensitive-hit-shape] ok');
