const baseUrl = (process.env.ORIGIN_HEALTH_URL || 'http://127.0.0.1:3000/api/health').trim();
const workspaceBaseUrl = (
  process.env.ORIGIN_WORKSPACE_SMOKE_BASE_URL
  || (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return 'http://127.0.0.1:3000';
    }
  })()
).replace(/\/+$/, '');
const workspaceSizeWarnBytes = Number(process.env.ORIGIN_WORKSPACE_SIZE_WARN_BYTES || 2 * 1024 * 1024);

function sizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { text, body, bytes: Buffer.byteLength(text) };
}

async function resolveWorkspaceToken() {
  const directToken = (process.env.ORIGIN_WORKSPACE_SMOKE_TOKEN || '').trim();
  if (directToken) return directToken;

  const username = (process.env.ORIGIN_WORKSPACE_SMOKE_USERNAME || '').trim();
  const password = process.env.ORIGIN_WORKSPACE_SMOKE_PASSWORD || '';
  if (!username && !password) return null;
  if (!username || !password) {
    throw new Error('ORIGIN_WORKSPACE_SMOKE_USERNAME and ORIGIN_WORKSPACE_SMOKE_PASSWORD must be set together');
  }

  const response = await fetch(`${workspaceBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });
  const { body } = await readJsonResponse(response);
  if (!response.ok || !body?.token) {
    throw new Error(`workspace login failed: http_${response.status}`);
  }
  return String(body.token);
}

async function fetchWorkspaceJson(path: string, token: string) {
  const response = await fetch(`${workspaceBaseUrl}${path}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  });
  const measured = await readJsonResponse(response);
  if (!response.ok) throw new Error(`${path} failed: http_${response.status}`);
  return measured;
}

function extractProjectSummaries(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.projects)) return body.projects;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

async function checkWorkspaceProjectSizes() {
  const token = await resolveWorkspaceToken();
  if (!token) {
    console.log('[health] warn workspace-size skipped - set ORIGIN_WORKSPACE_SMOKE_TOKEN or username/password env');
    return;
  }

  const list = await fetchWorkspaceJson('/api/projects', token);
  const projects = extractProjectSummaries(list.body);
  const listPrefix = list.bytes > workspaceSizeWarnBytes ? 'warn' : 'ok';
  console.log(
    `[health] ${listPrefix} workspace projects list size=${sizeLabel(list.bytes)} total=${projects.length}`,
  );

  const firstProjectId = String(projects[0]?.id || '').trim();
  if (!firstProjectId) {
    console.log('[health] warn workspace project detail skipped - no projects in authenticated account');
    return;
  }

  const detail = await fetchWorkspaceJson(`/api/projects/${encodeURIComponent(firstProjectId)}`, token);
  const detailPrefix = detail.bytes > workspaceSizeWarnBytes ? 'warn' : 'ok';
  const title = String(detail.body?.title || detail.body?.name || firstProjectId).slice(0, 80);
  console.log(
    `[health] ${detailPrefix} workspace project detail size=${sizeLabel(detail.bytes)} project=${title}`,
  );
}

async function main() {
  try {
    const response = await fetch(baseUrl, { headers: { accept: 'application/json' } });
    const body: any = await response.json().catch(() => ({}));
    const status = body?.status || `http_${response.status}`;
    console.log(`[health] ${status} ${baseUrl}`);
    if (Array.isArray(body?.checks)) {
      for (const check of body.checks) {
        const prefix = check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'fail';
        console.log(`[health] ${prefix} ${check.name}${check.message ? ` - ${check.message}` : ''}`);
      }
    }
    if (!response.ok || body?.ok === false) process.exit(1);

    try {
      await checkWorkspaceProjectSizes();
    } catch (e: any) {
      console.error(`[health] workspace-size failed: ${e?.message || String(e)}`);
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`[health] request failed ${baseUrl}: ${e?.message || String(e)}`);
    process.exit(1);
  }
}

main();

export {};
