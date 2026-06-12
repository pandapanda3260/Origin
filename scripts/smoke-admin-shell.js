const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const username = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
const password = process.env.ADMIN_SMOKE_PASSWORD || 'origin-admin-dev-2026!';
const origin = process.env.ADMIN_SMOKE_ORIGIN || 'http://localhost:3000';

async function request(path, options = {}) {
  const res = await fetch(baseUrl + path, options);
  const text = await res.text();
  return { res, text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login() {
  const result = await request('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert(result.res.status === 200, `admin login failed: ${result.res.status} ${result.text}`);
  const setCookie = result.res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  assert(cookie.includes('admin_token='), 'admin login did not set admin_token cookie');
  return cookie;
}

function activeHref(html) {
  const matches = Array.from(html.matchAll(/<a\s+[^>]*data-admin-nav="true"[^>]*href="([^"]+)"[^>]*data-active="true"/g));
  assert(matches.length === 1, `expected exactly one active nav item, got ${matches.length}`);
  return matches[0][1];
}

function navHrefs(html) {
  return Array.from(html.matchAll(/<a\s+[^>]*data-admin-nav="true"[^>]*href="([^"]+)"/g)).map((m) => m[1]);
}

async function main() {
  // 2026-06 瘦身后导航为 7 页：/admin /admin/search /admin/billing /admin/usage-stats /admin/system /admin/content /admin/knowledge。
  const unauth = await request('/admin/search', { redirect: 'manual' });
  assert(unauth.res.status === 302, `unauth /admin/search should return 302, got ${unauth.res.status}`);
  assert((unauth.res.headers.get('location') || '').includes('/admin/login'), 'unauth redirect should target /admin/login');

  const cookie = await login();
  const search = await request('/admin/search', { headers: { cookie } });
  assert(search.res.status === 200, `authenticated /admin/search should return 200, got ${search.res.status}`);
  assert(activeHref(search.text) === '/admin/search', 'active nav href for /admin/search is incorrect');
  assert(search.text.includes('data-admin-search-input="true"'), '/admin/search should render the search control');
  assert(search.text.includes('data-users-table="true"'), '/admin/search should render the merged users table');
  assert(search.text.includes('/api/admin/users'), '/admin/search should be wired to the admin users API');

  const home = await request('/admin', { headers: { cookie } });
  assert(home.res.status === 200, `authenticated /admin should return 200, got ${home.res.status}`);
  const hrefs = navHrefs(home.text);
  assert(hrefs.length === 7, `expected exactly 7 admin nav links after slimdown, got ${hrefs.length}`);
  const expectedHrefs = ['/admin', '/admin/search', '/admin/billing', '/admin/usage-stats', '/admin/system', '/admin/content', '/admin/knowledge'];
  for (const expected of expectedHrefs) {
    assert(hrefs.includes(expected), `nav should include ${expected}`);
  }
  for (const removed of ['/admin/users', '/admin/tasks', '/admin/token-stats', '/admin/time-stats', '/admin/staff', '/admin/config', '/admin/key-pool', '/admin/storage']) {
    assert(!hrefs.includes(removed), `nav should no longer include retired page ${removed}`);
  }
  for (const href of hrefs) {
    const page = await request(href, { headers: { cookie } });
    assert(page.res.status === 200, `nav href ${href} should return 200, got ${page.res.status}`);
    assert(activeHref(page.text) === href, `nav href ${href} should have matching active item`);
  }

  const logout = await request('/api/admin/auth/logout', {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'x-idempotency-key': crypto.randomUUID(),
    },
  });
  assert(logout.res.status === 200, `admin logout should return 200, got ${logout.res.status}`);
  const clearedCookie = logout.res.headers.get('set-cookie') || '';
  assert(/admin_token=;/.test(clearedCookie) || /Max-Age=0/i.test(clearedCookie), 'logout did not clear admin_token cookie');

  const afterLogout = await request('/admin/system', { redirect: 'manual' });
  assert(afterLogout.res.status === 302, `after logout /admin/system without cookie should return 302, got ${afterLogout.res.status}`);

  console.log('admin shell smoke ok: server gate, nav active state, nav hrefs, and logout flow passed');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
