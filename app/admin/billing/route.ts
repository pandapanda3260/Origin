import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/billing',
    title: '财务积分',
    headHtml: `<style>
      .billing-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
      .billing-toolbar input { width:320px; max-width:100%; }
      .billing-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:14px; }
      .metric { border:1px solid var(--line); border-radius:8px; background:#fff; padding:14px; }
      .metric strong { display:block; font-size:var(--admin-font-xl); margin-top:6px; }
      .admin-table-wrap { margin-top:14px; }
      table.admin-table { min-width:980px; }
      .tabs { display:flex; gap:8px; flex-wrap:wrap; margin:14px 0; }
      .tabs button[data-active="true"] { background:var(--accent-bg); color:var(--admin-success-strong); font-weight:700; }
      .adjust-form { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:10px; }
      .adjust-user-input { width:120px; }
      .adjust-amount-input { width:190px; }
      .adjust-confirm-input { width:160px; }
      @media (max-width: 900px) { .billing-grid { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<section class="panel">
      <div class="billing-toolbar">
        <input data-billing-search="true" placeholder="搜索用户 / 订单 / ledger / refId" />
        <button data-billing-search-button="true" class="primary">搜索</button>
        <button data-billing-refresh="true">刷新</button>
      </div>
      <div class="billing-grid" data-billing-metrics="true"></div>
      <div class="adjust-form">
        <input data-adjust-user-id="true" class="adjust-user-input" placeholder="用户 ID" />
        <input data-adjust-amount="true" class="adjust-amount-input" placeholder="调账积分，正数加、负数扣" />
        <input data-adjust-confirm="true" class="adjust-confirm-input" placeholder="大额输入 CONFIRM" />
        <button data-adjust-submit="true" class="primary">人工调账</button>
      </div>
      <div class="tabs">
        <button data-tab="users" data-active="true">余额</button>
        <button data-tab="orders">订单</button>
        <button data-tab="ledger">Ledger</button>
        <button data-tab="cost">成本观察</button>
        <button data-tab="redeem">兑换码</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead data-billing-head="true"></thead>
          <tbody data-billing-table="true"><tr><td class="muted">加载中...</td></tr></tbody>
        </table>
      </div>
      <div class="notice" data-billing-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const state = { tab:'users', data:null };
      const qInput = document.querySelector('[data-billing-search="true"]');
      const metrics = document.querySelector('[data-billing-metrics="true"]');
      const head = document.querySelector('[data-billing-head="true"]');
      const table = document.querySelector('[data-billing-table="true"]');
      const notice = document.querySelector('[data-billing-notice="true"]');
      function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
      function setNotice(message, kind = '') { notice.textContent = message || ''; notice.dataset.kind = kind; }
      function fmtDate(value) { if (!value) return '-'; try { return new Date(value).toLocaleString('zh-CN', { hour12:false }); } catch { return value; } }
      function yuan(cents) { return (Number(cents || 0) / 100).toFixed(2); }
      function renderMetrics() {
        const cost = state.data?.cost || {};
        const revenue = (cost.revenue || []).map((r) => r.currency + ' ' + yuan(r.amountCents)).join(' / ') || '0.00';
        const gifts = (cost.gifts || []).reduce((sum, r) => sum + Number(r.credits || 0), 0);
        const charged = (cost.creditSpend || []).reduce((sum, r) => sum + Number(r.chargedCredits || 0), 0);
        metrics.innerHTML =
          '<div class="metric"><span class="muted">现金收入（真实 paid topup）</span><strong>' + esc(revenue) + '</strong></div>' +
          '<div class="metric"><span class="muted">赠送/兑换/调账入账</span><strong>' + gifts + ' 积分</strong></div>' +
          '<div class="metric"><span class="muted">累计消耗积分</span><strong>' + charged + '</strong></div>';
      }
      function rows(items, emptyCols, mapper) {
        if (!items || !items.length) return '<tr><td colspan="' + emptyCols + '" class="muted">暂无数据</td></tr>';
        return items.map(mapper).join('');
      }
      function render() {
        renderMetrics();
        document.querySelectorAll('[data-tab]').forEach((btn) => btn.dataset.active = btn.dataset.tab === state.tab ? 'true' : 'false');
        const data = state.data || {};
        if (state.tab === 'users') {
          head.innerHTML = '<tr><th>ID</th><th>用户</th><th>总积分</th><th>订阅</th><th>充值</th><th>赠送</th><th>计划</th><th>更新时间</th></tr>';
          table.innerHTML = rows(data.users, 8, (u) => '<tr><td>' + u.id + '</td><td><strong>' + esc(u.username) + '</strong><div class="muted">' + esc(u.email || u.displayName || '') + '</div></td><td>' + Number(u.totalCredits || 0) + '</td><td>' + Number(u.subscriptionCredits || 0) + '</td><td>' + Number(u.topupCredits || 0) + '</td><td>' + Number(u.bonusCredits || 0) + '</td><td>' + esc(u.planCode || '-') + '</td><td>' + esc(fmtDate(u.creditsUpdatedAt)) + '</td></tr>');
        } else if (state.tab === 'orders') {
          head.innerHTML = '<tr><th>订单</th><th>用户</th><th>类型</th><th>Provider</th><th>金额</th><th>积分</th><th>状态</th><th>时间</th></tr>';
          table.innerHTML = rows(data.orders, 8, (o) => '<tr><td class="mono">' + esc(o.id) + '</td><td>' + esc(o.username) + '<div class="muted">' + o.userId + '</div></td><td>' + esc(o.kind + '/' + (o.planCode || '-')) + '</td><td>' + esc(o.provider) + '<div class="muted mono">' + esc(o.providerRef || '') + '</div></td><td>' + esc(o.currency) + ' ' + yuan(o.amountCents) + '</td><td>' + Number(o.creditsAdded || 0) + '</td><td>' + esc(o.status) + '</td><td>' + esc(fmtDate(o.createdAt)) + '</td></tr>');
        } else if (state.tab === 'ledger') {
          head.innerHTML = '<tr><th>Ledger</th><th>用户</th><th>金额</th><th>类型</th><th>原因</th><th>Ref</th><th>模型/成本</th><th>时间</th></tr>';
          table.innerHTML = rows(data.ledger, 8, (l) => '<tr><td class="mono">' + esc(l.id) + '</td><td>' + esc(l.username) + '<div class="muted">' + l.userId + '</div></td><td>' + Number(l.amount || 0) + '<div class="muted">余额 ' + Number(l.balanceAfter || 0) + '</div></td><td>' + esc(l.kind) + (l.adminUsername ? '<div class="muted">admin ' + esc(l.adminUsername) + '</div>' : '') + '</td><td>' + esc(l.reason || '-') + '</td><td class="mono">' + esc(l.refId || '-') + '</td><td>' + esc([l.provider,l.model,l.modelRole].filter(Boolean).join(' / ') || '-') + '<div class="muted">' + (l.costMicros ? (Number(l.costMicros)/1000000).toFixed(6) : '-') + '</div></td><td>' + esc(fmtDate(l.createdAt)) + '</td></tr>');
        } else if (state.tab === 'cost') {
          head.innerHTML = '<tr><th>Provider</th><th>Model</th><th>Role</th><th>实际成本</th><th>消耗积分</th><th>样本</th></tr>';
          table.innerHTML = rows(data.cost?.modelCost, 6, (r) => '<tr><td>' + esc(r.provider) + '</td><td>' + esc(r.model) + '</td><td>' + esc(r.modelRole) + '</td><td>' + (Number(r.costMicros || 0)/1000000).toFixed(6) + '</td><td>' + Number(r.chargedCredits || 0) + '</td><td>' + Number(r.count || 0) + '</td></tr>');
        } else {
          head.innerHTML = '<tr><th>兑换码</th><th>积分</th><th>计划</th><th>使用</th><th>过期</th><th>备注</th><th>创建</th></tr>';
          table.innerHTML = rows(data.redeemCodes, 7, (r) => '<tr><td class="mono">' + esc(r.code) + '</td><td>' + Number(r.credits || 0) + '</td><td>' + esc(r.planCode || '-') + '</td><td>' + Number(r.usedCount || 0) + '/' + Number(r.maxUses || 0) + '</td><td>' + esc(fmtDate(r.expiresAt)) + '</td><td>' + esc(r.memo || '-') + '</td><td>' + esc(fmtDate(r.createdAt)) + '</td></tr>');
        }
      }
      async function load() {
        const params = new URLSearchParams();
        if (qInput.value.trim()) params.set('q', qInput.value.trim());
        setNotice('加载中...');
        const res = await fetch('/api/admin/billing?' + params.toString(), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setNotice((data && data.detail) || '加载失败', 'error'); return; }
        state.data = data; render(); setNotice('已更新', 'ok');
      }
      async function adjust() {
        const userId = Number(document.querySelector('[data-adjust-user-id="true"]').value);
        const amount = Number(document.querySelector('[data-adjust-amount="true"]').value);
        const confirmText = document.querySelector('[data-adjust-confirm="true"]').value.trim();
        const reason = window.prompt('人工调账原因（不可物理撤销，只能反向调账）');
        if (!reason || !reason.trim()) return;
        const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const headers = { 'content-type':'application/json', 'x-idempotency-key': key, 'x-admin-reason': reason.trim() };
        const body = { action:'manual_adjust', userId, amount, confirmText, reason: reason.trim(), dryRun:true };
        setNotice('正在预检查...');
        const dry = await fetch('/api/admin/billing', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(body) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) { setNotice((dryData && dryData.detail) || '预检查失败', 'error'); return; }
        if (!window.confirm('确认对用户 ' + userId + ' 调账 ' + amount + ' 积分？')) { setNotice('已取消'); return; }
        const commit = await fetch('/api/admin/billing', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify({ action:'manual_adjust', userId, amount, confirmText, reason: reason.trim() }) });
        const commitData = await commit.json().catch(() => null);
        if (!commit.ok) { setNotice((commitData && commitData.detail) || '提交失败', 'error'); return; }
        setNotice('调账完成', 'ok'); await load();
      }
      document.querySelector('[data-billing-search-button="true"]')?.addEventListener('click', load);
      document.querySelector('[data-billing-refresh="true"]')?.addEventListener('click', load);
      qInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') load(); });
      document.querySelector('[data-adjust-submit="true"]')?.addEventListener('click', adjust);
      document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => { state.tab = btn.dataset.tab; render(); }));
      window.adminStartPolling?.(load);
    </script>`,
  });
}
