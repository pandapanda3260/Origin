import assert from 'node:assert/strict';
import { sanitizeProxyStatusText } from '../lib/proxy-fetch';

async function main() {
  const statusText = sanitizeProxyStatusText('请求参数无效');
  const resp = new Response('body-ok', { status: 400, statusText });
  assert.equal(resp.status, 400);
  assert.equal(resp.statusText, '');
  assert.equal(await resp.text(), 'body-ok');

  {
    const statusText = sanitizeProxyStatusText('Bad\r\nGateway');
    const resp = new Response('body-ok', { status: 502, statusText });
    assert.equal(resp.statusText, 'BadGateway');
    assert.equal(await resp.text(), 'body-ok');
  }

  {
    const statusText = sanitizeProxyStatusText('OK\tCached');
    const resp = new Response('body-ok', { status: 200, statusText });
    assert.equal(resp.statusText, 'OK\tCached');
    assert.equal(await resp.text(), 'body-ok');
  }

  console.log('[test-proxy-fetch-status-text] all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
