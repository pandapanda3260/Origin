import { NextRequest } from 'next/server';
import { renderAdminPage } from '@/lib/admin-shell';
import {
  DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT,
  DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT,
  MAX_GLOBAL_CONCURRENCY_LIMIT,
  MIN_GLOBAL_CONCURRENCY_LIMIT,
} from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return renderAdminPage(req, {
    activePath: '/admin/config',
    title: '系统配置',
    headHtml: `<style>
      .config-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
      .config-field { border:1px solid var(--line); border-radius:8px; background:#fff; padding:14px; }
      .config-field label { display:flex; justify-content:space-between; gap:12px; align-items:center; }
      .config-field input[type="text"], .config-field input[type="number"] { width:100%; margin-top:10px; }
      .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
      .config-field .muted { margin:8px 0 0; }
      @media (max-width: 900px) { .config-grid { grid-template-columns:1fr; } }
    </style>`,
    bodyHtml: `<section class="panel">
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
      <div class="actions">
        <button data-config-save="true" class="primary">保存配置</button>
        <button data-config-refresh="true">刷新</button>
      </div>
      <div class="notice" data-config-notice="true"></div>
    </section>`,
    scriptsHtml: `<script>
      const notice = document.querySelector('[data-config-notice="true"]');
      function setNotice(message, kind = '') { notice.textContent = message || ''; notice.dataset.kind = kind; }
      function readForm() {
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
      function fill(data) {
        document.querySelector('[data-config-banner-enabled="true"]').checked = !!data.maintenance_banner?.enabled;
        document.querySelector('[data-config-banner-message="true"]').value = data.maintenance_banner?.message || '';
        document.querySelector('[data-config-registration="true"]').checked = !!data.registration_enabled;
        document.querySelector('[data-config-video="true"]').checked = !!data.video_generation_enabled;
        document.querySelector('[data-config-export="true"]').checked = !!data.export_enabled;
        document.querySelector('[data-config-video-limit="true"]').value = data.global_video_concurrency_limit || ${DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT};
        document.querySelector('[data-config-image-limit="true"]').value = data.global_image_concurrency_limit || ${DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT};
      }
      async function load() {
        setNotice('加载中...');
        const res = await fetch('/api/admin/config', { credentials:'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setNotice((data && data.detail) || '加载失败', 'error'); return; }
        fill(data); setNotice('已更新', 'ok');
      }
      async function save() {
        const reason = window.prompt('修改系统配置的原因');
        if (!reason || !reason.trim()) return;
        const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
        const headers = { 'content-type':'application/json', 'x-idempotency-key': key, 'x-admin-reason': reason.trim() };
        const config = readForm();
        setNotice('正在预检查...');
        const dry = await fetch('/api/admin/config', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify({ config, reason: reason.trim(), dryRun:true }) });
        const dryData = await dry.json().catch(() => null);
        if (!dry.ok || !dryData?.dryRun) { setNotice((dryData && dryData.detail) || '预检查失败', 'error'); return; }
        if (!window.confirm('确认保存系统配置？')) { setNotice('已取消'); return; }
        const commit = await fetch('/api/admin/config', { method:'POST', credentials:'same-origin', headers, body: JSON.stringify({ config, reason: reason.trim() }) });
        const data = await commit.json().catch(() => null);
        if (!commit.ok) { setNotice((data && data.detail) || '提交失败', 'error'); return; }
        fill(data); setNotice('保存完成', 'ok');
      }
      document.querySelector('[data-config-save="true"]')?.addEventListener('click', save);
      document.querySelector('[data-config-refresh="true"]')?.addEventListener('click', load);
      window.adminStartPolling?.(load);
    </script>`,
  });
}
