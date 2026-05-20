import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/storage',
    title: '存储管理',
    headHtml: `<style>
      .storage-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
      .storage-toolbar input { width:110px; }
      .storage-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:14px; }
      .metric { border:1px solid var(--line); border-radius:8px; background:#fff; padding:14px; }
      .metric strong { display:block; font-size:var(--admin-font-xl); margin-top:6px; }
      .admin-table-wrap { margin-top:14px; }
      table.admin-table { min-width:920px; }
      .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
      @media (max-width: 900px) { .storage-grid { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="storage-toolbar">
        <label class="muted">孤儿文件最小年龄（小时） <input data-storage-age="true" type="number" value="24" min="0" max="720" /></label>
        <button data-storage-refresh="true">扫描</button>
      </div>
      <div class="storage-grid" data-storage-metrics="true"></div>
      <div class="actions">
        <button data-storage-quarantine="true" class="danger">隔离孤儿文件</button>
        <button data-storage-cleanup="true" class="danger">清理 7 天前 quarantine</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Bucket</th><th>Owner</th><th>文件</th><th>大小</th><th>原因</th><th>mtime</th></tr></thead>
          <tbody data-storage-table="true"><tr><td colspan="6" class="muted">加载中...</td></tr></tbody>
        </table>
      </div>
      <div class="notice" data-storage-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const state = { data:null };
      const ageInput = document.querySelector('[data-storage-age="true"]');
      const metrics = document.querySelector('[data-storage-metrics="true"]');
      const table = document.querySelector('[data-storage-table="true"]');
      const notice = document.querySelector('[data-storage-notice="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      function setNotice(message, kind = '') { notice.textContent = message || ''; notice.dataset.kind = kind; }
      function mb(bytes) { return (Number(bytes || 0)/1024/1024).toFixed(2) + ' MB'; }
      function render() {
        const data = state.data || {};
        const totalBytes = (data.usage || []).reduce((sum, row) => sum + Number(row.bytes || 0), 0);
        const totalFiles = (data.usage || []).reduce((sum, row) => sum + Number(row.files || 0), 0);
        metrics.innerHTML =
          '<div class="metric"><span class="muted">总占用</span><strong>' + mb(totalBytes) + '</strong></div>' +
          '<div class="metric"><span class="muted">文件数</span><strong>' + totalFiles + '</strong></div>' +
          '<div class="metric"><span class="muted">候选孤儿</span><strong>' + (data.orphanFiles || []).length + '</strong></div>';
        const files = data.orphanFiles || [];
        table.innerHTML = files.length ? files.map((f) => '<tr><td>' + esc(f.bucket) + '</td><td>' + esc(f.ownerId) + '</td><td>' + esc(f.filename) + '<div class="muted">' + esc(f.path) + '</div></td><td>' + mb(f.bytes) + '</td><td>' + esc(f.reason) + '</td><td>' + esc(f.mtime) + '</td></tr>').join('') : '<tr><td colspan="6" class="muted">暂无可隔离孤儿文件</td></tr>';
      }
      async function load() {
        setNotice('扫描中...');
        const res = await fetch('/api/admin/storage?minAgeHours=' + encodeURIComponent(ageInput.value || '24'), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setNotice((data && data.detail) || '扫描失败', 'error'); return; }
        state.data = data; render(); setNotice('已扫描：' + data.generatedAt, 'ok');
      }
      async function mutate(action) {
        const reason = window.prompt(action === 'quarantine_orphans' ? '隔离孤儿文件原因' : '清理 quarantine 原因');
        if (!reason || !reason.trim()) return;
        const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const headers = { 'content-type':'application/json', 'x-idempotency-key': key, 'x-admin-reason': reason.trim() };
        const body = { action, minAgeHours: Number(ageInput.value || 24), reason: reason.trim(), dryRun:true };
        setNotice('正在预检查...');
        const dry = await fetch('/api/admin/storage', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(body) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) { setNotice((dryData && dryData.detail) || '预检查失败', 'error'); return; }
        if (!window.confirm('确认执行 ' + action + '？')) { setNotice('已取消'); return; }
        const commitBody = { action, minAgeHours: Number(ageInput.value || 24), reason: reason.trim() };
        if (action === 'quarantine_orphans') commitBody.candidateHash = dryData.candidateHash;
        const commit = await fetch('/api/admin/storage', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(commitBody) });
        const data = await commit.json().catch(() => null);
        if (!commit.ok) { setNotice((data && data.detail) || '提交失败', 'error'); return; }
        setNotice('操作完成', 'ok'); await load();
      }
      document.querySelector('[data-storage-refresh="true"]')?.addEventListener('click', load);
      document.querySelector('[data-storage-quarantine="true"]')?.addEventListener('click', () => mutate('quarantine_orphans'));
      document.querySelector('[data-storage-cleanup="true"]')?.addEventListener('click', () => mutate('cleanup_quarantine'));
      window.adminStartPolling?.(load);
    </script>`,
  });
}
