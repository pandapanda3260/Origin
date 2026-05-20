import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';
import { AUDIT_ONLY_MODULES } from '@/lib/knowledge/audit-only-modules';

export function renderKnowledgeAdminPage(req: NextRequest, initialTab: 'cards' | 'audits' | 'dry_run' = 'cards') {
  return renderAdminPage(req, {
    activePath: '/admin/knowledge',
    title: '知识库',
    headHtml: `<style>
      .knowledge-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
      .knowledge-toolbar select, .knowledge-toolbar input, .audit-toolbar select, .audit-toolbar input, .knowledge-editor input, .knowledge-editor textarea { padding-left:10px; padding-right:10px; }
      .knowledge-tabs { display:flex; gap:8px; margin-bottom:14px; border-bottom:1px solid var(--line); }
      .knowledge-tab { border:0; border-bottom:2px solid transparent; border-radius:0; padding:10px 12px; background:transparent; }
      .knowledge-tab[data-active="true"] { border-bottom-color:var(--accent); color:var(--accent); }
      .knowledge-editor { display:grid; grid-template-columns:280px minmax(0,1fr); gap:14px; }
      .knowledge-list { border:1px solid var(--line); border-radius:8px; background:#fff; overflow:auto; max-height:620px; }
      .knowledge-item { width:100%; height:auto; border:0; border-bottom:1px solid var(--admin-border-soft); border-radius:0; text-align:left; padding:12px; display:block; }
      .knowledge-item[data-active="true"] { background:var(--accent-bg); }
      .knowledge-tags-input { min-width:360px; }
      .knowledge-editor textarea { width:100%; min-height:260px; padding:10px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:var(--admin-font-sm); line-height:var(--admin-line-body); }
      .knowledge-empty { padding:14px; }
      .audit-page { display:grid; gap:14px; }
      .dry-run-card { margin-bottom:14px; min-height:0; }
      .dry-run-card h3 { margin:0 0 10px; }
      .dry-run-card .audit-toolbar { margin-bottom:10px; }
      .flush-muted { margin:0; }
      .audit-layout { display:grid; grid-template-columns:minmax(420px, .92fr) minmax(0, 1.28fr); gap:16px; align-items:start; }
      .audit-toolbar { display:grid; grid-template-columns:repeat(6, minmax(130px, 1fr)) auto; gap:10px; align-items:center; border:1px solid var(--line); border-radius:8px; background:var(--admin-bg-soft); padding:12px; }
      .audit-toolbar select, .audit-toolbar input { min-width:0; width:100%; }
      .audit-toolbar button { height:34px; }
      .audit-list-shell { display:grid; gap:10px; min-width:0; }
      .audit-list { border:1px solid var(--line); border-radius:8px; background:#fff; overflow:auto; min-height:430px; max-height:calc(100vh - 455px); }
      .audit-list-header { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:0 2px; color:var(--admin-text-muted); font-size:var(--admin-font-sm); }
      .audit-item { width:100%; height:auto !important; min-height:118px; box-sizing:border-box; border:0; border-bottom:1px solid var(--admin-border-soft); border-left:3px solid transparent; border-radius:0; text-align:left; padding:14px 16px; display:grid; align-content:start; gap:9px; background:#fff; color:var(--text); cursor:pointer; line-height:1.45; }
      .audit-item:hover { background:var(--admin-bg-soft); }
      .audit-item[data-active="true"] { background:var(--accent-bg); border-left-color:var(--accent); }
      .audit-item-title { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .audit-item-title strong { font-size:var(--admin-font-nav); line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .audit-item-title time { color:var(--admin-text-muted); font-size:var(--admin-font-sm); white-space:nowrap; flex:0 0 auto; }
      .audit-item-meta, .audit-item-foot { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:var(--admin-font-sm); color:var(--admin-text-muted); min-height:22px; }
      .audit-item-summary { color:var(--admin-text); font-size:var(--admin-font-sm); line-height:var(--admin-line-body); white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
      .audit-detail { border:1px solid var(--line); border-radius:8px; background:#fff; min-height:430px; max-height:none; overflow:visible; display:flex; flex-direction:column; }
      .audit-detail-empty { min-height:320px; }
      .audit-detail-header { border-bottom:1px solid var(--line); background:linear-gradient(180deg, var(--panel) 0%, var(--admin-bg-soft) 100%); padding:16px; }
      .audit-detail-header h3 { margin:0; font-size:var(--admin-font-xl); line-height:1.3; }
      .audit-detail-subtitle { margin:8px 0 0; color:var(--admin-text-muted); font-size:var(--admin-font-sm); display:flex; gap:8px; flex-wrap:wrap; }
      .audit-detail-body { padding:16px; overflow:auto; display:grid; gap:14px; }
      .audit-kv-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
      .audit-kv { border:1px solid var(--admin-border-soft); border-radius:8px; background:var(--admin-bg-soft); padding:10px; min-width:0; }
      .audit-kv span { display:block; color:var(--admin-text-muted); font-size:var(--admin-font-xs); margin-bottom:4px; }
      .audit-kv strong { display:block; font-size:var(--admin-font-md); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .audit-section { border:1px solid var(--admin-border); border-radius:8px; overflow:hidden; background:#fff; }
      .audit-section-head { padding:12px 14px; font-weight:700; display:flex; align-items:center; justify-content:space-between; gap:10px; border-bottom:1px solid var(--admin-border-soft); background:var(--admin-bg-soft); color:var(--admin-text-strong); }
      .audit-section-head span { color:var(--admin-text-muted); font-weight:400; font-size:var(--admin-font-sm); text-align:right; }
      .audit-section .admin-code-block { max-height:280px; border:0; border-radius:0; margin:0; }
      .audit-section[data-large="true"] .admin-code-block { max-height:360px; }
      .audit-metrics { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
      .audit-metric { border:1px solid var(--line); border-radius:8px; background:#fff; padding:12px; }
      .audit-metric strong { display:block; margin-bottom:8px; font-size:var(--admin-font-nav); }
      .audit-metric .metric-row { display:flex; justify-content:space-between; gap:8px; font-size:var(--admin-font-sm); color:var(--admin-text-muted); margin-top:5px; }
      .metric-status-ok { color:var(--admin-success-strong); }
      .metric-status-warn { color:var(--admin-warning); }
      .metric-status-danger { color:var(--admin-danger); }
      .metric-status-empty { color:var(--admin-neutral); }
      .audit-pager { display:flex; gap:8px; align-items:center; justify-content:flex-end; margin-top:10px; }
      .audit-pager .audit-page-info { color:var(--admin-text-muted); font-size:var(--admin-font-sm); margin-right:auto; }
      .form-row { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
      .form-row input { min-width:160px; }
      .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
      .badge { margin-right:4px; }
      pre.preview { max-height:280px; margin-top:10px; }
      @media (max-width: 1200px) { .audit-toolbar { grid-template-columns:repeat(3, minmax(0, 1fr)); } .audit-toolbar button { width:100%; } .audit-kv-grid { grid-template-columns:1fr 1fr; } }
      @media (max-width: 900px) { .knowledge-editor, .audit-layout, .audit-metrics { grid-template-columns:1fr; } .audit-detail { position:static; max-height:none; } .audit-kv-grid { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="knowledge-tabs">
        <a class="knowledge-tab" href="/admin/knowledge" data-knowledge-tab="cards" data-active="${initialTab === 'cards'}">Cards</a>
        <a class="knowledge-tab" href="/admin/knowledge/audits" data-knowledge-tab="audits" data-active="${initialTab === 'audits'}">Audits</a>
        <a class="knowledge-tab" href="/admin/knowledge/dry-run" data-knowledge-tab="dry_run" data-active="${initialTab === 'dry_run'}">Dry-run</a>
      </div>
      <div data-knowledge-panel="cards"${initialTab === 'cards' ? '' : ' hidden'}>
        <div class="knowledge-toolbar">
          <select data-knowledge-module="true"></select>
          <select data-knowledge-project="true"></select>
          <button data-knowledge-new="true" class="primary">新建草稿</button>
          <button data-knowledge-refresh="true">刷新</button>
        </div>
        <div class="knowledge-editor">
          <div class="knowledge-list" data-knowledge-list="true"></div>
          <div>
            <div class="form-row">
              <input data-card-title="true" placeholder="卡片标题" />
              <input data-card-type="true" placeholder="card type" value="rule" />
              <input data-card-priority="true" placeholder="优先级" value="100" />
            </div>
            <div class="form-row">
              <input data-card-tags="true" class="knowledge-tags-input" placeholder="标签，逗号分隔" />
            </div>
            <textarea data-card-data="true" spellcheck="false">{}</textarea>
            <div class="actions">
              <button data-action="save_draft" class="primary">保存草稿</button>
              <button data-action="preview">预览</button>
              <button data-action="publish" class="primary">发布</button>
              <button data-action="rollback">回滚为新版</button>
            </div>
            <pre class="preview admin-code-block" data-knowledge-preview="true">选择或新建一张卡片。</pre>
            <div class="notice" data-knowledge-notice="true"></div>
          </div>
        </div>
      </div>
      <div data-knowledge-panel="dry_run"${initialTab === 'dry_run' ? '' : ' hidden'}>
        <div class="audit-detail dry-run-card">
          <h3>Selective injection dry-run</h3>
          <div class="audit-toolbar">
            <select data-dry-project="true"><option value="">选择项目</option></select>
            <select data-dry-stage="true"><option value="">选择阶段</option></select>
            <input data-dry-provider="true" placeholder="provider，可选" />
            <button data-dry-run="true" class="primary">预演上下文</button>
          </div>
          <div class="notice" data-dry-notice="true"></div>
          <pre class="admin-code-block" data-dry-output="true">P1 期间默认不注入 prompt。这里仅预览某个阶段将来会拼入的知识块和粗略 token 增量。</pre>
        </div>
      </div>
      <div class="audit-page" data-knowledge-panel="audits"${initialTab === 'audits' ? '' : ' hidden'}>
        <div class="audit-metrics" data-audit-metrics="true"></div>
        <p class="muted flush-muted" data-audit-metrics-note="true"></p>
        <div class="audit-toolbar">
          <select data-audit-project="true"><option value="">全部项目</option></select>
          <select data-audit-stage="true"><option value="">全部阶段</option></select>
          <input data-audit-rule-card="true" placeholder="ruleCardId" />
          <input data-audit-guard-mode="true" placeholder="guardMode" />
          <input data-audit-provider="true" placeholder="provider" />
          <input data-audit-run="true" placeholder="runId" />
          <button data-audit-refresh="true" class="primary">查询</button>
        </div>
        <div class="audit-layout">
          <div class="audit-list-shell">
            <div class="audit-list-header">
              <span>审计记录</span>
              <span data-audit-list-count="true"></span>
            </div>
            <div class="audit-list" data-audit-list="true"></div>
            <div class="notice" data-audit-notice="true"></div>
            <div class="audit-pager">
              <span class="audit-page-info" data-audit-page-info="true"></span>
              <button data-audit-prev="true">上一页</button>
              <button data-audit-next="true">下一页</button>
            </div>
          </div>
          <div class="audit-detail audit-detail-empty admin-empty-state" data-audit-detail="true">选择一条审计记录。</div>
        </div>
      </div>
    </section>`,
    scriptsHtml: `<script>
      const initialTab = '${initialTab}';
      const AUDIT_ONLY_MODULES = new Set(${JSON.stringify(Array.from(AUDIT_ONLY_MODULES))});
      const state = { cards: [], projects: [], modules: [], stages: [], selected: null, module:'style_bible', audits: [], selectedAudit: null, auditPage: { limit: 50, offset: 0, total: 0, hasMore: false }, auditMetrics: null };
      const list = document.querySelector('[data-knowledge-list="true"]');
      const moduleInput = document.querySelector('[data-knowledge-module="true"]');
      const projectInput = document.querySelector('[data-knowledge-project="true"]');
      const tabButtons = document.querySelectorAll('[data-knowledge-tab]');
      const panels = document.querySelectorAll('[data-knowledge-panel]');
      const auditProjectInput = document.querySelector('[data-audit-project="true"]');
      const auditStageInput = document.querySelector('[data-audit-stage="true"]');
      const auditRuleCardInput = document.querySelector('[data-audit-rule-card="true"]');
      const auditGuardModeInput = document.querySelector('[data-audit-guard-mode="true"]');
      const auditProviderInput = document.querySelector('[data-audit-provider="true"]');
      const auditRunInput = document.querySelector('[data-audit-run="true"]');
      const dryProjectInput = document.querySelector('[data-dry-project="true"]');
      const dryStageInput = document.querySelector('[data-dry-stage="true"]');
      const dryProviderInput = document.querySelector('[data-dry-provider="true"]');
      const dryOutput = document.querySelector('[data-dry-output="true"]');
      const dryNotice = document.querySelector('[data-dry-notice="true"]');
      const auditList = document.querySelector('[data-audit-list="true"]');
      const auditDetail = document.querySelector('[data-audit-detail="true"]');
      const auditNotice = document.querySelector('[data-audit-notice="true"]');
      const auditMetrics = document.querySelector('[data-audit-metrics="true"]');
      const auditMetricsNote = document.querySelector('[data-audit-metrics-note="true"]');
      const auditPageInfo = document.querySelector('[data-audit-page-info="true"]');
      const auditListCount = document.querySelector('[data-audit-list-count="true"]');
      const auditPrevButton = document.querySelector('[data-audit-prev="true"]');
      const auditNextButton = document.querySelector('[data-audit-next="true"]');
      const titleInput = document.querySelector('[data-card-title="true"]');
      const typeInput = document.querySelector('[data-card-type="true"]');
      const priorityInput = document.querySelector('[data-card-priority="true"]');
      const tagsInput = document.querySelector('[data-card-tags="true"]');
      const dataInput = document.querySelector('[data-card-data="true"]');
      const previewBox = document.querySelector('[data-knowledge-preview="true"]');
      const notice = document.querySelector('[data-knowledge-notice="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      function setNotice(message, kind = '') { notice.textContent = message || ''; notice.dataset.kind = kind; }
      function setAuditNotice(message, kind = '') { auditNotice.textContent = message || ''; auditNotice.dataset.kind = kind; }
      function setDryNotice(message, kind = '') { dryNotice.textContent = message || ''; dryNotice.dataset.kind = kind; }
      function renderModules() {
        if (!state.modules.length) return;
        moduleInput.innerHTML = state.modules.map((m) => '<option value="' + esc(m.key) + '">' + esc(m.label || m.key) + '</option>').join('');
        moduleInput.value = state.module || state.modules[0].key;
      }
      function renderProjects() {
        projectInput.innerHTML = state.projects.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.title || p.id) + ' · ' + esc(p.username || p.ownerId) + '</option>').join('');
        auditProjectInput.innerHTML = '<option value="">全部项目</option>' + state.projects.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.title || p.id) + ' · ' + esc(p.username || p.ownerId) + '</option>').join('');
        dryProjectInput.innerHTML = '<option value="">选择项目</option>' + state.projects.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.title || p.id) + ' · ' + esc(p.username || p.ownerId) + '</option>').join('');
      }
      function renderStages() {
        auditStageInput.innerHTML = '<option value="">全部阶段</option>' + state.stages.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
        dryStageInput.innerHTML = '<option value="">选择阶段</option>' + state.stages.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
      }
      function renderList() {
        if (!state.cards.length) { list.innerHTML = '<div class="muted knowledge-empty">暂无卡片</div>'; return; }
        list.innerHTML = state.cards.map((card) => '<button class="knowledge-item" data-id="' + esc(card.id) + '" data-active="' + (state.selected?.id === card.id ? 'true' : 'false') + '">' +
          '<span class="badge ' + esc(card.lifecycle) + '">' + esc(card.lifecycle) + '</span><span class="badge">v' + Number(card.version || 1) + '</span>' +
          '<strong>' + esc(card.title) + '</strong><div class="muted">' + esc(card.id) + '</div>' +
        '</button>').join('');
      }
      function fillEditor(card) {
        state.selected = card;
        titleInput.value = card?.title || '';
        typeInput.value = card?.cardType || 'rule';
        priorityInput.value = card?.priority || 100;
        tagsInput.value = (card?.tags || []).join(', ');
        dataInput.value = JSON.stringify(card?.data || {}, null, 2);
        previewBox.textContent = card ? '已选择：' + card.title : '新建草稿。';
        renderList();
      }
      async function load() {
        state.module = moduleInput.value;
        setNotice('加载中...');
        const res = await fetch('/api/admin/knowledge?module=' + encodeURIComponent(state.module), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setNotice((data && data.detail) || '加载失败', 'error'); return; }
        state.modules = data.modules || state.modules;
        state.stages = data.stages || state.stages;
        if (!state.module && state.modules[0]) state.module = state.modules[0].key;
        state.cards = data.cards || []; state.projects = data.projects || [];
        renderModules(); renderProjects(); renderStages();
        const keep = state.selected && state.cards.find((c) => c.id === state.selected.id);
        fillEditor(keep || state.cards[0] || null);
        setNotice('已更新', 'ok');
      }
      function switchTab(tab) {
        tabButtons.forEach((btn) => btn.dataset.active = String(btn.dataset.knowledgeTab === tab));
        panels.forEach((panel) => panel.hidden = panel.dataset.knowledgePanel !== tab);
        if (tab === 'audits') loadAudits();
      }
      function auditQueryParams() {
        const params = new URLSearchParams();
        params.set('view', 'audits');
        params.set('limit', String(state.auditPage.limit));
        params.set('offset', String(state.auditPage.offset));
        if (auditProjectInput.value) params.set('projectId', auditProjectInput.value);
        if (auditStageInput.value) params.set('stage', auditStageInput.value);
        if (auditRuleCardInput.value.trim()) params.set('ruleCardId', auditRuleCardInput.value.trim());
        if (auditGuardModeInput.value.trim()) params.set('guardMode', auditGuardModeInput.value.trim());
        if (auditProviderInput.value.trim()) params.set('provider', auditProviderInput.value.trim());
        if (auditRunInput.value.trim()) params.set('runId', auditRunInput.value.trim());
        return params;
      }
      function resetAuditPagination() {
        state.auditPage.offset = 0;
      }
      function renderAuditPager() {
        const total = Number(state.auditPage.total || 0);
        const limit = Number(state.auditPage.limit || 50);
        const offset = Number(state.auditPage.offset || 0);
        const count = state.audits.length;
        const start = total && count ? offset + 1 : 0;
        const end = total && count ? offset + count : 0;
        auditPageInfo.textContent = total ? '显示 ' + start + '-' + end + ' / ' + total : '无匹配记录';
        auditPrevButton.disabled = offset <= 0;
        auditNextButton.disabled = !state.auditPage.hasMore;
      }
      function pct(value) {
        return Math.round(Number(value || 0) * 1000) / 10 + '%';
      }
      function shortId(value, len = 12) {
        const text = String(value || '').trim();
        return text ? text.slice(0, len) : '-';
      }
      function formatDate(value) {
        const raw = String(value || '').trim();
        if (!raw) return '-';
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return raw;
        return date.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
      }
      function compactJson(value, max = 180) {
        const text = typeof value === 'string' ? value : JSON.stringify(value || {});
        return text.length > max ? text.slice(0, max) + '…' : text;
      }
      function jsonText(value) {
        return typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
      }
      function badge(text, extraClass = '') {
        return '<span class="badge ' + esc(extraClass) + '">' + esc(text || '-') + '</span>';
      }
      function kv(label, value) {
        return '<div class="audit-kv"><span>' + esc(label) + '</span><strong title="' + esc(value || '-') + '">' + esc(value || '-') + '</strong></div>';
      }
      function detailSection(title, summary, content, open = false, large = false) {
        return '<section class="audit-section" data-large="' + String(large) + '">' +
          '<div class="audit-section-head">' + esc(title) + '<span>' + esc(summary || '') + '</span></div>' +
          '<pre class="admin-code-block">' + esc(content || '无') + '</pre>' +
        '</section>';
      }
      function renderAuditMetrics() {
        const metrics = state.auditMetrics;
        if (!metrics || !Array.isArray(metrics.stages)) {
          auditMetrics.innerHTML = '';
          auditMetricsNote.textContent = '';
          return;
        }
        auditMetricsNote.textContent = metrics.retentionNote || '';
        const important = ['style_bible', 'video_prompt', 'video_prompt_refine'];
        const byStage = new Map(metrics.stages.map((item) => [item.stage, item]));
        const rows = important.map((stage) => byStage.get(stage)).filter(Boolean);
        auditMetrics.innerHTML = rows.map((row) => '<div class="audit-metric">' +
          '<strong>' + esc(row.stage) + '</strong>' +
          '<div class="metric-row"><span>注入拒绝率</span><span class="metric-status-' + esc(row.rejectStatus || 'ok') + '">' + pct(row.injectionRejectRate) + ' · ' + Number(row.injectionRejected || 0) + '/' + Number(row.total || 0) + '</span></div>' +
          '<div class="metric-row"><span>token 超限率</span><span class="metric-status-' + esc(row.tokenStatus || 'ok') + '">' + pct(row.tokenLimitRate) + ' · ' + Number(row.tokenLimited || 0) + '/' + Number(row.total || 0) + '</span></div>' +
          '<div class="metric-row"><span>最近 audit</span><span class="metric-status-' + esc(row.activityStatus || 'empty') + '">' + esc(row.lastAuditAt ? formatDate(row.lastAuditAt) : '无活动') + '</span></div>' +
        '</div>').join('');
      }
      async function loadAudits() {
        setAuditNotice('查询中...');
        const res = await fetch('/api/admin/knowledge?' + auditQueryParams().toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setAuditNotice((data && data.detail) || '查询失败', 'error'); return; }
        state.projects = data.projects || state.projects;
        state.stages = data.stages || state.stages;
        state.audits = data.audits || [];
        state.auditPage = {
          limit: Number(data.page?.limit || state.auditPage.limit || 50),
          offset: Number(data.page?.offset || 0),
          total: Number(data.page?.total || 0),
          hasMore: Boolean(data.page?.hasMore),
        };
        state.auditMetrics = data.metrics || null;
        renderProjects(); renderStages(); renderAuditList();
        renderAuditMetrics();
        renderAuditPager();
        setAuditNotice('共 ' + state.auditPage.total + ' 条，当前显示 ' + state.audits.length + ' 条', 'ok');
        if (state.audits[0]) loadAuditDetail(state.audits[0].id);
        else auditDetail.innerHTML = '<div class="audit-detail-empty admin-empty-state">没有匹配的审计记录。<br><span class="muted">调整筛选条件后重新查询。</span></div>';
      }
      function renderAuditList() {
        auditListCount.textContent = state.auditPage.total ? state.auditPage.total + ' 条' : '';
        if (!state.audits.length) { auditList.innerHTML = '<div class="muted knowledge-empty">暂无审计记录</div>'; return; }
        auditList.innerHTML = state.audits.map((row) => '<button class="audit-item" data-id="' + esc(row.id) + '" data-active="' + (state.selectedAudit?.id === row.id ? 'true' : 'false') + '">' +
          '<div class="audit-item-title"><strong>' + esc(row.projectTitle || row.projectId) + '</strong><time>' + esc(formatDate(row.updatedAt)) + '</time></div>' +
          '<div class="audit-item-meta">' + badge(row.stage) + (row.provider ? badge(row.provider) : '') + badge('cards ' + Number((row.ruleCardIds || []).length)) + '</div>' +
          '<div class="audit-item-summary">' + esc(compactJson(row.stageTargetSummary || {}, 220)) + '</div>' +
          '<div class="audit-item-foot"><span>context ' + esc(shortId(row.contextHash)) + '</span><span>input ' + esc(shortId(row.inputHash)) + '</span></div>' +
        '</button>').join('');
      }
      async function loadAuditDetail(id) {
        if (!id) return;
        const res = await fetch('/api/admin/knowledge?view=audit_detail&id=' + encodeURIComponent(id), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { auditDetail.textContent = (data && data.detail) || '详情加载失败'; return; }
        state.selectedAudit = data.audit;
        renderAuditList();
        const audit = data.audit;
        const injectionText = audit.injection
          ? JSON.stringify(audit.injection, null, 2)
          : 'Not in P2 injection scope (audit-only)';
        const cards = Array.isArray(audit.cards) ? audit.cards : [];
        const injectedCards = Array.isArray(audit.injectedCards)
          ? audit.injectedCards
          : cards.filter((card) => card && !AUDIT_ONLY_MODULES.has(card.module));
        const auditOnlyCards = Array.isArray(audit.auditOnlyCards)
          ? audit.auditOnlyCards
          : cards.filter((card) => card && AUDIT_ONLY_MODULES.has(card.module));
        const providerRuntimeNote = auditOnlyCards.length
          ? '<p class="muted">Audit-only cards are kept for traceability but intentionally excluded from the LLM promptBlock.</p>'
          : '';
        const refineGuardNote = audit.stage === 'video_prompt_refine'
          ? '<p class="muted">Injection reflects the pre-LLM decision; accepted/violationTypes in Stage target reflect the post-LLM refine guard result.</p>'
          : '';
        auditDetail.innerHTML =
          '<div class="audit-detail-header">' +
            '<h3>' + esc(audit.stage) + ' · ' + esc(audit.projectTitle || audit.projectId) + '</h3>' +
            '<div class="audit-detail-subtitle">' +
              badge('updated ' + formatDate(audit.updatedAt)) +
              badge('run ' + (audit.createdByRunId || '-')) +
              badge('context ' + shortId(audit.contextHash)) +
              badge('input ' + shortId(audit.inputHash)) +
            '</div>' +
          '</div>' +
          '<div class="audit-detail-body">' +
            '<div class="audit-kv-grid">' +
              kv('项目', audit.projectTitle || audit.projectId) +
              kv('阶段', audit.stage) +
              kv('Provider', audit.provider || '-') +
              kv('Rule cards', String((audit.ruleCardIds || []).length)) +
              kv('Injected', String(injectedCards.length)) +
              kv('Audit-only', String(auditOnlyCards.length)) +
            '</div>' +
            refineGuardNote +
            providerRuntimeNote +
            detailSection('Injection', audit.injection ? '当前注入决策' : 'audit-only', injectionText, true) +
            detailSection('Rule cards', (audit.ruleCardIds || []).length + ' ids', jsonText(audit.ruleCardIds || []), true) +
            detailSection('Injected cards', injectedCards.length + ' cards', jsonText(injectedCards), false, true) +
            detailSection('Audit-only cards', auditOnlyCards.length + ' cards', jsonText(auditOnlyCards), false, true) +
            detailSection('Stage target', '运行目标与 guard 结果', jsonText(audit.stageTarget || {}), true) +
            detailSection('Prompt block', audit.promptBlock ? '实际拼接文本' : '无', audit.promptBlock || '无', false, true) +
            detailSection('Context', '项目快照 / feature flags / source hashes', jsonText({ projectSnapshot: audit.projectSnapshot, featureFlagsSnapshot: audit.featureFlagsSnapshot, cards, sourceHashes: audit.sourceHashes }), false, true) +
          '</div>';
      }
      async function loadDryRun() {
        const projectId = dryProjectInput.value;
        const stage = dryStageInput.value;
        if (!projectId || !stage) { setDryNotice('请选择项目和阶段', 'error'); return; }
        setDryNotice('预演中...');
        const params = new URLSearchParams();
        params.set('view', 'dry_run');
        params.set('projectId', projectId);
        params.set('stage', stage);
        if (dryProviderInput.value.trim()) params.set('provider', dryProviderInput.value.trim());
        const res = await fetch('/api/admin/knowledge?' + params.toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setDryNotice((data && data.detail) || '预演失败', 'error'); return; }
        const run = data.dryRun || {};
        dryOutput.textContent = [
          '项目：' + (run.project?.title || run.project?.id || projectId),
          '阶段：' + run.stage,
          'Provider：' + (run.provider || '-'),
          '当前是否会注入：' + (run.injectionEnabled ? '是' : '否，P1 默认仅 audit/dry-run'),
          'promptBlock 粗略 token 增量：' + Number(run.estimatedTokens || 0),
          '命中规则：' + (run.ruleCards || []).map((card) => card.id + ' v' + card.version).join(', '),
          '',
          run.promptBlock || '无 promptBlock'
        ].join('\\n');
        setDryNotice('预演完成', 'ok');
      }
      function requestPayload(action, dryRun) {
        return {
          action,
          id: state.selected?.id,
          cardId: state.selected?.id,
          module: moduleInput.value,
          title: titleInput.value.trim(),
          cardType: typeInput.value.trim() || 'rule',
          priority: Number(priorityInput.value || 100),
          tags: tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean),
          dataJson: dataInput.value,
          projectId: projectInput.value,
          runModel: false,
          dryRun,
        };
      }
      async function mutate(action) {
        const reason = window.prompt(action + ' 原因');
        if (!reason || !reason.trim()) return;
        const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const headers = { 'content-type':'application/json', 'x-idempotency-key': key, 'x-admin-reason': reason.trim() };
        const dryBody = { ...requestPayload(action, true), reason: reason.trim() };
        setNotice('正在预检查...');
        const dry = await fetch('/api/admin/knowledge', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(dryBody) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) { setNotice((dryData && dryData.detail) || '预检查失败', 'error'); return; }
        if (!window.confirm('确认执行 ' + action + '？')) { setNotice('已取消'); return; }
        const commit = await fetch('/api/admin/knowledge', {
          method:'POST',
          credentials:'same-origin',
          headers,
          body: JSON.stringify({ ...requestPayload(action, false), reason: reason.trim() }),
        });
        const data = await commit.json().catch(() => null);
        if (!commit.ok) { setNotice((data && data.detail) || '提交失败', 'error'); return; }
        if (action === 'preview') previewBox.textContent = (data.output || '') + '\\n\\nPrompt:\\n' + (data.prompt || '');
        setNotice(action + ' 完成', 'ok');
        await load();
        if (data.card) fillEditor(data.card);
      }
      moduleInput.addEventListener('change', load);
      document.querySelector('[data-knowledge-refresh="true"]')?.addEventListener('click', load);
      document.querySelector('[data-audit-refresh="true"]')?.addEventListener('click', () => { resetAuditPagination(); loadAudits(); });
      auditPrevButton?.addEventListener('click', () => {
        state.auditPage.offset = Math.max(0, state.auditPage.offset - state.auditPage.limit);
        loadAudits();
      });
      auditNextButton?.addEventListener('click', () => {
        if (!state.auditPage.hasMore) return;
        state.auditPage.offset += state.auditPage.limit;
        loadAudits();
      });
      document.querySelector('[data-dry-run="true"]')?.addEventListener('click', loadDryRun);
      tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.knowledgeTab)));
      document.querySelector('[data-knowledge-new="true"]')?.addEventListener('click', () => fillEditor({ module: moduleInput.value, title:'', cardType:'rule', priority:100, tags:[], data:{}, lifecycle:'draft', version:1 }));
      list.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-id]');
        if (!btn) return;
        const card = state.cards.find((c) => c.id === btn.dataset.id);
        fillEditor(card);
      });
      auditList.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-id]');
        if (!btn) return;
        loadAuditDetail(btn.dataset.id);
      });
      document.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', () => mutate(btn.dataset.action)));
      load().then(() => {
        if (initialTab === 'audits') loadAudits();
      });
    </script>`,
  });
}
