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
  const unauth = await request('/admin/users', { redirect: 'manual' });
  assert(unauth.res.status === 302, `unauth /admin/users should return 302, got ${unauth.res.status}`);
  assert((unauth.res.headers.get('location') || '').includes('/admin/login'), 'unauth redirect should target /admin/login');

  const cookie = await login();
  const users = await request('/admin/users', { headers: { cookie } });
  assert(users.res.status === 200, `authenticated /admin/users should return 200, got ${users.res.status}`);
  assert(activeHref(users.text) === '/admin/users', 'active nav href for /admin/users is incorrect');
  assert(users.text.includes('data-user-search="true"'), '/admin/users should render the user search control');
  assert(users.text.includes('/api/admin/users'), '/admin/users should be wired to the admin users API');
  assert(!users.text.includes('P1-B 接入'), '/admin/users should not render the old placeholder panel');

  const home = await request('/admin', { headers: { cookie } });
  assert(home.res.status === 200, `authenticated /admin should return 200, got ${home.res.status}`);
  const hrefs = navHrefs(home.text);
  assert(hrefs.length >= 8, `expected admin nav links, got ${hrefs.length}`);
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

  const afterLogout = await request('/admin/tasks', { redirect: 'manual' });
  assert(afterLogout.res.status === 302, `after logout /admin/tasks without cookie should return 302, got ${afterLogout.res.status}`);

  console.log('admin shell smoke ok: server gate, nav active state, nav hrefs, and logout flow passed');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
