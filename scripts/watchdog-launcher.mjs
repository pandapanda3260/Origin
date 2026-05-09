import { spawn } from 'node:child_process';

const script = '/Users/mark/Documents/origin/scripts/origin-dev-watchdog.sh';
const child = spawn('/bin/bash', [script], {
  stdio: 'inherit',
  cwd: '/Users/mark/Documents/origin',
});

const forward = (sig) => () => child.kill(sig);
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGINT', forward('SIGINT'));
process.on('SIGHUP', forward('SIGHUP'));

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
