import net from 'node:net';

// Client for PiSugar Power Manager (pisugar-server).
// Talks to either:
// - Unix domain socket (default /tmp/pisugar-server.sock), OR
// - TCP (default 127.0.0.1:8423)
// with newline-delimited commands.
//
// Protocol reference:
//   https://github.com/PiSugar/pisugar-power-manager-rs
//   echo "get battery" | nc -U /tmp/pisugar-server.sock

function connOptsFrom({ socketPath, host, port }) {
  return socketPath ? { path: socketPath } : { host, port };
}

/**
 * Run several commands over a SINGLE connection.
 *
 * The previous implementation opened one socket per field, so a full status
 * read meant six sequential connect/write/read/teardown cycles, each with its
 * own 1200ms timeout — up to ~7.2s of stall per poll on a 30s poll interval.
 * pisugar-server accepts multiple newline-delimited commands per connection,
 * so we pipeline them and correlate replies by key.
 *
 * Returns a Map of key -> parsed value for whatever came back. Commands that
 * produce no reply are simply absent; callers treat missing as null.
 */
export async function pisugarCommands(cmds, {
  socketPath = process.env.POCKETAGENT_PISUGAR_SOCKET || '/tmp/pisugar-server.sock',
  host = process.env.POCKETAGENT_PISUGAR_HOST || '127.0.0.1',
  port = Number(process.env.POCKETAGENT_PISUGAR_PORT || 8423),
  timeoutMs = 1500
} = {}) {
  const list = (Array.isArray(cmds) ? cmds : [cmds])
    .map(c => String(c || '').trim())
    .filter(Boolean);
  if (!list.length) throw new Error('no commands given');

  return await new Promise((resolve, reject) => {
    let done = false;
    const sock = net.createConnection(connOptsFrom({ socketPath, host, port }));
    const results = new Map();
    let buf = '';

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      if (err && results.size === 0) return reject(err);
      resolve(results);
    };

    // Resolve on timeout with whatever we collected rather than throwing away
    // partial telemetry — a partial reading still beats none for diagnostics.
    const timer = setTimeout(() => finish(new Error('pisugar timeout')), timeoutMs);

    sock.on('connect', () => {
      try {
        sock.write(list.join('\n') + '\n');
      } catch (e) {
        finish(e);
      }
    });

    sock.on('data', d => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const p = parsePisugarResponse(line);
        if (p.key) results.set(p.key, p.value);
      }
      // Got a reply for every command we sent — no need to wait for the timeout.
      if (results.size >= list.length) finish(null);
    });

    sock.on('error', e => finish(e));
    sock.on('close', () => finish(null));
  });
}

/** Back-compat single-command helper. */
export async function pisugarCommand(cmd, opts = {}) {
  const res = await pisugarCommands([cmd], opts);
  const [key, value] = res.entries().next().value ?? [];
  return key ? `${key}: ${value}` : '';
}

export function parsePisugarResponse(line) {
  // Examples:
  //  battery: 78
  //  battery_v: 3.91
  //  battery_power_plugged: true
  const s = String(line || '').trim();
  const m = s.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
  if (!m) return { raw: s };
  const key = m[1];
  const rawVal = (m[2] ?? '').trim();
  let value = rawVal;
  if (/^(true|false)$/i.test(rawVal)) value = rawVal.toLowerCase() === 'true';
  else if (/^-?\d+(\.\d+)?$/.test(rawVal)) value = Number(rawVal);
  return { key, value, raw: s };
}

const NUM = v => (typeof v === 'number' ? v : null);
const BOOL = v => (typeof v === 'boolean' ? v : null);

/**
 * Full status read in one round-trip.
 *
 * NOTE: voltage and current are the fields that actually matter for diagnosing
 * the early-shutoff problem. Reported `percent` is derived from a voltage curve
 * (see `battery_curve` in /etc/pisugar-server/config.json) and can be badly
 * miscalibrated — voltage is the ground truth.
 */
export async function getPisugarStatus(opts = {}) {
  let res;
  try {
    res = await pisugarCommands([
      'get battery',
      'get battery_v',
      'get battery_i',
      'get battery_power_plugged',
      'get battery_allow_charging',
      'get battery_charging',
      'get temperature',
      'get safe_shutdown_level',
      'get safe_shutdown_delay'
    ], opts);
  } catch {
    res = new Map();
  }

  return {
    percent: NUM(res.get('battery')),
    voltage: NUM(res.get('battery_v')),
    current: NUM(res.get('battery_i')),
    plugged: BOOL(res.get('battery_power_plugged')),
    allowCharging: BOOL(res.get('battery_allow_charging')),
    charging: BOOL(res.get('battery_charging')),
    temperature: NUM(res.get('temperature')),
    // Surfaced so the monitor can warn if the server is configured to
    // auto-shutdown at a high threshold — the prime suspect for early cutoff.
    safeShutdownLevel: NUM(res.get('safe_shutdown_level')),
    safeShutdownDelay: NUM(res.get('safe_shutdown_delay'))
  };
}
