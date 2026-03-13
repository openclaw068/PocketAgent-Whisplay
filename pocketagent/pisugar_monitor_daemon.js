import http from 'node:http';
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

function postJson({ host, port, path, payload, timeoutMs = 1200 }) {
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  const opts = {
    method: 'POST',
    hostname: host,
    port,
    path,
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

function shouldWarn({ plugged }) {
  if (!WARN_ONLY_ON_BATTERY) return true;
  // If we don't know plugged status, default to warning (safer) — but you asked no warnings on power.
  // We'll treat unknown as "do not warn" to match your preference.
  if (plugged == null) return false;
  return plugged === false;
}

async function tick() {
  const st = await getPisugarStatus();

  // Push display patch (best-effort)
  void postJson({
    host: DISPLAY_HOST,
    port: DISPLAY_PORT,
    path: '/update',
    payload: { battery: { percent: st.percent, plugged: st.plugged, charging: st.charging } }
  });

  if (typeof st.percent !== 'number') return;

  // Reset warning latches when plugged in (new discharge cycle)
  if (st.plugged === true) {
    warned20 = false;
    warned10 = false;
    return;
  }

  if (!shouldWarn({ plugged: st.plugged })) return;

  if (!warned20 && st.percent <= WARN_1 && st.percent > WARN_2) {
    warned20 = true;
    void postJson({
      host: NOTIFY_HOST,
      port: NOTIFY_PORT,
      path: '/notify',
      payload: { id: 'battery-20', kind: 'battery', text: `Battery is at ${Math.round(st.percent)} percent.` }
    });
  }

  if (!warned10 && st.percent <= WARN_2) {
    warned10 = true;
    warned20 = true;
    void postJson({
      host: NOTIFY_HOST,
      port: NOTIFY_PORT,
      path: '/notify',
      payload: { id: 'battery-10', kind: 'battery', text: `Battery is at ${Math.round(st.percent)} percent. You should plug me in soon.` }
    });
  }
}

async function main() {
  console.log('[pisugar-monitor] starting', { pollSecs: POLL_SECS, warn1: WARN_1, warn2: WARN_2, warnOnlyOnBattery: WARN_ONLY_ON_BATTERY });
  // immediate tick
  try { await tick(); } catch (e) { console.error('[pisugar-monitor] tick error:', e?.message ?? e); }
  setInterval(() => { tick().catch(e => console.error('[pisugar-monitor] tick error:', e?.message ?? e)); }, Math.max(5, POLL_SECS) * 1000);
}

main().catch(e => {
  console.error('[pisugar-monitor] fatal:', e);
  process.exit(1);
});
