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

// Relative volume nudge when we don't have a stable raw mapping.
// Uses amixer's built-in relative syntax: e.g. "5%+" / "5%-".
export async function nudgeVolumePercent({ card = null, control = 'Speaker', deltaPercent = 5 }) {
  const d = Number(deltaPercent);
  const step = Math.max(0, Math.min(100, Math.round(Math.abs(d))));
  const rel = `${step}%${d >= 0 ? '+' : '-'}`;

  const args = [];
  if (card !== null && card !== undefined) args.push('-c', String(card));
  args.push('sset', control, rel);
  await run('amixer', args);
  return { deltaPercent: d >= 0 ? step : -step };
}

export async function getVolumeRaw({ card = null, control = 'Playback' }) {
  const args = [];
  if (card !== null && card !== undefined) args.push('-c', String(card));
  args.push('sget', control);
  const { out } = await run('amixer', args);

  // Try to parse the first channel raw integer value, e.g.:
  // Front Left: 200 [78%] [-27.50dB]
  const m = out.match(/Front Left:\s*Playback\s*(\d+)\s*\[/i) || out.match(/Front Left:\s*(\d+)\s*\[/i);
  if (!m) throw new Error(`Could not parse raw volume from amixer output for ${control}`);
  return Number(m[1]);
}

export function rawToPercent({ raw, min = 200, max = 255 }) {
  const lo = Math.min(Number(min), Number(max));
  const hi = Math.max(Number(min), Number(max));
  const r = Math.max(lo, Math.min(hi, Number(raw)));
  if (hi === lo) return 0;
  return Math.round(((r - lo) / (hi - lo)) * 100);
}
