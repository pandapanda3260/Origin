import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/search',
    title: '客服检索',
    headHtml: `<style>
      .search-toolbar { display:flex; gap:10px; align-items:center; margin-bottom:14px; }
      .search-toolbar input { width:520px; max-width:100%; }
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
      @media (max-width: 900px) { .field-grid { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="search-toolbar">
        <input data-admin-search-input="true" placeholder="输入 userId / 手机号 / 旧邮箱 / orderId / batchId / taskId / projectId / exportId" />
        <button class="primary" data-admin-search-button="true">检索</button>
      </div>
      <div class="notice" data-admin-search-notice="true"></div>
    </section>
    <section class="search-results section-gap" data-admin-search-results="true"></section>`,
    scriptsHtml: `<script>
      const searchInput = document.querySelector('[data-admin-search-input="true"]');
      const searchButton = document.querySelector('[data-admin-search-button="true"]');
      const searchNotice = document.querySelector('[data-admin-search-notice="true"]');
      const searchResults = document.querySelector('[data-admin-search-results="true"]');
      const groupLabels = {
        user: '用户',
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
        createdAt: '创建时间',
        updatedAt: '更新时间'
      };

      function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
      }

      function fmtValue(value) {
        if (value === null || value === undefined || value === '') return '-';
        if (typeof value === 'boolean') return value ? '是' : '否';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
      }

      function setSearchNotice(message, kind = '') {
        searchNotice.textContent = message || '';
        searchNotice.dataset.kind = kind;
      }

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
        const groups = data.groups || {};
        const types = ['user', 'order', 'project', 'batch', 'video_task', 'export'];
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
        if (!sections.length) {
          searchResults.innerHTML = '<section class="panel"><p class="muted">没有匹配结果</p></section>';
          return;
        }
        searchResults.innerHTML = sections.join('');
      }

      async function runSearch() {
        const q = searchInput.value.trim();
        if (!q) {
          searchResults.innerHTML = '';
          setSearchNotice('请输入要检索的 ID、用户名或邮箱');
          return;
        }
        setSearchNotice('检索中...');
        const res = await fetch('/api/admin/search?q=' + encodeURIComponent(q), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setSearchNotice((data && data.detail) || '检索失败', 'error');
          return;
        }
        renderResults(data || { groups:{} });
        setSearchNotice('命中 ' + ((data && data.items && data.items.length) || 0) + ' 条', 'ok');
      }

      searchButton?.addEventListener('click', runSearch);
      searchInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') runSearch();
      });
    </script>`,
  });
}
