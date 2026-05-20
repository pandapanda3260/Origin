import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdmin } from './admin-auth';

// If admin pages later enable a Content-Security-Policy header, scriptsHtml must move to a nonce-based script loader.

type AdminShellOptions = {
  activePath: string;
  title: string;
  adminUsername: string;
  bodyHtml: string;
  headHtml?: string;
  scriptsHtml?: string;
};

type AdminPageOptions = Omit<AdminShellOptions, 'adminUsername'>;

const NAV_GROUPS = [
  {
    title: '运营管理',
    items: [
      { href: '/admin', label: '问题队列', icon: 'queue' },
    ],
  },
  {
    title: '用户与业务',
    items: [
      { href: '/admin/users', label: '用户管理', icon: 'users' },
      { href: '/admin/billing', label: '财务积分', icon: 'coin' },
      { href: '/admin/search', label: '客服检索', icon: 'search' },
      { href: '/admin/tasks', label: '任务管理', icon: 'task' },
    ],
  },
  {
    title: '系统与配置',
    items: [
      { href: '/admin/staff', label: 'Admin 账号', icon: 'staff' },
      { href: '/admin/config', label: '系统配置', icon: 'settings' },
      { href: '/admin/key-pool', label: 'Key 池', icon: 'key' },
      { href: '/admin/content', label: '内容审核', icon: 'shield' },
      { href: '/admin/storage', label: '存储管理', icon: 'storage' },
      { href: '/admin/knowledge', label: '知识库', icon: 'book' },
    ],
  },
];

export async function renderAdminPage(req: NextRequest, options: AdminPageOptions): Promise<NextResponse> {
  const admin = await getCurrentAdmin(req);
  if (!admin) return redirectToAdminLogin(req);
  return htmlResponse(renderAdminShell({ ...options, adminUsername: admin.username }));
}

export function redirectToAdminLogin(req: NextRequest): NextResponse {
  return NextResponse.redirect(new URL('/admin/login', req.url), 302);
}

export function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function renderAdminShell(options: AdminShellOptions): string {
  const activePath = normalizePath(options.activePath);
  const navHtml = NAV_GROUPS.map((group) => {
    const itemsHtml = group.items.map((item) => {
      const active = item.href === activePath;
      return `<a data-admin-nav="true" href="${item.href}" data-active="${active ? 'true' : 'false'}">
        <span class="nav-icon" aria-hidden="true">${adminIcon(item.icon)}</span>
        <span>${escapeHtml(item.label)}</span>
      </a>`;
    }).join('');
    return `<section class="nav-group"><p>${escapeHtml(group.title)}</p><div class="nav-items">${itemsHtml}</div></section>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)} · ORIGINRISE Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg:#f6f8fb;
      --sidebar:#f8fbfa;
      --panel:#ffffff;
      --admin-text-strong:#0f1a2a;
      --admin-text:#26364b;
      --admin-text-muted:#607086;
      --admin-text-subtle:#8b98a9;
      --admin-border:#d8e2ef;
      --admin-border-soft:#edf2f7;
      --admin-bg-soft:#f7fafc;
      --admin-success:#0b7a68;
      --admin-success-strong:#0b5f58;
      --admin-success-soft:#e7f5f2;
      --admin-warning:#a05a00;
      --admin-warning-soft:#fff7e8;
      --admin-danger:#b42318;
      --admin-danger-soft:#fff0ed;
      --admin-info:#2563eb;
      --admin-info-soft:#edf4fb;
      --admin-neutral:#657386;
      --admin-neutral-soft:#f0f3f6;
      --admin-code-bg:#f7fafc;
      --admin-code-text:#1f2f43;
      --admin-log-bg:#101820;
      --admin-log-text:#c8f7d2;
      --admin-font-xs:11px;
      --admin-font-sm:12px;
      --admin-font-md:13px;
      --admin-font-nav:14px;
      --admin-font-lg:15px;
      --admin-font-xl:18px;
      --admin-font-page:24px;
      --admin-font-counter:34px;
      --admin-line-tight:1.2;
      --admin-line-title:1.35;
      --admin-line-body:1.55;
      --admin-line-code:1.6;
      --admin-space-xs:6px;
      --admin-space-sm:10px;
      --admin-space-md:16px;
      --admin-space-lg:24px;
      --admin-space-xl:32px;
      --text:var(--admin-text-strong);
      --muted:var(--admin-text-muted);
      --muted-2:var(--admin-text-subtle);
      --line:#e4ebf2;
      --line-strong:#d3dee8;
      --accent:#119c91;
      --accent-dark:#087a72;
      --accent-soft:#e5f6f3;
      --accent-bg:var(--accent-soft);
      --danger:var(--admin-danger);
      --danger-soft:var(--admin-danger-soft);
      --warning:#f09000;
      --warning-soft:#fff3df;
      --purple:#7338d8;
      --purple-soft:#f0e9ff;
      --pink:#e74f80;
      --pink-soft:#fdebf2;
      --shadow:0 16px 40px rgba(16, 27, 45, .08);
      --shadow-soft:0 8px 22px rgba(16, 27, 45, .06);
      --radius:16px;
    }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased; }
    a { color:inherit; text-decoration:none; }
    button { font:inherit; }
    .admin-shell { min-height:100vh; display:grid; grid-template-columns:240px minmax(0, 1fr); background:var(--bg); }
    .sidebar { position:sticky; top:0; height:100vh; display:flex; flex-direction:column; border-right:1px solid var(--line); background:linear-gradient(180deg, #fbfefd 0%, var(--sidebar) 58%, #f4faf8 100%); padding:24px 20px 18px; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:800; font-size:17px; color:#142033; letter-spacing:-.01em; margin:0 0 28px; }
    .brand span:last-child { font-size:var(--admin-font-lg); white-space:nowrap; }
    .brand-mark { width:34px; height:34px; display:grid; place-items:center; border-radius:999px; background:linear-gradient(145deg, #17aa9e, #0f8f86); box-shadow:0 10px 22px rgba(17,156,145,.22); color:#fff; flex:0 0 auto; }
    .brand-mark .admin-icon { width:22px; height:22px; }
    nav { display:grid; gap:18px; }
    .nav-group p { margin:0 0 10px; color:#7d8a99; font-size:var(--admin-font-sm); font-weight:700; }
    .nav-items { display:grid; gap:4px; }
    nav a { min-height:38px; display:flex; align-items:center; gap:12px; padding:0 13px; border-radius:10px; color:#28384d; font-size:14px; font-weight:600; transition:background .18s ease, color .18s ease, transform .18s ease; }
    nav a:hover { background:#eef6f4; color:#10243a; }
    nav a[data-active="true"] { position:relative; background:linear-gradient(90deg, rgba(17,156,145,.15), rgba(17,156,145,.07)); color:var(--accent-dark); font-weight:800; }
    nav a[data-active="true"]::before { content:""; position:absolute; left:0; top:11px; bottom:11px; width:3px; border-radius:999px; background:var(--accent); }
    .nav-icon { width:20px; height:20px; display:grid; place-items:center; color:#607086; flex:0 0 auto; }
    nav a[data-active="true"] .nav-icon { color:var(--accent); }
    .admin-system-card { margin-top:auto; border:1px solid var(--line); background:rgba(255,255,255,.72); border-radius:12px; padding:14px 15px; display:flex; align-items:center; justify-content:space-between; gap:12px; box-shadow:0 10px 26px rgba(16,27,45,.04); }
    .admin-system-card strong { display:flex; align-items:center; gap:10px; color:#2d4056; font-size:var(--admin-font-md); }
    .status-ok { display:flex; align-items:center; gap:7px; color:var(--accent); font-size:var(--admin-font-sm); font-weight:800; white-space:nowrap; }
    .status-dot { width:7px; height:7px; border-radius:999px; background:var(--accent); box-shadow:0 0 0 4px rgba(17,156,145,.13); }
    .main { min-width:0; }
    header { height:84px; display:flex; align-items:center; justify-content:space-between; gap:22px; padding:0 44px 0 46px; border-bottom:1px solid var(--line); background:rgba(255,255,255,.86); box-shadow:0 1px 0 rgba(255,255,255,.7), 0 8px 28px rgba(16,27,45,.035); backdrop-filter:saturate(140%) blur(14px); }
    h1, .admin-page-title { margin:0; font-size:var(--admin-font-page); line-height:var(--admin-line-tight); font-weight:800; letter-spacing:-.025em; color:var(--admin-text-strong); }
    .admin-user { display:flex; align-items:center; gap:14px; color:#1a2a3f; font-size:14px; font-weight:600; }
    .admin-avatar { width:34px; height:34px; display:grid; place-items:center; border-radius:999px; color:var(--accent); background:var(--accent-soft); box-shadow:inset 0 0 0 1px rgba(17,156,145,.08); }
    .admin-user-name { white-space:nowrap; }
    main { width:100%; max-width:1360px; margin:0 auto; padding:34px 44px 48px; }
    .grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:18px; }
    .panel { border:1px solid var(--line); background:var(--panel); border-radius:var(--radius); padding:22px; box-shadow:var(--shadow-soft); }
    .panel h2, .admin-section-title { margin:0 0 14px; font-size:var(--admin-font-xl); line-height:var(--admin-line-title); font-weight:700; letter-spacing:-.01em; color:var(--admin-text-strong); }
    .panel + .panel, .section-gap { margin-top:16px; }
    .admin-card-title { margin:0; font-size:var(--admin-font-lg); line-height:1.4; font-weight:700; color:var(--admin-text-strong); }
    .admin-body-text { color:var(--admin-text); font-size:var(--admin-font-md); line-height:var(--admin-line-body); }
    .muted, .admin-muted { color:var(--admin-text-muted); font-size:var(--admin-font-sm); line-height:1.5; }
    .admin-subtle { color:var(--admin-text-subtle); font-size:var(--admin-font-sm); line-height:1.5; }
    .status { display:flex; flex-wrap:wrap; gap:10px; margin:18px 0; }
    .chip { padding:8px 10px; background:var(--admin-info-soft); border-radius:8px; font-size:var(--admin-font-sm); color:var(--admin-text); line-height:1.4; }
    .row { padding:8px 0; border-bottom:1px solid var(--admin-border-soft); }
    .row:last-child { border-bottom:0; }
    .mono, .admin-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric:tabular-nums; }
    pre, .admin-log-block { white-space:pre-wrap; max-height:320px; overflow:auto; background:var(--admin-log-bg); color:var(--admin-log-text); padding:14px; border-radius:10px; font-size:var(--admin-font-sm); line-height:var(--admin-line-code); }
    .admin-code-block { white-space:pre-wrap; overflow:auto; background:var(--admin-code-bg); color:var(--admin-code-text); border:1px solid var(--admin-border-soft); border-radius:8px; padding:14px; font-size:var(--admin-font-sm); line-height:var(--admin-line-code); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size:2; }
    button, .admin-button { border:1px solid var(--line-strong); background:#fff; border-radius:10px; height:34px; padding:0 12px; cursor:pointer; color:var(--text); font-size:var(--admin-font-md); font-weight:600; transition:background .18s ease, border-color .18s ease, transform .18s ease; }
    button:hover { border-color:#a9bbc9; background:#f7fafc; }
    .admin-button-small, .actions button { height:30px; padding:0 9px; font-size:var(--admin-font-sm); font-weight:600; }
    button.primary, .admin-button-primary { color:var(--admin-success-strong); border-color:#8ac7bd; }
    button.danger, .admin-button-danger { color:var(--admin-danger); border-color:#f0b8ae; }
    button.ghost, .admin-button-ghost { color:var(--admin-text-muted); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .logout-btn { height:34px; display:inline-flex; align-items:center; gap:7px; padding:0 13px; border-radius:10px; color:var(--accent-dark); border-color:#d7e7e4; font-weight:700; }
    .admin-input, .admin-select, .admin-textarea, .admin-toolbar input, .admin-toolbar select, .users-toolbar input, .tasks-toolbar input, .tasks-toolbar select, .content-toolbar input, .content-toolbar select, .billing-toolbar input, .storage-toolbar input, .search-toolbar input, .config-field input, .config-field textarea, .form-row input { border:1px solid var(--line-strong); border-radius:6px; background:#fff; color:var(--text); font-size:var(--admin-font-md); }
    .admin-input, .admin-select, .admin-toolbar input, .admin-toolbar select, .users-toolbar input, .tasks-toolbar input, .tasks-toolbar select, .content-toolbar input, .content-toolbar select, .billing-toolbar input, .storage-toolbar input, .search-toolbar input, .config-field input, .form-row input { height:34px; padding:0 10px; }
    .admin-textarea, .config-field textarea { padding:10px; line-height:var(--admin-line-body); }
    .admin-label, .form-row label, .config-field label { color:var(--admin-text-muted); font-size:var(--admin-font-sm); font-weight:700; line-height:1.4; }
    .admin-table-wrap { overflow:auto; border:1px solid var(--line); border-radius:8px; background:#fff; }
    table.admin-table { width:100%; border-collapse:collapse; font-size:var(--admin-font-sm); line-height:1.5; }
    .admin-table th, .admin-table td { padding:10px 12px; border-bottom:1px solid var(--admin-border-soft); text-align:left; vertical-align:top; }
    .admin-table th { color:var(--admin-text-muted); font-weight:700; background:var(--admin-bg-soft); line-height:1.4; }
    .admin-table tr:last-child td { border-bottom:0; }
    .badge, .admin-badge { display:inline-flex; align-items:center; justify-content:center; min-width:0; height:22px; border-radius:999px; padding:0 8px; font-size:var(--admin-font-xs); font-weight:700; line-height:1; background:var(--admin-info-soft); color:#385064; white-space:nowrap; }
    .badge.ok, .badge.published, .badge.completed, .badge.real, .badge.low, .admin-badge-success { background:var(--admin-success-soft); color:var(--admin-success-strong); }
    .badge.running, .badge.queued, .badge.retry_pending, .badge.upstream_pending, .badge.needs_review, .badge.draft, .badge.medium, .admin-badge-warning { background:var(--admin-warning-soft); color:var(--admin-warning); }
    .badge.danger, .badge.failed, .badge.cancelled, .badge.fake, .badge.high, .admin-badge-danger { background:var(--admin-danger-soft); color:var(--admin-danger); }
    .badge.archived, .admin-badge-neutral { background:var(--admin-neutral-soft); color:var(--admin-neutral); }
    .admin-badge-info { background:var(--admin-info-soft); color:#385064; }
    .notice, .admin-notice { margin:10px 0 0; min-height:20px; color:var(--admin-text-muted); font-size:var(--admin-font-sm); line-height:1.5; }
    .notice[data-kind="error"], .admin-notice-danger { color:var(--admin-danger); }
    .notice[data-kind="ok"], .admin-notice-success { color:var(--admin-success-strong); }
    .notice[data-kind="warning"], .admin-notice-warning { color:var(--admin-warning); }
    .admin-empty-state { display:grid; place-items:center; min-height:220px; padding:var(--admin-space-xl); color:var(--admin-text-muted); font-size:var(--admin-font-md); line-height:var(--admin-line-body); text-align:center; }
    .admin-empty-state .muted, .admin-empty-state .admin-muted { margin-top:6px; color:var(--admin-text-subtle); font-size:var(--admin-font-sm); }
    .empty-page { max-width:720px; }
    .empty-page p { margin:0; color:var(--muted); line-height:1.7; font-size:13px; }
    .admin-icon { width:1em; height:1em; display:block; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; fill:none; }
    @media (max-width: 900px) {
      .admin-shell { grid-template-columns:1fr; }
      .sidebar { position:relative; height:auto; border-right:0; border-bottom:1px solid var(--line); padding:22px; }
      .brand { margin-bottom:22px; }
      nav { gap:16px; }
      .nav-items { grid-template-columns:repeat(2, minmax(0, 1fr)); }
      .admin-system-card { margin-top:22px; }
      header { height:auto; min-height:74px; padding:18px 24px; flex-wrap:wrap; }
      main { padding:24px; }
      .grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .nav-items, .grid { grid-template-columns:1fr; }
      header { align-items:flex-start; }
      .admin-user { width:100%; justify-content:space-between; }
    }
  </style>
  ${options.headHtml || ''}
</head>
<body>
  <div class="admin-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">${adminIcon('brand')}</span>
        <span>ORIGINRISE Admin</span>
      </div>
      <nav>${navHtml}</nav>
      <div class="admin-system-card">
        <strong>${adminIcon('shield')} 系统状态</strong>
        <span class="status-ok"><span class="status-dot"></span>正常</span>
      </div>
    </aside>
    <div class="main">
      <header>
        <h1>${escapeHtml(options.title)}</h1>
        <div class="admin-user">
          <span class="admin-avatar" aria-hidden="true">${adminIcon('user')}</span>
          <span class="admin-user-name">${escapeHtml(options.adminUsername)}</span>
          <button class="logout-btn" data-admin-logout="true">退出 ${adminIcon('logout')}</button>
        </div>
      </header>
      <main data-admin-main="true">${options.bodyHtml}</main>
    </div>
  </div>
  <script>
    window.adminMarkRefresh = function adminMarkRefresh() {
      const value = new Date().toISOString();
      document.body.dataset.lastRefresh = value;
      document.querySelector('[data-admin-main="true"]')?.setAttribute('data-last-refresh', value);
      return value;
    };
    window.adminRunWithRefresh = async function adminRunWithRefresh(fn) {
      const result = await fn();
      window.adminMarkRefresh();
      return result;
    };
    window.adminStartPolling = function adminStartPolling(fn, intervalMs = 30000) {
      let busy = false;
      const run = async () => {
        if (busy || document.hidden) return;
        busy = true;
        try { await window.adminRunWithRefresh(fn); }
        finally { busy = false; }
      };
      run();
      const timer = setInterval(run, intervalMs);
      timer.unref?.();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
      return timer;
    };
    document.querySelector('[data-admin-logout="true"]')?.addEventListener('click', async () => {
      await fetch('/api/admin/auth/logout', {
        method:'POST',
        credentials:'same-origin',
        headers: { 'x-idempotency-key': (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) }
      });
      location.href = '/admin/login';
    });
  </script>
  ${options.scriptsHtml || ''}
</body>
</html>`;
}

export function adminIcon(name: string): string {
  const paths: Record<string, string> = {
    brand: '<path d="M7 17.5c2.2 2.3 6.3 2.5 9.2.4 2.2-1.6 2.7-4.1.9-5.4-1.5-1.1-3.8-.7-5.9-.3-2.4.4-4.6.8-5.5-.8-.9-1.7.9-4.1 3.7-5.2 2.9-1.1 6.3-.5 8 1.5"/><path d="M5.8 12c.4 3.7 3.4 6.8 7.2 7.2 4.4.5 8.2-2.8 8.2-7.2 0-2.2-1-4.2-2.6-5.5"/>',
    queue: '<path d="M4 7h3"/><path d="M4 12h3"/><path d="M4 17h3"/><path d="M11 6h9v4h-9z"/><path d="M11 14h9v4h-9z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16.5 3.13a4 4 0 0 1 0 7.75"/>',
    coin: '<circle cx="12" cy="12" r="8"/><path d="M12 7v10"/><path d="M15 9.5c-.5-.7-1.4-1.1-2.7-1.1-1.5 0-2.6.7-2.6 1.8 0 1.2 1 1.6 2.9 2.1 1.7.5 2.8 1 2.8 2.2 0 1.1-1 2-2.8 2-1.4 0-2.5-.4-3.2-1.3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
    task: '<path d="M9 11l2 2 4-5"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
    staff: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
    settings: '<circle cx="12" cy="12" r="3.5"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2.1 2.1 0 0 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.65V21a2.1 2.1 0 0 1-4.2 0v-.08a1.8 1.8 0 0 0-1.18-1.65 1.8 1.8 0 0 0-1.98.36l-.05.05a2.1 2.1 0 0 1-2.97-2.97l.05-.05a1.8 1.8 0 0 0 .36-1.98 1.8 1.8 0 0 0-1.65-1.1H2a2.1 2.1 0 0 1 0-4.2h.08a1.8 1.8 0 0 0 1.65-1.18 1.8 1.8 0 0 0-.36-1.98l-.05-.05A2.1 2.1 0 0 1 6.3 3.2l.05.05a1.8 1.8 0 0 0 1.98.36H8.4A1.8 1.8 0 0 0 9.5 2h.08a2.1 2.1 0 0 1 4.2 0v.08a1.8 1.8 0 0 0 1.18 1.65 1.8 1.8 0 0 0 1.98-.36l.05-.05a2.1 2.1 0 0 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 1.98v.08A1.8 1.8 0 0 0 21 9.5h.08a2.1 2.1 0 0 1 0 4.2H21a1.8 1.8 0 0 0-1.6 1.3z"/>',
    key: '<circle cx="7.5" cy="14.5" r="3.5"/><path d="M10 12l9-9"/><path d="M14 4l3 3"/><path d="M16 2l4 4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    storage: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.5 17.5A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.5L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    review: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-5"/>',
    activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
    crown: '<path d="m3 8 4 3 5-7 5 7 4-3-2 10H5L3 8z"/><path d="M5 21h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
    cube: '<path d="m21 16-9 5-9-5V8l9-5 9 5v8z"/><path d="m3.3 7.7 8.7 4.8 8.7-4.8"/><path d="M12 22v-9.5"/>',
  };
  return `<svg class="admin-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}

export function renderPlaceholderPanel(title: string, description: string): string {
  return `<section class="panel empty-page"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></section>`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizePath(path: string): string {
  if (!path || path === '/') return '/admin';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
