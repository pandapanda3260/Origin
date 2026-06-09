import { NextRequest } from 'next/server';
import { adminIcon, renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const tokenIcons = {
    activity: adminIcon('activity'),
    cube: adminIcon('cube'),
    file: adminIcon('file'),
    search: adminIcon('search'),
    user: adminIcon('user'),
    users: adminIcon('users'),
    coin: adminIcon('coin'),
    alert: adminIcon('alert'),
  };

  return renderAdminPage(req, {
    activePath: '/admin/token-stats',
    title: 'Token 统计',
    headHtml: `<style>
      main { max-width:1840px; }
      .token-overview { padding:22px; }
      .token-toolbar { display:grid; grid-template-columns:minmax(220px,.85fr) minmax(220px,.75fr) minmax(360px,1.2fr) auto; gap:26px; align-items:end; }
      .token-filter { display:grid; grid-template-columns:auto minmax(0,1fr); gap:14px; align-items:center; min-width:0; }
      .token-filter > span:first-child { color:var(--admin-text-strong); font-size:var(--admin-font-lg); font-weight:800; white-space:nowrap; }
      .token-control { position:relative; height:48px; display:flex; align-items:center; min-width:0; border:1px solid var(--line-strong); border-radius:8px; background:#fff; box-shadow:0 8px 20px rgba(16,27,45,.035); }
      .token-control .token-field-icon { width:44px; height:100%; display:grid; place-items:center; color:var(--admin-text-muted); flex:0 0 auto; }
      .token-control .admin-icon { width:20px; height:20px; }
      .token-control input, .token-control select { width:100%; height:100%; min-width:0; border:0; background:transparent; outline:0; color:var(--admin-text-strong); font-size:var(--admin-font-lg); font-weight:700; }
      .token-control select { appearance:none; padding-right:38px; cursor:pointer; }
      .token-control-select::after { content:""; position:absolute; right:16px; top:50%; width:8px; height:8px; border-right:2px solid var(--admin-text-muted); border-bottom:2px solid var(--admin-text-muted); transform:translateY(-70%) rotate(45deg); pointer-events:none; }
      .token-control-search input { padding-left:18px; padding-right:48px; }
      .token-control-search .token-field-icon { position:absolute; right:2px; top:0; color:var(--admin-text-muted); }
      .token-actions { display:flex; gap:14px; align-items:center; justify-content:flex-end; white-space:nowrap; }
      .token-action { height:48px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:0 22px; border-radius:8px; border:1px solid var(--line-strong); background:#fff; color:var(--admin-text); font-size:var(--admin-font-lg); font-weight:800; box-shadow:0 8px 20px rgba(16,27,45,.035); }
      .token-action .admin-icon { width:19px; height:19px; }
      .token-action-primary { min-width:150px; border-color:rgba(17,156,145,.5); background:linear-gradient(180deg, var(--accent), var(--accent-dark)); color:white; box-shadow:0 12px 26px rgba(17,156,145,.2); }
      .token-action-primary:hover { background:linear-gradient(180deg, var(--accent), var(--accent-dark)); color:white; border-color:rgba(17,156,145,.72); }
      .date-fields { display:none; grid-column:1 / -1; grid-template-columns:repeat(2, minmax(220px, 1fr)); gap:14px; padding-top:2px; }
      .token-toolbar[data-range="custom"] .date-fields { display:grid; }
      .token-explain { display:flex; align-items:center; gap:10px; margin:22px 0 0; color:var(--admin-text); font-size:var(--admin-font-lg); font-weight:700; line-height:1.6; }
      .token-explain .admin-icon { width:20px; height:20px; color:var(--admin-info); flex:0 0 auto; }
      .token-kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:18px; margin:24px 0 18px; }
      .token-kpi { min-height:118px; display:flex; align-items:center; gap:24px; border:1px solid var(--line); border-radius:8px; background:#fff; padding:24px 28px; box-shadow:0 12px 30px rgba(16,27,45,.035); }
      .token-kpi-icon { width:64px; height:64px; display:grid; place-items:center; border-radius:12px; flex:0 0 auto; }
      .token-kpi-icon .admin-icon { width:34px; height:34px; stroke-width:1.9; }
      .token-kpi-label { display:block; color:var(--admin-text); font-size:var(--admin-font-lg); font-weight:800; }
      .token-kpi-value { display:block; margin-top:8px; color:var(--admin-text-strong); font-size:var(--admin-font-counter); line-height:1; font-weight:900; letter-spacing:0; }
      .token-kpi-mint .token-kpi-icon { background:var(--admin-success-soft); color:var(--admin-success-strong); }
      .token-kpi-blue .token-kpi-icon { background:var(--admin-info-soft); color:var(--admin-info); }
      .token-kpi-purple .token-kpi-icon { background:var(--purple-soft); color:var(--purple); }
      .token-kpi-orange .token-kpi-icon { background:var(--admin-warning-soft); color:var(--admin-warning); }
      .token-meta { display:flex; flex-wrap:wrap; gap:14px; margin:0; }
      .token-note-chip { min-height:40px; display:inline-flex; align-items:center; gap:10px; padding:0 16px; border-radius:6px; background:var(--admin-info-soft); color:var(--admin-text); font-size:var(--admin-font-lg); font-weight:700; }
      .token-note-chip .admin-icon { width:18px; height:18px; color:var(--admin-info); }
      .token-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:22px; margin-top:22px; }
      .token-overview, .token-split > .panel, .token-details { min-width:0; }
      .token-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 16px; }
      .token-section-title { display:flex; align-items:center; gap:12px; min-width:0; }
      .token-section-title h2 { margin:0; font-size:var(--admin-font-page); line-height:1.25; font-weight:900; letter-spacing:0; }
      .token-section-icon { width:44px; height:44px; display:grid; place-items:center; border-radius:12px; background:var(--admin-success-soft); color:var(--admin-success-strong); flex:0 0 auto; }
      .token-section-icon .admin-icon { width:24px; height:24px; }
      .token-section-count { color:var(--admin-text-muted); font-size:var(--admin-font-lg); font-weight:800; white-space:nowrap; }
      .token-table-wrap { max-width:100%; border-radius:8px; }
      .token-table { width:100%; table-layout:fixed; }
      .token-table th, .token-table td { padding:15px 20px; vertical-align:middle; }
      .token-table th { height:48px; color:var(--admin-text-muted); font-size:var(--admin-font-lg); font-weight:800; white-space:nowrap; }
      .token-table td { color:var(--admin-text-strong); font-size:var(--admin-font-md); }
      .token-table-user { min-width:760px; }
      .token-table-category { min-width:760px; }
      .token-table-calls { min-width:1360px; }
      .token-cell-title { display:block; color:var(--admin-text-strong); font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .token-cell-sub { display:block; margin-top:4px; color:var(--admin-text-muted); font-size:var(--admin-font-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .token-value-strong { color:var(--admin-text-strong); font-size:var(--admin-font-lg); font-weight:900; }
      .token-empty { min-height:126px; display:grid; place-items:center; gap:8px; color:var(--admin-text-subtle); text-align:center; font-size:var(--admin-font-lg); font-weight:700; }
      .token-empty .admin-icon { width:38px; height:38px; color:var(--admin-text-subtle); }
      .token-details { margin-top:22px; }
      .token-details .token-section-head { margin-bottom:16px; }
      .token-pager { display:flex; align-items:center; gap:16px; }
      .token-page-text { min-width:58px; text-align:center; color:var(--admin-text-strong); font-size:var(--admin-font-lg); font-weight:900; }
      .token-pager button { height:38px; min-width:86px; border-radius:8px; color:var(--admin-text); font-weight:800; }
      .token-details-foot { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:16px; color:var(--admin-text-muted); font-size:var(--admin-font-lg); font-weight:700; }
      .token-status { display:inline-flex; align-items:center; min-height:24px; padding:0 9px; border-radius:999px; font-size:var(--admin-font-xs); font-weight:800; }
      .token-status-ok { background:var(--admin-success-soft); color:var(--admin-success-strong); }
      .token-status-warn { background:var(--admin-warning-soft); color:var(--admin-warning); }
      @media (max-width: 1320px) {
        .token-toolbar { grid-template-columns:1fr 1fr; }
        .token-actions { grid-column:1 / -1; justify-content:flex-start; }
        .token-kpis { grid-template-columns:repeat(2,minmax(0,1fr)); }
      }
      @media (max-width: 980px) {
        .token-toolbar, .token-split, .token-kpis, .date-fields { grid-template-columns:1fr; }
        .token-filter { grid-template-columns:1fr; gap:8px; }
        .token-actions { flex-wrap:wrap; }
        .token-action { width:100%; }
        .token-kpi { padding:20px; }
        .token-details-foot { align-items:flex-start; flex-direction:column; }
      }
    </style>`,
    bodyHtml: `<section class="panel token-overview">
      <div class="token-toolbar" data-token-toolbar="true" data-range="7d">
        <label class="token-filter"> <span>时间范围</span>
          <span class="token-control token-control-select">
            <span class="token-field-icon" aria-hidden="true">${tokenIcons.activity}</span>
            <select data-token-range="true">
              <option value="1d">最近 1 天</option>
              <option value="7d" selected>最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="custom">可选日期</option>
            </select>
          </span>
        </label>
        <label class="token-filter"> <span>用户 ID</span>
          <span class="token-control">
            <span class="token-field-icon" aria-hidden="true">${tokenIcons.user}</span>
            <input data-token-owner="true" placeholder="全部用户" />
          </span>
        </label>
        <label class="token-filter"> <span>搜索</span>
          <span class="token-control token-control-search">
            <input data-token-query="true" placeholder="用户 / 项目 / 模型 / 调用" />
            <span class="token-field-icon" aria-hidden="true">${tokenIcons.search}</span>
          </span>
        </label>
        <div class="token-actions">
          <button data-token-refresh="true" class="token-action token-action-primary">${tokenIcons.search}<span>查询</span></button>
          <button data-token-export="true" class="token-action">${tokenIcons.file}<span>下载明细 CSV</span></button>
        </div>
        <div class="date-fields">
          <label class="token-filter"> <span>开始日期</span><span class="token-control"><input data-token-from="true" type="date" /></span></label>
          <label class="token-filter"> <span>结束日期</span><span class="token-control"><input data-token-to="true" type="date" /></span></label>
        </div>
      </div>
      <div class="token-explain">${tokenIcons.alert}<span>统计起始日期：Token 账本上线后。无 usage 的流式/异常调用保留明细，但不计入总 Token。Token 统计不是现金成本统计。</span></div>
      <div class="token-kpis" data-token-kpis="true"></div>
      <div class="token-meta" data-token-notes="true"></div>
    </section>

    <section class="token-split">
      <div class="panel">
        <div class="token-section-head">
          <div class="token-section-title"><span class="token-section-icon" aria-hidden="true">${tokenIcons.users}</span><h2>按用户消耗</h2></div>
          <span class="token-section-count" data-token-user-count="true"></span>
        </div>
        <div class="admin-table-wrap token-table-wrap">
          <table class="admin-table token-table token-table-user">
            <thead><tr><th>用户</th><th>调用</th><th>输入</th><th>输出</th><th>总 Token</th></tr></thead>
            <tbody data-token-users="true"><tr><td colspan="5"><div class="token-empty">${tokenIcons.file}<span>加载中...</span></div></td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="token-section-head">
          <div class="token-section-title"><span class="token-section-icon" aria-hidden="true">${tokenIcons.cube}</span><h2>按分类消耗</h2></div>
          <span class="token-section-count" data-token-category-count="true"></span>
        </div>
        <div class="admin-table-wrap token-table-wrap">
          <table class="admin-table token-table token-table-category">
            <thead><tr><th>一级分类</th><th>功能项</th><th>调用</th><th>总 Token</th></tr></thead>
            <tbody data-token-categories="true"><tr><td colspan="4"><div class="token-empty">${tokenIcons.file}<span>加载中...</span></div></td></tr></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="panel token-details">
      <div class="token-section-head">
        <div class="token-section-title"><span class="token-section-icon" aria-hidden="true">${tokenIcons.file}</span><h2>调用明细</h2></div>
        <div class="token-pager">
          <button data-token-prev="true">上一页</button>
          <span class="token-page-text" data-token-page="true">1 / 1</span>
          <button data-token-next="true">下一页</button>
        </div>
      </div>
      <div class="admin-table-wrap token-table-wrap">
        <table class="admin-table token-table token-table-calls">
          <thead><tr><th>时间</th><th>用户 / 项目</th><th>分类</th><th>模型</th><th>Token</th><th>积分消耗</th><th>状态</th><th>路径</th></tr></thead>
          <tbody data-token-calls="true"><tr><td colspan="8"><div class="token-empty">${tokenIcons.file}<span>加载中...</span></div></td></tr></tbody>
        </table>
      </div>
      <div class="token-details-foot">
        <span class="notice" data-token-notice="true"></span>
      </div>
    </section>`,
    scriptsHtml: `<script>
      const tokenIcons = ${JSON.stringify(tokenIcons)};
      const state = { offset:0, limit:100, total:0 };
      const toolbar = document.querySelector('[data-token-toolbar="true"]');
      const rangeInput = document.querySelector('[data-token-range="true"]');
      const ownerInput = document.querySelector('[data-token-owner="true"]');
      const qInput = document.querySelector('[data-token-query="true"]');
      const fromInput = document.querySelector('[data-token-from="true"]');
      const toInput = document.querySelector('[data-token-to="true"]');
      const notice = document.querySelector('[data-token-notice="true"]');
      const prevButton = document.querySelector('[data-token-prev="true"]');
      const nextButton = document.querySelector('[data-token-next="true"]');
      const pageText = document.querySelector('[data-token-page="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      function setNotice(message, kind = '') { notice.textContent = message || ''; notice.dataset.kind = kind; }
      function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
      function fmtDate(value) { if (!value) return '-'; try { return new Date(value).toLocaleString('zh-CN', { hour12:false }); } catch { return value; } }
      function params(extra = {}) {
        const p = new URLSearchParams();
        p.set('range', rangeInput.value);
        if (rangeInput.value === 'custom') {
          if (fromInput.value) p.set('from', fromInput.value);
          if (toInput.value) p.set('to', toInput.value);
        }
        if (ownerInput.value.trim()) p.set('ownerId', ownerInput.value.trim());
        if (qInput.value.trim()) p.set('q', qInput.value.trim());
        Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
        return p;
      }
      function empty(cols, text = '暂无数据') {
        return '<tr><td colspan="' + cols + '"><div class="token-empty">' + tokenIcons.file + '<span>' + esc(text) + '</span></div></td></tr>';
      }
      function renderKpis(summary) {
        const cards = [
          { tone:'mint', icon:tokenIcons.cube, label:'总 Token', value:fmt(summary.totalTokens) },
          { tone:'blue', icon:tokenIcons.file, label:'输入 Token', value:fmt(summary.inputTokens) },
          { tone:'purple', icon:tokenIcons.activity, label:'输出 Token', value:fmt(summary.outputTokens) },
          { tone:'orange', icon:tokenIcons.coin, label:'有 usage 调用 / 缺失 usage', value:fmt(summary.calls) + ' / ' + fmt(summary.missingUsageCalls) },
        ];
        document.querySelector('[data-token-kpis="true"]').innerHTML = cards.map((card) =>
          '<div class="token-kpi token-kpi-' + card.tone + '"><span class="token-kpi-icon" aria-hidden="true">' + card.icon + '</span><span><span class="token-kpi-label">' + esc(card.label) + '</span><strong class="token-kpi-value">' + esc(card.value) + '</strong></span></div>'
        ).join('');
      }
      function renderUsers(rows) {
        document.querySelector('[data-token-user-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-token-users="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="token-cell-title">' + esc(row.username || 'unknown') + '</span><span class="token-cell-sub">ID ' + esc(row.ownerId ?? '-') + '</span></td><td>' + fmt(row.calls) + '</td><td>' + fmt(row.inputTokens) + '</td><td>' + fmt(row.outputTokens) + '</td><td><strong class="token-value-strong">' + fmt(row.totalTokens) + '</strong></td></tr>'
        ).join('') : empty(5);
      }
      function renderCategories(rows) {
        document.querySelector('[data-token-category-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-token-categories="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="token-cell-title">' + esc(row.moduleLabel || row.moduleKey) + '</span><span class="token-cell-sub admin-mono">' + esc(row.moduleKey) + '</span></td><td><span class="token-cell-title">' + esc(row.featureLabel || row.featureKey) + '</span><span class="token-cell-sub admin-mono">' + esc(row.featureKey) + '</span></td><td>' + fmt(row.calls) + '</td><td><strong class="token-value-strong">' + fmt(row.totalTokens) + '</strong></td></tr>'
        ).join('') : empty(4);
      }
      function renderCalls(payload) {
        state.total = Number(payload.total || 0);
        const rows = payload.rows || [];
        document.querySelector('[data-token-calls="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="token-cell-title">' + esc(fmtDate(row.createdAt)) + '</span><span class="token-cell-sub admin-mono">' + esc(row.traceName || '-') + '</span></td>' +
          '<td><span class="token-cell-title">' + esc(row.usernameSnapshot || 'unknown') + '</span><span class="token-cell-sub">' + esc(row.projectTitleSnapshot || row.projectId || '-') + '</span></td>' +
          '<td><span class="token-cell-title">' + esc(row.moduleLabel) + '</span><span class="token-cell-sub">' + esc(row.featureLabel) + '</span></td>' +
          '<td><span class="token-cell-title">' + esc(row.provider || '-') + '</span><span class="token-cell-sub admin-mono">' + esc(row.model || '-') + '</span></td>' +
          '<td><strong class="token-value-strong">' + fmt(row.totalTokens) + '</strong><span class="token-cell-sub">in ' + fmt(row.inputTokens) + ' / out ' + fmt(row.outputTokens) + '</span></td>' +
          '<td><strong class="token-value-strong">' + (Number(row.chargedCredits || 0) > 0 ? fmt(row.chargedCredits) : '-') + '</strong><span class="token-cell-sub">' + esc(row.billingStatus || row.billingScope || '-') + '</span></td>' +
          '<td><span class="token-status ' + (row.status === 'ok' ? 'token-status-ok' : 'token-status-warn') + '">' + esc(row.status) + '</span><span class="token-cell-sub">' + esc(row.usageSource) + '</span></td>' +
          '<td class="admin-mono"><span class="token-cell-title">' + esc(row.requestPath || row.routeName || '-') + '</span></td></tr>'
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
        const res = await fetch('/api/admin/token-stats?' + params({ view, ...extra }).toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.detail) || '加载失败');
        return data;
      }
      async function load() {
        setNotice('加载中...');
        toolbar.dataset.range = rangeInput.value;
        const [summary, users, categories, calls] = await Promise.all([
          getJson('summary'),
          getJson('users', { limit:100 }),
          getJson('categories', { limit:100 }),
          getJson('calls', { limit:state.limit, offset:state.offset }),
        ]);
        renderKpis(summary.summary || {});
        renderUsers(users.users || []);
        renderCategories(categories.categories || []);
        renderCalls(calls);
        document.querySelector('[data-token-notes="true"]').innerHTML = (summary.notes || []).map((note) => '<span class="token-note-chip">' + tokenIcons.alert + '<span>' + esc(note) + '</span></span>').join('');
      }
      async function loadSafely() {
        try { await load(); }
        catch (error) { setNotice(error.message || String(error), 'error'); }
      }
      async function exportCsv() {
        const body = Object.fromEntries(params({ action:'export', limit:20000 }).entries());
        const res = await fetch('/api/admin/token-stats', {
          method:'POST',
          credentials:'same-origin',
          headers:{ 'content-type':'application/json', 'x-admin-reason':'token stats csv export' },
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
        a.download = 'token-usage.csv';
        a.click();
        URL.revokeObjectURL(href);
        setNotice('CSV 已生成', 'ok');
      }
      rangeInput.addEventListener('change', () => { toolbar.dataset.range = rangeInput.value; state.offset = 0; loadSafely(); });
      document.querySelector('[data-token-refresh="true"]').addEventListener('click', () => { state.offset = 0; loadSafely(); });
      document.querySelector('[data-token-export="true"]').addEventListener('click', exportCsv);
      prevButton.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadSafely(); });
      nextButton.addEventListener('click', () => { if (state.offset + state.limit < state.total) { state.offset += state.limit; loadSafely(); } });
      [ownerInput, qInput, fromInput, toInput].forEach((input) => input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { state.offset = 0; loadSafely(); } }));
      window.adminStartPolling?.(loadSafely);
    </script>`,
  });
}
