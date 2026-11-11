#!/usr/bin/env node
// Runs one adapter in its own process group. A browser adapter blocks in a synchronous
// call to a browser CLI, so signalling the adapter alone leaves that CLI writing into
// the run. A timeout or a forwarded interrupt stops the whole group instead.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const GRACE_MS = 5000;
const [timeoutArg, marker, separator, ...argv] = process.argv.slice(2);
if (separator !== '--' || !argv.length || !marker || !/^\d+$/.test(timeoutArg ?? '')) {
  console.error('Usage: node src/adapter-supervisor.mjs <timeout-ms|0> <timeout-marker-file> -- <command> [args...]');
  process.exit(2);
}
const timeoutMs = Number(timeoutArg);
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', detached: true });

function signalGroup(signal) {
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

let timedOut = false;
const timer = timeoutMs > 0 ? setTimeout(() => {
  timedOut = true;
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), GRACE_MS).unref();
}, timeoutMs) : null;

// The adapter sits in its own group, so a terminal interrupt no longer reaches it directly.
const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of forwarded) process.on(signal, () => signalGroup(signal));

child.on('error', error => {
  console.error(`adapter could not start: ${error.message}`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  // Nothing the adapter started may keep writing once the adapter itself is gone.
  signalGroup('SIGKILL');
  if (timedOut) {
    writeFileSync(marker, `${JSON.stringify({ timeout_ms: timeoutMs, adapter_signal: signal })}\n`, { flag: 'wx' });
    process.exit(124);
  }
  if (signal) {
    // Report the adapter's own signal, so the runner can tell a kill from a crash.
    for (const name of forwarded) process.removeAllListeners(name);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
