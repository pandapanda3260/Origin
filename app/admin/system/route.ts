import { NextRequest } from 'next/server';
import { adminIcon, renderAdminPage } from '@/lib/admin-shell';
import {
  DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT,
  DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT,
  MAX_GLOBAL_CONCURRENCY_LIMIT,
  MIN_GLOBAL_CONCURRENCY_LIMIT,
} from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 系统与安全 = 低频维护操作集中地：配置开关 / Key 池只读 / 存储管理 / Admin 账号 / 系统日志。
// 原四个独立导航页 + 首页日志面板合并于此，各 tab 懒加载，轮询只刷新当前 tab。
export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/system',
    title: '系统与安全',
    headHtml: `<style>
      main { max-width:1760px; }
      .sys-pane[data-active="false"] { display:none; }
      /* 配置开关 */
      .config-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
      .config-field { border:1px solid var(--line); border-radius:8px; background:#fff; padding:14px; }
      .config-field label { display:flex; justify-content:space-between; gap:12px; align-items:center; }
      .config-field input[type="text"], .config-field input[type="number"] { width:100%; margin-top:10px; }
      .config-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
      .config-field .muted { margin:8px 0 0; }
      /* Key 池 */
      table.key-pool-table { min-width:1220px; table-layout:fixed; }
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
      /* 存储 */
      .storage-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:14px; }
      .metric { border:1px solid var(--line); border-radius:8px; background:#fff; padding:14px; }
      .metric strong { display:block; font-size:var(--admin-font-xl); margin-top:6px; }
      table.storage-table { min-width:920px; }
      .storage-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
      /* Admin 账号 */
      .staff-layout { display:grid; grid-template-columns:minmax(0, 1.4fr) minmax(320px, .8fr); gap:16px; align-items:start; }
      .form-grid { display:grid; gap:10px; }
      .form-row { display:grid; gap:5px; }
      table.staff-table { min-width:780px; }
      .staff-table th, .staff-table td { vertical-align:middle; }
      .actions { display:flex; gap:6px; flex-wrap:wrap; }
      .audit-list { display:grid; gap:8px; max-height:360px; overflow:auto; }
      .audit-item { border:1px solid var(--admin-border-soft); border-radius:8px; padding:10px; background:#fff; }
      .audit-item strong { display:block; margin-bottom:4px; }
      /* 日志 */
      .log-actions { display:flex; align-items:center; gap:10px; }
      .log-tool { height:34px; display:inline-flex; align-items:center; gap:7px; padding:0 12px; border-radius:10px; color:var(--admin-text); background:#fff; font-size:var(--admin-font-sm); font-weight:700; }
      .log-tool .admin-icon { width:14px; height:14px; }
      .log-tool:not(.active) .status-dot { background:var(--admin-border); box-shadow:none; }
      .log-console { min-height:300px; max-height:520px; margin:0; background:var(--admin-log-bg); color:var(--admin-log-text); padding:22px 24px; border-radius:12px; font-family:"SFMono-Regular", Consolas, Menlo, monospace; font-size:var(--admin-font-sm); line-height:1.7; }
      @media (max-width: 1000px) { .config-grid, .key-sync, .storage-grid { grid-template-columns:1fr; } .staff-layout { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `
    <div class="adm-tabs" role="tablist">
      <button class="adm-tab" data-sys-tab="config" data-active="true">${adminIcon('settings')}配置开关</button>
      <button class="adm-tab" data-sys-tab="keypool" data-active="false">${adminIcon('key')}Key 池</button>
      <button class="adm-tab" data-sys-tab="storage" data-active="false">${adminIcon('storage')}存储</button>
      <button class="adm-tab" data-sys-tab="staff" data-active="false">${adminIcon('staff')}Admin 账号</button>
      <button class="adm-tab" data-sys-tab="logs" data-active="false">${adminIcon('file')}系统日志</button>
    </div>

    <!-- 配置开关 -->
    <div class="sys-pane" data-sys-pane="config" data-active="true">
      <section class="panel">
        <div class="config-grid">
          <div class="config-field"><label>维护横幅 <input data-config-banner-enabled="true" type="checkbox" /></label><input data-config-banner-message="true" type="text" placeholder="横幅文案" /></div>
          <div class="config-field"><label>注册开关 <input data-config-registration="true" type="checkbox" /></label><p class="muted">关闭后注册验证接口返回 503。</p></div>
          <div class="config-field"><label>视频生成开关 <input data-config-video="true" type="checkbox" /></label><p class="muted">关闭后 video submit / video-gen 入口返回 503。</p></div>
          <div class="config-field"><label>导出开关 <input data-config-export="true" type="checkbox" /></label><p class="muted">关闭后导出入口返回 503。</p></div>
          <div class="config-field">
            <label>视频生成并发上限（进程级）</label>
            <p class="muted">所有用户共享；控制视频 batch 与 video submit。内测默认 ${DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT}，不是单用户额度。</p>
            <input data-config-video-limit="true" type="number" min="${MIN_GLOBAL_CONCURRENCY_LIMIT}" max="${MAX_GLOBAL_CONCURRENCY_LIMIT}" />
          </div>
          <div class="config-field">
            <label>图片生成并发上限（进程级）</label>
            <p class="muted">所有用户共享；控制图片 batch 与 image submit。内测默认 ${DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT}，不是单用户额度。</p>
            <input data-config-image-limit="true" type="number" min="${MIN_GLOBAL_CONCURRENCY_LIMIT}" max="${MAX_GLOBAL_CONCURRENCY_LIMIT}" />
          </div>
        </div>
        <div class="config-actions">
          <button data-config-save="true" class="adm-btn adm-btn-primary">保存配置</button>
          <button data-config-refresh="true" class="adm-btn">刷新</button>
        </div>
        <div class="notice" data-config-notice="true"></div>
      </section>
    </div>

    <!-- Key 池 -->
    <div class="sys-pane" data-sys-pane="keypool" data-active="false">
      <section class="panel">
        <p class="muted">后台只读展示 model/key/baseUrl 路由状态；模型路由按外部 env 文件热读，非模型 env 仍以进程缓存为准。</p>
        <div class="key-sync" data-key-pool-sync="true"></div>
        <div class="admin-table-wrap section-gap">
          <table class="admin-table key-pool-table">
            <colgroup>
              <col class="key-col-slot" /><col class="key-col-mode" /><col class="key-col-provider" /><col class="key-col-model" /><col class="key-col-fallback" /><col class="key-col-metrics" /><col class="key-col-base" /><col class="key-col-endpoint" /><col class="key-col-source" />
            </colgroup>
            <thead><tr><th>Slot</th><th>模式</th><th>Provider</th><th>Model</th><th>Fallback</th><th>近 10 分钟</th><th>Base URL</th><th>Endpoint</th><th>来源</th></tr></thead>
            <tbody data-key-pool-table="true"><tr><td colspan="9"><div class="adm-empty">加载中...</div></td></tr></tbody>
          </table>
        </div>
        <div class="notice" data-key-pool-notice="true"></div>
      </section>
    </div>

    <!-- 存储 -->
    <div class="sys-pane" data-sys-pane="storage" data-active="false">
      <section class="panel">
        <div class="adm-toolbar">
          <label class="adm-field"><span>孤儿文件最小年龄（小时）</span><input data-storage-age="true" type="number" value="24" min="0" max="720" /></label>
          <div class="adm-actions">
            <button data-storage-refresh="true" class="adm-btn adm-btn-primary">扫描</button>
            <button data-storage-quarantine="true" class="adm-btn adm-btn-danger">隔离孤儿文件</button>
            <button data-storage-cleanup="true" class="adm-btn adm-btn-danger">清理 7 天前 quarantine</button>
          </div>
        </div>
        <p class="muted">注意：孤儿扫描单次最多展示/处理 500 条，超出需多轮执行。</p>
        <div class="storage-grid" data-storage-metrics="true"></div>
        <div class="admin-table-wrap">
          <table class="admin-table storage-table">
            <thead><tr><th>Bucket</th><th>Owner</th><th>文件</th><th>大小</th><th>原因</th><th>mtime</th></tr></thead>
            <tbody data-storage-table="true"><tr><td colspan="6"><div class="adm-empty">点击"扫描"开始</div></td></tr></tbody>
          </table>
        </div>
        <div class="notice" data-storage-notice="true"></div>
      </section>
    </div>

    <!-- Admin 账号 -->
    <div class="sys-pane" data-sys-pane="staff" data-active="false">
      <div class="staff-layout">
        <section class="panel">
          <h2>Admin 列表</h2>
          <div class="admin-table-wrap">
            <table class="admin-table staff-table">
              <thead>
                <tr><th>ID</th><th>账号</th><th>状态</th><th>Shadow User</th><th>上次登录</th><th>Token Revoked</th><th>创建时间</th><th>操作</th></tr>
              </thead>
              <tbody data-staff-table="true"><tr><td colspan="8"><div class="adm-empty">加载中...</div></td></tr></tbody>
            </table>
          </div>
          <div class="notice" data-staff-notice="true"></div>
        </section>
        <div>
          <section class="panel">
            <h2>创建 Admin</h2>
            <div class="form-grid">
              <div class="form-row"><label>账号</label><input data-create-username="true" placeholder="letters_numbers.-" /></div>
              <div class="form-row"><label>初始密码</label><input data-create-password="true" type="password" placeholder="至少 12 位，至少两类字符" /></div>
              <button class="adm-btn adm-btn-primary" data-create-admin="true">创建</button>
            </div>
          </section>
          <section class="panel">
            <h2>自我改密</h2>
            <div class="form-grid">
              <div class="form-row"><label>旧密码</label><input data-self-old-password="true" type="password" /></div>
              <div class="form-row"><label>新密码</label><input data-self-new-password="true" type="password" placeholder="至少 12 位，至少两类字符" /></div>
              <button class="adm-btn" data-self-password="true">修改自己的密码</button>
            </div>
            <p class="muted">修改成功后当前后台登录态会失效，需要重新登录。</p>
          </section>
        </div>
      </div>
      <section class="panel section-gap">
        <h2>Admin 操作日志</h2>
        <div class="audit-list" data-staff-audit="true"><div class="muted">加载中...</div></div>
      </section>
    </div>

    <!-- 系统日志 -->
    <div class="sys-pane" data-sys-pane="logs" data-active="false">
      <section class="panel">
        <div class="adm-section-head">
          <h2>系统日志（warning 及以上，最近 120 行）</h2>
          <div class="log-actions">
            <button type="button" id="autoScrollLogs" class="log-tool active" aria-pressed="true"><span class="status-dot"></span>自动滚动</button>
            <button type="button" id="clearLogs" class="log-tool">${adminIcon('trash')}清空</button>
          </div>
        </div>
        <pre id="logs" class="log-console">加载中...</pre>
      </section>
    </div>`,
    scriptsHtml: `<script>
      const esc = adminUi.esc;
      const fmtDate = adminUi.fmtDate;
      const sysState = { tab:'config', loaded:{} };

      // ===== tab 切换 + 懒加载 =====
      const paneLoaders = {
        config: () => cfgLoad(),
        keypool: () => kpLoad(),
        storage: () => stLoad(),
        staff: () => stfLoad(),
        logs: () => logLoad(),
      };
      document.querySelectorAll('[data-sys-tab]').forEach((btn) => btn.addEventListener('click', () => {
        sysState.tab = btn.dataset.sysTab;
        document.querySelectorAll('[data-sys-tab]').forEach((b) => b.dataset.active = b.dataset.sysTab === sysState.tab ? 'true' : 'false');
        document.querySelectorAll('[data-sys-pane]').forEach((p) => p.dataset.active = p.dataset.sysPane === sysState.tab ? 'true' : 'false');
        if (!sysState.loaded[sysState.tab]) { sysState.loaded[sysState.tab] = true; paneLoaders[sysState.tab]?.(); }
      }));

      function dryRunThenCommitFactory(noticeEl) {
        return async function dryRunThenCommit(url, method, body, reason, confirmText) {
          const headers = { 'content-type':'application/json', 'x-idempotency-key': adminUi.idemKey() };
          if (reason) headers['x-admin-reason'] = reason;
          const dry = await fetch(url, { method, credentials:'same-origin', headers, body: JSON.stringify({ ...body, reason, dryRun:true }) });
          const dryData = await dry.json().catch(() => null);
          if (!dry.ok || !dryData?.dryRun) throw new Error((dryData && dryData.detail) || '预检查失败');
          if (!window.confirm(confirmText)) return null;
          const commit = await fetch(url, { method, credentials:'same-origin', headers, body: JSON.stringify({ ...body, reason }) });
          const commitData = await commit.json().catch(() => null);
          if (!commit.ok) throw new Error((commitData && commitData.detail) || '提交失败');
          return commitData;
        };
      }

      // ===== 配置开关 =====
      const cfgNotice = document.querySelector('[data-config-notice="true"]');
      function cfgReadForm() {
        return {
          maintenance_banner: {
            enabled: document.querySelector('[data-config-banner-enabled="true"]').checked,
            message: document.querySelector('[data-config-banner-message="true"]').value,
            startsAt: null,
            endsAt: null
          },
          registration_enabled: document.querySelector('[data-config-registration="true"]').checked,
          video_generation_enabled: document.querySelector('[data-config-video="true"]').checked,
          export_enabled: document.querySelector('[data-config-export="true"]').checked,
          global_video_concurrency_limit: Number(document.querySelector('[data-config-video-limit="true"]').value || ${DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT}),
          global_image_concurrency_limit: Number(document.querySelector('[data-config-image-limit="true"]').value || ${DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT})
        };
      }
      function cfgFill(data) {
        document.querySelector('[data-config-banner-enabled="true"]').checked = !!data.maintenance_banner?.enabled;
        document.querySelector('[data-config-banner-message="true"]').value = data.maintenance_banner?.message || '';
        document.querySelector('[data-config-registration="true"]').checked = !!data.registration_enabled;
        document.querySelector('[data-config-video="true"]').checked = !!data.video_generation_enabled;
        document.querySelector('[data-config-export="true"]').checked = !!data.export_enabled;
        document.querySelector('[data-config-video-limit="true"]').value = data.global_video_concurrency_limit || ${DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT};
        document.querySelector('[data-config-image-limit="true"]').value = data.global_image_concurrency_limit || ${DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT};
      }
      async function cfgLoad() {
        adminUi.setNotice(cfgNotice, '加载中...');
        const res = await fetch('/api/admin/config', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { adminUi.setNotice(cfgNotice, (data && data.detail) || '加载失败', 'error'); return; }
        cfgFill(data); adminUi.setNotice(cfgNotice, '已更新', 'ok');
      }
      async function cfgSave() {
        const reason = window.prompt('修改系统配置的原因');
        if (!reason || !reason.trim()) return;
        const headers = { 'content-type':'application/json', 'x-idempotency-key': adminUi.idemKey(), 'x-admin-reason': reason.trim() };
        const config = cfgReadForm();
        adminUi.setNotice(cfgNotice, '正在预检查...');
        const dry = await fetch('/api/admin/config', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify({ config, reason: reason.trim(), dryRun:true }) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) { adminUi.setNotice(cfgNotice, (dryData && dryData.detail) || '预检查失败', 'error'); return; }
        if (!window.confirm('确认保存系统配置？')) { adminUi.setNotice(cfgNotice, '已取消'); return; }
        const commit = await fetch('/api/admin/config', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify({ config, reason: reason.trim() }) });
        const data = await commit.json().catch(() => null);
        if (!commit.ok) { adminUi.setNotice(cfgNotice, (data && data.detail) || '提交失败', 'error'); return; }
        cfgFill(data); adminUi.setNotice(cfgNotice, '保存完成', 'ok');
      }
      document.querySelector('[data-config-save="true"]')?.addEventListener('click', cfgSave);
      document.querySelector('[data-config-refresh="true"]')?.addEventListener('click', cfgLoad);

      // ===== Key 池 =====
      const kpTable = document.querySelector('[data-key-pool-table="true"]');
      const kpNotice = document.querySelector('[data-key-pool-notice="true"]');
      const kpSync = document.querySelector('[data-key-pool-sync="true"]');
      function kpShortPath(path) {
        return String(path || '').replace(/^.*\\/([^/]+)$/, '$1') || '-';
      }
      function kpRenderSync(envSync) {
        if (!kpSync) return;
        const files = envSync?.externalFiles || [];
        const fileText = files.map((f) => kpShortPath(f.path) + (f.exists ? ' · ' + (f.keys?.length || 0) + ' keys' : ' · missing')).join('；') || '-';
        const processWarn = envSync?.fileNewerThanProcessEnv;
        kpSync.innerHTML = [
          '<div class="key-sync-item"><strong>模型路由</strong><span class="muted">' + (envSync?.modelRoutingReadsExternalEnvLive ? '实时读取外部 env 文件' : '读取进程 env') + '</span></div>',
          '<div class="key-sync-item"><strong>env 文件</strong><span class="muted">' + esc(fileText) + '<br>最后修改 ' + esc(fmtDate(envSync?.fileMaxModifiedAt)) + '</span></div>',
          '<div class="key-sync-item ' + (processWarn ? 'warn' : '') + '"><strong>进程 env</strong><span class="muted">启动 ' + esc(fmtDate(envSync?.processStartedAt)) + '<br>缓存加载 ' + esc(fmtDate(envSync?.runtimeLoadedAt)) + (processWarn ? '；非模型配置需重启' : '') + '</span></div>'
        ].join('');
      }
      async function kpLoad() {
        const res = await fetch('/api/admin/key-pool/status', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { kpNotice.textContent = (data && data.detail) || '加载失败'; return; }
        kpRenderSync(data.envSync || {});
        const pools = data.pools || [];
        kpTable.innerHTML = pools.map((p) => {
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
          kpNotice.textContent = '告警：近 ' + (data.metricsWindow || 10) + ' 分钟出现模型 fallback：' + summary + recentText;
        } else {
          kpNotice.textContent = '已更新：' + new Date(data.updatedAt || Date.now()).toLocaleString('zh-CN', { hour12:false });
        }
      }

      // ===== 存储 =====
      const stState = { data:null };
      const stAge = document.querySelector('[data-storage-age="true"]');
      const stMetrics = document.querySelector('[data-storage-metrics="true"]');
      const stTable = document.querySelector('[data-storage-table="true"]');
      const stNotice = document.querySelector('[data-storage-notice="true"]');
      function stMb(bytes) { return (Number(bytes || 0)/1024/1024).toFixed(2) + ' MB'; }
      function stRender() {
        const data = stState.data || {};
        const totalBytes = (data.usage || []).reduce((sum, row) => sum + Number(row.bytes || 0), 0);
        const totalFiles = (data.usage || []).reduce((sum, row) => sum + Number(row.files || 0), 0);
        stMetrics.innerHTML =
          '<div class="metric"><span class="muted">总占用</span><strong>' + stMb(totalBytes) + '</strong></div>' +
          '<div class="metric"><span class="muted">文件数</span><strong>' + totalFiles + '</strong></div>' +
          '<div class="metric"><span class="muted">候选孤儿</span><strong>' + (data.orphanFiles || []).length + '</strong></div>';
        const files = data.orphanFiles || [];
        stTable.innerHTML = files.length ? files.map((f) => '<tr><td>' + esc(f.bucket) + '</td><td>' + esc(f.ownerId) + '</td><td>' + esc(f.filename) + '<div class="muted">' + esc(f.path) + '</div></td><td>' + stMb(f.bytes) + '</td><td>' + esc(f.reason) + '</td><td>' + esc(f.mtime) + '</td></tr>').join('') : adminUi.emptyRow(6, '暂无可隔离孤儿文件');
      }
      async function stLoad() {
        adminUi.setNotice(stNotice, '扫描中...');
        const res = await fetch('/api/admin/storage?minAgeHours=' + encodeURIComponent(stAge.value || '24'), { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { adminUi.setNotice(stNotice, (data && data.detail) || '扫描失败', 'error'); return; }
        stState.data = data; stRender(); adminUi.setNotice(stNotice, '已扫描：' + data.generatedAt, 'ok');
      }
      async function stMutate(action) {
        const reason = window.prompt(action === 'quarantine_orphans' ? '隔离孤儿文件原因' : '清理 quarantine 原因');
        if (!reason || !reason.trim()) return;
        const headers = { 'content-type':'application/json', 'x-idempotency-key': adminUi.idemKey(), 'x-admin-reason': reason.trim() };
        const body = { action, minAgeHours: Number(stAge.value || 24), reason: reason.trim(), dryRun:true };
        adminUi.setNotice(stNotice, '正在预检查...');
        const dry = await fetch('/api/admin/storage', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(body) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) { adminUi.setNotice(stNotice, (dryData && dryData.detail) || '预检查失败', 'error'); return; }
        if (!window.confirm('确认执行 ' + action + '？')) { adminUi.setNotice(stNotice, '已取消'); return; }
        const commitBody = { action, minAgeHours: Number(stAge.value || 24), reason: reason.trim() };
        if (action === 'quarantine_orphans') commitBody.candidateHash = dryData.candidateHash;
        const commit = await fetch('/api/admin/storage', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify(commitBody) });
        const data = await commit.json().catch(() => null);
        if (!commit.ok) { adminUi.setNotice(stNotice, (data && data.detail) || '提交失败', 'error'); return; }
        adminUi.setNotice(stNotice, '操作完成', 'ok'); await stLoad();
      }
      document.querySelector('[data-storage-refresh="true"]')?.addEventListener('click', stLoad);
      document.querySelector('[data-storage-quarantine="true"]')?.addEventListener('click', () => stMutate('quarantine_orphans'));
      document.querySelector('[data-storage-cleanup="true"]')?.addEventListener('click', () => stMutate('cleanup_quarantine'));

      // ===== Admin 账号 =====
      const stfState = { items: [], recentActions: [], currentAdminId: null };
      const stfTable = document.querySelector('[data-staff-table="true"]');
      const stfAudit = document.querySelector('[data-staff-audit="true"]');
      const stfNotice = document.querySelector('[data-staff-notice="true"]');
      const stfDryRunThenCommit = dryRunThenCommitFactory(stfNotice);
      async function stfLoadMe() {
        const res = await fetch('/api/admin/auth/me', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.admin) stfState.currentAdminId = data.admin.id;
      }
      function stfRender() {
        const items = stfState.items || [];
        if (!items.length) {
          stfTable.innerHTML = adminUi.emptyRow(8, '暂无 admin');
          return;
        }
        stfTable.innerHTML = items.map((admin) => {
          const disabled = !!admin.disabledAt;
          const isSelf = Number(admin.id) === Number(stfState.currentAdminId);
          const status = disabled ? '<span class="badge danger">已禁用</span>' : '<span class="badge ok">正常</span>';
          const disableButton = disabled || isSelf
            ? '<button disabled>禁用</button>'
            : '<button class="danger" data-action="disable" data-admin-id="' + admin.id + '">禁用</button>';
          const resetButton = isSelf
            ? '<button disabled>重置密码</button>'
            : '<button data-action="reset_password" data-admin-id="' + admin.id + '">重置密码</button>';
          return '<tr>' +
            '<td>' + admin.id + '</td>' +
            '<td><strong>' + esc(admin.username) + '</strong>' + (isSelf ? '<div class="muted">当前账号</div>' : '') + '</td>' +
            '<td>' + status + '</td>' +
            '<td>' + esc(admin.previewUserId || '-') + '</td>' +
            '<td>' + esc(fmtDate(admin.lastLoginAt)) + '</td>' +
            '<td>' + esc(fmtDate(admin.tokenRevokedAt)) + '</td>' +
            '<td>' + esc(fmtDate(admin.createdAt)) + '</td>' +
            '<td><div class="actions">' +
              '<button data-action="revoke_tokens" data-admin-id="' + admin.id + '">互踢</button>' +
              resetButton + disableButton +
            '</div></td>' +
          '</tr>';
        }).join('');
      }
      function stfRenderAudit() {
        const rows = stfState.recentActions || [];
        if (!rows.length) {
          stfAudit.innerHTML = '<div class="muted">暂无 admin 操作日志</div>';
          return;
        }
        stfAudit.innerHTML = rows.map((row) => (
          '<div class="audit-item">' +
            '<strong>' + esc(row.action) + ' <span class="badge">' + esc(row.status) + '</span></strong>' +
            '<div class="muted">' + esc(row.adminUsername || 'unknown') + ' · ' + esc(fmtDate(row.createdAt)) + '</div>' +
            '<div class="muted">target: ' + esc(row.targetType || '-') + ' / ' + esc(row.targetId || '-') + '</div>' +
            (row.reason ? '<div>' + esc(row.reason) + '</div>' : '') +
          '</div>'
        )).join('');
      }
      async function stfLoad() {
        adminUi.setNotice(stfNotice, '加载中...');
        await stfLoadMe();
        const res = await fetch('/api/admin/staff', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          adminUi.setNotice(stfNotice, (data && data.detail) || '加载失败', 'error');
          return;
        }
        stfState.items = data.items || [];
        stfState.recentActions = data.recentActions || [];
        stfRender();
        stfRenderAudit();
        adminUi.setNotice(stfNotice, '已更新', 'ok');
      }
      document.querySelector('[data-create-admin="true"]')?.addEventListener('click', async () => {
        const username = document.querySelector('[data-create-username="true"]').value.trim();
        const password = document.querySelector('[data-create-password="true"]').value;
        const reason = window.prompt('创建 admin 的原因');
        if (!username || !password || !reason) return;
        try {
          adminUi.setNotice(stfNotice, '正在创建...');
          await stfDryRunThenCommit('/api/admin/staff', 'POST', { username, password }, reason.trim(), '确认创建 admin ' + username + '？');
          document.querySelector('[data-create-password="true"]').value = '';
          adminUi.setNotice(stfNotice, '创建完成', 'ok');
          await stfLoad();
        } catch (error) { adminUi.setNotice(stfNotice, error.message || String(error), 'error'); }
      });
      stfTable?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const adminId = Number(button.dataset.adminId);
        const admin = stfState.items.find((item) => Number(item.id) === adminId);
        const reason = window.prompt(action + ' admin ' + (admin?.username || adminId) + ' 的原因');
        if (!reason) return;
        const body = { action, adminId };
        if (action === 'reset_password') {
          const next = window.prompt('输入新密码');
          if (!next) return;
          body.newPassword = next;
        }
        try {
          adminUi.setNotice(stfNotice, '正在提交...');
          await stfDryRunThenCommit('/api/admin/staff', 'PATCH', body, reason.trim(), '确认执行 ' + action + '：' + (admin?.username || adminId) + '？');
          adminUi.setNotice(stfNotice, '操作完成', 'ok');
          await stfLoad();
        } catch (error) { adminUi.setNotice(stfNotice, error.message || String(error), 'error'); }
      });
      document.querySelector('[data-self-password="true"]')?.addEventListener('click', async () => {
        const oldPassword = document.querySelector('[data-self-old-password="true"]').value;
        const newPassword = document.querySelector('[data-self-new-password="true"]').value;
        if (!oldPassword || !newPassword) {
          adminUi.setNotice(stfNotice, '请填写旧密码和新密码', 'error');
          return;
        }
        try {
          adminUi.setNotice(stfNotice, '正在修改密码...');
          await stfDryRunThenCommit('/api/admin/staff/self-password', 'POST', { oldPassword, newPassword }, '', '确认修改自己的 admin 密码？修改后需要重新登录。');
          adminUi.setNotice(stfNotice, '密码已修改，请重新登录', 'ok');
          location.href = '/admin/login';
        } catch (error) { adminUi.setNotice(stfNotice, error.message || String(error), 'error'); }
      });

      // ===== 系统日志 =====
      let autoScrollLogs = true;
      async function logLoad() {
        const resp = await fetch('/api/admin/logs?level=warning&lines=120', { credentials:'same-origin' });
        const el = document.getElementById('logs');
        if (!resp.ok) { el.textContent = '日志加载失败'; return; }
        const data = await resp.json();
        el.textContent = (data.lines || []).join('\\n') || '暂无日志';
        if (autoScrollLogs) el.scrollTop = el.scrollHeight;
      }
      document.getElementById('autoScrollLogs')?.addEventListener('click', () => {
        autoScrollLogs = !autoScrollLogs;
        const btn = document.getElementById('autoScrollLogs');
        btn.classList.toggle('active', autoScrollLogs);
        btn.setAttribute('aria-pressed', String(autoScrollLogs));
        if (autoScrollLogs) {
          const el = document.getElementById('logs');
          el.scrollTop = el.scrollHeight;
        }
      });
      document.getElementById('clearLogs')?.addEventListener('click', () => {
        document.getElementById('logs').textContent = '';
      });

      // 首次加载当前 tab；轮询只刷新当前 tab。
      sysState.loaded[sysState.tab] = true;
      window.adminStartPolling?.(async () => { await paneLoaders[sysState.tab]?.(); });
    </script>`,
  });
}
