import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/users',
    title: '用户管理',
    headHtml: `<style>
      .users-toolbar { display:flex; gap:10px; align-items:center; margin-bottom:14px; }
      .users-toolbar input { width:320px; max-width:100%; }
      .users-meta { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
      table.admin-table { min-width:920px; }
      .admin-table th, .admin-table td { vertical-align:middle; }
      .actions { display:flex; gap:6px; flex-wrap:wrap; }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="users-toolbar">
        <input data-user-search="true" placeholder="搜索 ID / 用户名 / 邮箱 / 昵称" />
        <button data-user-search-button="true" class="primary">搜索</button>
        <button data-user-refresh="true">刷新</button>
      </div>
      <div class="users-meta" data-users-meta="true"></div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>用户</th>
              <th>邮箱</th>
              <th>积分</th>
              <th>项目</th>
              <th>状态</th>
              <th>最近账本</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody data-users-table="true">
            <tr><td colspan="9" class="muted">加载中...</td></tr>
          </tbody>
        </table>
      </div>
      <div class="notice" data-users-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const userState = { items: [], q: '' };
      const table = document.querySelector('[data-users-table="true"]');
      const meta = document.querySelector('[data-users-meta="true"]');
      const notice = document.querySelector('[data-users-notice="true"]');
      const searchInput = document.querySelector('[data-user-search="true"]');

      function setNotice(message, kind = '') {
        if (!notice) return;
        notice.textContent = message || '';
        notice.dataset.kind = kind;
      }

      function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
      }

      function fmtDate(value) {
        if (!value) return '-';
        try { return new Date(value).toLocaleString('zh-CN', { hour12:false }); } catch { return value; }
      }

      function renderUsers() {
        const items = userState.items || [];
        meta.innerHTML = [
          '<span class="chip">结果：' + items.length + '</span>',
          '<span class="chip">禁用：' + items.filter((u) => u.disabledAt).length + '</span>',
          '<span class="chip">可登录：' + items.filter((u) => !u.disabledAt).length + '</span>'
        ].join('');
        if (!items.length) {
          table.innerHTML = '<tr><td colspan="9" class="muted">暂无匹配用户</td></tr>';
          return;
        }
        table.innerHTML = items.map((u) => {
          const status = u.disabledAt
            ? '<span class="badge danger">已禁用</span>'
            : '<span class="badge ok">正常</span>';
          const actions = u.disabledAt
            ? '<button data-action="restore" data-user-id="' + u.id + '">恢复</button>'
            : '<button class="danger" data-action="disable" data-user-id="' + u.id + '">禁用</button>';
          return '<tr>' +
            '<td>' + u.id + '</td>' +
            '<td><strong>' + esc(u.username) + '</strong><div class="muted">' + esc(u.displayName || '') + '</div></td>' +
            '<td>' + esc(u.email || '-') + '</td>' +
            '<td>' + Number(u.totalCredits || 0) + '</td>' +
            '<td>' + Number(u.projectCount || 0) + '</td>' +
            '<td>' + status + (u.tokenRevokedAt ? '<div class="muted">已踢：' + esc(fmtDate(u.tokenRevokedAt)) + '</div>' : '') + '</td>' +
            '<td>' + esc(fmtDate(u.lastLedgerAt)) + '</td>' +
            '<td>' + esc(fmtDate(u.createdAt)) + '</td>' +
            '<td><div class="actions">' + actions + '<button data-action="force_logout" data-user-id="' + u.id + '">强制下线</button></div></td>' +
          '</tr>';
        }).join('');
      }

      async function loadUsers() {
        const q = searchInput?.value?.trim() || '';
        userState.q = q;
        setNotice('加载中...');
        const res = await fetch('/api/admin/users?q=' + encodeURIComponent(q), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setNotice((data && data.detail) || '加载失败', 'error');
          return;
        }
        userState.items = data.items || [];
        renderUsers();
        setNotice('已更新', 'ok');
      }

      function actionLabel(action) {
        if (action === 'disable') return '禁用';
        if (action === 'restore') return '恢复';
        if (action === 'force_logout') return '强制下线';
        return action;
      }

      async function mutateUser(action, userId) {
        const user = userState.items.find((item) => String(item.id) === String(userId));
        const label = actionLabel(action);
        const reason = window.prompt(label + '用户 ' + (user?.username || userId) + ' 的原因');
        if (!reason || !reason.trim()) return;
        const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const payload = { action, userId: Number(userId), reason: reason.trim(), dryRun: true };
        const headers = {
          'content-type':'application/json',
          'x-idempotency-key': idempotencyKey,
          'x-admin-reason': reason.trim()
        };
        setNotice('正在预检查...');
        const dryRun = await fetch('/api/admin/users', {
          method:'POST',
          credentials:'same-origin',
          headers,
          body: JSON.stringify(payload),
        });
        const dryRunData = await dryRun.json().catch(() => null);
        if (!dryRun.ok || !dryRunData?.dryRun) {
          setNotice((dryRunData && dryRunData.detail) || '预检查失败', 'error');
          return;
        }
        const confirmed = window.confirm(label + '用户 ' + (user?.username || userId) + '？此操作会写入审计日志。');
        if (!confirmed) {
          setNotice('已取消');
          return;
        }
        setNotice('正在提交...');
        const commit = await fetch('/api/admin/users', {
          method:'POST',
          credentials:'same-origin',
          headers,
          body: JSON.stringify({ action, userId: Number(userId), reason: reason.trim() }),
        });
        const commitData = await commit.json().catch(() => null);
        if (!commit.ok) {
          setNotice((commitData && commitData.detail) || '提交失败', 'error');
          return;
        }
        setNotice(label + '已完成', 'ok');
        await loadUsers();
      }

      document.querySelector('[data-user-search-button="true"]')?.addEventListener('click', loadUsers);
      document.querySelector('[data-user-refresh="true"]')?.addEventListener('click', loadUsers);
      searchInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') loadUsers();
      });
      table?.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        mutateUser(button.dataset.action, button.dataset.userId);
      });
      window.adminStartPolling?.(loadUsers);
    </script>`,
  });
}
