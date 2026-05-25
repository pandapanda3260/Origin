import { NextRequest } from 'next/server';
import { adminIcon, renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const icons = {
    activity: adminIcon('activity'),
    alert: adminIcon('alert'),
    cube: adminIcon('cube'),
    file: adminIcon('file'),
    search: adminIcon('search'),
    user: adminIcon('user'),
    users: adminIcon('users'),
  };
  const iconsJson = JSON.stringify(icons).replace(/<\//g, '<\\/');

  return renderAdminPage(req, {
    activePath: '/admin/time-stats',
    title: '时间统计',
    headHtml: `<style>
      main { max-width:1840px; }
      .time-overview { padding:22px; }
      .time-toolbar { display:grid; grid-template-columns:minmax(180px,.65fr) minmax(150px,.45fr) minmax(190px,.55fr) minmax(210px,.7fr) minmax(170px,.55fr) minmax(240px,.85fr) auto; gap:14px; align-items:end; }
      .time-control { min-width:0; }
      .time-control label { display:block; margin:0 0 8px; color:var(--admin-text); font-size:var(--admin-font-sm); font-weight:800; }
      .time-control input, .time-control select { width:100%; height:42px; border:1px solid var(--line-strong); border-radius:8px; background:#fff; color:var(--admin-text-strong); padding:0 12px; font-size:var(--admin-font-md); font-weight:700; }
      .time-actions { display:flex; gap:10px; align-items:center; justify-content:flex-end; }
      .time-action { height:42px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:0 16px; border-radius:8px; border:1px solid var(--line-strong); background:#fff; color:var(--admin-text); font-size:var(--admin-font-md); font-weight:800; }
      .time-action-primary { border-color:rgba(17,156,145,.55); background:linear-gradient(180deg, var(--accent), var(--accent-dark)); color:#fff; }
      .time-date-fields { display:none; grid-column:1 / -1; grid-template-columns:repeat(2, minmax(220px, 1fr)); gap:14px; }
      .time-toolbar[data-range="custom"] .time-date-fields { display:grid; }
      .time-notes { display:flex; flex-wrap:wrap; gap:10px; margin:18px 0 0; }
      .time-note { min-height:34px; display:inline-flex; align-items:center; gap:8px; padding:0 12px; border-radius:6px; background:var(--admin-info-soft); color:var(--admin-text); font-size:var(--admin-font-sm); font-weight:700; }
      .time-note .admin-icon { width:16px; height:16px; color:var(--admin-info); }
      .time-kpis { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:14px; margin-top:20px; }
      .time-kpi { min-height:108px; border:1px solid var(--line); border-radius:8px; background:#fff; padding:18px; box-shadow:0 10px 24px rgba(16,27,45,.035); }
      .time-kpi[data-empty="true"] { opacity:.48; }
      .time-kpi-label { display:block; color:var(--admin-text); font-size:var(--admin-font-sm); font-weight:800; }
      .time-kpi-value { display:block; margin-top:8px; color:var(--admin-text-strong); font-size:var(--admin-font-page); line-height:1; font-weight:900; letter-spacing:0; }
      .time-kpi-sub { display:block; margin-top:8px; color:var(--admin-text-muted); font-size:var(--admin-font-sm); font-weight:700; }
      .time-split { display:grid; grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr); gap:20px; margin-top:22px; }
      .time-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 14px; }
      .time-section-head h2 { margin:0; font-size:var(--admin-font-page); line-height:1.25; font-weight:900; letter-spacing:0; }
      .time-count { color:var(--admin-text-muted); font-size:var(--admin-font-md); font-weight:800; white-space:nowrap; }
      .time-table { width:100%; table-layout:fixed; }
      .time-table th, .time-table td { padding:13px 16px; vertical-align:middle; }
      .time-table th { color:var(--admin-text-muted); font-size:var(--admin-font-sm); font-weight:800; white-space:nowrap; }
      .time-table td { color:var(--admin-text-strong); font-size:var(--admin-font-sm); }
      .time-cell-title { display:block; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .time-cell-sub { display:block; margin-top:4px; color:var(--admin-text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .time-details { margin-top:22px; }
      .time-details .time-table { min-width:1280px; }
      .time-table-wrap { max-width:100%; overflow:auto; border-radius:8px; }
      .time-empty { min-height:110px; display:grid; place-items:center; gap:8px; color:var(--admin-text-subtle); text-align:center; font-size:var(--admin-font-md); font-weight:700; }
      .time-empty .admin-icon { width:34px; height:34px; color:var(--admin-text-subtle); }
      .time-status { display:inline-flex; align-items:center; min-height:28px; padding:0 10px; border-radius:999px; background:var(--admin-info-soft); color:var(--admin-info); font-weight:900; }
      .time-status.failed { background:var(--admin-danger-soft); color:var(--admin-danger); }
      .time-status.cancelled { background:var(--admin-warning-soft); color:var(--admin-warning); }
      .time-status.success { background:var(--admin-success-soft); color:var(--admin-success-strong); }
      .time-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; }
      .time-pager { display:flex; gap:10px; align-items:center; }
      .time-pager button { min-width:74px; height:36px; border-radius:8px; border:1px solid var(--line-strong); background:#fff; font-weight:800; }
      .notice[data-kind="error"] { color:var(--admin-danger); }
      .notice[data-kind="ok"] { color:var(--admin-success-strong); }
      @media (max-width:1400px) {
        .time-toolbar { grid-template-columns:repeat(3,minmax(0,1fr)); }
        .time-actions { justify-content:flex-start; }
        .time-kpis { grid-template-columns:repeat(3,minmax(0,1fr)); }
        .time-split { grid-template-columns:1fr; }
      }
    </style>`,
    bodyHtml: `<section class="panel time-overview">
      <div class="time-toolbar" data-time-toolbar="true" data-range="7d">
        <div class="time-control"><label>时间范围</label><select data-time-range="true"><option value="1d">最近 1 天</option><option value="7d" selected>最近 7 天</option><option value="30d">最近 30 天</option><option value="custom">自定义</option></select></div>
        <div class="time-control"><label>用户 ID</label><input data-time-owner="true" inputmode="numeric" placeholder="全部" /></div>
        <div class="time-control"><label>模块</label><select data-time-module="true"><option value="">全部模块</option></select></div>
        <div class="time-control"><label>功能项</label><select data-time-feature="true"><option value="">全部功能</option></select></div>
        <div class="time-control"><label>状态</label><select data-time-status="true"><option value="">全部状态</option><option value="success">成功</option><option value="partial_success">部分成功</option><option value="failed">失败</option><option value="cancelled">取消</option><option value="active">进行中</option></select></div>
        <div class="time-control"><label>搜索</label><input data-time-query="true" placeholder="项目 / 用户 / 调用项" /></div>
        <div class="time-actions"><button class="time-action time-action-primary" data-time-refresh="true">${icons.search}查询</button><button class="time-action" data-time-export="true">${icons.file}CSV</button></div>
        <div class="time-date-fields">
          <div class="time-control"><label>开始日期</label><input type="date" data-time-from="true" /></div>
          <div class="time-control"><label>结束日期</label><input type="date" data-time-to="true" /></div>
        </div>
      </div>
      <div class="time-notes" data-time-notes="true"></div>
      <div class="time-kpis" data-time-kpis="true"></div>
    </section>
    <div class="time-split">
      <section class="panel"><div class="time-section-head"><h2>用户等待</h2><span class="time-count" data-time-user-count="true">0 条</span></div><div class="time-table-wrap"><table class="time-table"><thead><tr><th>用户</th><th>任务</th><th>成功</th><th>失败</th><th>平均</th><th>P95</th></tr></thead><tbody data-time-users="true"></tbody></table></div></section>
      <section class="panel"><div class="time-section-head"><h2>环节分布</h2><span class="time-count" data-time-category-count="true">0 条</span></div><div class="time-table-wrap"><table class="time-table"><thead><tr><th>模块</th><th>功能项</th><th>任务</th><th>平均</th><th>P95</th></tr></thead><tbody data-time-categories="true"></tbody></table></div></section>
    </div>
    <section class="panel time-details">
      <div class="time-section-head"><h2>等待明细</h2><span class="time-count" data-time-total="true">0 条</span></div>
      <div class="time-table-wrap"><table class="time-table"><thead><tr><th>开始时间</th><th>用户 / 项目</th><th>环节</th><th>调用项</th><th>状态</th><th>等待</th><th>来源</th><th>错误</th></tr></thead><tbody data-time-details="true"></tbody></table></div>
      <div class="time-foot"><span class="notice" data-time-notice="true"></span><div class="time-pager"><button data-time-prev="true">上一页</button><span data-time-page="true">1 / 1</span><button data-time-next="true">下一页</button></div></div>
    </section>`,
    scriptsHtml: `<script>
      const icons = ${iconsJson};
      const state = { offset:0, limit:100, total:0, features:[] };
      const toolbar = document.querySelector('[data-time-toolbar="true"]');
      const rangeInput = document.querySelector('[data-time-range="true"]');
      const ownerInput = document.querySelector('[data-time-owner="true"]');
      const moduleInput = document.querySelector('[data-time-module="true"]');
      const featureInput = document.querySelector('[data-time-feature="true"]');
      const statusInput = document.querySelector('[data-time-status="true"]');
      const qInput = document.querySelector('[data-time-query="true"]');
      const fromInput = document.querySelector('[data-time-from="true"]');
      const toInput = document.querySelector('[data-time-to="true"]');
      const notice = document.querySelector('[data-time-notice="true"]');
      const prevButton = document.querySelector('[data-time-prev="true"]');
      const nextButton = document.querySelector('[data-time-next="true"]');
      const pageText = document.querySelector('[data-time-page="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      function setNotice(message, kind = '') { notice.textContent = message || ''; notice.dataset.kind = kind; }
      function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
      function fmtMs(ms) { if (ms == null) return '-'; const s = Math.round(Number(ms) / 1000); if (s < 60) return s + ' 秒'; const m = Math.floor(s / 60); const r = s % 60; if (m < 60) return m + ' 分 ' + r + ' 秒'; const h = Math.floor(m / 60); return h + ' 小时 ' + (m % 60) + ' 分'; }
      function fmtDate(value) { if (!value) return '-'; try { return new Date(value).toLocaleString('zh-CN', { hour12:false, timeZone:'Asia/Shanghai' }); } catch { return value; } }
      function fmtError(value) {
        let text = String(value || '').trim();
        if (!text) return '-';
        text = text
          .replace(/("(?:prompt|input|messages|request|response|body)"\\s*:\\s*)("[^"]*"|\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\})/gi, '$1"[redacted]"')
          .replace(/((?:prompt|input|messages|request|response|body)\\s*[:=]\\s*)(.{20,400})/gi, '$1[redacted]');
        return text.length > 200 ? text.slice(0, 200) + '...' : text;
      }
      function params(extra = {}) {
        const p = new URLSearchParams();
        p.set('range', rangeInput.value);
        if (rangeInput.value === 'custom') {
          if (fromInput.value) p.set('from', fromInput.value);
          if (toInput.value) p.set('to', toInput.value);
        }
        if (ownerInput.value.trim()) p.set('ownerId', ownerInput.value.trim());
        if (moduleInput.value) p.set('moduleKey', moduleInput.value);
        if (featureInput.value) p.set('featureKey', featureInput.value);
        if (statusInput.value) p.set('status', statusInput.value);
        if (qInput.value.trim()) p.set('q', qInput.value.trim());
        Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
        return p;
      }
      function empty(cols, text = '暂无数据') {
        return '<tr><td colspan="' + cols + '"><div class="time-empty">' + icons.file + '<span>' + esc(text) + '</span></div></td></tr>';
      }
      function populateFilters(features) {
        if (!features || !features.length || state.features.length) return;
        state.features = features;
        const modules = [];
        features.forEach((f) => { if (!modules.some((m) => m.moduleKey === f.moduleKey)) modules.push({ moduleKey:f.moduleKey, moduleLabel:f.moduleLabel }); });
        moduleInput.innerHTML = '<option value="">全部模块</option>' + modules.map((m) => '<option value="' + esc(m.moduleKey) + '">' + esc(m.moduleLabel) + '</option>').join('');
        renderFeatureOptions();
      }
      function renderFeatureOptions() {
        const moduleKey = moduleInput.value;
        const features = state.features.filter((f) => !moduleKey || f.moduleKey === moduleKey);
        featureInput.innerHTML = '<option value="">全部功能</option>' + features.map((f) => '<option value="' + esc(f.featureKey) + '">' + esc(f.featureLabel) + '</option>').join('');
      }
      function renderKpis(summary) {
        const groups = [
          ['成功', summary.success],
          ['失败', summary.failed],
          ['取消', summary.cancelled],
          ['部分成功', summary.partialSuccess],
        ];
        const cards = groups.map(([label, metric]) => ({ label, value:fmtMs(metric && metric.avgWaitMs), sub:'P95 ' + fmtMs(metric && metric.p95WaitMs) + ' / ' + fmt(metric && metric.count) + ' 条', empty:!(metric && metric.count) }));
        cards.push({ label:'当前进行中', value:fmt(summary.active), sub:'最长 ' + fmtMs(summary.activeLongestWaitMs), empty:!summary.active });
        cards.push({ label:'总任务', value:fmt(summary.total), sub:'终态 ' + fmt(summary.terminal) + ' / 用户 ' + fmt(summary.users), empty:!summary.total });
        document.querySelector('[data-time-kpis="true"]').innerHTML = cards.map((card) =>
          '<div class="time-kpi" data-empty="' + (card.empty ? 'true' : 'false') + '"><span class="time-kpi-label">' + esc(card.label) + '</span><strong class="time-kpi-value">' + esc(card.value) + '</strong><span class="time-kpi-sub">' + esc(card.sub) + '</span></div>'
        ).join('');
      }
      function renderUsers(rows) {
        document.querySelector('[data-time-user-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-time-users="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="time-cell-title">' + esc(row.username || 'unknown') + '</span><span class="time-cell-sub">ID ' + esc(row.ownerId ?? '-') + '</span></td><td>' + fmt(row.total) + '</td><td>' + fmt(row.success) + '</td><td>' + fmt(row.failed) + '</td><td>' + esc(fmtMs(row.avgWaitMs)) + '</td><td>' + esc(fmtMs(row.p95WaitMs)) + '</td></tr>'
        ).join('') : empty(6);
      }
      function renderCategories(rows) {
        document.querySelector('[data-time-category-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-time-categories="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="time-cell-title">' + esc(row.moduleLabel) + '</span><span class="time-cell-sub admin-mono">' + esc(row.moduleKey) + '</span></td><td><span class="time-cell-title">' + esc(row.featureLabel) + '</span><span class="time-cell-sub admin-mono">' + esc(row.featureKey) + '</span></td><td>' + fmt(row.total) + '</td><td>' + esc(fmtMs(row.avgWaitMs)) + '</td><td>' + esc(fmtMs(row.p95WaitMs)) + '</td></tr>'
        ).join('') : empty(5);
      }
      function renderDetails(payload) {
        state.total = Number(payload.total || 0);
        const rows = payload.rows || [];
        document.querySelector('[data-time-total="true"]').textContent = state.total + ' 条';
        document.querySelector('[data-time-details="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="time-cell-title">' + esc(fmtDate(row.startedAt)) + '</span><span class="time-cell-sub">' + esc(row.endedAt ? fmtDate(row.endedAt) : '进行中') + '</span></td>' +
          '<td><span class="time-cell-title">' + esc(row.username || 'unknown') + '</span><span class="time-cell-sub">' + esc(row.projectDisplay || '-') + '</span></td>' +
          '<td><span class="time-cell-title">' + esc(row.moduleLabel) + '</span><span class="time-cell-sub">' + esc(row.featureLabel) + '</span></td>' +
          '<td><span class="time-cell-title">' + esc(row.callItemLabel || row.callItemId) + '</span><span class="time-cell-sub admin-mono">' + esc(row.callItemId) + '</span></td>' +
          '<td><span class="time-status ' + esc(row.statusGroup) + '">' + esc(row.status) + '</span></td>' +
          '<td><strong>' + esc(fmtMs(row.waitMs)) + '</strong></td>' +
          '<td><span class="time-cell-title admin-mono">' + esc(row.sourceTable) + '</span><span class="time-cell-sub admin-mono">' + esc(row.sourceId) + '</span></td>' +
          '<td><span class="time-cell-title">' + esc(fmtError(row.errorMessage)) + '</span><span class="time-cell-sub">' + esc(row.provider || '-') + '</span></td></tr>'
        ).join('') : empty(8);
        const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
        const page = Math.min(totalPages, Math.floor(state.offset / state.limit) + 1);
        pageText.textContent = page + ' / ' + totalPages;
        prevButton.disabled = state.offset <= 0;
        nextButton.disabled = state.offset + state.limit >= state.total;
        const start = state.total ? state.offset + 1 : 0;
        const end = Math.min(state.offset + rows.length, state.total);
        setNotice('显示 ' + start + '-' + end + ' / ' + state.total);
      }
      async function getJson(view, extra = {}) {
        const res = await fetch('/api/admin/time-stats?' + params({ view, ...extra }).toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.detail) || '加载失败');
        populateFilters(data.features || []);
        return data;
      }
      async function load() {
        setNotice('加载中...');
        toolbar.dataset.range = rangeInput.value;
        const [summary, users, categories, details] = await Promise.all([
          getJson('summary'),
          getJson('users', { limit:100 }),
          getJson('categories', { limit:100 }),
          getJson('details', { limit:state.limit, offset:state.offset }),
        ]);
        renderKpis(summary.summary || {});
        renderUsers(users.users || []);
        renderCategories(categories.categories || []);
        renderDetails(details);
        document.querySelector('[data-time-notes="true"]').innerHTML = (summary.notes || []).map((note) => '<span class="time-note">' + icons.alert + '<span>' + esc(note) + '</span></span>').join('');
      }
      async function loadSafely() {
        try { await load(); }
        catch (error) { setNotice(error.message || String(error), 'error'); }
      }
      async function exportCsv() {
        const body = Object.fromEntries(params({ action:'export' }).entries());
        const res = await fetch('/api/admin/time-stats', {
          method:'POST',
          credentials:'same-origin',
          headers:{ 'content-type':'application/json', 'x-admin-reason':'time stats csv export' },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setNotice((data && data.detail) || '导出失败', 'error');
          return;
        }
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = 'time-usage.csv';
        a.click();
        URL.revokeObjectURL(href);
        setNotice('CSV 已生成', 'ok');
      }
      rangeInput.addEventListener('change', () => { toolbar.dataset.range = rangeInput.value; state.offset = 0; loadSafely(); });
      moduleInput.addEventListener('change', () => { renderFeatureOptions(); state.offset = 0; loadSafely(); });
      featureInput.addEventListener('change', () => { state.offset = 0; loadSafely(); });
      statusInput.addEventListener('change', () => { state.offset = 0; loadSafely(); });
      document.querySelector('[data-time-refresh="true"]').addEventListener('click', () => { state.offset = 0; loadSafely(); });
      document.querySelector('[data-time-export="true"]').addEventListener('click', exportCsv);
      prevButton.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadSafely(); });
      nextButton.addEventListener('click', () => { if (state.offset + state.limit < state.total) { state.offset += state.limit; loadSafely(); } });
      [ownerInput, qInput, fromInput, toInput].forEach((input) => input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { state.offset = 0; loadSafely(); } }));
      window.adminStartPolling?.(loadSafely);
    </script>`,
  });
}
