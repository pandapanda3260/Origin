import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const workspace = fs.readFileSync(path.join(repoRoot, 'public', 'workspace.html'), 'utf8');
const styles = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const main = fs.readFileSync(path.join(repoRoot, 'public', 'main.js'), 'utf8');

assert.match(workspace, /<button[^>]*id="navAgent"[^>]*hidden[^>]*>/, 'agent FAB starts hidden until JS route placement runs');
assert.match(workspace, /id="agentDockResetBtn"/, 'agent panel exposes a dock reset control');

assert.match(main, /sw_agent_fab_pos_v3/, 'agent FAB uses v3 dock persistence');
assert.doesNotMatch(main, /sw_agent_fab_pos_v2/, 'agent FAB must not reuse v2 absolute-position persistence');
assert.match(main, /AGENT_FAB_DOCKS\s*=\s*\["top-start", "top-end", "bottom-start", "bottom-end"\]/, 'agent FAB supports the four dock anchors');

assert.match(main, /function _syncFixedWorkbenchRoute\(page\)[\s\S]*syncAgentFabPlacement\("route", page\);[\s\S]*function _syncBoardNavigationState/, 'route chrome sync owns agent FAB placement');
assert.match(main, /function _agentFabRoutePolicy\(page\)[\s\S]*current === "onlineEditor"[\s\S]*isBoardEnabled\(\) && current === "shots"[\s\S]*visible: !isOnlineEditor && !isBoardRoute/, 'agent FAB route policy hides online editor and board routes');
assert.match(main, /var sidebar = \$\("sidebar"\);[\s\S]*sidebarRect\.right \+ margin[\s\S]*right: Math\.max\(left, viewportWidth - margin\)/, 'agent safe rect avoids the visible sidebar for left-side docks');

assert.match(main, /window\.addEventListener\("resize", function \(\) \{\s*syncAgentFabPlacement\("resize"\);\s*\}\);/, 'agent FAB resize is routed through syncAgentFabPlacement');
assert.doesNotMatch(main, /window\.addEventListener\("resize"[\s\S]{0,500}_readAgentFabPos/, 'resize handler must not re-read legacy absolute FAB position');
assert.doesNotMatch(main, /window\.addEventListener\("resize"[\s\S]{0,500}_saveAgentFabPos/, 'resize handler must not re-save legacy absolute FAB position');

assert.match(main, /function _agentFabElements\(\)[\s\S]*fab: \$\("navAgent"\)[\s\S]*panel: \$\("agentPanel"\)/, 'placement sync can safely resolve FAB and panel elements');
assert.match(main, /if \(!fab && !panel\) return;/, 'placement sync safely no-ops before elements exist');
assert.match(main, /_syncAgentPanelPlacement\(fab, panel, dock\);\s*panel\.hidden = false;/, 'panel placement is written before it becomes visible');
assert.match(main, /syncAgentFabPlacement\(_agentOpen \? "panel-open" : "panel-close"\)/, 'panel toggle uses the shared placement entrypoint');
assert.match(main, /_saveAgentFabDock\(_nearestAgentFabDock\(fab\)\);\s*syncAgentFabPlacement\("drag-end"\);/, 'drag end persists dock and re-enters shared placement');
assert.match(main, /_saveAgentFabDock\(AGENT_FAB_DEFAULT_DOCK\);\s*syncAgentFabPlacement\("dock-reset"\);/, 'dock reset restores the default dock through shared placement');

assert.match(styles, /--top-announcement-height:\s*32px;/, 'safe rect has top announcement height available');
assert.match(styles, /body\.is-online-editor-page #sidebar,\s*body\.is-online-editor-page #announceBanner,\s*body\.is-online-editor-page #maintenanceBanner\s*\{\s*display:\s*none !important;\s*\}/, 'online editor still hides sidebar and banners');
assert.doesNotMatch(styles, /is-online-editor-page[^{}]*\.agent-fab/, 'online editor must not hide agent FAB in CSS');
assert.doesNotMatch(styles, /is-online-editor-page[^{}]*\.agent-panel/, 'online editor must not hide agent panel in CSS');
assert.doesNotMatch(styles, /is-board-workbench-page[^{}]*\.agent-fab/, 'board route must not hide agent FAB in CSS');
assert.doesNotMatch(styles, /is-board-workbench-page[^{}]*\.agent-panel/, 'board route must not hide agent panel in CSS');
assert.match(styles, /transform-origin:\s*var\(--agent-panel-origin,\s*bottom right\);/, 'agent panel transform origin follows placement');
assert.match(styles, /translateY\(var\(--agent-panel-enter-y,\s*16px\)\)/, 'agent panel entrance direction follows placement');

console.log('✓ agent FAB placement contract passed');
