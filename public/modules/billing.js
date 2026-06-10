import { ApiError, apiGet, apiPost, escapeHtml, showToast } from './utils.js';
import { mountHoloCard } from './holo_card.js';

let _ctx = {};
let _summary = null;
let _ledger = [];
// 账务流水分页：server 端 offset 分页（后端 /api/billing/ledger 已支持 limit/offset/total）。
// 每页 10 行；_ledgerPage 从 0 起；翻页只重渲流水区块，不整页重渲（避免顶部卡片闪烁）。
const LEDGER_PAGE_SIZE = 10;
let _ledgerTotal = 0;
let _ledgerPage = 0;
let _ledgerBusy = false;
let _pendingOrderNo = '';
let _paymentMethod = 'wxpay';
// 防重复提交开关：发起支付 / 兑换 / 取消恢复时置位，避免连点触发多次请求或状态卡死。
let _checkoutBusy = false;
let _redeemBusy = false;
let _subActionBusy = false;
// 每次 renderBillingPage() 重新渲染前，先销毁上一轮挂在 .plan-card 上的 holo
// 效果，避免重复绑定 pointer 事件 / 泄漏 rAF。
let _holoDestroys = [];

// 账务流水时间戳格式化：后端下发 ISO（2026-05-31T04:09:00.000Z），
// 直接展示给用户不够友好，统一转成本地 "YYYY-MM-DD HH:mm"；解析失败兜底原文。
function _fmtWhen(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return s;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 到期日只展示日期（YYYY-MM-DD）：订阅周期末是计费日，不需要精确到分钟，
// 直接展示后端 ISO 串里的 "T...Z" 既不友好也容易让人误读。解析失败兜底原文。
function _fmtDate(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return s;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 账务流水类别中文兜底（kind 是后端稳定枚举，9 值）。作为 reason 未命中时的兜底层。
function _kindLabel(kind) {
  var map = {
    text: '文本生成', image: '图片生成', video: '视频生成', export: '导出成片',
    topup: '积分充值', redeem: '兑换码充值', refund: '失败退还', gift: '赠送积分', adjust: '余额调整',
  };
  return map[String(kind || '')] || '';
}

// reason 在各扣费点是自由文本（dotted/colon 代码 + 部分已中文），不适合做唯一展示源。
// 这里把会露英文/代码的"稳定前缀"映射成中文；命中即用，未命中返回空交回上层。
function _reasonLabel(reason) {
  var r = String(reason == null ? '' : reason);
  if (!r) return '';
  // 顺序：更具体的前缀在前
  if (r.indexOf('edit.export.failed') === 0) return '导出失败退还';
  if (r.indexOf('edit.export.cancelled') === 0) return '导出取消退还';
  if (r.indexOf('edit.export') === 0) return '导出成片';
  if (r === 'script.full-create') return '剧本生成';
  if (r === 'script.adapt') return '剧本改编';
  if (r === 'script.revise') return '剧本修订';
  if (r.indexOf('script.') === 0) return '剧本生成失败退还'; // script.error / script.persist.error
  if (r.indexOf('batch:video_segments') === 0 || r.indexOf('batch:videos') === 0) return '视频生成';
  if (r.indexOf('batch:storyboard_prompts') === 0) return '分镜镜头生成';
  if (r.indexOf('batch:video_prompts') === 0) return '视频提示词生成';
  if (r.indexOf('batch:') === 0) return '图片生成';
  if (r.indexOf('refund:') === 0) return '生成失败退还';
  if (r === 'orphan export reap') return '导出超时退还';
  return '';
}

function _hasCjk(s) { return /[一-鿿]/.test(String(s == null ? '' : s)); }

// 流水标签解析（前端映射，不动后端）：
//  1) reason 命中稳定前缀 → 中文；
//  2) reason 已是中文（工具箱*/兑换码*/开户赠送*）→ 原样；
//  3) reason 是其它非中文文本 → 保留原文（必要英文可保留，不强译）；
//  4) reason 为空 → 用 kind 中文兜底；都没有则 "账务记录"。
function _ledgerLabel(item) {
  var reason = String((item && item.reason) || '');
  var mapped = _reasonLabel(reason);
  if (mapped) return mapped;
  if (reason && _hasCjk(reason)) return reason;
  if (reason) return reason;
  return _kindLabel(item && (item.kind || item.entry_type)) || '账务记录';
}

function _ledgerAccountParts() {
  var user = (_summary && _summary.user) || {};
  var accountName = String(user.displayName || user.display_name || user.username || '').trim() || '未命名账号';
  var phone = String(user.phone || '').trim() || '未绑定';
  return ['账号名称 ' + accountName, '注册手机号 ' + phone];
}

function _billingAccountName() {
  var user = (_summary && _summary.user) || {};
  return String(user.displayName || user.display_name || user.username || user.phone || '').trim();
}

// ---- 账务流水渲染（区块级，供整页渲染与翻页增量渲染复用）----
function _ledgerRowsHtml() {
  return (_ledger || []).map(function (item) {
    var when = _fmtWhen(item.createdAt || item.created_at || '');
    var label = _ledgerLabel(item);
    var amount = Number(item.amount || 0);
    var amountText = (amount > 0 ? '+' : '') + amount;
    var balance = Number(item.balanceAfter || item.balance_after || 0);
    var meta = [when, '余额 ' + balance].concat(_ledgerAccountParts()).filter(Boolean).map(function (part) {
      return escapeHtml(part);
    }).join(' · ');
    return '<div class="flex items-center justify-between gap-4 py-3 border-b border-outline-variant/10">' +
      '<div class="min-w-0">' +
        '<div class="text-sm font-medium text-on-surface truncate">' + escapeHtml(label) + '</div>' +
        '<div class="text-[11px] text-on-surface-variant/60 mt-1">' + meta + '</div>' +
      '</div>' +
      '<div class="text-sm font-bold ' + (amount >= 0 ? 'text-emerald-600' : 'text-rose-500') + '">' + escapeHtml(amountText) + '</div>' +
    '</div>';
  }).join('') || '<p class="text-sm text-on-surface-variant/50">暂无账务流水。</p>';
}

// 翻页控件：放"最近账务流水"标题右侧（标题行 flex justify-between）。仅 1 页时隐藏。
// 用内联样式避免依赖未预编译的 Tailwind 工具类（本仓 workspace-tailwind 为静态编译）。
function _ledgerPagerHtml() {
  var total = Number(_ledgerTotal || 0);
  if (total <= LEDGER_PAGE_SIZE) return '';
  var totalPages = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
  var cur = (_ledgerPage || 0) + 1;
  var atFirst = (_ledgerPage || 0) <= 0;
  var atLast = (_ledgerPage || 0) >= totalPages - 1;
  var base = 'padding:3px 9px;border-radius:8px;border:1px solid rgba(0,0,0,0.12);background:#fff;font-weight:700;line-height:1;font-size:13px;';
  function navBtn(dir, glyph, disabled) {
    return '<button type="button" data-ledger-nav="' + dir + '"' + (disabled ? ' disabled' : '') +
      ' style="' + base + (disabled ? 'opacity:0.35;cursor:not-allowed;' : 'cursor:pointer;') + '">' + glyph + '</button>';
  }
  return '<div class="flex items-center gap-2">' +
    navBtn('prev', '‹', atFirst) +
    '<span class="text-[11px] text-on-surface-variant/60">第 ' + cur + ' / ' + totalPages + ' 页</span>' +
    navBtn('next', '›', atLast) +
  '</div>';
}

function _ledgerInnerHtml() {
  return '<div class="flex items-center justify-between gap-3 mb-4">' +
      '<div class="text-sm font-bold">最近账务流水</div>' +
      _ledgerPagerHtml() +
    '</div>' +
    '<div>' + _ledgerRowsHtml() + '</div>';
}

function _bindLedgerPager(scope) {
  if (!scope) return;
  var prev = scope.querySelector('[data-ledger-nav="prev"]');
  var next = scope.querySelector('[data-ledger-nav="next"]');
  if (prev) prev.addEventListener('click', function () {
    if ((_ledgerPage || 0) > 0) loadLedgerPage((_ledgerPage || 0) - 1);
  });
  if (next) next.addEventListener('click', function () {
    var totalPages = Math.max(1, Math.ceil(Number(_ledgerTotal || 0) / LEDGER_PAGE_SIZE));
    if ((_ledgerPage || 0) < totalPages - 1) loadLedgerPage((_ledgerPage || 0) + 1);
  });
}

// 只重渲流水区块（不动顶部卡片/套餐网格），避免翻页时整页闪烁。
function _renderLedgerSection() {
  var el = document.getElementById('billingLedgerSection');
  if (!el) return;
  el.innerHTML = _ledgerInnerHtml();
  _bindLedgerPager(el);
}

async function loadLedgerPage(page) {
  if (_ledgerBusy) return;
  if (page < 0) page = 0;
  _ledgerBusy = true;
  try {
    var resp = await apiGet('/api/billing/ledger?limit=' + LEDGER_PAGE_SIZE + '&offset=' + (page * LEDGER_PAGE_SIZE));
    _ledger = (resp && resp.items) || [];
    _ledgerTotal = Number((resp && resp.total) || 0);
    _ledgerPage = page;
  } catch (e) {
    showToast(e && e.message ? e.message : '加载账务流水失败', 'warn');
  } finally {
    _ledgerBusy = false;
  }
  _renderLedgerSection();
}

export function initBilling(ctx) {
  _ctx = ctx || {};
}

export function getBillingSummary() {
  return _summary;
}

export function refreshBillingBadge() {
  // 刷新账户入口里的会员类型文案。
  // 档位 title 直接取后端 /api/billing/me 下发的 currentPlan.title，前端不做 code→title 映射；
  // 这样后端加档位 / 改档位文案（services/billing_service.py PLANS 表），前端一行都不用动。
  var badgeEl = document.getElementById('accountBillingBadge');
  var menuPlanEl = document.getElementById('accountMenuPlan');
  var menuCreditsEl = document.getElementById('accountMenuCredits');
  if (!badgeEl && !menuPlanEl && !menuCreditsEl) return;

  var planTitle;
  var credits = 0;
  if (!_summary) {
    // _summary===null：刚登录 /api/billing/me 还没回 / 或失败。后端会给每个用户 seed
    // 一条 free 订阅，这里的 Free 仅作首屏兜底，几十毫秒后就会被真数据覆盖。
    planTitle = 'Free';
  } else {
    planTitle = (_summary.currentPlan && _summary.currentPlan.title) || 'Free';
    var balances = _summary.balances || {};
    credits = balances.totalCredits || 0;
  }

  if (badgeEl) badgeEl.textContent = String(planTitle);
  if (menuPlanEl) menuPlanEl.textContent = String(planTitle);
  if (menuCreditsEl) menuCreditsEl.textContent = Number(credits || 0).toLocaleString();
}

export async function loadBillingSummary() {
  try {
    _summary = await apiGet('/api/billing/me');
    try {
      _ledgerPage = 0;
      var ledgerResp = await apiGet('/api/billing/ledger?limit=' + LEDGER_PAGE_SIZE + '&offset=0');
      _ledger = (ledgerResp && ledgerResp.items) || [];
      _ledgerTotal = Number((ledgerResp && ledgerResp.total) || 0);
    } catch (_e) {
      _ledger = [];
      _ledgerTotal = 0;
    }
    renderBillingPage();
    refreshBillingBadge();
    return _summary;
  } catch (e) {
    console.warn('[billing] load summary failed:', e);
    return null;
  }
}

export async function loadBillingPlans() {
  try {
    return await apiGet('/api/billing/plans');
  } catch (e) {
    console.warn('[billing] load plans failed:', e);
    return { plans: [], topupPacks: [] };
  }
}

// 前端支付方式（微信/支付宝）映射到后端 /api/billing/checkout 期望的 provider 字段。
function _providerFromMethod(method) {
  return method === 'alipay' ? 'alipay' : 'wechat';
}

export async function startCheckout(orderType, code, paymentMethod) {
  var method = paymentMethod || _paymentMethod || 'wxpay';
  // 对齐后端 checkout 入参：provider + planCode / packCode。
  var body = { provider: _providerFromMethod(method) };
  if (orderType === 'subscription') body.planCode = code;
  else body.packCode = code;
  var order;
  try {
    order = await apiPost('/api/billing/checkout', body);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    _pendingOrderNo = '';
    var detail = (e && e.message) ? String(e.message) : '发起支付失败，请稍后重试';
    showToast(detail, 'warn');
    renderBillingPage();
    return { ok: false, detail: detail };
  }
  var navigated = submitCheckoutForm(order);
  if (!navigated) {
    // 支付通道尚未对接（占位）或未返回可用支付地址：把后端的引导文案如实展示，
    // 让用户知道下一步该怎么做（例如改用兑换码），而不是抛"支付表单数据不完整"。
    _pendingOrderNo = '';
    var msg = (order && order.message) ? String(order.message) : '支付通道维护中，暂时无法发起支付，请稍后再试或使用兑换码。';
    showToast(msg, 'info');
    renderBillingPage();
    return order;
  }
  // 真实网关：即将跳转，标记 pending 供返回后轮询/展示。
  _pendingOrderNo = (order && (order.order_no || order.orderId)) || '';
  renderBillingPage();
  return order;
}

export async function pollOrder(orderNo) {
  return await apiGet('/api/billing/orders/' + encodeURIComponent(orderNo));
}

// 返回 true 表示已发起跳转/表单提交（拿到了可用支付地址）；返回 false 表示
// 没有可用支付目标（占位/未配置），由调用方给出友好提示，而不是抛错。
export function submitCheckoutForm(order) {
  order = order || {};
  var providerPayload = order.providerPayload || {};
  var checkoutUrl = providerPayload.checkoutUrl || providerPayload.url || providerPayload.url_qrcode || providerPayload.pay_url || providerPayload.payment_url || providerPayload.cashier_url || providerPayload.code_url || providerPayload.qrcode || providerPayload.qr_url || order.payUrl || order.pay_url || '';
  // 'about:blank' 是后端占位 payUrl，不是真实支付地址，视为不可用。
  if (checkoutUrl && checkoutUrl !== 'about:blank') {
    window.location.href = String(checkoutUrl);
    return true;
  }
  var gatewayUrl = order.gateway_url || '';
  var fields = order.formFields || {};
  if (!gatewayUrl || !fields || typeof fields !== 'object' || !Object.keys(fields).length) {
    return false;
  }
  var form = document.createElement('form');
  form.method = 'POST';
  form.action = gatewayUrl;
  form.style.display = 'none';
  Object.keys(fields).forEach(function (key) {
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = String(fields[key] == null ? '' : fields[key]);
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  return true;
}

// 兑换码兑换：后端 /api/billing/redeem 已实现（成功返回 { ok, creditsAdded, message }，
// 失败返回 { detail }）。这里做前端入口：成功后刷新余额/流水，失败给出明确文案。
export async function redeemCode(code) {
  var resp;
  try {
    resp = await apiPost('/api/billing/redeem', { code: code });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    var failedDetail = (e && e.message) ? String(e.message) : '兑换失败，请检查兑换码后重试';
    showToast(failedDetail, 'warn');
    return { ok: false, detail: failedDetail };
  }
  if (resp && resp.ok) {
    await loadBillingSummary();
    showToast((resp.message ? String(resp.message) : '兑换成功') + (resp.creditsAdded ? '（+' + resp.creditsAdded + ' 积分）' : ''), 'ok');
    return { ok: true };
  }
  var detail = (resp && resp.detail) ? String(resp.detail) : '兑换失败，请检查兑换码后重试';
  showToast(detail, 'warn');
  return { ok: false, detail: detail };
}

export function showBillingPaywall(meta) {
  var billing = meta || {};
  var required = billing.requiredCredits || 0;
  var available = billing.availableCredits || 0;
  showToast('积分不足：需要 ' + required + '，当前 ' + available + '。请购买积分。', 'warn');
  if (_ctx.switchPage) _ctx.switchPage('billing');
}

export async function waitForOrderApplied(orderNo, timeoutMs) {
  timeoutMs = Math.max(5000, Number(timeoutMs || 30000));
  var started = Date.now();
  while (Date.now() - started < timeoutMs) {
    var order = await pollOrder(orderNo);
    var status = (order && order.status) || '';
    if (status === 'applied' || status === 'failed') return order;
    await new Promise(function (resolve) { setTimeout(resolve, 2000); });
  }
  return null;
}

export async function handleBillingReturnFromUrl() {
  try {
    var url = new URL(window.location.href);
    var state = url.searchParams.get('billing') || '';
    var orderNo = url.searchParams.get('orderNo') || '';
    if (state === 'return') {
      url.searchParams.set('t', String(Date.now()));
    }
    url.searchParams.delete('billing');
    if (orderNo) url.searchParams.delete('orderNo');
    window.history.replaceState({}, '', url.toString());
    await loadBillingSummary();
    if (state === 'return' && orderNo) {
      var polled = await waitForOrderApplied(orderNo, 12000);
      await loadBillingSummary();
      _pendingOrderNo = '';
      showToast(polled && polled.status === 'applied' ? '支付成功，账务已刷新。' : '支付已返回，请稍候账务状态刷新。', polled && polled.status === 'applied' ? 'ok' : 'warn');
      if (_ctx.switchPage) _ctx.switchPage('billing');
      return;
    }
    _pendingOrderNo = '';
    if (state === 'return') {
      showToast('支付已返回，请稍候账务状态刷新。', 'ok');
      if (_ctx.switchPage) _ctx.switchPage('billing');
    } else if (state === 'cancel') {
      showToast('已取消支付。', 'warn');
      if (_ctx.switchPage) _ctx.switchPage('billing');
    }
  } catch (_e) {}
}

export async function cancelSubscription() {
  await apiPost('/api/billing/subscription/cancel', {});
  await loadBillingSummary();
  showToast('已设置为到期取消。', 'ok');
}

export async function resumeSubscription() {
  await apiPost('/api/billing/subscription/resume', {});
  await loadBillingSummary();
  showToast('已恢复自动续订。', 'ok');
}

export function renderBillingPage() {
  // 旧：#pageBilling 是独立 page 的外壳；新：#billingModal 是顶层 modal 外壳。
  // 只要能拿到渲染目标 #billingContent 就可以渲染，外壳用哪个容器对 render 是透明的。
  var host = document.getElementById('billingContent');
  if (!host) return;
  // 释放上一次渲染挂的 holo 监听（pointer 事件 + rAF），防止重渲时重复占用。
  if (_holoDestroys && _holoDestroys.length) {
    _holoDestroys.forEach(function (d) { try { d && d(); } catch (_e) {} });
    _holoDestroys = [];
  }
  if (!_summary) {
    host.innerHTML = '<p class="text-sm text-on-surface-variant/50">正在加载账务信息…</p>';
    return;
  }
  var subscription = _summary.subscription || {};
  var plan = (_summary.currentPlan && _summary.currentPlan.title) || 'Free';
  var accountName = _billingAccountName();
  var currentPlanLabel = (accountName ? accountName + ' · ' : '') + plan;
  var balances = _summary.balances || {};
  var plans = _summary.plans || [];
  var topups = _summary.topupPacks || [];
  var statusText = subscription.status || 'active';
  var periodEnd = subscription.current_period_end || subscription.currentPeriodEnd || '';
  var cancelAtPeriodEnd = !!(subscription.cancel_at_period_end || subscription.cancelAtPeriodEnd);
  // ----------------------------------------------------------------
  // 订阅套餐卡片 —— "Luminous Infinity" pricing card
  // 视觉 / 结构参考：/Users/cuize/Downloads/stitch_sleek_ai_video_agent (3)/code.html
  // CSS 样式在 static/styles.css 的 .plan-card / .plan-energy-pulse / .plan-price-glow
  // / .plan-cta / .billing-plans-grid / .plan-badge-current 等块里。
  // 原则：
  //   - 卡片数据（title / price / monthly_credits / limits / features）全部来自后端
  //     /api/billing/me 的 plans[]，前端只做"数据 -> 视觉"的渲染映射；
  //   - 不把"哪个是最推荐档位"做成前端硬编码，isCurrent 由后端 subscription.plan_code
  //     驱动，命中时套用 .is-current 变体（cyan 极光边 + CTA 高亮 + "当前" 徽章）；
  //   - data-plan-code 只放在 CTA <button> 上，避免整卡 + 按钮双重触发 checkout
  //     （click 委托在下面 host.querySelectorAll('[data-plan-code]') 里）。
  // ----------------------------------------------------------------
  function _formatMoney(cents) {
    var amount = Number(cents || 0) / 100;
    var body = amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2);
    return '¥' + body;
  }
  function _priorityLabel(value) {
    var v = String(value || '');
    if (v === 'priority') return '优先调度';
    if (v === 'fast') return '快速调度';
    if (v === 'normal') return '标准调度';
    return v;
  }
  function _formatPlanPrice(p) {
    var cents = Number(p.price_cents || 0);
    var cycle = (p.billing_cycle || 'month');
    // 免费档 / 企业自定义合约：不显示具体价格
    if (cents <= 0 && cycle !== 'month') return { price: '联系销售', cycle: '' };
    if (cents <= 0) return { price: '免费', cycle: '' };
    var cycleLabel = cycle === 'year' ? '/年' : '/月';
    return { price: _formatMoney(cents), cycle: cycleLabel };
  }
  function _derivePlanFeatureItems(p) {
    var limits = p.limits || {};
    var features = p.features || {};
    var items = [];
    // 1) 月度积分
    items.push({
      icon: 'bolt',
      label: (Number(p.monthly_credits || 0)).toLocaleString() + ' 积分',
      sub: Number(p.monthly_credits || 0) > 0 ? '每月重置' : '按合约交付',
    });
    // 2) 并发
    if (limits.concurrency != null) {
      items.push({
        icon: 'speed',
        label: Number(limits.concurrency) + ' 个并发任务',
        sub: '任务调度上限',
      });
    }
    // 3) 项目与存储
    if (limits.projects != null || limits.storageGB != null) {
      var quotaBits = [];
      if (limits.projects != null) quotaBits.push(Number(limits.projects).toLocaleString() + ' 个项目');
      if (limits.storageGB != null) quotaBits.push(Number(limits.storageGB).toLocaleString() + 'GB 存储');
      items.push({
        icon: 'inventory_2',
        label: quotaBits.join(' / '),
        sub: '项目与素材空间',
      });
    } else if (limits.maxVideoSeconds != null) {
      items.push({
        icon: 'timer',
        label: '单段 ' + Number(limits.maxVideoSeconds) + 's',
        sub: limits.maxCompositeSeconds ? '合成上限 ' + Number(limits.maxCompositeSeconds) + 's' : '',
      });
    }
    // 4) 模型与支持
    var models = Array.isArray(features.models) ? features.models.filter(Boolean).join(' / ') : String(features.models || '');
    var serviceBits = [];
    if (features.priority) serviceBits.push(_priorityLabel(features.priority));
    if (features.support) serviceBits.push(String(features.support) + '支持');
    if (models) {
      items.push({
        icon: 'auto_awesome',
        label: models,
        sub: serviceBits.join(' · '),
      });
    } else if (serviceBits.length) {
      items.push({
        icon: 'support_agent',
        label: serviceBits.join(' · '),
        sub: '服务权益',
      });
    }
    // 兼容未来扩展字段：没有 models/support 时，用差异化特性兜底。
    var hi = null;
    if (features.premiumUnlimited)      hi = { icon: 'all_inclusive',       label: 'Premium 无限配额',   sub: '高级模型不限次数' };
    else if (features.premiumCredits)   hi = { icon: 'stars',               label: Number(features.premiumCredits).toLocaleString() + ' Premium 积分', sub: '额外高级模型配额' };
    else if (features.customBranding)   hi = { icon: 'workspace_premium',   label: '自定义品牌水印',     sub: '品牌化交付' };
    else if (features.api)              hi = { icon: 'api',                 label: '全功能 API 访问',    sub: '集成工作流' };
    else if (features.customDeal)       hi = { icon: 'support_agent',       label: '定制企业合约',       sub: '联系销售定制' };
    else if (features.commercial)       hi = { icon: 'verified_user',       label: '商用授权',           sub: '可用于商业交付' };
    else if (features.watermark)        hi = { icon: 'branding_watermark',  label: '含官方水印',         sub: '免费档默认' };
    if (hi && items.length < 4) items.push(hi);
    // 最多只渲染 4 条，避免卡片高度参差
    return items.slice(0, 4);
  }
  var trialPack = null;
  var regularTopups = [];
  topups.forEach(function (p) {
    if ((p.kind || '') === 'trial' || p.code === 'pack_trial') trialPack = p;
    else regularTopups.push(p);
  });

  // 当前档（含 free）一律渲染成卡片；非当前的 free 仍不展示（不做"降级到 free"卡）。
  var _curCode = subscription.plan_code || subscription.planCode || '';
  var planCards = plans.filter(function (p) { return p.code !== 'free' || p.code === _curCode; }).map(function (p) {
    var isCurrent = (subscription.plan_code || subscription.planCode || '') === p.code;
    var priceObj = _formatPlanPrice(p);
    var isCustom = priceObj.price === '联系销售';
    // 中文价格文案（免费 / 联系销售）在 text-5xl 下 CJK 字身比 "$NNN" 数字视觉大很多，
    // 降到 text-4xl 让其视觉高度与付费档 "$299" 接近。
    var priceCls = _hasCjk(priceObj.price) ? 'text-4xl' : 'text-5xl';
    var featureItems = _derivePlanFeatureItems(p);
    var subLabelBits = [p.billing_cycle === 'year' ? '年付套餐' : '月付套餐'];
    if (p.description) subLabelBits.push(p.description);
    if (p.features && p.features.topupAllowed) subLabelBits.push('可加购');
    var subLabel = subLabelBits.join(' · ');
    var creditsChip = Number(p.monthly_credits || 0) > 0
      ? '<div class="plan-credits-chip">' + (Number(p.monthly_credits).toLocaleString()) + ' 积分 / 月</div>'
      : '';
    var featureHtml = featureItems.map(function (item) {
      return '<li class="plan-feature-item">' +
        '<span class="material-symbols-outlined plan-feature-icon">' + escapeHtml(item.icon) + '</span>' +
        '<div>' +
          '<div>' + escapeHtml(item.label) + '</div>' +
          (item.sub ? '<div class="plan-feature-sub">' + escapeHtml(item.sub) + '</div>' : '') +
        '</div>' +
      '</li>';
    }).join('');
    // CTA 与"升级此套餐"互斥同位：当前付费档 → 取消/恢复；当前 free → 不可取消；非当前 → 升级/联系销售。
    var isPaidCurrent = isCurrent && p.code !== 'free';
    var ctaHtml;
    if (isPaidCurrent && cancelAtPeriodEnd) {
      ctaHtml = '<button type="button" class="billing-card-plan plan-cta" data-sub-action="resume">恢复自动续订</button>';
    } else if (isPaidCurrent) {
      // CTA 复用与其它套餐卡完全一致的 .plan-cta 样式，保证卡片 UI 统一（不再内联改色）。
      ctaHtml = '<button type="button" class="billing-card-plan plan-cta" data-sub-action="cancel">取消套餐订阅</button>';
    } else if (isCurrent) {
      // 免费当前档：默认 :disabled 会让文字置灰看不清，这里强制白字 + 中性半透明底（非 cyan），保证可读。
      ctaHtml = '<button type="button" class="billing-card-plan plan-cta" disabled style="color:#ECEFF1;opacity:1;background:rgba(255,255,255,0.12);box-shadow:none;">当前套餐</button>';
    } else if (isCustom) {
      ctaHtml = '<button type="button" class="billing-card-plan plan-cta" data-plan-code="' + escapeHtml(p.code) + '" disabled>联系销售</button>';
    } else {
      ctaHtml = '<button type="button" class="billing-card-plan plan-cta" data-plan-code="' + escapeHtml(p.code) + '">升级此套餐</button>';
    }
    // 已申请到期取消：在 CTA 上方提示"到期后降级为免费版"。
    var cancelNote = (isPaidCurrent && cancelAtPeriodEnd)
      ? '<div class="text-[10px] font-bold text-amber-300/90 mt-3">' + (periodEnd ? '到期 ' + escapeHtml(_fmtDate(periodEnd)) + ' 后降级为免费版' : '到期后降级为免费版') + '</div>'
      : '';
    return '<div class="plan-card' + (isCurrent ? ' is-current' : '') + '">' +
      '<div class="plan-energy-pulse"></div>' +
      '<div class="relative z-10 flex flex-col h-full">' +
        '<div class="mb-6">' +
          '<div class="flex items-center justify-between gap-2">' +
            '<h3 class="font-headline text-xl font-black tracking-tighter uppercase">' + escapeHtml(p.title || p.code) + '</h3>' +
            (isCurrent ? '<span class="plan-badge-current">当前</span>' : '') +
          '</div>' +
          '<p class="text-[9px] font-bold tracking-widest text-[#ECEFF1]/50 uppercase mt-1">' + escapeHtml(subLabel) + '</p>' +
        '</div>' +
        '<div class="mb-6">' +
          '<div class="flex items-baseline gap-1">' +
            '<span class="' + priceCls + ' font-bold plan-price-glow tracking-tighter">' + escapeHtml(priceObj.price) + '</span>' +
            (priceObj.cycle ? '<span class="text-[11px] font-bold text-[#ECEFF1]/30 uppercase">' + escapeHtml(priceObj.cycle) + '</span>' : '') +
          '</div>' +
          (creditsChip ? '<div class="mt-2">' + creditsChip + '</div>' : '') +
        '</div>' +
        '<ul class="space-y-4 flex-grow">' + featureHtml + '</ul>' +
        cancelNote +
        ctaHtml +
      '</div>' +
    '</div>';
  }).join('');
  // 加购积分档位卡：延续 .plan-current-card 的视觉语言（深底 + halftone），
  // 每张档位卡用 .plan-topup-card 深底薄亮边 + cyan hover，积分数字走 cyan
  // 高亮。data-topup-code 保留不变，下面 host.querySelectorAll 仍能绑 click。
  var topupCards = regularTopups.map(function (p) {
    var priceStr = _formatMoney(p.price_cents || 0);
    var credits = Number(p.credits || 0).toLocaleString();
    return '<button type="button" class="billing-card-topup plan-topup-card" data-topup-code="' + escapeHtml(p.code) + '">' +
      '<div class="plan-topup-title">' + escapeHtml(p.title || p.code) + '</div>' +
      '<div class="plan-topup-meta">' + escapeHtml(priceStr) + ' · <span class="plan-topup-credits">' + escapeHtml(credits) + ' 积分</span></div>' +
    '</button>';
  }).join('');
  var trialCard = '';
  if (trialPack) {
    trialCard = '<div class="plan-card">' +
      '<div class="plan-energy-pulse"></div>' +
      '<div class="relative z-10 flex flex-col h-full">' +
        '<div class="mb-6">' +
          '<div class="flex items-center justify-between gap-2">' +
            '<h3 class="font-headline text-xl font-black tracking-tighter uppercase">体验包</h3>' +
          '</div>' +
          '<p class="text-[9px] font-bold tracking-widest text-[#ECEFF1]/50 uppercase mt-1">首次专享</p>' +
        '</div>' +
        '<div class="mb-6">' +
          '<div class="flex items-baseline gap-1">' +
            '<span class="text-5xl font-bold plan-price-glow tracking-tighter">' + escapeHtml(_formatMoney(trialPack.price_cents || 0)) + '</span>' +
            '<span class="text-[11px] font-bold text-[#ECEFF1]/30 uppercase">一次性</span>' +
          '</div>' +
          '<div class="mt-2"><div class="plan-credits-chip">' + escapeHtml(Number(trialPack.credits || 0).toLocaleString()) + ' 积分</div></div>' +
        '</div>' +
        '<ul class="space-y-4 flex-grow">' +
          '<li class="plan-feature-item"><span class="material-symbols-outlined plan-feature-icon">workspace_premium</span><div><div>永久</div></div></li>' +
          '<li class="plan-feature-item"><span class="material-symbols-outlined plan-feature-icon">movie</span><div><div>1× 15s</div><div class="plan-feature-sub">Premium 完整流程</div></div></li>' +
          '<li class="plan-feature-item"><span class="material-symbols-outlined plan-feature-icon">person</span><div><div>仅个人</div></div></li>' +
          '<li class="plan-feature-item"><span class="material-symbols-outlined plan-feature-icon">looks_one</span><div><div>终身1次</div></div></li>' +
        '</ul>' +
        '<button type="button" class="billing-card-plan plan-cta" data-topup-code="' + escapeHtml(trialPack.code) + '">体验</button>' +
      '</div>' +
    '</div>';
  }

  var featureBadges = [];
  var features = (_summary.currentPlan && _summary.currentPlan.features) || {};
  if (features.commercial) featureBadges.push('商用');
  if (features.customBranding) featureBadges.push('自定义品牌');
  if (features.api) featureBadges.push('API');
  if (features.topupAllowed) featureBadges.push('可加购');
  // feature badge 在深色当前套餐卡上用 .plan-feature-badge（亮字+白色薄边），
  // 不再使用原本浅灰底的 bg-surface-container 版本。
  var featureHtml = featureBadges.length
    ? '<div class="flex flex-wrap gap-2 mt-2">' + featureBadges.map(function (label) {
        return '<span class="plan-feature-badge">' + escapeHtml(label) + '</span>';
      }).join('') + '</div>'
    : '';
  // 取消/恢复入口已移到"当前套餐卡片"的 CTA 上（与升级互斥同位）；顶部状态条不再放取消按钮。
  host.innerHTML = '' +
    // ----------------------------------------------------------------
    // 当前套餐状态卡（紧凑版）
    //   - 布局：左侧"当前套餐名 + 状态 + 特性 badges"，右侧"3 个余额小卡 并排"，
    //     底部一条极细操作栏（支付方式 + 取消/恢复），让整体高度控制在约 160-180px；
    //   - 视觉延续 .plan-card 的深色渐变 + halftone + 旋转极光边（.plan-energy-pulse），
    //     套餐名复用 .plan-price-glow 的 cyan 文字辉光；
    //   - 所有操作按钮与余额小卡都走深底兼容的 .plan-*-btn / .plan-balance-cell 样式，
    //     不再使用原本浅灰底的 bg-surface-container / bg-primary text-on-primary。
    // ----------------------------------------------------------------
    '<section class="plan-current-card">' +
      '<div class="plan-energy-pulse"></div>' +
      '<div class="relative z-10">' +
        '<div class="flex items-start justify-between gap-6 flex-wrap">' +
          '<div class="min-w-0 flex-1">' +
            '<div class="text-[9px] font-bold tracking-[0.3em] text-[#ECEFF1]/50 uppercase">当前套餐 / Current Plan</div>' +
            '<div class="flex items-baseline gap-3 flex-wrap mt-1">' +
              '<span class="text-3xl font-bold plan-price-glow tracking-tighter font-headline uppercase">' + escapeHtml(currentPlanLabel) + '</span>' +
              '<span class="text-[10px] font-bold text-[#ECEFF1]/40 uppercase tracking-widest">' + escapeHtml(statusText) + (periodEnd ? ' · 到期 ' + escapeHtml(_fmtDate(periodEnd)) : '') + '</span>' +
            '</div>' +
            featureHtml +
            (_pendingOrderNo ? '<div class="text-[11px] text-[#00E5FF] mt-2 font-bold">支付处理中：' + escapeHtml(_pendingOrderNo) + '</div>' : '') +
          '</div>' +
          '<div class="grid grid-cols-3 gap-2 flex-shrink-0">' +
            '<div class="plan-balance-cell"><div class="text-[9px] font-bold tracking-widest text-[#ECEFF1]/45 uppercase">总积分</div><div class="text-lg font-bold plan-price-glow mt-0.5">' + (balances.totalCredits || 0) + '</div></div>' +
            '<div class="plan-balance-cell"><div class="text-[9px] font-bold tracking-widest text-[#ECEFF1]/45 uppercase">体验/订阅积分</div><div class="text-lg font-bold text-[#ECEFF1] mt-0.5">' + (balances.subscriptionCredits || 0) + '</div></div>' +
            '<div class="plan-balance-cell"><div class="text-[9px] font-bold tracking-widest text-[#ECEFF1]/45 uppercase">常规购买积分</div><div class="text-lg font-bold text-[#ECEFF1] mt-0.5">' + (balances.topupCredits || 0) + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="flex items-center justify-end gap-3 mt-3 flex-wrap">' +
          '<div class="plan-pill-group">' +
            '<button type="button" class="billing-pay-method plan-pill-btn ' + (_paymentMethod === 'wxpay' ? 'is-active' : '') + '" data-pay-method="wxpay">微信</button>' +
            '<button type="button" class="billing-pay-method plan-pill-btn ' + (_paymentMethod === 'alipay' ? 'is-active' : '') + '" data-pay-method="alipay">支付宝</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</section>' +
    // 订阅套餐板块：毛玻璃容器（.billing-section-glass，样式见 styles.css）
    // 半透明白底 + 24px backdrop-blur，让底下的工作台点阵 canvas 透过来隐约可见。
    '<section class="billing-section-glass">' +
      '<div class="text-sm font-bold mb-4 text-on-surface">订阅套餐</div>' +
      '<div class="billing-plans-grid">' + trialCard + planCards + '</div>' +
    '</section>' +
    '<section class="plan-topup-section">' +
      '<div class="plan-topup-section-title">积分购买 / Credits</div>' +
      '<div class="grid grid-cols-2 gap-3">' + topupCards + '</div>' +
    '</section>' +
    // 兑换码入口：/api/billing/redeem 早已实现且是当前唯一可用的到账路径
    // （支付占位 message 也引导用户用兑换码），此前却没有任何前端入口。
    '<section class="bg-surface-container-lowest rounded-2xl p-6 border border-outline-variant/10 shadow-sm">' +
      '<div class="text-sm font-bold mb-1">兑换码</div>' +
      '<div class="text-[11px] text-on-surface-variant/55 mb-4">输入兑换码，积分立即到账。</div>' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<input id="billingRedeemInput" type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="输入兑换码" class="flex-1 min-w-[180px] px-4 py-2.5 rounded-xl border border-outline-variant/30 bg-white/60 text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/60 transition-colors" />' +
        '<button type="button" id="billingRedeemBtn" class="px-5 py-2.5 rounded-xl text-sm font-bold bg-[#0B1320] text-[#ECEFF1] hover:bg-[#00E5FF] hover:text-[#0B1320] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed">兑换</button>' +
      '</div>' +
    '</section>' +
    '<section id="billingLedgerSection" class="bg-surface-container-lowest rounded-2xl p-6 border border-outline-variant/10 shadow-sm">' +
      _ledgerInnerHtml() +
    '</section>';
  Array.prototype.slice.call(host.querySelectorAll('.billing-pay-method')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      _paymentMethod = btn.getAttribute('data-pay-method') || 'wxpay';
      renderBillingPage();
    });
  });
  // 取消/恢复续订：加 busy 守卫 + 按钮禁用，防止连点重复请求；成功后
  // loadBillingSummary() 会整页重渲替换按钮，失败则恢复按钮可用。
  function _bindSubAction(btn, fn, failMsg) {
    if (!btn) return;
    btn.addEventListener('click', async function () {
      if (_subActionBusy) return;
      _subActionBusy = true;
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = '处理中…';
      try {
        await fn();
      } catch (e) {
        showToast(e && e.message ? e.message : failMsg, 'error');
        if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = prev; }
      } finally {
        _subActionBusy = false;
      }
    });
  }
  _bindSubAction(host.querySelector('[data-sub-action="resume"]'), resumeSubscription, '恢复失败');
  _bindSubAction(host.querySelector('[data-sub-action="cancel"]'), cancelSubscription, '取消失败');
  _bindLedgerPager(host.querySelector('#billingLedgerSection'));

  // 发起支付：全局 _checkoutBusy 守卫，避免同时点多个套餐/积分包重复下单；
  // 点击后按钮禁用 + "处理中…"，startCheckout 内部成功/占位/错误都会重渲。
  function _bindCheckout(btn, orderType, attr) {
    btn.addEventListener('click', async function () {
      if (_checkoutBusy || btn.disabled) return;
      _checkoutBusy = true;
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = '处理中…';
      try {
        await startCheckout(orderType, btn.getAttribute(attr), _paymentMethod);
      } catch (e) {
        showToast(e && e.message ? e.message : '发起支付失败', 'error');
      } finally {
        _checkoutBusy = false;
        if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = prev; }
      }
    });
  }
  Array.prototype.slice.call(host.querySelectorAll('[data-plan-code]')).forEach(function (btn) {
    _bindCheckout(btn, 'subscription', 'data-plan-code');
  });
  Array.prototype.slice.call(host.querySelectorAll('[data-topup-code]')).forEach(function (btn) {
    _bindCheckout(btn, 'topup', 'data-topup-code');
  });

  // 兑换码：点击或回车提交；busy 守卫防连点；成功后整页重渲并清空输入。
  var redeemBtn = host.querySelector('#billingRedeemBtn');
  var redeemInput = host.querySelector('#billingRedeemInput');
  if (redeemBtn && redeemInput) {
    var doRedeem = async function () {
      if (_redeemBusy) return;
      var code = (redeemInput.value || '').trim();
      if (!code) { showToast('请输入兑换码', 'warn'); try { redeemInput.focus(); } catch (_e) {} return; }
      _redeemBusy = true;
      redeemBtn.disabled = true;
      redeemInput.disabled = true;
      var prev = redeemBtn.textContent;
      redeemBtn.textContent = '兑换中…';
      try {
        await redeemCode(code);
      } catch (e) {
        showToast(e && e.message ? e.message : '兑换失败', 'error');
      } finally {
        _redeemBusy = false;
        if (document.body.contains(redeemBtn)) { redeemBtn.disabled = false; redeemBtn.textContent = prev; }
        if (document.body.contains(redeemInput)) { redeemInput.disabled = false; }
      }
    };
    redeemBtn.addEventListener('click', doRedeem);
    redeemInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); doRedeem(); }
    });
  }
  // 为每张订阅套餐卡挂 holographic tilt + shine + glare（参考 reactbits
  // profile-card）。纯视觉层，不触碰支付/数据；destroy fn 收集起来下次重渲前
  // 先统一释放，保证 pointer 事件与 rAF 不会叠加。
  Array.prototype.slice.call(host.querySelectorAll('.plan-card')).forEach(function (card) {
    try {
      var destroy = mountHoloCard(card, { maxRotate: 6 });
      if (destroy) _holoDestroys.push(destroy);
    } catch (_e) { /* noop：视觉效果，不影响支付功能 */ }
  });
}
