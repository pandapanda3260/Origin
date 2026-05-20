/**
 * VevDemo 服务配置 API
 * 返回 VevDemo 前端和后端的 URL，供前端 iframe 使用
 */

import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getExternalEnvValue, loadExternalEnv } from '@/lib/env';
import { VEVDEMO_LEGACY_ENV_KEYS, readVevDemoUrlConfig } from '@/lib/vevdemo-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type OnlineEditorConfigReason = 'disabled' | 'missing_config' | 'ok';
type OnlineEditorOpenMode = 'iframe' | 'tab';

function readConfigValue(key: string): string {
  return (getExternalEnvValue(key) || process.env[key] || '').trim();
}

function parseEnabled(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseOpenMode(value: string): OnlineEditorOpenMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'iframe' || normalized === 'tab') return normalized;
  return null;
}

/**
 * GET /api/volcengine/config
 * 返回 VevDemo 服务配置
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const envLoad = loadExternalEnv();
  const enabledRaw = readConfigValue('ONLINE_EDITOR_ENABLED');
  const openModeRaw = readConfigValue('ONLINE_EDITOR_OPEN_MODE');
  const vevDemoConfig = readVevDemoUrlConfig();
  const missingKeys: string[] = [];

  if (!enabledRaw) missingKeys.push('ONLINE_EDITOR_ENABLED');

  const enabled = enabledRaw ? parseEnabled(enabledRaw) : false;
  const openMode = parseOpenMode(openModeRaw);

  if (enabled) {
    if (!openModeRaw || !openMode) missingKeys.push('ONLINE_EDITOR_OPEN_MODE');
    missingKeys.push(...vevDemoConfig.missingKeys);
  }

  const reason: OnlineEditorConfigReason = !enabled && enabledRaw
    ? 'disabled'
    : missingKeys.length > 0
      ? 'missing_config'
      : 'ok';
  const configured = reason === 'ok';
  const iframeBaseUrl = vevDemoConfig.editorUrl || null;
  const iframeProjectUrl = configured ? vevDemoConfig.editorProjectUrl || null : null;
  const apiBase = vevDemoConfig.apiUrl || null;

  console.info(
    `[volcengine/config] enabled=${enabled} configured=${configured} reason=${reason} openMode=${openMode || '(missing)'} envLoaded=${envLoad.loaded} iframeUrl=${iframeProjectUrl || '(missing)'} apiBase=${apiBase || '(missing)'} legacyKeysUsed=${vevDemoConfig.legacyKeysUsed.join(',') || '(none)'}`
  );
  if (envLoad.error) {
    console.warn(`[volcengine/config] external env load warning: ${envLoad.error}`);
  }

  return jsonOk({
    enabled,
    configured,
    reason,
    missingKeys,
    openMode: openMode || null,
    iframeBaseUrl,
    iframeProjectUrl,
    iframeUrl: iframeProjectUrl,
    apiBase,
    message: configured ? undefined : (
      reason === 'disabled'
        ? '在线精修剪辑器未启用'
        : `VevDemo 服务未配置，请设置 ${missingKeys.join(', ')} 环境变量（${VEVDEMO_LEGACY_ENV_KEYS.join(' / ')} 等旧名仍兼容）`
    ),
  });
}
