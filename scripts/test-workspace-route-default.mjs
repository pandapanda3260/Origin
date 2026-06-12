/**
 * Workspace route default contract.
 *
 * Bare /workspace and /workspace# must enter the project overview instead of
 * restoring a stale remembered editor route. Explicit #workspacePage=... links
 * still restore the requested workspace page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function assert(cond, label) {
  if (cond) return;
  failures.push(label);
}

const workspace = read('public/workspace.html');
const mainJs = read('public/main.js');
const prebootScript = workspace.match(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/)?.[0]
  ?.replace(/^<script>\s*/, '')
  ?.replace(/\s*<\/script>$/, '');

function runPreboot(hash) {
  if (!prebootScript) return '';
  const attrs = {};
  const storage = {
    getItem(key) {
      if (String(key).includes('sw_workspace_active_page')) return 'onlineEditor';
      if (key === 'sw_auth_user') return JSON.stringify({ id: 1 });
      return '';
    },
  };
  vm.runInNewContext(prebootScript, {
    window: {
      location: { hash },
      sessionStorage: storage,
      localStorage: storage,
      history: { state: { originWorkspaceActivePage: 'onlineEditor' } },
    },
    document: {
      documentElement: {
        setAttribute(key, value) {
          attrs[key] = value;
        },
      },
    },
    decodeURIComponent,
    String,
  });
  return attrs['data-workspace-boot-page'];
}

assert(
  workspace.includes('var hasWorkspacePageHash = false') &&
    workspace.includes('if (!hasWorkspacePageHash) page = "overview"') &&
    workspace.includes('page = normalize(page) || "overview"'),
  'workspace.html preboot must treat bare /workspace or /workspace# as overview',
);

assert(
  /function _readRememberedWorkspacePage\(options\)\s*\{[\s\S]*?if\s*\(!hasWorkspacePageHash\)\s*\{\s*return _isWorkspacePageOpenable\("overview", options\);/.test(mainJs),
  'main.js route reader must not restore stale storage when URL has no explicit workspacePage hash',
);

assert(
  /function _readRememberedWorkspacePage\(options\)\s*\{[\s\S]*?return _isWorkspacePageOpenable\(page, options\) \|\| _isWorkspacePageOpenable\("overview", options\);[\s\S]*?\n  \}/.test(mainJs),
  'main.js explicit empty/invalid workspacePage hash must fall back to overview, not stale storage',
);

assert(
  !/function _readRememberedWorkspacePage\(options\)\s*\{[\s\S]*?sessionStorage\.getItem\(WORKSPACE_ACTIVE_PAGE_KEY\)/.test(mainJs),
  'main.js route reader must not read stale sessionStorage fallback during startup routing',
);

assert(
  !/function _readRememberedWorkspacePage\(options\)\s*\{[\s\S]*?localStorage\.getItem\(WORKSPACE_ACTIVE_PAGE_FALLBACK_KEY\)/.test(mainJs),
  'main.js route reader must not read stale localStorage fallback during startup routing',
);

assert(
  /if\s*\(hash\.indexOf\(prefix\)\s*===\s*0\)\s*\{[\s\S]*?hasWorkspacePageHash\s*=\s*true;[\s\S]*?decodeURIComponent\(hash\.slice\(prefix\.length\)\)/.test(mainJs),
  'main.js must still honor explicit #workspacePage=... links',
);

assert(
  /<script type="module" src="main\.js\?v=357"><\/script>/.test(workspace),
  'workspace.html must bump main.js cache version after route default change',
);

assert(prebootScript, 'workspace.html preboot script should be extractable for route simulation');

assert(
  runPreboot('') === 'overview',
  'preboot simulation: /workspace must ignore stale stored onlineEditor and show overview',
);

assert(
  runPreboot('#') === 'overview',
  'preboot simulation: /workspace# must ignore stale stored onlineEditor and show overview',
);

assert(
  runPreboot('#workspacePage=') === 'overview',
  'preboot simulation: empty workspacePage hash must show overview',
);

assert(
  runPreboot('#workspacePage=onlineEditor') === 'onlineEditor',
  'preboot simulation: explicit onlineEditor hash must still show onlineEditor',
);

if (failures.length) {
  console.error(`✗ workspace route default contract failed (${failures.length})`);
  failures.forEach((failure) => console.error('  - ' + failure));
  process.exit(1);
}

console.log('✓ workspace route default contract passed');
