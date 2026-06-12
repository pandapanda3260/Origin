import { NextRequest } from 'next/server';
import { adminIcon, renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 客服检索 = 唯一"查人查单"入口（原用户管理已并入本页）。
// 用户区块：/api/admin/users 模糊搜索 + 禁用/恢复/强制下线（dryRun 两段提交）。
// 其他实体：/api/admin/search 精确命中（订单/项目/批次/视频/导出）。
export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/search',
    title: '客服检索',
    headHtml: `<style>
      .search-results { display:grid; gap:14px; }
      .result-group h2 { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 10px; font-size:var(--admin-font-lg); }
      .result-list { display:grid; gap:10px; }
      .result-item { border:1px solid var(--admin-border-soft); border-radius:8px; padding:12px; background:#fff; }
      .result-title { display:flex; align-items:center; justify-content:space-between; gap:12px; font-weight:700; }
      .result-subtitle { margin-top:4px; color:var(--admin-text-muted); font-size:var(--admin-font-sm); line-height:1.5; }
      .field-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px 12px; margin-top:10px; }
      .field { min-width:0; }
      .field span { display:block; color:var(--admin-text-muted); font-size:var(--admin-font-xs); line-height:1.4; }
      .field strong { display:block; margin-top:2px; font-size:var(--admin-font-sm); line-height:1.5; overflow-wrap:anywhere; }
      .users-meta { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
      table.users-table { min-width:920px; }
      .users-table .actions { display:flex; gap:6px; flex-wrap:wrap; }
      @media (max-width: 900px) { .field-grid { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="adm-toolbar">
        <label class="adm-field" style="flex:1; min-width:300px;"><span>检索</span>
          <input data-admin-search-input="true" placeholder="用户：ID / 手机号 / 昵称（模糊）；单据：orderId / batchId / taskId / projectId / exportId（精确）" />
        </label>
        <div class="adm-actions">
          <button class="adm-btn adm-btn-primary" data-admin-search-button="true">${adminIcon('search')}检索</button>
          <button class="adm-btn" data-admin-search-reset="true">最近用户</button>
        </div>
      </div>
      <div class="notice" data-admin-search-notice="true"></div>
    </section>
    <section class="panel section-gap">
      <div class="adm-section-head">
        <h2>用户</h2>
        <span class="adm-count" data-users-count="true"></span>
      </div>
      <div class="users-meta" data-users-meta="true"></div>
      <div class="admin-table-wrap">
        <table class="admin-table users-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>用户</th>
              <th>手机号</th>
              <th>积分</th>
              <th>项目</th>
              <th>状态</th>
              <th>最近账本</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody data-users-table="true"><tr><td colspan="9"><div class="adm-empty">加载中...</div></td></tr></tbody>
        </table>
      </div>
      <div class="notice" data-users-notice="true"></div>
    </section>
    <section class="search-results section-gap" data-admin-search-results="true"></section>`,
    scriptsHtml: `<script>
      const esc = adminUi.esc;
      const searchInput = document.querySelector('[data-admin-search-input="true"]');
      const searchNotice = document.querySelector('[data-admin-search-notice="true"]');
      const searchResults = document.querySelector('[data-admin-search-results="true"]');
      const usersTable = document.querySelector('[data-users-table="true"]');
      const usersMeta = document.querySelector('[data-users-meta="true"]');
      const usersNotice = document.querySelector('[data-users-notice="true"]');
      const userState = { items: [], lastQuery: null };
      const groupLabels = {
        order: '订单',
        project: '项目',
        batch: '批次',
        video_task: '视频任务',
        export: '导出任务'
      };
      const fieldLabels = {
        userId: '用户 ID',
        ownerId: '归属用户',
        username: '内部账号',
        phone: '手机号',
        displayName: '昵称',
        email: '旧邮箱',
        disabledAt: '禁用时间',
        totalCredits: '余额',
        projectCount: '项目数',
        orderCount: '订单数',
        ledgerCount: '账本数',
        provider: 'Provider',
        providerRef: 'Provider Ref',
        providerTask: 'Provider Task',
        externalExportId: '外部导出 ID',
        kind: '类型',
        planCode: '套餐/包',
        amountCents: '金额(分)',
        currency: '币种',
        creditsAdded: '入账积分',
        status: '状态',
        projectId: '项目 ID',
        projectTitle: '项目',
        batchId: '批次 ID',
        groupIdx: '镜头组',
        progress: '进度',
        filename: '输出文件',
        localDownloadStatus: '下载状态',
        errorMessage: '失败原因',
        total: '总数',
        succeeded: '成功',
        failed: '失败',
        runnerId: 'Runner',
        runnerHeartbeatAt: '心跳',
        durationSec: '时长(秒)',
        coverUrl: '封面',
        createdAt: '创建时间',
        updatedAt: '更新时间'
      };

      function fmtValue(value) {
        if (value === null || value === undefined || value === '') return '-';
        if (typeof value === 'boolean') return value ? '是' : '否';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
      }

      // ===== 用户区块（原用户管理页能力） =====
      function renderUsers() {
        const items = userState.items || [];
        document.querySelector('[data-users-count="true"]').textContent = items.length + ' 条';
        usersMeta.innerHTML = [
          '<span class="chip">' + (userState.lastQuery ? '匹配：' + esc(userState.lastQuery) : '最近注册') + '</span>',
          '<span class="chip">禁用：' + items.filter((u) => u.disabledAt).length + '</span>',
          '<span class="chip">可登录：' + items.filter((u) => !u.disabledAt).length + '</span>'
        ].join('');
        if (!items.length) {
          usersTable.innerHTML = adminUi.emptyRow(9, '暂无匹配用户');
          return;
        }
        usersTable.innerHTML = items.map((u) => {
          const status = u.disabledAt
            ? '<span class="badge danger">已禁用</span>'
            : '<span class="badge ok">正常</span>';
          const actions = (u.disabledAt
            ? '<button data-action="restore" data-user-id="' + u.id + '">恢复</button>'
            : '<button class="danger" data-action="disable" data-user-id="' + u.id + '">禁用</button>')
            + '<button data-action="force_logout" data-user-id="' + u.id + '">强制下线</button>';
          const primaryName = u.displayName || u.phone || u.username;
          const accountLine = u.phone || u.username || '';
          return '<tr>' +
            '<td>' + u.id + '</td>' +
            '<td><strong>' + esc(primaryName) + '</strong><div class="muted">' + esc(accountLine) + '</div></td>' +
            '<td>' + esc(u.phone || '-') + '</td>' +
            '<td>' + Number(u.totalCredits || 0) + '</td>' +
            '<td>' + Number(u.projectCount || 0) + '</td>' +
            '<td>' + status + (u.tokenRevokedAt ? '<div class="muted">已踢：' + esc(adminUi.fmtDate(u.tokenRevokedAt)) + '</div>' : '') + '</td>' +
            '<td>' + esc(adminUi.fmtDate(u.lastLedgerAt)) + '</td>' +
            '<td>' + esc(adminUi.fmtDate(u.createdAt)) + '</td>' +
            '<td><div class="actions">' + actions + '</div></td>' +
          '</tr>';
        }).join('');
      }
      async function loadUsers(q) {
        userState.lastQuery = q || null;
        const res = await fetch('/api/admin/users?q=' + encodeURIComponent(q || ''), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          adminUi.setNotice(usersNotice, (data && data.detail) || '用户加载失败', 'error');
          return;
        }
        userState.items = data.items || [];
        renderUsers();
        adminUi.setNotice(usersNotice, '');
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
        const userLabel = user?.displayName || user?.phone || user?.username || userId;
        const reason = window.prompt(label + '用户 ' + userLabel + ' 的原因');
        if (!reason || !reason.trim()) return;
        const headers = {
          'content-type':'application/json',
          'x-idempotency-key': adminUi.idemKey(),
          'x-admin-reason': reason.trim()
        };
        adminUi.setNotice(usersNotice, '正在预检查...');
        const dryRun = await fetch('/api/admin/users', {
          method:'POST',
          credentials:'same-origin',
          headers,
          body: JSON.stringify({ action, userId: Number(userId), reason: reason.trim(), dryRun: true }),
        });
        const dryRunData = await dryRun.json().catch(() => null);
        if (!dryRun.ok || !dryRunData?.dryRun) {
          adminUi.setNotice(usersNotice, (dryRunData && dryRunData.detail) || '预检查失败', 'error');
          return;
        }
        if (!window.confirm(label + '用户 ' + userLabel + '？此操作会写入审计日志。')) {
          adminUi.setNotice(usersNotice, '已取消');
          return;
        }
        adminUi.setNotice(usersNotice, '正在提交...');
        const commit = await fetch('/api/admin/users', {
          method:'POST',
          credentials:'same-origin',
          headers,
          body: JSON.stringify({ action, userId: Number(userId), reason: reason.trim() }),
        });
        const commitData = await commit.json().catch(() => null);
        if (!commit.ok) {
          adminUi.setNotice(usersNotice, (commitData && commitData.detail) || '提交失败', 'error');
          return;
        }
        adminUi.setNotice(usersNotice, label + '已完成', 'ok');
        await loadUsers(userState.lastQuery || '');
      }

      // ===== 其他实体（精确命中） =====
      function renderItem(item) {
        const fields = item.fields || {};
        const fieldHtml = Object.entries(fields)
          .filter(([, value]) => value !== null && value !== undefined && value !== '')
          .map(([key, value]) => '<div class="field"><span>' + esc(fieldLabels[key] || key) + '</span><strong>' + esc(fmtValue(value)) + '</strong></div>')
          .join('');
        return '<article class="result-item">' +
          '<div class="result-title"><span>' + esc(item.title || item.id) + '</span><span class="badge">' + esc(item.entityType) + ' · ' + esc(item.id) + '</span></div>' +
          '<div class="result-subtitle">' + esc(item.subtitle || '') + '</div>' +
          '<div class="field-grid">' + (fieldHtml || '<div class="muted">暂无字段</div>') + '</div>' +
        '</article>';
      }
      function renderResults(data) {
        const groups = (data && data.groups) || {};
        const types = ['order', 'project', 'batch', 'video_task', 'export'];
        const sections = types
          .map((type) => {
            const items = groups[type] || [];
            if (!items.length) return '';
            return '<section class="panel result-group">' +
              '<h2><span>' + groupLabels[type] + '</span><span class="badge">' + items.length + '</span></h2>' +
              '<div class="result-list">' + items.map(renderItem).join('') + '</div>' +
            '</section>';
          })
          .filter(Boolean);
        searchResults.innerHTML = sections.join('');
        return sections.length;
      }

      async function runSearch() {
        const q = searchInput.value.trim();
        if (!q) {
          searchResults.innerHTML = '';
          adminUi.setNotice(searchNotice, '显示最近注册用户。输入关键词可模糊搜用户、精确查单据。');
          await loadUsers('');
          return;
        }
        adminUi.setNotice(searchNotice, '检索中...');
        const [entityRes] = await Promise.all([
          fetch('/api/admin/search?q=' + encodeURIComponent(q), { credentials:'same-origin' }),
          loadUsers(q),
        ]);
        const data = await entityRes.json().catch(() => null);
        if (!entityRes.ok) {
          adminUi.setNotice(searchNotice, (data && data.detail) || '检索失败', 'error');
          return;
        }
        const groupCount = renderResults(data || { groups:{} });
        const userCount = userState.items.length;
        adminUi.setNotice(searchNotice, '用户命中 ' + userCount + ' 条；单据命中 ' + (((data || {}).items) || []).filter((item) => item.entityType !== 'user').length + ' 条', 'ok');
        if (!groupCount && !userCount) adminUi.setNotice(searchNotice, '没有匹配结果');
      }

      document.querySelector('[data-admin-search-button="true"]')?.addEventListener('click', runSearch);
      document.querySelector('[data-admin-search-reset="true"]')?.addEventListener('click', () => { searchInput.value = ''; runSearch(); });
      searchInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(); });
      usersTable?.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        mutateUser(button.dataset.action, button.dataset.userId);
      });
      runSearch();
    </script>`,
  });
}
