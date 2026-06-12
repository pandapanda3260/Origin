import { NextRequest } from 'next/server';
import { adminIcon, renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 用量统计 = Token 消耗 + 等待时间，两个量纲两个 tab，一个导航位。
// Token tab：/api/admin/token-stats（token_usage_events，权威 Token 账本）。
// 时间 tab：/api/admin/time-stats(任务表派生等待时间；V1 盲区由 API notes 渲染成页头警示条)。
// 指标口径见 docs/admin-metrics-registry.md。
export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/usage-stats',
    title: '用量统计',
    headHtml: `<style>
      main { max-width:1840px; }
      .usage-pane[data-active="false"] { display:none; }
      .usage-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:20px; margin-top:20px; }
      .usage-table { width:100%; table-layout:fixed; }
      .usage-table th, .usage-table td { padding:13px 16px; vertical-align:middle; }
      .usage-table-wide { min-width:1280px; }
      .usage-details { margin-top:20px; }
      .usage-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; }
      .usage-status { display:inline-flex; align-items:center; min-height:26px; padding:0 10px; border-radius:999px; background:var(--admin-info-soft); color:var(--admin-info); font-weight:800; font-size:var(--admin-font-xs); }
      .usage-status.failed { background:var(--admin-danger-soft); color:var(--admin-danger); }
      .usage-status.cancelled { background:var(--admin-warning-soft); color:var(--admin-warning); }
      .usage-status.success, .usage-status.ok { background:var(--admin-success-soft); color:var(--admin-success-strong); }
      .date-fields { display:none; grid-column:1 / -1; grid-template-columns:repeat(2, minmax(200px, 1fr)); gap:12px; }
      .adm-toolbar[data-range="custom"] .date-fields { display:grid; }
      @media (max-width: 1200px) { .usage-split { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `
    <div class="adm-tabs" role="tablist">
      <button class="adm-tab" data-usage-tab="token" data-active="true">${adminIcon('cube')}Token 消耗</button>
      <button class="adm-tab" data-usage-tab="time" data-active="false">${adminIcon('activity')}等待时间</button>
    </div>

    <!-- ===== Token 消耗 ===== -->
    <div class="usage-pane" data-usage-pane="token" data-active="true">
      <section class="panel">
        <div class="adm-toolbar" data-tok-toolbar="true" data-range="7d">
          <label class="adm-field"><span>时间范围</span>
            <select data-tok-range="true">
              <option value="1d">最近 1 天</option>
              <option value="7d" selected>最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label class="adm-field"><span>用户 ID</span><input data-tok-owner="true" inputmode="numeric" placeholder="全部用户" /></label>
          <label class="adm-field" style="flex:1; min-width:220px;"><span>搜索</span><input data-tok-query="true" placeholder="用户 / 项目 / 模型 / 调用" /></label>
          <div class="adm-actions">
            <button data-tok-refresh="true" class="adm-btn adm-btn-primary">${adminIcon('search')}查询</button>
            <button data-tok-export="true" class="adm-btn">${adminIcon('file')}CSV</button>
          </div>
          <div class="date-fields">
            <label class="adm-field"><span>开始日期</span><input data-tok-from="true" type="date" /></label>
            <label class="adm-field"><span>结束日期</span><input data-tok-to="true" type="date" /></label>
          </div>
        </div>
        <div class="adm-notes" data-tok-notes="true"></div>
        <div class="adm-kpis" data-tok-kpis="true"></div>
      </section>
      <div class="usage-split">
        <section class="panel">
          <div class="adm-section-head"><h2>按用户消耗</h2><span class="adm-count" data-tok-user-count="true"></span></div>
          <div class="admin-table-wrap"><table class="admin-table usage-table"><thead><tr><th>用户</th><th>调用</th><th>输入</th><th>输出</th><th>总 Token</th></tr></thead><tbody data-tok-users="true"></tbody></table></div>
        </section>
        <section class="panel">
          <div class="adm-section-head"><h2>按分类消耗</h2><span class="adm-count" data-tok-category-count="true"></span></div>
          <div class="admin-table-wrap"><table class="admin-table usage-table"><thead><tr><th>一级分类</th><th>功能项</th><th>调用</th><th>总 Token</th></tr></thead><tbody data-tok-categories="true"></tbody></table></div>
        </section>
      </div>
      <section class="panel usage-details">
        <div class="adm-section-head">
          <h2>调用明细</h2>
          <div class="adm-pager">
            <button class="adm-btn" data-tok-prev="true">上一页</button>
            <span class="adm-page-text" data-tok-page="true">1 / 1</span>
            <button class="adm-btn" data-tok-next="true">下一页</button>
          </div>
        </div>
        <div class="admin-table-wrap"><table class="admin-table usage-table usage-table-wide"><thead><tr><th>时间</th><th>用户 / 项目</th><th>分类</th><th>模型</th><th>Token</th><th>积分消耗</th><th>状态</th><th>路径</th></tr></thead><tbody data-tok-calls="true"></tbody></table></div>
        <div class="usage-foot"><span class="notice" data-tok-notice="true"></span></div>
      </section>
    </div>

    <!-- ===== 等待时间 ===== -->
    <div class="usage-pane" data-usage-pane="time" data-active="false">
      <section class="panel">
        <div class="adm-blind-spot" data-tim-blindspot="true">加载口径说明中...</div>
        <div class="adm-toolbar" data-tim-toolbar="true" data-range="7d">
          <label class="adm-field"><span>时间范围</span>
            <select data-tim-range="true">
              <option value="1d">最近 1 天</option>
              <option value="7d" selected>最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label class="adm-field"><span>用户 ID</span><input data-tim-owner="true" inputmode="numeric" placeholder="全部" /></label>
          <label class="adm-field"><span>模块</span><select data-tim-module="true"><option value="">全部模块</option></select></label>
          <label class="adm-field"><span>功能项</span><select data-tim-feature="true"><option value="">全部功能</option></select></label>
          <label class="adm-field"><span>状态</span>
            <select data-tim-status="true">
              <option value="">全部状态</option>
              <option value="success">成功</option>
              <option value="partial_success">部分成功</option>
              <option value="failed">失败</option>
              <option value="cancelled">取消</option>
              <option value="active">进行中</option>
            </select>
          </label>
          <label class="adm-field" style="flex:1; min-width:200px;"><span>搜索</span><input data-tim-query="true" placeholder="项目 / 用户 / 调用项" /></label>
          <div class="adm-actions">
            <button class="adm-btn adm-btn-primary" data-tim-refresh="true">${adminIcon('search')}查询</button>
            <button class="adm-btn" data-tim-export="true">${adminIcon('file')}CSV</button>
          </div>
          <div class="date-fields">
            <label class="adm-field"><span>开始日期</span><input type="date" data-tim-from="true" /></label>
            <label class="adm-field"><span>结束日期</span><input type="date" data-tim-to="true" /></label>
          </div>
        </div>
        <div class="adm-kpis" data-tim-kpis="true"></div>
      </section>
      <div class="usage-split">
        <section class="panel">
          <div class="adm-section-head"><h2>用户等待</h2><span class="adm-count" data-tim-user-count="true">0 条</span></div>
          <div class="admin-table-wrap"><table class="admin-table usage-table"><thead><tr><th>用户</th><th>任务</th><th>成功</th><th>失败</th><th>平均</th><th>P95</th></tr></thead><tbody data-tim-users="true"></tbody></table></div>
        </section>
        <section class="panel">
          <div class="adm-section-head"><h2>环节分布</h2><span class="adm-count" data-tim-category-count="true">0 条</span></div>
          <div class="admin-table-wrap"><table class="admin-table usage-table"><thead><tr><th>模块</th><th>功能项</th><th>任务</th><th>平均</th><th>P95</th></tr></thead><tbody data-tim-categories="true"></tbody></table></div>
        </section>
      </div>
      <section class="panel usage-details">
        <div class="adm-section-head">
          <h2>等待明细</h2>
          <div class="adm-pager">
            <button class="adm-btn" data-tim-prev="true">上一页</button>
            <span class="adm-page-text" data-tim-page="true">1 / 1</span>
            <button class="adm-btn" data-tim-next="true">下一页</button>
          </div>
        </div>
        <div class="admin-table-wrap"><table class="admin-table usage-table usage-table-wide"><thead><tr><th>开始时间</th><th>用户 / 项目</th><th>环节</th><th>调用项</th><th>状态</th><th>等待</th><th>来源</th><th>错误</th></tr></thead><tbody data-tim-details="true"></tbody></table></div>
        <div class="usage-foot"><span class="notice" data-tim-notice="true"></span></div>
      </section>
    </div>`,
    scriptsHtml: `<script>
      const esc = adminUi.esc;
      const fmt = adminUi.fmt;
      const fmtMs = adminUi.fmtMs;
      const fmtDate = adminUi.fmtDate;

      // ===== tab 切换 =====
      const usageState = { tab:'token', tokenLoaded:false, timeLoaded:false };
      document.querySelectorAll('[data-usage-tab]').forEach((btn) => btn.addEventListener('click', () => {
        usageState.tab = btn.dataset.usageTab;
        document.querySelectorAll('[data-usage-tab]').forEach((b) => b.dataset.active = b.dataset.usageTab === usageState.tab ? 'true' : 'false');
        document.querySelectorAll('[data-usage-pane]').forEach((p) => p.dataset.active = p.dataset.usagePane === usageState.tab ? 'true' : 'false');
        if (usageState.tab === 'time' && !usageState.timeLoaded) { usageState.timeLoaded = true; timLoadSafely(); }
      }));

      // ===== Token tab（数据源 token_usage_events） =====
      const tokState = { offset:0, limit:100, total:0 };
      const tokToolbar = document.querySelector('[data-tok-toolbar="true"]');
      const tokRange = document.querySelector('[data-tok-range="true"]');
      const tokOwner = document.querySelector('[data-tok-owner="true"]');
      const tokQuery = document.querySelector('[data-tok-query="true"]');
      const tokFrom = document.querySelector('[data-tok-from="true"]');
      const tokTo = document.querySelector('[data-tok-to="true"]');
      const tokNotice = document.querySelector('[data-tok-notice="true"]');
      const tokPrev = document.querySelector('[data-tok-prev="true"]');
      const tokNext = document.querySelector('[data-tok-next="true"]');
      const tokPage = document.querySelector('[data-tok-page="true"]');
      function tokParams(extra = {}) {
        const p = new URLSearchParams();
        p.set('range', tokRange.value);
        if (tokRange.value === 'custom') {
          if (tokFrom.value) p.set('from', tokFrom.value);
          if (tokTo.value) p.set('to', tokTo.value);
        }
        if (tokOwner.value.trim()) p.set('ownerId', tokOwner.value.trim());
        if (tokQuery.value.trim()) p.set('q', tokQuery.value.trim());
        Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
        return p;
      }
      function tokRenderKpis(summary) {
        const cards = [
          { label:'总 Token', value:fmt(summary.totalTokens) },
          { label:'输入 Token', value:fmt(summary.inputTokens) },
          { label:'输出 Token', value:fmt(summary.outputTokens) },
          { label:'有 usage 调用 / 缺失 usage', value:fmt(summary.calls) + ' / ' + fmt(summary.missingUsageCalls) },
        ];
        document.querySelector('[data-tok-kpis="true"]').innerHTML = cards.map((card) =>
          '<div class="adm-kpi"><span class="adm-kpi-label">' + esc(card.label) + '</span><strong class="adm-kpi-value">' + esc(card.value) + '</strong></div>'
        ).join('');
      }
      function tokRenderUsers(rows) {
        document.querySelector('[data-tok-user-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-tok-users="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="adm-cell-title">' + esc(row.username || 'unknown') + '</span><span class="adm-cell-sub">ID ' + esc(row.ownerId ?? '-') + '</span></td><td>' + fmt(row.calls) + '</td><td>' + fmt(row.inputTokens) + '</td><td>' + fmt(row.outputTokens) + '</td><td><strong>' + fmt(row.totalTokens) + '</strong></td></tr>'
        ).join('') : adminUi.emptyRow(5);
      }
      function tokRenderCategories(rows) {
        document.querySelector('[data-tok-category-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-tok-categories="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="adm-cell-title">' + esc(row.moduleLabel || row.moduleKey) + '</span><span class="adm-cell-sub admin-mono">' + esc(row.moduleKey) + '</span></td><td><span class="adm-cell-title">' + esc(row.featureLabel || row.featureKey) + '</span><span class="adm-cell-sub admin-mono">' + esc(row.featureKey) + '</span></td><td>' + fmt(row.calls) + '</td><td><strong>' + fmt(row.totalTokens) + '</strong></td></tr>'
        ).join('') : adminUi.emptyRow(4);
      }
      function tokRenderCalls(payload) {
        tokState.total = Number(payload.total || 0);
        const rows = payload.rows || [];
        document.querySelector('[data-tok-calls="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="adm-cell-title">' + esc(fmtDate(row.createdAt)) + '</span><span class="adm-cell-sub admin-mono">' + esc(row.traceName || '-') + '</span></td>' +
          '<td><span class="adm-cell-title">' + esc(row.usernameSnapshot || 'unknown') + '</span><span class="adm-cell-sub">' + esc(row.projectTitleSnapshot || row.projectId || '-') + '</span></td>' +
          '<td><span class="adm-cell-title">' + esc(row.moduleLabel) + '</span><span class="adm-cell-sub">' + esc(row.featureLabel) + '</span></td>' +
          '<td><span class="adm-cell-title">' + esc(row.provider || '-') + '</span><span class="adm-cell-sub admin-mono">' + esc(row.model || '-') + '</span></td>' +
          '<td><strong>' + fmt(row.totalTokens) + '</strong><span class="adm-cell-sub">in ' + fmt(row.inputTokens) + ' / out ' + fmt(row.outputTokens) + '</span></td>' +
          '<td><strong>' + (Number(row.chargedCredits || 0) > 0 ? fmt(row.chargedCredits) : '-') + '</strong><span class="adm-cell-sub">' + esc(row.billingStatus || row.billingScope || '-') + '</span></td>' +
          '<td><span class="usage-status ' + (row.status === 'ok' ? 'ok' : 'failed') + '">' + esc(row.status) + '</span><span class="adm-cell-sub">' + esc(row.usageSource) + '</span></td>' +
          '<td class="admin-mono"><span class="adm-cell-title">' + esc(row.requestPath || row.routeName || '-') + '</span></td></tr>'
        ).join('') : adminUi.emptyRow(8);
        const totalPages = Math.max(1, Math.ceil(tokState.total / tokState.limit));
        const page = Math.min(totalPages, Math.floor(tokState.offset / tokState.limit) + 1);
        tokPage.textContent = page + ' / ' + totalPages;
        tokPrev.disabled = tokState.offset <= 0;
        tokNext.disabled = tokState.offset + tokState.limit >= tokState.total;
        const start = tokState.total ? tokState.offset + 1 : 0;
        const end = Math.min(tokState.offset + rows.length, tokState.total);
        adminUi.setNotice(tokNotice, '显示 ' + start + '-' + end + ' / ' + tokState.total);
      }
      async function tokGetJson(view, extra = {}) {
        const res = await fetch('/api/admin/token-stats?' + tokParams({ view, ...extra }).toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.detail) || '加载失败');
        return data;
      }
      async function tokLoad() {
        adminUi.setNotice(tokNotice, '加载中...');
        tokToolbar.dataset.range = tokRange.value;
        const [summary, users, categories, calls] = await Promise.all([
          tokGetJson('summary'),
          tokGetJson('users', { limit:100 }),
          tokGetJson('categories', { limit:100 }),
          tokGetJson('calls', { limit:tokState.limit, offset:tokState.offset }),
        ]);
        tokRenderKpis(summary.summary || {});
        tokRenderUsers(users.users || []);
        tokRenderCategories(categories.categories || []);
        tokRenderCalls(calls);
        document.querySelector('[data-tok-notes="true"]').innerHTML = (summary.notes || []).map((note) => '<span class="adm-note">' + esc(note) + '</span>').join('');
      }
      async function tokLoadSafely() {
        try { await tokLoad(); }
        catch (error) { adminUi.setNotice(tokNotice, error.message || String(error), 'error'); }
      }
      async function tokExportCsv() {
        const body = Object.fromEntries(tokParams({ action:'export', limit:20000 }).entries());
        const res = await fetch('/api/admin/token-stats', {
          method:'POST',
          credentials:'same-origin',
          headers:{ 'content-type':'application/json', 'x-admin-reason':'token stats csv export' },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          adminUi.setNotice(tokNotice, (data && data.detail) || '导出失败', 'error');
          return;
        }
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = 'token-usage.csv';
        a.click();
        URL.revokeObjectURL(href);
        adminUi.setNotice(tokNotice, 'CSV 已生成', 'ok');
      }
      tokRange.addEventListener('change', () => { tokToolbar.dataset.range = tokRange.value; tokState.offset = 0; tokLoadSafely(); });
      document.querySelector('[data-tok-refresh="true"]').addEventListener('click', () => { tokState.offset = 0; tokLoadSafely(); });
      document.querySelector('[data-tok-export="true"]').addEventListener('click', tokExportCsv);
      tokPrev.addEventListener('click', () => { tokState.offset = Math.max(0, tokState.offset - tokState.limit); tokLoadSafely(); });
      tokNext.addEventListener('click', () => { if (tokState.offset + tokState.limit < tokState.total) { tokState.offset += tokState.limit; tokLoadSafely(); } });
      [tokOwner, tokQuery, tokFrom, tokTo].forEach((input) => input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { tokState.offset = 0; tokLoadSafely(); } }));

      // ===== 时间 tab（任务表派生等待时间） =====
      const timState = { offset:0, limit:100, total:0, features:[] };
      const timToolbar = document.querySelector('[data-tim-toolbar="true"]');
      const timRange = document.querySelector('[data-tim-range="true"]');
      const timOwner = document.querySelector('[data-tim-owner="true"]');
      const timModule = document.querySelector('[data-tim-module="true"]');
      const timFeature = document.querySelector('[data-tim-feature="true"]');
      const timStatus = document.querySelector('[data-tim-status="true"]');
      const timQuery = document.querySelector('[data-tim-query="true"]');
      const timFrom = document.querySelector('[data-tim-from="true"]');
      const timTo = document.querySelector('[data-tim-to="true"]');
      const timNotice = document.querySelector('[data-tim-notice="true"]');
      const timPrev = document.querySelector('[data-tim-prev="true"]');
      const timNext = document.querySelector('[data-tim-next="true"]');
      const timPage = document.querySelector('[data-tim-page="true"]');
      function timFmtError(value) {
        let text = String(value || '').trim();
        if (!text) return '-';
        text = text
          .replace(/("(?:prompt|input|messages|request|response|body)"\\s*:\\s*)("[^"]*"|\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\})/gi, '$1"[redacted]"')
          .replace(/((?:prompt|input|messages|request|response|body)\\s*[:=]\\s*)(.{20,400})/gi, '$1[redacted]');
        return text.length > 200 ? text.slice(0, 200) + '...' : text;
      }
      function timParams(extra = {}) {
        const p = new URLSearchParams();
        p.set('range', timRange.value);
        if (timRange.value === 'custom') {
          if (timFrom.value) p.set('from', timFrom.value);
          if (timTo.value) p.set('to', timTo.value);
        }
        if (timOwner.value.trim()) p.set('ownerId', timOwner.value.trim());
        if (timModule.value) p.set('moduleKey', timModule.value);
        if (timFeature.value) p.set('featureKey', timFeature.value);
        if (timStatus.value) p.set('status', timStatus.value);
        if (timQuery.value.trim()) p.set('q', timQuery.value.trim());
        Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
        return p;
      }
      function timPopulateFilters(features) {
        if (!features || !features.length || timState.features.length) return;
        timState.features = features;
        const modules = [];
        features.forEach((f) => { if (!modules.some((m) => m.moduleKey === f.moduleKey)) modules.push({ moduleKey:f.moduleKey, moduleLabel:f.moduleLabel }); });
        timModule.innerHTML = '<option value="">全部模块</option>' + modules.map((m) => '<option value="' + esc(m.moduleKey) + '">' + esc(m.moduleLabel) + '</option>').join('');
        timRenderFeatureOptions();
      }
      function timRenderFeatureOptions() {
        const moduleKey = timModule.value;
        const features = timState.features.filter((f) => !moduleKey || f.moduleKey === moduleKey);
        timFeature.innerHTML = '<option value="">全部功能</option>' + features.map((f) => '<option value="' + esc(f.featureKey) + '">' + esc(f.featureLabel) + '</option>').join('');
      }
      function timRenderKpis(summary) {
        const groups = [
          ['成功', summary.success],
          ['失败', summary.failed],
          ['取消', summary.cancelled],
          ['部分成功', summary.partialSuccess],
        ];
        const cards = groups.map(([label, metric]) => ({ label, value:fmtMs(metric && metric.avgWaitMs), sub:'P95 ' + fmtMs(metric && metric.p95WaitMs) + ' / ' + fmt(metric && metric.count) + ' 条', empty:!(metric && metric.count) }));
        cards.push({ label:'当前进行中', value:fmt(summary.active), sub:'最长 ' + fmtMs(summary.activeLongestWaitMs), empty:!summary.active });
        cards.push({ label:'总任务', value:fmt(summary.total), sub:'终态 ' + fmt(summary.terminal) + ' / 用户 ' + fmt(summary.users), empty:!summary.total });
        document.querySelector('[data-tim-kpis="true"]').innerHTML = cards.map((card) =>
          '<div class="adm-kpi" data-empty="' + (card.empty ? 'true' : 'false') + '"><span class="adm-kpi-label">' + esc(card.label) + '</span><strong class="adm-kpi-value">' + esc(card.value) + '</strong><span class="adm-kpi-sub">' + esc(card.sub) + '</span></div>'
        ).join('');
      }
      function timRenderUsers(rows) {
        document.querySelector('[data-tim-user-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-tim-users="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="adm-cell-title">' + esc(row.username || 'unknown') + '</span><span class="adm-cell-sub">ID ' + esc(row.ownerId ?? '-') + '</span></td><td>' + fmt(row.total) + '</td><td>' + fmt(row.success) + '</td><td>' + fmt(row.failed) + '</td><td>' + esc(fmtMs(row.avgWaitMs)) + '</td><td>' + esc(fmtMs(row.p95WaitMs)) + '</td></tr>'
        ).join('') : adminUi.emptyRow(6);
      }
      function timRenderCategories(rows) {
        document.querySelector('[data-tim-category-count="true"]').textContent = rows.length + ' 条';
        document.querySelector('[data-tim-categories="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="adm-cell-title">' + esc(row.moduleLabel) + '</span><span class="adm-cell-sub admin-mono">' + esc(row.moduleKey) + '</span></td><td><span class="adm-cell-title">' + esc(row.featureLabel) + '</span><span class="adm-cell-sub admin-mono">' + esc(row.featureKey) + '</span></td><td>' + fmt(row.total) + '</td><td>' + esc(fmtMs(row.avgWaitMs)) + '</td><td>' + esc(fmtMs(row.p95WaitMs)) + '</td></tr>'
        ).join('') : adminUi.emptyRow(5);
      }
      function timRenderDetails(payload) {
        timState.total = Number(payload.total || 0);
        const rows = payload.rows || [];
        document.querySelector('[data-tim-details="true"]').innerHTML = rows.length ? rows.map((row) =>
          '<tr><td><span class="adm-cell-title">' + esc(fmtDate(row.startedAt)) + '</span><span class="adm-cell-sub">' + esc(row.endedAt ? fmtDate(row.endedAt) : '进行中') + '</span></td>' +
          '<td><span class="adm-cell-title">' + esc(row.username || 'unknown') + '</span><span class="adm-cell-sub">' + esc(row.projectDisplay || '-') + '</span></td>' +
          '<td><span class="adm-cell-title">' + esc(row.moduleLabel) + '</span><span class="adm-cell-sub">' + esc(row.featureLabel) + '</span></td>' +
          '<td><span class="adm-cell-title">' + esc(row.callItemLabel || row.callItemId) + '</span><span class="adm-cell-sub admin-mono">' + esc(row.callItemId) + '</span></td>' +
          '<td><span class="usage-status ' + esc(row.statusGroup) + '">' + esc(row.status) + '</span></td>' +
          '<td><strong>' + esc(fmtMs(row.waitMs)) + '</strong></td>' +
          '<td><span class="adm-cell-title admin-mono">' + esc(row.sourceTable) + '</span><span class="adm-cell-sub admin-mono">' + esc(row.sourceId) + '</span></td>' +
          '<td><span class="adm-cell-title">' + esc(timFmtError(row.errorMessage)) + '</span><span class="adm-cell-sub">' + esc(row.provider || '-') + '</span></td></tr>'
        ).join('') : adminUi.emptyRow(8);
        const totalPages = Math.max(1, Math.ceil(timState.total / timState.limit));
        const page = Math.min(totalPages, Math.floor(timState.offset / timState.limit) + 1);
        timPage.textContent = page + ' / ' + totalPages;
        timPrev.disabled = timState.offset <= 0;
        timNext.disabled = timState.offset + timState.limit >= timState.total;
        const start = timState.total ? timState.offset + 1 : 0;
        const end = Math.min(timState.offset + rows.length, timState.total);
        adminUi.setNotice(timNotice, '显示 ' + start + '-' + end + ' / ' + timState.total);
      }
      async function timGetJson(view, extra = {}) {
        const res = await fetch('/api/admin/time-stats?' + timParams({ view, ...extra }).toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.detail) || '加载失败');
        timPopulateFilters(data.features || []);
        if (Array.isArray(data.notes) && data.notes.length) {
          document.querySelector('[data-tim-blindspot="true"]').innerHTML = '<strong>口径声明（V1 盲区，宁可承认不全，不可显得全而不准）：</strong><br>' + data.notes.map((note) => '· ' + esc(note)).join('<br>');
        }
        return data;
      }
      async function timLoad() {
        adminUi.setNotice(timNotice, '加载中...');
        timToolbar.dataset.range = timRange.value;
        const [summary, users, categories, details] = await Promise.all([
          timGetJson('summary'),
          timGetJson('users', { limit:100 }),
          timGetJson('categories', { limit:100 }),
          timGetJson('details', { limit:timState.limit, offset:timState.offset }),
        ]);
        timRenderKpis(summary.summary || {});
        timRenderUsers(users.users || []);
        timRenderCategories(categories.categories || []);
        timRenderDetails(details);
      }
      async function timLoadSafely() {
        try { await timLoad(); }
        catch (error) { adminUi.setNotice(timNotice, error.message || String(error), 'error'); }
      }
      async function timExportCsv() {
        const body = Object.fromEntries(timParams({ action:'export' }).entries());
        const res = await fetch('/api/admin/time-stats', {
          method:'POST',
          credentials:'same-origin',
          headers:{ 'content-type':'application/json', 'x-admin-reason':'time stats csv export' },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          adminUi.setNotice(timNotice, (data && data.detail) || '导出失败', 'error');
          return;
        }
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = 'time-usage.csv';
        a.click();
        URL.revokeObjectURL(href);
        adminUi.setNotice(timNotice, 'CSV 已生成', 'ok');
      }
      timRange.addEventListener('change', () => { timToolbar.dataset.range = timRange.value; timState.offset = 0; timLoadSafely(); });
      timModule.addEventListener('change', () => { timRenderFeatureOptions(); timState.offset = 0; timLoadSafely(); });
      timFeature.addEventListener('change', () => { timState.offset = 0; timLoadSafely(); });
      timStatus.addEventListener('change', () => { timState.offset = 0; timLoadSafely(); });
      document.querySelector('[data-tim-refresh="true"]').addEventListener('click', () => { timState.offset = 0; timLoadSafely(); });
      document.querySelector('[data-tim-export="true"]').addEventListener('click', timExportCsv);
      timPrev.addEventListener('click', () => { timState.offset = Math.max(0, timState.offset - timState.limit); timLoadSafely(); });
      timNext.addEventListener('click', () => { if (timState.offset + timState.limit < timState.total) { timState.offset += timState.limit; timLoadSafely(); } });
      [timOwner, timQuery, timFrom, timTo].forEach((input) => input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { timState.offset = 0; timLoadSafely(); } }));

      // 首次只拉当前 tab；轮询只刷新当前 tab，避免双倍查询压力。
      window.adminStartPolling?.(async () => {
        if (usageState.tab === 'token') { usageState.tokenLoaded = true; await tokLoadSafely(); }
        else { usageState.timeLoaded = true; await timLoadSafely(); }
      });
    </script>`,
  });
}
