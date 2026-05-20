import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/tasks',
    title: '任务管理',
    headHtml: `<style>
      .tasks-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
      .tasks-toolbar input { width:300px; max-width:100%; }
      .tasks-meta { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
      table.admin-table { min-width:1120px; }
      .actions { display:flex; gap:6px; flex-wrap:wrap; min-width:210px; }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="tasks-toolbar">
        <input data-task-search="true" placeholder="搜索任务 ID / 项目 ID / 用户名 / provider task" />
        <select data-task-source="true">
          <option value="">全部来源</option>
          <option value="batch">Batch</option>
          <option value="batch_task">Batch Task</option>
          <option value="video_task">Video Task</option>
          <option value="export">Export</option>
        </select>
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
        <button data-task-search-button="true" class="primary">筛选</button>
        <button data-task-refresh="true">刷新</button>
      </div>
      <div class="tasks-meta" data-tasks-meta="true"></div>
      <div class="admin-table-wrap">
        <table class="admin-table">
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
          <tbody data-tasks-table="true"><tr><td colspan="9" class="muted">加载中...</td></tr></tbody>
        </table>
      </div>
      <div class="notice" data-tasks-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const taskState = { items: [] };
      const table = document.querySelector('[data-tasks-table="true"]');
      const meta = document.querySelector('[data-tasks-meta="true"]');
      const notice = document.querySelector('[data-tasks-notice="true"]');
      const qInput = document.querySelector('[data-task-search="true"]');
      const sourceInput = document.querySelector('[data-task-source="true"]');
      const statusInput = document.querySelector('[data-task-status="true"]');

      function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
      }
      function setNotice(message, kind = '') {
        notice.textContent = message || '';
        notice.dataset.kind = kind;
      }
      function fmtDate(value) {
        if (!value) return '-';
        try { return new Date(value).toLocaleString('zh-CN', { hour12:false }); } catch { return value; }
      }
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
        meta.innerHTML = [
          '<span class="chip">结果：' + items.length + '</span>',
          '<span class="chip">Batch：' + (bySource.batch || 0) + '</span>',
          '<span class="chip">子任务：' + (bySource.batch_task || 0) + '</span>',
          '<span class="chip">视频：' + (bySource.video_task || 0) + '</span>',
          '<span class="chip">导出：' + (bySource.export || 0) + '</span>'
        ].join('');
        if (!items.length) {
          table.innerHTML = '<tr><td colspan="9" class="muted">暂无匹配任务</td></tr>';
          return;
        }
        table.innerHTML = items.map((item) => '<tr>' +
          '<td>' + esc(sourceLabel(item.source)) + '</td>' +
          '<td><span class="mono">' + esc(item.id) + '</span>' + (item.batchId ? '<div class="muted mono">batch ' + esc(item.batchId) + '</div>' : '') + '</td>' +
          '<td><strong>' + esc(item.username || item.ownerId || '-') + '</strong><div class="muted mono">' + esc(item.projectTitle || item.projectId || '-') + '</div></td>' +
          '<td>' + esc(item.kind || '-') + (item.taskType ? '<div class="muted">' + esc(item.taskType) + '</div>' : '') + '</td>' +
          '<td>' + statusBadge(item.status) + (item.cancelRequestedAt ? '<div class="muted">已请求取消</div>' : '') + '</td>' +
          '<td>' + esc(item.reason || '-') + '</td>' +
          '<td>' + esc(item.provider || '-') + (item.providerTaskId ? '<div class="muted mono">' + esc(item.providerTaskId) + '</div>' : '') + '</td>' +
          '<td>' + esc(fmtDate(item.updatedAt)) + '</td>' +
          '<td><div class="actions">' + actionButtons(item) + '</div></td>' +
        '</tr>').join('');
      }
      async function loadTasks() {
        const params = new URLSearchParams();
        if (qInput.value.trim()) params.set('q', qInput.value.trim());
        if (sourceInput.value) params.set('source', sourceInput.value);
        if (statusInput.value) params.set('status', statusInput.value);
        setNotice('加载中...');
        const res = await fetch('/api/admin/tasks?' + params.toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setNotice((data && data.detail) || '加载失败', 'error');
          return;
        }
        taskState.items = data.items || [];
        renderTasks();
        setNotice('已更新', 'ok');
      }
      function actionLabel(action) {
        return ({ cancel:'取消', retry:'重试', force_fail:'强制失败', refund_check:'退款检查' })[action] || action;
      }
      async function mutateTask(action, source, id) {
        const item = taskState.items.find((t) => t.source === source && String(t.id) === String(id));
        const label = actionLabel(action);
        const reason = window.prompt(label + ' ' + sourceLabel(source) + ' ' + id + ' 的原因');
        if (!reason || !reason.trim()) return;
        const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const headers = { 'content-type':'application/json', 'x-idempotency-key': idempotencyKey, 'x-admin-reason': reason.trim() };
        const payload = { action, source, id, reason: reason.trim(), dryRun: true };
        setNotice('正在预检查...');
        const dryRun = await fetch('/api/admin/tasks', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(payload) });
        const dryRunData = await dryRun.json().catch(() => null);
        if (!dryRun.ok || !dryRunData?.dryRun) {
          setNotice((dryRunData && dryRunData.detail) || '预检查失败', 'error');
          return;
        }
        const warnings = Array.isArray(dryRunData.warnings) && dryRunData.warnings.length ? '\\n' + dryRunData.warnings.join('\\n') : '';
        if (!window.confirm(label + ' ' + (item?.id || id) + '？此操作会写入审计日志。' + warnings)) {
          setNotice('已取消');
          return;
        }
        setNotice('正在提交...');
        const commit = await fetch('/api/admin/tasks', {
          method:'POST',
          credentials:'same-origin',
          headers,
          body: JSON.stringify({ action, source, id, reason: reason.trim() }),
        });
        const commitData = await commit.json().catch(() => null);
        if (!commit.ok) {
          setNotice((commitData && commitData.detail) || '提交失败', 'error');
          return;
        }
        setNotice(label + '已完成', 'ok');
        await loadTasks();
      }
      document.querySelector('[data-task-search-button="true"]')?.addEventListener('click', loadTasks);
      document.querySelector('[data-task-refresh="true"]')?.addEventListener('click', loadTasks);
      qInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadTasks(); });
      table?.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        mutateTask(button.dataset.action, button.dataset.source, button.dataset.id);
      });
      window.adminStartPolling?.(loadTasks);
    </script>`,
  });
}
