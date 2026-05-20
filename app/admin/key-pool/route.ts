import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/key-pool',
    title: 'Key 池只读',
    headHtml: `<style>
      table.admin-table { min-width:880px; }
    </style>`,
    bodyHtml: `<section class="panel">
      <p class="muted">后台只读展示 model/key/baseUrl 路由状态；写入仍只能改 .env.local 与 lib/model-routing.ts。</p>
      <div class="admin-table-wrap section-gap">
        <table class="admin-table">
          <thead><tr><th>Slot</th><th>模式</th><th>Provider</th><th>Model</th><th>近 10 分钟</th><th>Base URL</th><th>Endpoint</th><th>来源</th></tr></thead>
          <tbody data-key-pool-table="true"><tr><td colspan="8" class="muted">加载中...</td></tr></tbody>
        </table>
      </div>
      <div class="notice" data-key-pool-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const table = document.querySelector('[data-key-pool-table="true"]');
      const notice = document.querySelector('[data-key-pool-notice="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      async function load() {
        const res = await fetch('/api/admin/key-pool/status', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { notice.textContent = (data && data.detail) || '加载失败'; return; }
        const pools = data.pools || [];
        table.innerHTML = pools.map((p) => {
          const m = p.metrics || {};
          const metricText = '调用 ' + (m.total || 0) + ' / 失败 ' + (m.failed || 0) + ' / 限流 ' + (m.rateLimited || 0) + (m.fallbackUsed ? ' / fallback ' + m.fallbackUsed : '');
          return '<tr><td>' + esc(p.name) + '</td><td><span class="badge ' + esc(p.mode) + '">' + esc(p.mode) + '</span></td><td>' + esc(p.provider || '-') + '</td><td>' + esc(p.model || '-') + '</td><td>' + esc(metricText) + '</td><td class="mono">' + esc(p.baseUrl || '-') + '</td><td class="mono">' + esc(p.endpoint || '-') + '</td><td>' + esc(p.source || '-') + '</td></tr>';
        }).join('') || '<tr><td colspan="8" class="muted">暂无路由状态</td></tr>';
        notice.textContent = '已更新：' + new Date(data.updatedAt || Date.now()).toLocaleString('zh-CN', { hour12:false });
      }
      window.adminStartPolling?.(load);
    </script>`,
  });
}
