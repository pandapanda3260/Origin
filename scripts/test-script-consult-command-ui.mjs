import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const scriptSource = readFileSync(join(root, 'public/modules/script.js'), 'utf8');
const promptSource = readFileSync(join(root, 'lib/prompts.ts'), 'utf8');
const helperSource = readFileSync(join(root, 'lib/script-consult-ready.ts'), 'utf8');

function commandAlternativesFromRegex(source, label) {
  const match = source.match(/\^\(([^)]+)\)\$/);
  assert.ok(match, `${label} must expose an anchored command regex`);
  return match[1].split('|');
}

assert.match(
  scriptSource,
  /function _isExplicitScriptDraftConfirmCommand\(text\)[\s\S]*确认生成剧本[\s\S]*生成草稿/,
  'script UI must recognize explicit typed confirm/generate commands',
);

assert.match(
  scriptSource,
  /replace\(\s*\/\[。！!．\.~～…\]\+\$\/,\s*""\s*\)/,
  'script UI command matcher must strip common terminal punctuation except question marks',
);

assert.deepEqual(
  commandAlternativesFromRegex(scriptSource, 'frontend'),
  commandAlternativesFromRegex(helperSource, 'server helper'),
  'frontend and server helper command regex alternatives must stay mirrored',
);

assert.match(
  scriptSource,
  /if \(await _handleConsultConfirmCommand\(idea\)\) return;[\s\S]*?_classifySourceTextInput\(idea\)/,
  'typed confirm command must be handled before normal consult/model turn',
);

assert.match(
  scriptSource,
  /document\.querySelector\("#chatMessages \.btn-confirm-draft"\)[\s\S]*sc\.ready === true[\s\S]*_lastConsultAssistantReady\(\)/,
  'typed confirm command must require an existing ready consult target',
);

assert.match(
  scriptSource,
  /chatAddMsg\("user", escapeHtml\(idea\)\);[\s\S]*await _consultConfirm\(\);/,
  'typed confirm command must call the same consult confirm path as the button',
);

assert.match(
  promptSource,
  /可以输入"确认生成剧本"或点下方按钮/,
  'consult prompt must tell users they can type the confirm command',
);

console.log('[test-script-consult-command-ui] ok');
