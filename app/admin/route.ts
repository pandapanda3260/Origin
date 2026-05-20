import { NextRequest } from 'next/server';
import { adminIcon, renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin',
    title: '问题队列运营台',
    headHtml: HOME_STYLES,
    bodyHtml: `
      <section class="grid issue-overview" aria-label="问题队列概览">
        <article class="issue-card issue-danger">
          <div class="issue-icon">${adminIcon('alert')}</div>
          <div class="issue-copy">
            <h2>失败 / 卡住任务</h2>
            <p id="staleTasksSummary">加载中...</p>
          </div>
          <strong id="staleTasksCount">0</strong>
          <div id="staleTasks" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-warning">
          <div class="issue-icon">${adminIcon('review')}</div>
          <div class="issue-copy">
            <h2>待复核内容风险</h2>
            <p id="contentRisksSummary">加载中...</p>
          </div>
          <strong id="contentRisksCount">0</strong>
          <div id="contentRisks" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-purple">
          <div class="issue-icon">${adminIcon('user')}</div>
          <div class="issue-copy">
            <h2>异常账户</h2>
            <p id="abnormalAccountsSummary">加载中...</p>
          </div>
          <strong id="abnormalAccountsCount">0</strong>
          <div id="abnormalAccounts" class="issue-list" aria-live="polite"></div>
        </article>
        <article class="issue-card issue-pink">
          <div class="issue-icon">${adminIcon('key')}</div>
          <div class="issue-copy">
            <h2>Key 池红灯</h2>
            <p id="keyPoolSummary">加载中...</p>
          </div>
          <strong id="keyPoolCount">0</strong>
          <div id="keyPool" class="issue-list" aria-live="polite"></div>
        </article>
      </section>
      <section class="kpi-strip" id="stats" aria-label="运营数据"></section>
      <section class="panel log-panel">
        <div class="panel-head">
          <h2><span class="panel-title-icon">${adminIcon('file')}</span>系统日志</h2>
          <div class="log-actions">
            <button type="button" id="autoScrollLogs" class="log-tool active" aria-pressed="true"><span class="status-dot"></span>自动滚动</button>
            <button type="button" id="clearLogs" class="log-tool">${adminIcon('trash')}清空</button>
          </div>
        </div>
        <pre id="logs" class="log-console">加载中...</pre>
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
    gap:16px;
    align-items:center;
    border:1px solid var(--line);
    background:rgba(255,255,255,.94);
    border-radius:var(--radius);
    padding:22px 20px;
    box-shadow:var(--shadow-soft);
    transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    overflow:hidden;
  }
  .issue-card:hover { transform:translateY(-2px); box-shadow:var(--shadow); border-color:var(--admin-border); }
  .issue-icon { width:52px; height:52px; display:grid; place-items:center; border-radius:999px; font-size:var(--admin-font-page); }
  .issue-icon .admin-icon { width:24px; height:24px; }
  .issue-copy { min-width:0; }
  .issue-copy h2 { margin:0; font-size:var(--admin-font-nav); line-height:1.25; font-weight:800; color:var(--admin-text-strong); letter-spacing:-.01em; white-space:nowrap; }
  .issue-copy p { margin:6px 0 0; font-size:var(--admin-font-sm); line-height:1.35; color:var(--admin-text-muted); white-space:nowrap; }
  .issue-card > strong { font-size:var(--admin-font-counter); line-height:1; font-weight:800; letter-spacing:-.04em; }
  .issue-list { grid-column:1 / -1; display:none; margin-top:2px; padding-top:14px; border-top:1px solid var(--line); }
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
    margin:30px 0;
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
  .panel-head { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; }
  .panel-head h2 { display:flex; align-items:center; gap:10px; margin:0; font-size:var(--admin-font-xl); }
  .panel-title-icon { width:22px; height:22px; display:grid; place-items:center; color:var(--accent); }
  .panel-title-icon .admin-icon { width:21px; height:21px; }
  .log-actions { display:flex; align-items:center; gap:10px; }
  .log-tool { height:34px; display:inline-flex; align-items:center; gap:7px; padding:0 12px; border-radius:10px; color:var(--admin-text); background:#fff; font-size:var(--admin-font-sm); font-weight:700; }
  .log-tool .admin-icon { width:14px; height:14px; }
  .log-tool.active { color:var(--admin-text); }
  .log-tool:not(.active) .status-dot { background:var(--admin-border); box-shadow:none; }
  .log-console {
    min-height:300px;
    max-height:380px;
    margin:0;
    border:1px solid rgba(255,255,255,.06);
    background:radial-gradient(circle at 16% 0%, rgba(35, 92, 104, .22), transparent 28%), linear-gradient(135deg, var(--admin-log-bg) 0%, var(--admin-log-bg) 100%);
    color:var(--admin-log-text);
    padding:22px 24px;
    border-radius:12px;
    font-family:"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size:var(--admin-font-sm);
    line-height:1.7;
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.04);
  }
  @media (max-width: 1180px) {
    .issue-overview { grid-template-columns:repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 720px) {
    .issue-overview, .kpi-strip { grid-template-columns:1fr; }
    .kpi-item { justify-content:flex-start; border-right:0; border-bottom:1px solid var(--line); }
    .kpi-item:last-child { border-bottom:0; }
    .panel-head { align-items:flex-start; flex-direction:column; }
  }
</style>`;

const HOME_SCRIPT = `<script>
  let autoScrollLogs = true;
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
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
  async function loadLogs() {
    const resp = await fetch('/api/admin/logs?level=warning&lines=120', { credentials:'same-origin' });
    const el = document.getElementById('logs');
    if (!resp.ok) { el.textContent = '日志加载失败'; return; }
    const data = await resp.json();
    el.textContent = (data.lines || []).join('\\n') || '暂无日志';
    if (autoScrollLogs) el.scrollTop = el.scrollHeight;
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
    renderQueueList('staleTasks', data.staleTasks, (item) =>
      '<div class="row"><b>' + escapeHtml(item.source) + '</b> #' + escapeHtml(item.id) + '<br><span class="muted">' + escapeHtml(item.reason || item.lastSignalAt || '') + '</span></div>',
      '暂无失败或卡住任务',
      '{count} 条任务需要处理'
    );
    renderQueueList('contentRisks', data.contentRisks, (item) =>
      '<div class="row"><b>' + escapeHtml(item.severity) + '</b> ' + escapeHtml(item.scanReason) + '<br><span class="muted">' + escapeHtml(item.sourceType) + ' #' + escapeHtml(item.sourceId) + '</span></div>',
      '暂无待复核内容风险',
      '{count} 条内容风险待复核'
    );
    renderQueueList('abnormalAccounts', data.abnormalAccounts, (item) =>
      '<div class="row"><b>' + escapeHtml(item.username) + '</b><br><span class="muted">' + escapeHtml(item.reason) + '</span></div>',
      '暂无异常账户',
      '{count} 个异常账户'
    );
    renderQueueList('keyPool', data.keyPoolAlerts, (item) =>
      '<div class="row"><b>' + escapeHtml(item.slot) + '</b><br><span class="muted">' + escapeHtml(item.reason) + '</span></div>',
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
  document.getElementById('autoScrollLogs')?.addEventListener('click', () => {
    autoScrollLogs = !autoScrollLogs;
    const btn = document.getElementById('autoScrollLogs');
    btn.classList.toggle('active', autoScrollLogs);
    btn.setAttribute('aria-pressed', String(autoScrollLogs));
    if (autoScrollLogs) {
      const el = document.getElementById('logs');
      el.scrollTop = el.scrollHeight;
    }
  });
  document.getElementById('clearLogs')?.addEventListener('click', () => {
    document.getElementById('logs').textContent = '';
  });
  window.adminStartPolling?.(async () => { await Promise.all([loadProblemQueue(), loadStats(), loadLogs()]); });
</script>`;
