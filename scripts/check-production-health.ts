const baseUrl = (process.env.ORIGIN_HEALTH_URL || 'http://127.0.0.1:3000/api/health').trim();

async function main() {
  try {
    const response = await fetch(baseUrl, { headers: { accept: 'application/json' } });
    const body: any = await response.json().catch(() => ({}));
    const status = body?.status || `http_${response.status}`;
    console.log(`[health] ${status} ${baseUrl}`);
    if (Array.isArray(body?.checks)) {
      for (const check of body.checks) {
        const prefix = check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'fail';
        console.log(`[health] ${prefix} ${check.name}${check.message ? ` - ${check.message}` : ''}`);
      }
    }
    if (!response.ok || body?.ok === false) process.exit(1);
  } catch (e: any) {
    console.error(`[health] request failed ${baseUrl}: ${e?.message || String(e)}`);
    process.exit(1);
  }
}

main();

export {};
