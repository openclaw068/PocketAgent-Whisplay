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

export async function setVolumePercent({ card = null, control = 'Speaker', percent }) {
  const p = Math.max(0, Math.min(100, Number(percent)));
  const args = [];
  if (card !== null && card !== undefined) args.push('-c', String(card));
  args.push('sset', control, `${p}%`);
  await run('amixer', args);
  return p;
}

export async function setVolumePercentRaw({ card = null, control = 'Playback', percent, min = 200, max = 255 }) {
  const p = Math.max(0, Math.min(100, Number(percent)));
  const lo = Number(min);
  const hi = Number(max);
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);

  // Linear map: 0% -> a, 100% -> b
  const raw = Math.round(a + (p / 100) * (b - a));

  const args = [];
  if (card !== null && card !== undefined) args.push('-c', String(card));
  args.push('sset', control, String(raw));

  await run('amixer', args);
  return { percent: p, raw, min: a, max: b };
}

export async function listControls({ card = null }) {
  const args = [];
  if (card !== null && card !== undefined) args.push('-c', String(card));
  args.push('scontrols');
  const { out } = await run('amixer', args);
  return out;
}
