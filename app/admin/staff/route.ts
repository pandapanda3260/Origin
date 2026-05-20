import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/staff',
    title: 'Admin 账号',
    headHtml: `<style>
      .staff-layout { display:grid; grid-template-columns:minmax(0, 1.4fr) minmax(320px, .8fr); gap:16px; align-items:start; }
      .form-grid { display:grid; gap:10px; }
      .form-row { display:grid; gap:5px; }
      table.admin-table { min-width:780px; }
      .admin-table th, .admin-table td { vertical-align:middle; }
      .actions { display:flex; gap:6px; flex-wrap:wrap; }
      .audit-list { display:grid; gap:8px; max-height:360px; overflow:auto; }
      .audit-item { border:1px solid var(--admin-border-soft); border-radius:8px; padding:10px; background:#fff; }
      .audit-item strong { display:block; margin-bottom:4px; }
      @media (max-width: 1000px) { .staff-layout { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<div class="staff-layout">
      <section class="panel">
        <h2>Admin 列表</h2>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>账号</th>
                <th>状态</th>
                <th>Shadow User</th>
                <th>上次登录</th>
                <th>Token Revoked</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody data-staff-table="true"><tr><td colspan="8" class="muted">加载中...</td></tr></tbody>
          </table>
        </div>
        <div class="notice" data-staff-notice="true"></div>
      </section>
      <div>
        <section class="panel">
          <h2>创建 Admin</h2>
          <div class="form-grid">
            <div class="form-row"><label>账号</label><input data-create-username="true" placeholder="letters_numbers.-" /></div>
            <div class="form-row"><label>初始密码</label><input data-create-password="true" type="password" placeholder="至少 12 位，至少两类字符" /></div>
            <button class="primary" data-create-admin="true">创建</button>
          </div>
        </section>
        <section class="panel">
          <h2>自我改密</h2>
          <div class="form-grid">
            <div class="form-row"><label>旧密码</label><input data-self-old-password="true" type="password" /></div>
            <div class="form-row"><label>新密码</label><input data-self-new-password="true" type="password" placeholder="至少 12 位，至少两类字符" /></div>
            <button data-self-password="true">修改自己的密码</button>
          </div>
          <p class="muted">修改成功后当前后台登录态会失效，需要重新登录。</p>
        </section>
      </div>
    </div>
    <section class="panel section-gap">
      <h2>Admin 操作日志</h2>
      <div class="audit-list" data-staff-audit="true"><div class="muted">加载中...</div></div>
    </section>`,
    scriptsHtml: `<script>
      const staffState = { items: [], recentActions: [], currentAdminId: null };
      const staffTable = document.querySelector('[data-staff-table="true"]');
      const staffAudit = document.querySelector('[data-staff-audit="true"]');
      const staffNotice = document.querySelector('[data-staff-notice="true"]');

      function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
      }
      function fmtDate(value) {
        if (!value) return '-';
        try { return new Date(value).toLocaleString('zh-CN', { hour12:false }); } catch { return value; }
      }
      function setStaffNotice(message, kind = '') {
        if (!staffNotice) return;
        staffNotice.textContent = message || '';
        staffNotice.dataset.kind = kind;
      }
      async function loadMe() {
        const res = await fetch('/api/admin/auth/me', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.admin) staffState.currentAdminId = data.admin.id;
      }
      function renderStaff() {
        const items = staffState.items || [];
        if (!items.length) {
          staffTable.innerHTML = '<tr><td colspan="8" class="muted">暂无 admin</td></tr>';
          return;
        }
        staffTable.innerHTML = items.map((admin) => {
          const disabled = !!admin.disabledAt;
          const isSelf = Number(admin.id) === Number(staffState.currentAdminId);
          const status = disabled ? '<span class="badge danger">已禁用</span>' : '<span class="badge ok">正常</span>';
          const disableButton = disabled || isSelf
            ? '<button disabled>禁用</button>'
            : '<button class="danger" data-action="disable" data-admin-id="' + admin.id + '">禁用</button>';
          const resetButton = isSelf
            ? '<button disabled>重置密码</button>'
            : '<button data-action="reset_password" data-admin-id="' + admin.id + '">重置密码</button>';
          return '<tr>' +
            '<td>' + admin.id + '</td>' +
            '<td><strong>' + esc(admin.username) + '</strong>' + (isSelf ? '<div class="muted">当前账号</div>' : '') + '</td>' +
            '<td>' + status + '</td>' +
            '<td>' + esc(admin.previewUserId || '-') + '</td>' +
            '<td>' + esc(fmtDate(admin.lastLoginAt)) + '</td>' +
            '<td>' + esc(fmtDate(admin.tokenRevokedAt)) + '</td>' +
            '<td>' + esc(fmtDate(admin.createdAt)) + '</td>' +
            '<td><div class="actions">' +
              '<button data-action="revoke_tokens" data-admin-id="' + admin.id + '">互踢</button>' +
              resetButton + disableButton +
            '</div></td>' +
          '</tr>';
        }).join('');
      }
      function renderAudit() {
        const rows = staffState.recentActions || [];
        if (!rows.length) {
          staffAudit.innerHTML = '<div class="muted">暂无 admin 操作日志</div>';
          return;
        }
        staffAudit.innerHTML = rows.map((row) => (
          '<div class="audit-item">' +
            '<strong>' + esc(row.action) + ' <span class="badge">' + esc(row.status) + '</span></strong>' +
            '<div class="muted">' + esc(row.adminUsername || 'unknown') + ' · ' + esc(fmtDate(row.createdAt)) + '</div>' +
            '<div class="muted">target: ' + esc(row.targetType || '-') + ' / ' + esc(row.targetId || '-') + '</div>' +
            (row.reason ? '<div>' + esc(row.reason) + '</div>' : '') +
          '</div>'
        )).join('');
      }
      async function loadStaff() {
        setStaffNotice('加载中...');
        await loadMe();
        const res = await fetch('/api/admin/staff', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setStaffNotice((data && data.detail) || '加载失败', 'error');
          return;
        }
        staffState.items = data.items || [];
        staffState.recentActions = data.recentActions || [];
        renderStaff();
        renderAudit();
        setStaffNotice('已更新', 'ok');
      }
      async function postJson(url, method, body, reason) {
        const headers = {
          'content-type':'application/json',
          'x-idempotency-key': crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random()
        };
        if (reason) headers['x-admin-reason'] = reason;
        const res = await fetch(url, { method, credentials:'same-origin', headers, body: JSON.stringify(body) });
        const data = await res.json().catch(() => null);
        return { res, data };
      }
      async function dryRunThenCommit(url, method, body, reason, confirmText) {
        const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const headers = { 'content-type':'application/json', 'x-idempotency-key': key };
        if (reason) headers['x-admin-reason'] = reason;
        const dry = await fetch(url, { method, credentials:'same-origin', headers, body: JSON.stringify({ ...body, reason, dryRun:true }) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) throw new Error((dryData && dryData.detail) || '预检查失败');
        if (!window.confirm(confirmText)) return null;
        const commit = await fetch(url, { method, credentials:'same-origin', headers, body: JSON.stringify({ ...body, reason }) });
        const commitData = await commit.json().catch(() => null);
        if (!commit.ok) throw new Error((commitData && commitData.detail) || '提交失败');
        return commitData;
      }
      document.querySelector('[data-create-admin="true"]')?.addEventListener('click', async () => {
        const username = document.querySelector('[data-create-username="true"]').value.trim();
        const password = document.querySelector('[data-create-password="true"]').value;
        const reason = window.prompt('创建 admin 的原因');
        if (!username || !password || !reason) return;
        try {
          setStaffNotice('正在创建...');
          await dryRunThenCommit('/api/admin/staff', 'POST', { username, password }, reason.trim(), '确认创建 admin ' + username + '？');
          document.querySelector('[data-create-password="true"]').value = '';
          setStaffNotice('创建完成', 'ok');
          await loadStaff();
        } catch (error) { setStaffNotice(error.message || String(error), 'error'); }
      });
      staffTable?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const adminId = Number(button.dataset.adminId);
        const admin = staffState.items.find((item) => Number(item.id) === adminId);
        const reason = window.prompt(action + ' admin ' + (admin?.username || adminId) + ' 的原因');
        if (!reason) return;
        const body = { action, adminId };
        if (action === 'reset_password') {
          const next = window.prompt('输入新密码');
          if (!next) return;
          body.newPassword = next;
        }
        try {
          setStaffNotice('正在提交...');
          await dryRunThenCommit('/api/admin/staff', 'PATCH', body, reason.trim(), '确认执行 ' + action + '：' + (admin?.username || adminId) + '？');
          setStaffNotice('操作完成', 'ok');
          await loadStaff();
        } catch (error) { setStaffNotice(error.message || String(error), 'error'); }
      });
      document.querySelector('[data-self-password="true"]')?.addEventListener('click', async () => {
        const oldPassword = document.querySelector('[data-self-old-password="true"]').value;
        const newPassword = document.querySelector('[data-self-new-password="true"]').value;
        if (!oldPassword || !newPassword) {
          setStaffNotice('请填写旧密码和新密码', 'error');
          return;
        }
        try {
          setStaffNotice('正在修改密码...');
          await dryRunThenCommit('/api/admin/staff/self-password', 'POST', { oldPassword, newPassword }, '', '确认修改自己的 admin 密码？修改后需要重新登录。');
          setStaffNotice('密码已修改，请重新登录', 'ok');
          location.href = '/admin/login';
        } catch (error) { setStaffNotice(error.message || String(error), 'error'); }
      });
      window.adminStartPolling?.(loadStaff);
    </script>`,
  });
}
