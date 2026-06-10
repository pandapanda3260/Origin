/**
 * 门控诊断面板（Hit Diagnostic Panel）
 *
 * 作用：把后端在 SSE 流里推送的 `{type:'diagnostic', diagnostic: {...}}` 事件
 * 渲染成可折叠的侧边卡片，让崔泽直观看到每次生成到底激活/跳过了哪些词库子集.
 *
 * 用法（在任何调用 apiPostStream 的地方）：
 *   import { attachDiagnostic, renderDiagnosticPanel } from './diagnostic.js';
 *   const diagBox = document.getElementById('shots-diagnostic');
 *   const captor = attachDiagnostic(diagBox);
 *   await apiPostStream(url, body, onChunk, captor.onEvent);
 *
 * attachDiagnostic 返回 { onEvent, getLast } — onEvent 喂给 apiPostStream，
 * getLast 返回最近一次收到的 diagnostic 对象（没有则 null）.
 */

import { escapeHtml } from './utils.js?v=300';

const STAGE_LABEL = {
  shot_design: '分镜设计',
  video_prompt: '视频提示词',
  image_prompt: '图像提示词',
};

export function renderDiagnosticPanel(container, diag) {
  if (!container) return;
  if (!diag) {
    container.innerHTML = '<div class="diag-empty">暂无门控诊断数据——生成一次后这里会显示激活的词库子集</div>';
    return;
  }

  const stageLabel = STAGE_LABEL[diag.stage] || diag.stage || '未知阶段';
  const inputs = diag.inputs || {};
  const activated = Array.isArray(diag.activated) ? diag.activated : [];
  const skipped = Array.isArray(diag.skipped) ? diag.skipped : [];

  let inputsHtml = '';
  Object.keys(inputs).forEach(function (k) {
    const v = inputs[k];
    let disp = '';
    if (Array.isArray(v)) {
      disp = v.length ? v.map(escapeHtml).join('、') : '（空）';
    } else if (typeof v === 'boolean') {
      disp = v ? '是' : '否';
    } else {
      disp = escapeHtml(String(v == null ? '' : v));
    }
    inputsHtml += '<div class="diag-input-row"><span class="diag-input-key">' + escapeHtml(k) + '</span><span class="diag-input-val">' + disp + '</span></div>';
  });

  const actHtml = activated.length
    ? activated.map(function (a) {
        return (
          '<div class="diag-item diag-activated">' +
            '<div class="diag-item-head">✅ ' + escapeHtml(a.toolkit || '') + ' → ' + escapeHtml(a.subset || '') + '</div>' +
            '<div class="diag-item-reason">' + escapeHtml(a.reason || '') + '</div>' +
          '</div>'
        );
      }).join('')
    : '<div class="diag-empty">本次没有命中任何条件激活的子集</div>';

  const skipHtml = skipped.length
    ? skipped.map(function (a) {
        return (
          '<div class="diag-item diag-skipped">' +
            '<div class="diag-item-head">⭕ ' + escapeHtml(a.toolkit || '') + ' → ' + escapeHtml(a.subset || '') + '</div>' +
            '<div class="diag-item-reason">' + escapeHtml(a.reason || '') + '</div>' +
          '</div>'
        );
      }).join('')
    : '<div class="diag-empty">本次没有被跳过的子集</div>';

  container.innerHTML =
    '<details class="diag-block" open>' +
      '<summary class="diag-summary">门控诊断 · ' + escapeHtml(stageLabel) + ' <span class="diag-summary-count">激活 ' + activated.length + ' 条 / 跳过 ' + skipped.length + ' 条</span></summary>' +
      '<div class="diag-body">' +
        '<div class="diag-section"><div class="diag-section-title">输入</div>' + (inputsHtml || '<div class="diag-empty">无</div>') + '</div>' +
        '<div class="diag-section"><div class="diag-section-title">已激活</div>' + actHtml + '</div>' +
        '<div class="diag-section"><div class="diag-section-title">已跳过</div>' + skipHtml + '</div>' +
      '</div>' +
    '</details>';
}

export function attachDiagnostic(container) {
  let last = null;
  renderDiagnosticPanel(container, null);
  return {
    onEvent: function (evt) {
      if (evt && evt.type === 'diagnostic' && evt.diagnostic) {
        last = evt.diagnostic;
        try { renderDiagnosticPanel(container, last); } catch (_e) {}
      }
    },
    getLast: function () { return last; },
  };
}
