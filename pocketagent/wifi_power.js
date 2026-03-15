import { spawn } from 'node:child_process';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (err += d.toString()));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${err || out}`));
    });
  });
}

async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms));
}

export async function wifiOn({ iface = 'wlan0', timeoutMs = 12000 } = {}) {
  // Best-effort: unblock + connect. This assumes NetworkManager.
  try { await run('rfkill', ['unblock', 'wifi']); } catch {}
  try { await run('nmcli', ['dev', 'connect', iface]); } catch {}

  // Wait for connected state (cap to timeout)
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const { out } = await run('nmcli', ['-t', '-f', 'GENERAL.STATE', 'dev', 'show', iface]);
      // "GENERAL.STATE:100 (connected)"
      if ((out || '').includes(':100')) return { ok: true };
    } catch {}
    await sleep(400);
  }
  return { ok: false, reason: 'wifi_on_timeout' };
}

export async function wifiOff({ iface = 'wlan0' } = {}) {
  // Best-effort: disconnect + block.
  try { await run('nmcli', ['dev', 'disconnect', iface]); } catch {}
  try { await run('rfkill', ['block', 'wifi']); } catch {}
  return { ok: true };
}
