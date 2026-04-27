import { apiGet, apiPost, escapeHtml, showToast } from './utils.js';
import { mountHoloCard } from './holo_card.js';

let _ctx = {};
let _summary = null;
let _ledger = [];
let _pendingOrderNo = '';
let _paymentMethod = 'wxpay';
// 每次 renderBillingPage() 重新渲染前，先销毁上一轮挂在 .plan-card 上的 holo
// 效果，避免重复绑定 pointer 事件 / 泄漏 rAF。
let _holoDestroys = [];

export function initBilling(ctx) {
  _ctx = ctx || {};
}

export function getBillingSummary() {
  return _summary;
}

export function refreshBillingBadge() {
  // 两处都刷：
  //   - #accountBillingBadge  左下账户卡里的小字
  //   - #navBillingLabel       左侧导航「订阅与积分」入口的 label
  // 文案格式："<档位title> · <积分图标> <数字> 积分"，例如 "Pro · [toll] 1234 积分"。
  // 档位 title 直接取后端 /api/billing/me 下发的 currentPlan.title，前端不做 code→title 映射；
  // 这样后端加档位 / 改档位文案（services/billing_service.py PLANS 表），前端一行都不用动。
  var badgeEl = document.getElementById('accountBillingBadge');
  var navLabelEl = document.getElementById('navBillingLabel');
  if (!badgeEl && !navLabelEl) return;

  var planTitle, credits;
  if (!_summary) {
    // _summary===null：刚登录 /api/billing/me 还没回 / 或失败。后端会给每个用户 seed
    // 一条 free 订阅，这里的 Free · 0 仅作首屏兜底，几十毫秒后就会被真数据覆盖。
    planTitle = 'Free';
    credits = 0;
  } else {
    planTitle = (_summary.currentPlan && _summary.currentPlan.title) || 'Free';
    var balances = _summary.balances || {};
    credits = balances.totalCredits || 0;
  }

  var safePlan = escapeHtml(String(planTitle));
  var safeCredits = escapeHtml(String(credits));
  var html =
    safePlan +
    ' · <span class="material-symbols-outlined text-sm align-middle">toll</span> ' +
    safeCredits + ' 积分';

  if (badgeEl) badgeEl.innerHTML = html;
  if (navLabelEl) navLabelEl.innerHTML = html;
}

export async function loadBillingSummary() {
  try {
    _summary = await apiGet('/api/billing/me');
    try {
      var ledgerResp = await apiGet('/api/billing/ledger?limit=20');
      _ledger = (ledgerResp && ledgerResp.items) || [];
    } catch (_e) {
      _ledger = [];
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

export async function startCheckout(orderType, code, paymentMethod) {
  var body = {
    orderType: orderType,
    paymentMethod: paymentMethod || _paymentMethod || 'wxpay',
  };
  if (orderType === 'subscription') body.planCode = code;
  else body.topupPackCode = code;
  var order = await apiPost('/api/billing/checkout', body);
  _pendingOrderNo = (order && order.order_no) || '';
  renderBillingPage();
  submitCheckoutForm(order);
  return order;
}

export async function pollOrder(orderNo) {
  return await apiGet('/api/billing/orders/' + encodeURIComponent(orderNo));
}

export function submitCheckoutForm(order) {
  var providerPayload = (order && order.providerPayload) || {};
  var checkoutUrl = providerPayload.checkoutUrl || providerPayload.url || providerPayload.url_qrcode || providerPayload.pay_url || providerPayload.payment_url || providerPayload.cashier_url || providerPayload.code_url || providerPayload.qrcode || providerPayload.qr_url || '';
  if (checkoutUrl) {
    window.location.href = String(checkoutUrl);
    return;
  }
  var gatewayUrl = (order && order.gateway_url) || '';
  var fields = (order && order.formFields) || {};
  if (!gatewayUrl || !fields || typeof fields !== 'object') {
    throw new Error('支付表单数据不完整');
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
  function _formatPlanPrice(p) {
    var cents = Number(p.price_cents || 0);
    var cycle = (p.billing_cycle || 'month');
    // 免费档 / 企业自定义合约：不显示具体价格
    if (cents <= 0 && cycle !== 'month') return { price: '联系销售', cycle: '' };
    if (cents <= 0) return { price: '免费', cycle: '' };
    var dollars = cents / 100;
    var priceStr = '$' + (dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2));
    var cycleLabel = cycle === 'year' ? '/yr' : '/mo';
    return { price: priceStr, cycle: cycleLabel };
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
    // 3) 单段长度
    if (limits.maxVideoSeconds != null) {
      items.push({
        icon: 'timer',
        label: '单段 ' + Number(limits.maxVideoSeconds) + 's',
        sub: limits.maxCompositeSeconds ? '合成上限 ' + Number(limits.maxCompositeSeconds) + 's' : '',
      });
    }
    // 4) 档位差异化特性（只取一条最能代表该档的）
    var hi = null;
    if (features.premiumUnlimited)      hi = { icon: 'all_inclusive',       label: 'Premium 无限配额',   sub: '高级模型不限次数' };
    else if (features.premiumCredits)   hi = { icon: 'stars',               label: Number(features.premiumCredits).toLocaleString() + ' Premium 积分', sub: '额外高级模型配额' };
    else if (features.customBranding)   hi = { icon: 'workspace_premium',   label: '自定义品牌水印',     sub: '品牌化交付' };
    else if (features.api)              hi = { icon: 'api',                 label: '全功能 API 访问',    sub: '集成工作流' };
    else if (features.customDeal)       hi = { icon: 'support_agent',       label: '定制企业合约',       sub: '联系销售定制' };
    else if (features.commercial)       hi = { icon: 'verified_user',       label: '商用授权',           sub: '可用于商业交付' };
    else if (features.watermark)        hi = { icon: 'branding_watermark',  label: '含官方水印',         sub: '免费档默认' };
    if (hi) items.push(hi);
    // 最多只渲染 4 条，避免卡片高度参差
    return items.slice(0, 4);
  }
  var trialPack = null;
  var regularTopups = [];
  topups.forEach(function (p) {
    if ((p.kind || '') === 'trial' || p.code === 'pack_trial') trialPack = p;
    else regularTopups.push(p);
  });

  var planCards = plans.filter(function (p) { return p.code !== 'free'; }).map(function (p) {
    var isCurrent = (subscription.plan_code || subscription.planCode || '') === p.code;
    var priceObj = _formatPlanPrice(p);
    var isCustom = priceObj.price === '联系销售';
    var featureItems = _derivePlanFeatureItems(p);
    var subLabel = (p.billing_cycle === 'year' ? '年付套餐' : '月付套餐') + (p.features && p.features.topupAllowed ? ' · 可加购' : '');
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
    var ctaLabel = isCurrent ? '当前套餐' : (isCustom ? '联系销售' : '升级此套餐');
    var ctaAttrs = 'class="billing-card-plan plan-cta" data-plan-code="' + escapeHtml(p.code) + '"' + (isCurrent || isCustom ? ' disabled' : '');
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
            '<span class="text-5xl font-bold plan-price-glow tracking-tighter">' + escapeHtml(priceObj.price) + '</span>' +
            (priceObj.cycle ? '<span class="text-[11px] font-bold text-[#ECEFF1]/30 uppercase">' + escapeHtml(priceObj.cycle) + '</span>' : '') +
          '</div>' +
          (creditsChip ? '<div class="mt-2">' + creditsChip + '</div>' : '') +
        '</div>' +
        '<ul class="space-y-4 flex-grow">' + featureHtml + '</ul>' +
        '<button type="button" ' + ctaAttrs + '>' + escapeHtml(ctaLabel) + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
  // 加购积分档位卡：延续 .plan-current-card 的视觉语言（深底 + halftone），
  // 每张档位卡用 .plan-topup-card 深底薄亮边 + cyan hover，积分数字走 cyan
  // 高亮。data-topup-code 保留不变，下面 host.querySelectorAll 仍能绑 click。
  var topupCards = regularTopups.map(function (p) {
    var priceStr = '$' + ((p.price_cents || 0) / 100).toFixed(2);
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
            '<span class="text-5xl font-bold plan-price-glow tracking-tighter">$3.5</span>' +
            '<span class="text-[11px] font-bold text-[#ECEFF1]/30 uppercase">一次性</span>' +
          '</div>' +
          '<div class="mt-2"><div class="plan-credits-chip">510 积分</div></div>' +
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
  var ledgerRows = (_ledger || []).map(function (item) {
    var when = item.created_at || item.createdAt || '';
    var amount = Number(item.amount || 0);
    var amountText = (amount > 0 ? '+' : '') + amount;
    return '<div class="flex items-center justify-between gap-4 py-3 border-b border-outline-variant/10">' +
      '<div class="min-w-0">' +
        '<div class="text-sm font-medium text-on-surface">' + escapeHtml(item.reason_code || item.entry_type || 'ledger') + '</div>' +
        '<div class="text-[11px] text-on-surface-variant/60 mt-1">' + escapeHtml(when) + '</div>' +
      '</div>' +
      '<div class="text-sm font-bold ' + (amount >= 0 ? 'text-emerald-600' : 'text-rose-500') + '">' + escapeHtml(amountText) + '</div>' +
    '</div>';
  }).join('') || '<p class="text-sm text-on-surface-variant/50">暂无账务流水。</p>';
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
              '<span class="text-3xl font-bold plan-price-glow tracking-tighter font-headline uppercase">' + escapeHtml(plan) + '</span>' +
              '<span class="text-[10px] font-bold text-[#ECEFF1]/40 uppercase tracking-widest">' + escapeHtml(statusText) + (periodEnd ? ' · 到期 ' + escapeHtml(periodEnd) : '') + '</span>' +
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
        '<div class="flex items-center justify-end gap-2 mt-3 flex-wrap">' +
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
    '<section class="bg-surface-container-lowest rounded-2xl p-6 border border-outline-variant/10 shadow-sm">' +
      '<div class="text-sm font-bold mb-4">最近账务流水</div>' +
      '<div>' + ledgerRows + '</div>' +
    '</section>';
  Array.prototype.slice.call(host.querySelectorAll('.billing-pay-method')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      _paymentMethod = btn.getAttribute('data-pay-method') || 'wxpay';
      renderBillingPage();
    });
  });
  var resumeBtn = host.querySelector('#btnResumeSubscription');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', async function () {
      try {
        await resumeSubscription();
      } catch (e) {
        showToast(e && e.message ? e.message : '恢复失败', 'error');
      }
    });
  }
  var cancelBtn = host.querySelector('#btnCancelSubscription');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async function () {
      try {
        await cancelSubscription();
      } catch (e) {
        showToast(e && e.message ? e.message : '取消失败', 'error');
      }
    });
  }
  Array.prototype.slice.call(host.querySelectorAll('[data-plan-code]')).forEach(function (btn) {
    btn.addEventListener('click', async function () {
      try {
        await startCheckout('subscription', btn.getAttribute('data-plan-code'), _paymentMethod);
      } catch (e) {
        showToast(e && e.message ? e.message : '发起支付失败', 'error');
      }
    });
  });
  Array.prototype.slice.call(host.querySelectorAll('[data-topup-code]')).forEach(function (btn) {
    btn.addEventListener('click', async function () {
      try {
        await startCheckout('topup', btn.getAttribute('data-topup-code'), _paymentMethod);
      } catch (e) {
        showToast(e && e.message ? e.message : '发起支付失败', 'error');
      }
    });
  });
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
