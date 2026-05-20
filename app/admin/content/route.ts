import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/content',
    title: '内容审核',
    headHtml: `<style>
      .content-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
      .content-toolbar input { width:320px; max-width:100%; }
      .content-meta { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
      table.admin-table { min-width:1040px; }
      .actions { display:flex; gap:6px; flex-wrap:wrap; }
      .excerpt { max-width:360px; white-space:normal; line-height:1.55; }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="content-toolbar">
        <input data-content-search="true" placeholder="搜索 flag / source / 项目 / 用户 / 命中原因" />
        <select data-content-status="true">
          <option value="pending">待复核</option>
          <option value="hidden">已隐藏</option>
          <option value="dismissed">已忽略</option>
          <option value="">全部</option>
        </select>
        <button data-content-search-button="true" class="primary">筛选</button>
        <button data-content-refresh="true">刷新</button>
      </div>
      <div class="content-meta" data-content-meta="true"></div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>风险</th>
              <th>来源</th>
              <th>用户 / 项目</th>
              <th>命中原因</th>
              <th>片段</th>
              <th>状态</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody data-content-table="true"><tr><td colspan="8" class="muted">加载中...</td></tr></tbody>
        </table>
      </div>
      <div class="notice" data-content-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const state = { items: [], summary: {} };
      const qInput = document.querySelector('[data-content-search="true"]');
      const statusInput = document.querySelector('[data-content-status="true"]');
      const meta = document.querySelector('[data-content-meta="true"]');
      const table = document.querySelector('[data-content-table="true"]');
      const notice = document.querySelector('[data-content-notice="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      function setNotice(message, kind = '') { notice.textContent = message || ''; notice.dataset.kind = kind; }
      function fmtDate(value) { if (!value) return '-'; try { return new Date(value).toLocaleString('zh-CN', { hour12:false }); } catch { return value; } }
      function render() {
        const s = state.summary || {};
        meta.innerHTML = ['pending','hidden','dismissed'].map((key) => '<span class="chip">' + key + '：' + Number(s[key]?.total || 0) + '</span>').join('');
        if (!state.items.length) {
          table.innerHTML = '<tr><td colspan="8" class="muted">暂无内容风险</td></tr>';
          return;
        }
        table.innerHTML = state.items.map((item) => '<tr>' +
          '<td><span class="badge ' + esc(item.severity) + '">' + esc(item.severity) + '</span></td>' +
          '<td>' + esc(item.sourceType) + '<div class="muted mono">' + esc(item.sourceId) + '</div></td>' +
          '<td><strong>' + esc(item.username || item.ownerId) + '</strong><div class="muted mono">' + esc(item.projectTitle || item.projectId || '-') + '</div></td>' +
          '<td>' + esc(item.scanReason || '-') + '</td>' +
          '<td><div class="excerpt">' + esc(item.rawExcerpt || '-') + '</div></td>' +
          '<td>' + esc(item.status) + (item.reviewedByUsername ? '<div class="muted">by ' + esc(item.reviewedByUsername) + '</div>' : '') + '</td>' +
          '<td>' + esc(fmtDate(item.createdAt)) + '</td>' +
          '<td><div class="actions">' + (item.status === 'pending' ? '<button class="danger" data-action="hide" data-id="' + esc(item.id) + '">隐藏</button><button class="primary" data-action="dismiss" data-id="' + esc(item.id) + '">忽略</button>' : '<span class="muted">已处理</span>') + '</div></td>' +
        '</tr>').join('');
      }
      async function load() {
        const params = new URLSearchParams();
        params.set('status', statusInput.value);
        if (qInput.value.trim()) params.set('q', qInput.value.trim());
        setNotice('加载中...');
        const res = await fetch('/api/admin/content?' + params.toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setNotice((data && data.detail) || '加载失败', 'error'); return; }
        state.items = data.items || []; state.summary = data.summary || {}; render(); setNotice('已更新', 'ok');
      }
      async function mutate(action, id) {
        const reason = window.prompt((action === 'hide' ? '隐藏' : '忽略') + '该内容风险的原因');
        if (!reason || !reason.trim()) return;
        const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const headers = { 'content-type':'application/json', 'x-idempotency-key': key, 'x-admin-reason': reason.trim() };
        const body = { action, id, reason: reason.trim(), dryRun:true };
        setNotice('正在预检查...');
        const dry = await fetch('/api/admin/content', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(body) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) { setNotice((dryData && dryData.detail) || '预检查失败', 'error'); return; }
        if (!window.confirm((action === 'hide' ? '隐藏' : '忽略') + '该内容风险？')) { setNotice('已取消'); return; }
        const commit = await fetch('/api/admin/content', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify({ action, id, reason: reason.trim() }) });
        const commitData = await commit.json().catch(() => null);
        if (!commit.ok) { setNotice((commitData && commitData.detail) || '提交失败', 'error'); return; }
        setNotice('处理完成', 'ok'); await load();
      }
      document.querySelector('[data-content-search-button="true"]')?.addEventListener('click', load);
      document.querySelector('[data-content-refresh="true"]')?.addEventListener('click', load);
      qInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') load(); });
      statusInput?.addEventListener('change', load);
      table?.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-action]');
        if (!btn) return;
        mutate(btn.dataset.action, btn.dataset.id);
      });
      window.adminStartPolling?.(load);
    </script>`,
  });
}
