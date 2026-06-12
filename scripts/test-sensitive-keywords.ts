import assert from 'node:assert/strict';
import { SENSITIVE_KEYWORDS, scanSensitiveText } from '../lib/sensitive-keywords';
import { scanSensitiveText as scanFromContentFlags } from '../lib/content-flags';

assert.equal(SENSITIVE_KEYWORDS.length, 13, 'shared sensitive keyword baseline should keep the current 13-term union');

const sample = '镜头 01\n角色说：“kill the traitor”，地面有 blood，随后说自杀不是选择。';
const hits = scanSensitiveText(sample);
const terms = hits.map((hit) => hit.term);

assert.ok(terms.includes('kill'), 'video prompt parse should now see kill');
assert.ok(terms.includes('blood'), 'video prompt parse should preserve existing blood hit');
assert.ok(terms.includes('杀'), 'shared scanner should keep current broad Chinese kill hit');
assert.ok(terms.includes('自杀'), 'shared scanner should keep current self-harm hit');
assert.deepEqual(scanFromContentFlags(sample), hits, 'content-flags should re-export the same scanner behavior');

console.log('[test-sensitive-keywords] ok');
