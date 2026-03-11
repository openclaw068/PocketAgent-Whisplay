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

function barsFromSignal(signalPct) {
  const s = Number(signalPct);
  if (!Number.isFinite(s) || s <= 0) return 0;
  if (s >= 75) return 4;
  if (s >= 55) return 3;
  if (s >= 35) return 2;
  return 1;
}

export async function getWifiStatus({ iface = 'wlan0' } = {}) {
  // Returns: { connected, ssid, signalPct, bars }
  // Uses NetworkManager via nmcli.
  try {
    // -t output: yes:<ssid>:<signal>
    const { out } = await run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL', 'dev', 'wifi', 'list', 'ifname', iface]);
    const lines = (out || '').split('\n');
    for (const line of lines) {
      if (!line.startsWith('*:')) continue;
      const parts = line.split(':');
      const ssid = parts[1] || '';
      const signalPct = Number(parts[2] || 0);
      return {
        connected: true,
        ssid,
        signalPct,
        bars: barsFromSignal(signalPct)
      };
    }
    return { connected: false, ssid: '', signalPct: 0, bars: 0 };
  } catch {
    return { connected: false, ssid: '', signalPct: 0, bars: 0 };
  }
}
