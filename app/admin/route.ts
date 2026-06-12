import { NextRequest } from 'next/server';
import { adminIcon, renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 问题队列工作台 = 异常卡片（看） + 全部任务（处理）。
// 单任务写操作统一走 /api/admin/tasks；批量重排走 /api/admin/problem-queue bulk_requeue。
// 指标口径见 docs/admin-metrics-registry.md。
export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin',
    title: '问题队列',
    headHtml: HOME_STYLES,
    bodyHtml: `
      <section class="grid issue-overview" aria-label="问题队列概览">
        <article class="issue-card issue-danger">
          <div class="issue-icon">${adminIcon('review')}</div>
          <div class="issue-copy">
            <h2>需人工处理</h2>
            <p id="needsReviewSummary">加载中...</p>
          </div>
          <strong id="needsReviewCount">0</strong>
          <div class="issue-actions">
            <button type="button" class="adm-btn" data-issue-filter="needs_review">去处理</button>
            <button type="button" class="adm-btn" id="bulkRequeueButton">全部重排</button>
          </div>
          <div id="needsReview" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-warning">
          <div class="issue-icon">${adminIcon('alert')}</div>
          <div class="issue-copy">
            <h2>卡住任务</h2>
            <p id="staleTasksSummary">加载中...</p>
          </div>
          <strong id="staleTasksCount">0</strong>
          <div class="issue-actions">
            <button type="button" class="adm-btn" data-issue-filter="running">去处理</button>
          </div>
          <div id="staleTasks" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-pink">
          <div class="issue-icon">${adminIcon('alert')}</div>
          <div class="issue-copy">
            <h2>近 24h 失败</h2>
            <p id="failedTasksSummary">加载中...</p>
          </div>
          <strong id="failedTasksCount">0</strong>
          <div class="issue-actions">
            <button type="button" class="adm-btn" data-issue-filter="failed">去处理</button>
          </div>
          <div id="failedTasks" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-warning">
          <div class="issue-icon">${adminIcon('shield')}</div>
          <div class="issue-copy">
            <h2>待复核内容风险</h2>
            <p id="contentRisksSummary">加载中...</p>
          </div>
          <strong id="contentRisksCount">0</strong>
          <div class="issue-actions">
            <a class="adm-btn" href="/admin/content">去内容审核</a>
          </div>
          <div id="contentRisks" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-purple">
          <div class="issue-icon">${adminIcon('user')}</div>
          <div class="issue-copy">
            <h2>异常账户</h2>
            <p id="abnormalAccountsSummary">加载中...</p>
          </div>
          <strong id="abnormalAccountsCount">0</strong>
          <div class="issue-actions">
            <a class="adm-btn" href="/admin/search">去客服检索</a>
          </div>
          <div id="abnormalAccounts" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-pink">
          <div class="issue-icon">${adminIcon('key')}</div>
          <div class="issue-copy">
            <h2>Key 池红灯</h2>
            <p id="keyPoolSummary">加载中...</p>
          </div>
          <strong id="keyPoolCount">0</strong>
          <div class="issue-actions">
            <a class="adm-btn" href="/admin/system">去系统页</a>
          </div>
          <div id="keyPool" class="issue-list" aria-live="polite"></div>
        </article>
      </section>
      <section class="kpi-strip" id="stats" aria-label="运营数据"></section>
      <section class="panel" id="tasksSection">
        <div class="adm-section-head">
          <h2>全部任务</h2>
          <span class="adm-count" data-tasks-count="true"></span>
        </div>
        <div class="adm-toolbar">
          <label class="adm-field" style="flex:1; min-width:240px;"><span>搜索</span>
            <input data-task-search="true" placeholder="任务 ID / 项目 ID / 用户名 / provider task" />
          </label>
          <label class="adm-field"><span>来源</span>
            <select data-task-source="true">
              <option value="">全部来源</option>
              <option value="batch">Batch</option>
              <option value="batch_task">Batch Task</option>
              <option value="video_task">Video Task</option>
              <option value="export">Export</option>
            </select>
          </label>
          <label class="adm-field"><span>状态</span>
            <select data-task-status="true">
              <option value="">全部状态</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="retry_pending">retry_pending</option>
              <option value="upstream_pending">upstream_pending</option>
              <option value="needs_review">needs_review</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
          </label>
          <div class="adm-actions">
            <button data-task-search-button="true" class="adm-btn adm-btn-primary">${adminIcon('search')}筛选</button>
            <button data-task-refresh="true" class="adm-btn">刷新</button>
          </div>
        </div>
        <div class="tasks-meta" data-tasks-meta="true"></div>
        <div class="admin-table-wrap">
          <table class="admin-table tasks-table">
            <thead>
              <tr>
                <th>来源</th>
                <th>ID</th>
                <th>用户 / 项目</th>
                <th>类型</th>
                <th>状态</th>
                <th>原因</th>
                <th>Provider</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody data-tasks-table="true"><tr><td colspan="9"><div class="adm-empty">加载中...</div></td></tr></tbody>
          </table>
        </div>
        <div class="notice" data-tasks-notice="true"></div>
      </section>
    `,
    scriptsHtml: HOME_SCRIPT,
  });
}

const HOME_STYLES = `<style>
  .issue-overview { align-items:stretch; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); }
  .issue-card {
    position:relative;
    min-height:108px;
    display:grid;
    grid-template-columns:52px minmax(0, 1fr) auto;
    gap:14px 16px;
    align-items:center;
    border:1px solid var(--line);
    background:rgba(255,255,255,.94);
    border-radius:var(--radius);
    padding:20px;
    box-shadow:var(--shadow-soft);
    overflow:hidden;
  }
  .issue-icon { width:52px; height:52px; display:grid; place-items:center; border-radius:999px; }
  .issue-icon .admin-icon { width:24px; height:24px; }
  .issue-copy { min-width:0; }
  .issue-copy h2 { margin:0; font-size:var(--admin-font-nav); line-height:1.25; font-weight:800; color:var(--admin-text-strong); letter-spacing:-.01em; white-space:nowrap; }
  .issue-copy p { margin:6px 0 0; font-size:var(--admin-font-sm); line-height:1.35; color:var(--admin-text-muted); white-space:nowrap; }
  .issue-card > strong { font-size:var(--admin-font-counter); line-height:1; font-weight:800; letter-spacing:-.04em; }
  .issue-actions { grid-column:1 / -1; display:flex; gap:8px; flex-wrap:wrap; }
  .issue-actions .adm-btn { height:30px; padding:0 10px; font-size:var(--admin-font-sm); }
  .issue-list { grid-column:1 / -1; display:none; padding-top:12px; border-top:1px solid var(--line); }
  .issue-list.has-items { display:block; }
  .issue-list .row { padding:8px 0; font-size:var(--admin-font-sm); color:var(--admin-text); }
  .issue-list .row:first-child { padding-top:0; }
  .issue-list b { color:var(--admin-text-strong); }
  .issue-danger .issue-icon { color:var(--danger); background:var(--danger-soft); }
  .issue-danger > strong { color:var(--danger); }
  .issue-warning .issue-icon { color:var(--warning); background:var(--warning-soft); }
  .issue-warning > strong { color:var(--warning); }
  .issue-purple .issue-icon { color:var(--purple); background:var(--purple-soft); }
  .issue-purple > strong { color:var(--purple); }
  .issue-pink .issue-icon { color:var(--pink); background:var(--pink-soft); }
  .issue-pink > strong { color:var(--pink); }
  .kpi-strip {
    width:min(720px, 100%);
    display:grid;
    grid-template-columns:repeat(4, minmax(0, 1fr));
    align-items:center;
    margin:26px 0;
    border:1px solid var(--line);
    background:#fff;
    border-radius:12px;
    box-shadow:0 8px 22px rgba(16,27,45,.05);
    overflow:hidden;
  }
  .kpi-item { min-height:58px; display:flex; align-items:center; justify-content:center; gap:12px; padding:10px 16px; border-right:1px solid var(--line); }
  .kpi-item:last-child { border-right:0; }
  .kpi-icon { width:30px; height:30px; display:grid; place-items:center; border-radius:999px; color:var(--accent); background:var(--accent-soft); flex:0 0 auto; }
  .kpi-icon .admin-icon { width:16px; height:16px; }
  .kpi-label { color:var(--admin-text-muted); font-size:var(--admin-font-md); font-weight:700; }
  .kpi-value { color:var(--accent); font-size:var(--admin-font-xl); font-weight:800; letter-spacing:-.02em; }
  .tasks-meta { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
  table.tasks-table { min-width:1120px; }
  .tasks-table .actions { display:flex; gap:6px; flex-wrap:wrap; min-width:210px; }
  @media (max-width: 1180px) {
    .issue-overview { grid-template-columns:repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 720px) {
    .issue-overview, .kpi-strip { grid-template-columns:1fr; }
    .kpi-item { justify-content:flex-start; border-right:0; border-bottom:1px solid var(--line); }
    .kpi-item:last-child { border-bottom:0; }
  }
</style>`;

const HOME_SCRIPT = `<script>
  const esc = adminUi.esc;
  const queueState = { needsReviewIds: [] };
  const taskState = { items: [] };
  const tasksTable = document.querySelector('[data-tasks-table="true"]');
  const tasksMeta = document.querySelector('[data-tasks-meta="true"]');
  const tasksNotice = document.querySelector('[data-tasks-notice="true"]');
  const taskQInput = document.querySelector('[data-task-search="true"]');
  const taskSourceInput = document.querySelector('[data-task-source="true"]');
  const taskStatusInput = document.querySelector('[data-task-status="true"]');

  async function loadStats() {
    const resp = await fetch('/api/admin/stats', { credentials:'same-origin' });
    if (!resp.ok) return;
    const data = await resp.json();
    document.getElementById('stats').innerHTML = [
      ['users', '用户', data.totalUsers || 0],
      ['cube', '项目', data.totalProjects || 0],
      ['activity', '在线', data.onlineCount || 0],
      ['crown', '付费用户', data.paidUsers || 0]
    ].map(([icon,k,v]) => '<div class="kpi-item"><span class="kpi-icon">' + iconSvg(icon) + '</span><span class="kpi-label">' + k + '</span><strong class="kpi-value">' + v + '</strong></div>').join('');
  }
  function renderQueueList(id, items, formatter, emptyText, activeText) {
    const el = document.getElementById(id);
    const countEl = document.getElementById(id + 'Count');
    const summaryEl = document.getElementById(id + 'Summary');
    if (!el) return;
    const list = Array.isArray(items) ? items : [];
    if (countEl) countEl.textContent = String(list.length);
    if (summaryEl) summaryEl.textContent = list.length ? activeText.replace('{count}', String(list.length)) : emptyText;
    el.classList.toggle('has-items', list.length > 0);
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = list.slice(0, 4).map(formatter).join('');
  }
  async function loadProblemQueue() {
    const resp = await fetch('/api/admin/problem-queue', { credentials:'same-origin' });
    if (!resp.ok) return;
    const data = await resp.json();
    queueState.needsReviewIds = (data.needsReviewTasks || []).map((item) => String(item.id));
    renderQueueList('needsReview', data.needsReviewTasks, (item) =>
      '<div class="row"><b>' + esc(item.kind || '') + (item.taskType ? ' / ' + esc(item.taskType) : '') + '</b> #' + esc(item.id) + '<br><span class="muted">' + esc(item.reason || '') + '</span></div>',
      '暂无需人工处理的任务',
      '{count} 条 needs_review 待处理'
    );
    renderQueueList('staleTasks', data.staleTasks, (item) =>
      '<div class="row"><b>' + esc(item.source) + '</b> #' + esc(item.id) + '<br><span class="muted">' + esc(item.reason || item.lastSignalAt || '') + '</span></div>',
      '暂无卡住任务',
      '{count} 条 running 超时无心跳'
    );
    renderQueueList('failedTasks', data.failedTasks, (item) =>
      '<div class="row"><b>' + esc(item.source) + '</b> #' + esc(item.id) + '<br><span class="muted">' + esc(item.reason || '') + '</span></div>',
      '近 24 小时无失败任务',
      '{count} 条近 24h 失败'
    );
    renderQueueList('contentRisks', data.contentRisks, (item) =>
      '<div class="row"><b>' + esc(item.severity) + '</b> ' + esc(item.scanReason) + '<br><span class="muted">' + esc(item.sourceType) + ' #' + esc(item.sourceId) + '</span></div>',
      '暂无待复核内容风险',
      '{count} 条内容风险待复核'
    );
    renderQueueList('abnormalAccounts', data.abnormalAccounts, (item) =>
      '<div class="row"><b>' + esc(item.username) + '</b><br><span class="muted">' + esc(item.reason) + '</span></div>',
      '暂无异常账户',
      '{count} 个异常账户'
    );
    renderQueueList('keyPool', data.keyPoolAlerts, (item) =>
      '<div class="row"><b>' + esc(item.slot) + '</b><br><span class="muted">' + esc(item.reason) + '</span></div>',
      '暂无 Key 池红灯',
      '{count} 个 Key 池告警'
    );
  }
  function iconSvg(name) {
    const icons = {
      users: '${adminIcon('users')}',
      cube: '${adminIcon('cube')}',
      activity: '${adminIcon('activity')}',
      crown: '${adminIcon('crown')}'
    };
    return icons[name] || icons.activity;
  }

  // ===== 全部任务（原任务管理页，写路径统一为 /api/admin/tasks） =====
  function sourceLabel(source) {
    return ({ batch:'Batch', batch_task:'Batch Task', video_task:'Video', export:'Export' })[source] || source;
  }
  function statusBadge(status) {
    return '<span class="badge ' + esc(status) + '">' + esc(status || '-') + '</span>';
  }
  function actionButtons(item) {
    const active = ['queued','running','retry_pending','upstream_pending','needs_review'].includes(item.status);
    const buttons = [];
    if (item.source === 'batch' && active) buttons.push(['cancel', '取消', 'danger']);
    if (item.source === 'batch_task' && active) buttons.push(['cancel', '取消', 'danger']);
    if (item.source === 'batch_task' && ['needs_review','failed','cancelled','retry_pending'].includes(item.status)) buttons.push(['retry', '重试', 'primary']);
    if (item.source === 'batch_task' && active) buttons.push(['force_fail', '强制失败', 'danger']);
    if ((item.source === 'video_task' || item.source === 'export') && ['queued','running'].includes(item.status)) {
      buttons.push(['cancel', '取消', 'danger'], ['force_fail', '强制失败', 'danger']);
    }
    if (['failed','cancelled','needs_review'].includes(item.status) || item.source === 'batch') buttons.push(['refund_check', '退款检查', 'primary']);
    if (!buttons.length) return '<span class="muted">无可用动作</span>';
    return buttons.map(([action, label, cls]) =>
      '<button class="' + cls + '" data-action="' + action + '" data-source="' + esc(item.source) + '" data-id="' + esc(item.id) + '">' + label + '</button>'
    ).join('');
  }
  function renderTasks() {
    const items = taskState.items || [];
    const bySource = items.reduce((acc, item) => { acc[item.source] = (acc[item.source] || 0) + 1; return acc; }, {});
    document.querySelector('[data-tasks-count="true"]').textContent = items.length + ' 条';
    tasksMeta.innerHTML = [
      '<span class="chip">Batch：' + (bySource.batch || 0) + '</span>',
      '<span class="chip">子任务：' + (bySource.batch_task || 0) + '</span>',
      '<span class="chip">视频：' + (bySource.video_task || 0) + '</span>',
      '<span class="chip">导出：' + (bySource.export || 0) + '</span>'
    ].join('');
    if (!items.length) {
      tasksTable.innerHTML = adminUi.emptyRow(9, '暂无匹配任务');
      return;
    }
    tasksTable.innerHTML = items.map((item) => '<tr>' +
      '<td>' + esc(sourceLabel(item.source)) + '</td>' +
      '<td><span class="mono">' + esc(item.id) + '</span>' + (item.batchId ? '<div class="muted mono">batch ' + esc(item.batchId) + '</div>' : '') + '</td>' +
      '<td><strong>' + esc(item.username || item.ownerId || '-') + '</strong><div class="muted mono">' + esc(item.projectTitle || item.projectId || '-') + '</div></td>' +
      '<td>' + esc(item.kind || '-') + (item.taskType ? '<div class="muted">' + esc(item.taskType) + '</div>' : '') + '</td>' +
      '<td>' + statusBadge(item.status) + (item.cancelRequestedAt ? '<div class="muted">已请求取消</div>' : '') + '</td>' +
      '<td>' + esc(item.reason || '-') + '</td>' +
      '<td>' + esc(item.provider || '-') + (item.providerTaskId ? '<div class="muted mono">' + esc(item.providerTaskId) + '</div>' : '') + '</td>' +
      '<td>' + esc(adminUi.fmtDate(item.updatedAt)) + '</td>' +
      '<td><div class="actions">' + actionButtons(item) + '</div></td>' +
    '</tr>').join('');
  }
  async function loadTasks() {
    const params = new URLSearchParams();
    if (taskQInput.value.trim()) params.set('q', taskQInput.value.trim());
    if (taskSourceInput.value) params.set('source', taskSourceInput.value);
    if (taskStatusInput.value) params.set('status', taskStatusInput.value);
    adminUi.setNotice(tasksNotice, '加载中...');
    const res = await fetch('/api/admin/tasks?' + params.toString(), { credentials:'same-origin' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      adminUi.setNotice(tasksNotice, (data && data.detail) || '加载失败', 'error');
      return;
    }
    taskState.items = data.items || [];
    renderTasks();
    adminUi.setNotice(tasksNotice, '已更新', 'ok');
  }
  function actionLabel(action) {
    return ({ cancel:'取消', retry:'重试', force_fail:'强制失败', refund_check:'退款检查' })[action] || action;
  }
  async function mutateTask(action, source, id) {
    const item = taskState.items.find((t) => t.source === source && String(t.id) === String(id));
    const label = actionLabel(action);
    const reason = window.prompt(label + ' ' + sourceLabel(source) + ' ' + id + ' 的原因');
    if (!reason || !reason.trim()) return;
    const headers = { 'content-type':'application/json', 'x-idempotency-key': adminUi.idemKey(), 'x-admin-reason': reason.trim() };
    const payload = { action, source, id, reason: reason.trim(), dryRun: true };
    adminUi.setNotice(tasksNotice, '正在预检查...');
    const dryRun = await fetch('/api/admin/tasks', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(payload) });
    const dryRunData = await dryRun.json().catch(() => null);
    if (!dryRun.ok || !dryRunData?.dryRun) {
      adminUi.setNotice(tasksNotice, (dryRunData && dryRunData.detail) || '预检查失败', 'error');
      return;
    }
    const warnings = Array.isArray(dryRunData.warnings) && dryRunData.warnings.length ? '\\n' + dryRunData.warnings.join('\\n') : '';
    if (!window.confirm(label + ' ' + (item?.id || id) + '？此操作会写入审计日志。' + warnings)) {
      adminUi.setNotice(tasksNotice, '已取消');
      return;
    }
    adminUi.setNotice(tasksNotice, '正在提交...');
    const commit = await fetch('/api/admin/tasks', {
      method:'POST',
      credentials:'same-origin',
      headers,
      body: JSON.stringify({ action, source, id, reason: reason.trim() }),
    });
    const commitData = await commit.json().catch(() => null);
    if (!commit.ok) {
      adminUi.setNotice(tasksNotice, (commitData && commitData.detail) || '提交失败', 'error');
      return;
    }
    adminUi.setNotice(tasksNotice, label + '已完成', 'ok');
    await Promise.all([loadTasks(), loadProblemQueue()]);
  }
  async function bulkRequeue() {
    const ids = queueState.needsReviewIds;
    if (!ids.length) { window.alert('当前没有 needs_review 任务'); return; }
    const reason = window.prompt('批量重排 ' + ids.length + ' 条 needs_review 任务的原因');
    if (!reason || !reason.trim()) return;
    if (!window.confirm('确认将 ' + ids.length + ' 条任务重新排队？超出重试上限的任务会被自动跳过。')) return;
    const headers = { 'content-type':'application/json', 'x-idempotency-key': adminUi.idemKey(), 'x-admin-reason': reason.trim() };
    const res = await fetch('/api/admin/problem-queue', {
      method:'POST',
      credentials:'same-origin',
      headers,
      body: JSON.stringify({ action:'bulk_requeue', taskIds: ids, reason: reason.trim() }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) { window.alert((data && data.detail) || '批量重排失败'); return; }
    const okCount = (data.ok || []).length;
    const failCount = (data.failed || []).length;
    window.alert('重排完成：成功 ' + okCount + ' 条，跳过/失败 ' + failCount + ' 条');
    await Promise.all([loadTasks(), loadProblemQueue()]);
  }

  document.querySelector('[data-task-search-button="true"]')?.addEventListener('click', loadTasks);
  document.querySelector('[data-task-refresh="true"]')?.addEventListener('click', loadTasks);
  taskQInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadTasks(); });
  tasksTable?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    mutateTask(button.dataset.action, button.dataset.source, button.dataset.id);
  });
  document.getElementById('bulkRequeueButton')?.addEventListener('click', bulkRequeue);
  document.querySelectorAll('[data-issue-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      taskStatusInput.value = button.dataset.issueFilter || '';
      taskSourceInput.value = '';
      loadTasks();
      document.getElementById('tasksSection')?.scrollIntoView({ behavior:'smooth', block:'start' });
    });
  });
  window.adminStartPolling?.(async () => { await Promise.all([loadProblemQueue(), loadStats(), loadTasks()]); });
</script>`;
