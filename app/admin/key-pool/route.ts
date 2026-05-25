import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/key-pool',
    title: 'Key 池只读',
    headHtml: `<style>
      table.admin-table.key-pool-table { min-width:1220px; table-layout:fixed; }
      main { max-width:1760px; }
      .key-pool-table th, .key-pool-table td { padding:14px 18px; }
      .key-pool-table th { white-space:nowrap; }
      .key-pool-table td { color:var(--admin-text-strong); }
      .key-pool-table .key-col-slot { width:8%; }
      .key-pool-table .key-col-mode { width:6%; }
      .key-pool-table .key-col-provider { width:13%; }
      .key-pool-table .key-col-model { width:12%; }
      .key-pool-table .key-col-fallback { width:12%; }
      .key-pool-table .key-col-metrics { width:10%; }
      .key-pool-table .key-col-base { width:22%; }
      .key-pool-table .key-col-endpoint { width:12%; }
      .key-pool-table .key-col-source { width:5%; }
      .key-sync { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-bottom:16px; }
      .key-sync-item { border:1px solid var(--line); border-radius:8px; background:#fff; padding:12px 14px; }
      .key-sync-item strong { display:block; margin-bottom:4px; color:var(--admin-text-strong); }
      .key-sync-item.warn { border-color:rgba(217,119,6,.35); background:var(--warning-soft); }
      .key-cell-main { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .key-url { display:block; line-height:1.45; overflow-wrap:break-word; word-break:normal; }
      .key-endpoint { display:inline-flex; max-width:100%; align-items:center; min-height:24px; padding:2px 8px; border-radius:999px; background:var(--admin-bg-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .key-source { display:inline-flex; min-height:24px; align-items:center; padding:2px 8px; border-radius:999px; background:var(--admin-neutral-soft); color:var(--admin-neutral); font-weight:700; }
      .key-metrics { display:grid; grid-template-columns:1fr; gap:3px; color:var(--admin-text-muted); font-size:var(--admin-font-xs); line-height:1.35; }
      .key-metrics span { display:grid; grid-template-columns:max-content max-content; justify-content:start; column-gap:2em; white-space:nowrap; }
      .key-metrics em { font-style:normal; }
      .key-metrics b { color:var(--admin-text-strong); font-weight:800; }
      .key-metrics .warn b { color:var(--admin-danger); }
      .fallback-list { display:flex; flex-direction:column; gap:7px; }
      .fallback-item { display:block; min-width:0; color:var(--admin-text); line-height:1.4; }
      .fallback-item strong { display:block; margin-bottom:2px; font-size:var(--admin-font-xs); color:var(--admin-text-strong); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fallback-item .mono { display:block; color:var(--admin-text-muted); font-size:var(--admin-font-xs); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      @media (max-width: 980px) { .key-sync { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<section class="panel">
      <p class="muted">后台只读展示 model/key/baseUrl 路由状态；模型路由按外部 env 文件热读，非模型 env 仍以进程缓存为准。</p>
      <div class="key-sync" data-key-pool-sync="true"></div>
      <div class="admin-table-wrap section-gap">
        <table class="admin-table key-pool-table">
          <colgroup>
            <col class="key-col-slot" />
            <col class="key-col-mode" />
            <col class="key-col-provider" />
            <col class="key-col-model" />
            <col class="key-col-fallback" />
            <col class="key-col-metrics" />
            <col class="key-col-base" />
            <col class="key-col-endpoint" />
            <col class="key-col-source" />
          </colgroup>
          <thead><tr><th>Slot</th><th>模式</th><th>Provider</th><th>Model</th><th>Fallback</th><th>近 10 分钟</th><th>Base URL</th><th>Endpoint</th><th>来源</th></tr></thead>
          <tbody data-key-pool-table="true"><tr><td colspan="9" class="muted">加载中...</td></tr></tbody>
        </table>
      </div>
      <div class="notice" data-key-pool-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const table = document.querySelector('[data-key-pool-table="true"]');
      const notice = document.querySelector('[data-key-pool-notice="true"]');
      const sync = document.querySelector('[data-key-pool-sync="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      function fmt(value) {
        if (!value) return '-';
        try { return new Date(value).toLocaleString('zh-CN', { hour12:false }); }
        catch (_) { return String(value); }
      }
      function shortPath(path) {
        return String(path || '').replace(/^.*\\/([^/]+)$/, '$1') || '-';
      }
      function renderSync(envSync) {
        if (!sync) return;
        const files = envSync?.externalFiles || [];
        const fileText = files.map((f) => shortPath(f.path) + (f.exists ? ' · ' + (f.keys?.length || 0) + ' keys' : ' · missing')).join('；') || '-';
        const processWarn = envSync?.fileNewerThanProcessEnv;
        sync.innerHTML = [
          '<div class="key-sync-item"><strong>模型路由</strong><span class="muted">' + (envSync?.modelRoutingReadsExternalEnvLive ? '实时读取外部 env 文件' : '读取进程 env') + '</span></div>',
          '<div class="key-sync-item"><strong>env 文件</strong><span class="muted">' + esc(fileText) + '<br>最后修改 ' + esc(fmt(envSync?.fileMaxModifiedAt)) + '</span></div>',
          '<div class="key-sync-item ' + (processWarn ? 'warn' : '') + '"><strong>进程 env</strong><span class="muted">启动 ' + esc(fmt(envSync?.processStartedAt)) + '<br>缓存加载 ' + esc(fmt(envSync?.runtimeLoadedAt)) + (processWarn ? '；非模型配置需重启' : '') + '</span></div>'
        ].join('');
      }
      async function load() {
        const res = await fetch('/api/admin/key-pool/status', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { notice.textContent = (data && data.detail) || '加载失败'; return; }
        renderSync(data.envSync || {});
        const pools = data.pools || [];
        table.innerHTML = pools.map((p) => {
          const m = p.metrics || {};
          const metricText =
            '<div class="key-metrics">' +
              '<span><em>调用</em><b>' + esc(m.total || 0) + '</b></span>' +
              '<span class="' + ((m.failed || 0) ? 'warn' : '') + '"><em>失败</em><b>' + esc(m.failed || 0) + '</b></span>' +
              '<span class="' + ((m.rateLimited || 0) ? 'warn' : '') + '"><em>限流</em><b>' + esc(m.rateLimited || 0) + '</b></span>' +
              (m.fallbackUsed ? '<span class="warn"><em>Fallback</em><b>' + esc(m.fallbackUsed) + '</b></span>' : '') +
            '</div>';
          const fallbackText = (p.fallbacks || []).map((f) => '<span class="fallback-item"><strong>' + esc(f.provider || '-') + ' / ' + esc(f.model || '-') + '</strong><span class="mono">' + esc(f.baseUrl || '-') + esc(f.endpoint ? f.endpoint : '') + '</span></span>').join('');
          return '<tr>' +
            '<td><span class="key-cell-main">' + esc(p.name) + '</span></td>' +
            '<td><span class="badge ' + esc(p.mode) + '">' + esc(p.mode) + '</span></td>' +
            '<td><span class="key-cell-main">' + esc(p.provider || '-') + '</span></td>' +
            '<td><span class="key-cell-main">' + esc(p.model || '-') + '</span></td>' +
            '<td><div class="fallback-list">' + (fallbackText || '<span class="muted">-</span>') + '</div></td>' +
            '<td>' + metricText + '</td>' +
            '<td class="mono"><span class="key-url">' + esc(p.baseUrl || '-') + '</span></td>' +
            '<td class="mono"><span class="key-endpoint">' + esc(p.endpoint || '-') + '</span></td>' +
            '<td><span class="key-source">' + esc(p.source || '-') + '</span></td>' +
          '</tr>';
        }).join('') || '<tr><td colspan="9" class="muted">暂无路由状态</td></tr>';
        const fallbackPools = pools.filter((p) => p.metrics && p.metrics.fallbackUsed);
        const fallbackEvents = data.recentFallbackEvents || [];
        if (fallbackPools.length) {
          const summary = fallbackPools.map((p) => p.name + ' fallback ' + p.metrics.fallbackUsed).join('；');
          const recent = fallbackEvents[0];
          const recentText = recent ? '；最近：' + (recent.meta?.kind || recent.message || recent.slot || 'image') + ' / ' + (recent.provider || '-') + ' / ' + (recent.model || '-') : '';
          notice.textContent = '告警：近 ' + (data.metricsWindow || 10) + ' 分钟出现模型 fallback：' + summary + recentText;
        } else {
          notice.textContent = '已更新：' + new Date(data.updatedAt || Date.now()).toLocaleString('zh-CN', { hour12:false });
        }
      }
      window.adminStartPolling?.(load);
    </script>`,
  });
}
