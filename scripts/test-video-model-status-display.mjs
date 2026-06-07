import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/video_model_status.js', import.meta.url), 'utf8');
const { describeVideoModelStatusFailure } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`
);

assert.deepEqual(
  describeVideoModelStatusFailure({ status: 401, name: 'ApiError', message: 'unauthorized' }),
  {
    label: '登录状态失效',
    meta: '请刷新页面或重新登录后再试',
    status: 'missing',
    cache: false,
    reason: 'auth',
  },
);

assert.deepEqual(
  describeVideoModelStatusFailure({
    status: 200,
    name: 'ApiError',
    message: '尚未配置 API Key',
    payload: {
      ok: false,
      error: '尚未配置 API Key',
      hint: '请到 API 配置中心填写 video 槽位的 API 地址、Key 和模型名',
    },
  }),
  {
    label: '视频模型未配置',
    meta: '请到 API 配置中心填写 video 槽位的 API 地址、Key 和模型名',
    status: 'missing',
    cache: true,
    reason: 'config_missing',
  },
);

assert.deepEqual(
  describeVideoModelStatusFailure({ name: 'TimeoutError', message: '请求超时，请检查网络后重试' }),
  {
    label: '读取超时',
    meta: '后端响应较慢，请稍后重试',
    status: 'missing',
    cache: true,
    reason: 'timeout',
  },
);

assert.deepEqual(
  describeVideoModelStatusFailure({ status: 503, name: 'ApiError', message: '服务暂时不可用' }),
  {
    label: '后端暂时不可用',
    meta: '服务正在重启或繁忙，请稍后重试',
    status: 'missing',
    cache: true,
    reason: 'server',
  },
);

assert.deepEqual(
  describeVideoModelStatusFailure({ name: 'TypeError', message: 'Failed to fetch' }),
  {
    label: '后端连接异常',
    meta: '无法连接本地后端，请确认服务仍在运行',
    status: 'missing',
    cache: true,
    reason: 'network',
  },
);

console.log('test-video-model-status-display: ok');
