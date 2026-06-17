import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(LOGIN_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ORIGIN Admin Login</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0d1117; color:#eef3f8; }
    main { width:min(420px, calc(100vw - 32px)); }
    h1 { margin:0 0 8px; font-size:24px; line-height:1.2; letter-spacing:.01em; }
    p { margin:0 0 28px; color:#8f9baa; font-size:13px; }
    form { display:grid; gap:14px; padding:28px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.05); border-radius:8px; }
    label { display:grid; gap:7px; font-size:12px; color:#aab6c3; }
    input { height:42px; border-radius:6px; border:1px solid rgba(255,255,255,.16); background:#111923; color:#fff; padding:0 12px; font-size:13px; line-height:1.4; outline:none; }
    input:focus { border-color:#7dd3fc; }
    button { height:42px; border:0; border-radius:6px; background:#7dd3fc; color:#071018; font-size:13px; font-weight:700; cursor:pointer; }
    .error { min-height:18px; color:#fb7185; font-size:12px; }
  </style>
</head>
<body>
  <main>
    <h1>ORIGIN Admin</h1>
    <p>独立后台入口。普通工作台账号不可登录这里。</p>
    <form id="loginForm" autocomplete="off" data-form-type="other">
      <label>管理员账号<input id="adminLoginName" name="admin_login_name_ignored" autocomplete="off" autocapitalize="none" spellcheck="false" data-form-type="other" data-lpignore="true" data-1p-ignore="true" readonly required /></label>
      <label>密码<input id="adminLoginSecret" name="admin_login_secret_ignored" type="password" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore="true" readonly required /></label>
      <div id="error" class="error"></div>
      <button type="submit">登录后台</button>
    </form>
  </main>
  <script>
    const usernameInput = document.getElementById('adminLoginName');
    const passwordInput = document.getElementById('adminLoginSecret');
    let userInteracted = false;
    function unlockLoginFields() {
      userInteracted = true;
      usernameInput.readOnly = false;
      passwordInput.readOnly = false;
    }
    function clearAutofillValues() {
      if (userInteracted) return;
      usernameInput.value = '';
      passwordInput.value = '';
    }
    [usernameInput, passwordInput].forEach(function (input) {
      input.addEventListener('focus', unlockLoginFields, { once: true });
      input.addEventListener('pointerdown', unlockLoginFields, { once: true });
      input.addEventListener('keydown', unlockLoginFields, { once: true });
    });
    [0, 80, 300, 900].forEach(function (delay) {
      window.setTimeout(clearAutofillValues, delay);
    });
    document.getElementById('loginForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      unlockLoginFields();
      const error = document.getElementById('error');
      error.textContent = '';
      const resp = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: usernameInput.value,
          password: passwordInput.value
        })
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        error.textContent = data.detail || '登录失败';
        return;
      }
      location.href = '/admin';
    });
  </script>
</body>
</html>`;
