import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const projectSource = readFileSync(new URL('../public/modules/project.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');

assert.match(projectSource, /function _projectFetchMessage\(meta\)/);
assert.match(projectSource, /status === 401\) return "登录已失效，请重新登录后再打开项目。"/);
assert.match(projectSource, /status === 404\) return "项目不存在或已被删除，请刷新任务列表。"/);
assert.match(projectSource, /status >= 500\) return "服务器读取项目失败（" \+ status \+ "），请稍后重试。"/);
assert.match(projectSource, /meta\.code === "timeout"\) return "项目详情请求超时，请检查网络后重试。"/);
assert.match(projectSource, /options\.throwOnError/);
assert.match(projectSource, /err\.name = "ProjectFetchError"/);
assert.match(projectSource, /err\.name = "TimeoutError"/);
assert.match(projectSource, /promise\.then\(function \(\) \{\s*if \(_projectFetchInFlight\[key\] === promise\) delete _projectFetchInFlight\[key\];\s*\}, function \(\) \{/);
assert.doesNotMatch(projectSource, /promise\.finally/);

assert.match(mainSource, /fetchProjectByIdShared\(projId, \{\s*signal:[\s\S]*?force: true,\s*throwOnError: true,/);
assert.doesNotMatch(mainSource, /项目数据为空/);

assert.match(workspace, /"\/modules\/project\.js": "\/modules\/project\.js\?v=111"/);
assert.match(workspace, /<script type="module" src="main\.js\?v=358"><\/script>/);

console.log('[project-fetch-error-contract] static contract passed');
