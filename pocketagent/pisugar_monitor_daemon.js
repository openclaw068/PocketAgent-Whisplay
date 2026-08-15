import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getPisugarStatus } from './pisugar_client.js';

const POLL_SECS = Number(process.env.POCKETAGENT_BATTERY_POLL_SECS || 30);
const WARN_1 = Number(process.env.POCKETAGENT_BATTERY_WARN_1 || 20);
const WARN_2 = Number(process.env.POCKETAGENT_BATTERY_WARN_2 || 10);

// Only warn when NOT on external power (plugged=false)
const WARN_ONLY_ON_BATTERY = (process.env.POCKETAGENT_BATTERY_WARN_ONLY_ON_BATTERY ?? 'true').toLowerCase() === 'true';

const NOTIFY_HOST = process.env.POCKETAGENT_NOTIFY_HOST || '127.0.0.1';
const NOTIFY_PORT = Number(process.env.POCKETAGENT_NOTIFY_PORT || 3781);
const DISPLAY_HOST = process.env.POCKETAGENT_DISPLAY_HOST || '127.0.0.1';
const DISPLAY_PORT = Number(process.env.POCKETAGENT_DISPLAY_PORT || 3782);

// --- Telemetry logging -------------------------------------------------
// The early-shutoff bug has gone undiagnosed because nothing persisted the
// voltage curve. We already poll every 30s; write it down. CSV so it survives
// a hard cut line-by-line (append + fsync each row) and opens in anything.
const TELEMETRY_ENABLED = (process.env.POCKETAGENT_BATTERY_LOG ?? 'true').toLowerCase() === 'true';
const TELEMETRY_PATH = process.env.POCKETAGENT_BATTERY_LOG_PATH
  || path.join(process.env.POCKETAGENT_DATA_DIR || './data', 'battery-telemetry.csv');
const TELEMETRY_MAX_BYTES = Number(process.env.POCKETAGENT_BATTERY_LOG_MAX_BYTES || 5_000_000);

const CSV_HEADER = 'iso,uptime_s,percent,voltage_v,current_a,plugged,charging,temp_c\n';

function initTelemetry() {
  if (!TELEMETRY_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
    // Rotate if oversized, keeping one previous generation.
    try {
      const st = fs.statSync(TELEMETRY_PATH);
      if (st.size > TELEMETRY_MAX_BYTES) fs.renameSync(TELEMETRY_PATH, `${TELEMETRY_PATH}.1`);
    } catch {}
    if (!fs.existsSync(TELEMETRY_PATH)) fs.writeFileSync(TELEMETRY_PATH, CSV_HEADER);
    // Boot marker makes it obvious in the log where a hard cut happened:
    // the row before a marker is the last reading before power was lost.
    fs.appendFileSync(TELEMETRY_PATH, `# boot ${new Date().toISOString()}\n`);
  } catch (e) {
    console.error('[pisugar-monitor] telemetry init failed:', e?.message ?? e);
  }
}

function logTelemetry(st) {
  if (!TELEMETRY_ENABLED) return;
  const f = v => (typeof v === 'number' ? v : '');
  const b = v => (typeof v === 'boolean' ? (v ? '1' : '0') : '');
  const row = [
    new Date().toISOString(),
    Math.round(process.uptime()),
    f(st.percent), f(st.voltage), f(st.current),
    b(st.plugged), b(st.charging), f(st.temperature)
  ].join(',') + '\n';

  // Append + fsync: without the fsync, the final rows before a hard power cut
  // sit in the page cache and are lost — which is precisely the data we need.
  let fd;
  try {
    fd = fs.openSync(TELEMETRY_PATH, 'a');
    fs.writeSync(fd, row);
    fs.fsyncSync(fd);
  } catch (e) {
    console.error('[pisugar-monitor] telemetry write failed:', e?.message ?? e);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
// -----------------------------------------------------------------------

function postJson({ host, port, path: urlPath, payload, timeoutMs = 1200 }) {
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  const opts = {
    method: 'POST',
    hostname: host,
    port,
    path: urlPath,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length
    },
    timeout: timeoutMs
  };

  return new Promise((resolve) => {
    const req = http.request(opts, res => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 0 }); });
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
}

let warned20 = false;
let warned10 = false;
let configChecked = false;

function shouldWarn({ plugged }) {
  if (!WARN_ONLY_ON_BATTERY) return true;
  if (plugged == null) return false;
  return plugged === false;
}

/**
 * One-shot startup check: if pisugar-server is configured to auto-shutdown at
 * a high battery level, say so loudly. This is the leading suspect for the
 * "device dies at 30-40%" symptom — a soft shutdown triggered by config, not
 * a hardware fault. See /etc/pisugar-server/config.json (auto_shutdown_level).
 */
function checkShutdownConfig(st) {
  if (configChecked) return;
  if (typeof st.safeShutdownLevel !== 'number') return;
  configChecked = true;
  const lvl = st.safeShutdownLevel;
  if (lvl > 15) {
    console.warn(
      `[pisugar-monitor] *** safe_shutdown_level is ${lvl}% (delay ${st.safeShutdownDelay ?? '?'}s). ***\n` +
      `[pisugar-monitor] *** pisugar-server will power off the Pi at ${lvl}% reported battery. ***\n` +
      `[pisugar-monitor] *** If the device is dying early, THIS IS ALMOST CERTAINLY WHY. ***\n` +
      `[pisugar-monitor] *** Fix: sudo nano /etc/pisugar-server/config.json -> auto_shutdown_level ***`
    );
  } else {
    console.log(`[pisugar-monitor] safe_shutdown_level=${lvl}% delay=${st.safeShutdownDelay ?? '?'}s`);
  }
}

async function tick() {
  const st = await getPisugarStatus();

  logTelemetry(st);
  checkShutdownConfig(st);

  void postJson({
    host: DISPLAY_HOST,
    port: DISPLAY_PORT,
    path: '/update',
    payload: { battery: { percent: st.percent, plugged: st.plugged, charging: st.charging } }
  });

  if (typeof st.percent !== 'number') return;

  if (st.plugged === true) {
    warned20 = false;
    warned10 = false;
    return;
  }

  if (!shouldWarn({ plugged: st.plugged })) return;

  if (!warned20 && st.percent <= WARN_1 && st.percent > WARN_2) {
    warned20 = true;
    void postJson({
      host: NOTIFY_HOST, port: NOTIFY_PORT, path: '/notify',
      payload: { id: 'battery-20', kind: 'battery', text: `Battery is at ${Math.round(st.percent)} percent.` }
    });
  }

  if (!warned10 && st.percent <= WARN_2) {
    warned10 = true;
    warned20 = true;
    void postJson({
      host: NOTIFY_HOST, port: NOTIFY_PORT, path: '/notify',
      payload: { id: 'battery-10', kind: 'battery', text: `Battery is at ${Math.round(st.percent)} percent. You should plug me in soon.` }
    });
  }
}

async function main() {
  console.log('[pisugar-monitor] starting', {
    pollSecs: POLL_SECS, warn1: WARN_1, warn2: WARN_2,
    warnOnlyOnBattery: WARN_ONLY_ON_BATTERY,
    telemetry: TELEMETRY_ENABLED ? TELEMETRY_PATH : 'disabled'
  });
  initTelemetry();
  try { await tick(); } catch (e) { console.error('[pisugar-monitor] tick error:', e?.message ?? e); }
  setInterval(() => { tick().catch(e => console.error('[pisugar-monitor] tick error:', e?.message ?? e)); }, Math.max(5, POLL_SECS) * 1000);
}

main().catch(e => {
  console.error('[pisugar-monitor] fatal:', e);
  process.exit(1);
});
