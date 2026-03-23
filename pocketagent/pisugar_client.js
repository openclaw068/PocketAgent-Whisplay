import net from 'node:net';

// Minimal client for PiSugar Power Manager (pisugar-server).
// Talks to either:
// - Unix domain socket (default /tmp/pisugar-server.sock), OR
// - TCP (default 127.0.0.1:8423)
// with newline-delimited commands.

export async function pisugarCommand(cmd, {
  socketPath = process.env.POCKETAGENT_PISUGAR_SOCKET || '/tmp/pisugar-server.sock',
  host = process.env.POCKETAGENT_PISUGAR_HOST || '127.0.0.1',
  port = Number(process.env.POCKETAGENT_PISUGAR_PORT || 8423),
  timeoutMs = 1200
} = {}) {
  const command = String(cmd || '').trim();
  if (!command) throw new Error('missing cmd');

  return await new Promise((resolve, reject) => {
    let done = false;
    // Prefer UDS when present (more reliable than TCP on some images).
    const connOpts = socketPath ? { path: socketPath } : { host, port };
    const sock = net.createConnection(connOpts);
    const chunks = [];

    const finish = (err, data) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      if (err) return reject(err);
      resolve(data);
    };

    const t = setTimeout(() => finish(new Error('pisugar timeout')), timeoutMs);

    sock.on('connect', () => {
      try {
        sock.write(command + '\n');
      } catch (e) {
        clearTimeout(t);
        finish(e);
      }
    });

    sock.on('data', d => {
      chunks.push(d);
      // Responses are small and usually single-line; finish once we see a newline.
      const s = Buffer.concat(chunks).toString('utf8');
      if (s.includes('\n')) {
        clearTimeout(t);
        finish(null, s.trim());
      }
    });

    sock.on('error', e => {
      clearTimeout(t);
      finish(e);
    });

    sock.on('close', () => {
      clearTimeout(t);
      if (!done) finish(null, Buffer.concat(chunks).toString('utf8').trim());
    });
  });
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

export async function getPisugarStatus() {
  // Best-effort: not all fields exist on all builds/versions.
  const fields = {
    percent: null,
    voltage: null,
    plugged: null,
    allowCharging: null,
    charging: null,
    temperature: null
  };

  const tryGet = async (cmd, mapFn) => {
    try {
      const res = await pisugarCommand(cmd);
      const p = parsePisugarResponse(res);
      mapFn(p.value, p);
      return true;
    } catch {
      return false;
    }
  };

  await tryGet('get battery', (v) => { if (typeof v === 'number') fields.percent = v; });
  await tryGet('get battery_v', (v) => { if (typeof v === 'number') fields.voltage = v; });
  await tryGet('get battery_power_plugged', (v) => { if (typeof v === 'boolean') fields.plugged = v; });
  await tryGet('get battery_allow_charging', (v) => { if (typeof v === 'boolean') fields.allowCharging = v; });
  await tryGet('get battery_charging', (v) => { if (typeof v === 'boolean') fields.charging = v; });
  await tryGet('get temperature', (v) => { if (typeof v === 'number') fields.temperature = v; });

  return fields;
}
