import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUtterance } from '../pocketagent/agent.js';
import { loadJson, saveJson } from '../pocketagent/store.js';
import { ReminderEngine, newId } from '../pocketagent/reminders.js';
import { answerReminderQuery, selectRemindersForQuery } from '../pocketagent/query.js';
import { setVolumePercent } from '../pocketagent/volume.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
// Bind loopback by default. Previously this listened on 0.0.0.0, exposing the
// tester (which can create/delete reminders and change volume) to the whole
// LAN. Set POCKETAGENT_WEB_HOST=0.0.0.0 to opt in deliberately.
const HOST = process.env.POCKETAGENT_WEB_HOST || '127.0.0.1';
const DATA_DIR = process.env.POCKETAGENT_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultsPath = process.env.POCKETAGENT_DEFAULTS_FILE || path.join(DATA_DIR, 'defaults.json');
const remindersPath = process.env.POCKETAGENT_REMINDERS_DB || path.join(DATA_DIR, 'reminders.json');

const state = {
  pending: null,
  defaults: loadJson(defaultsPath, {
    timezone: 'America/Chicago',
    followup: { mode: 'repeat', everyMin: 15, maxCount: null, quietHours: { start: 23, end: 7 } }
  })
};

const engine = new ReminderEngine({ dbFile: remindersPath, timezone: state.defaults.timezone });
engine.start(async () => {}); // web tester doesn't auto-speak

function parseDueIso(timeText) {
  const now = new Date();
  const m = String(timeText || '').trim().match(/^(tomorrow\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return new Date(Date.now() + 60_000).toISOString();
  const isTomorrow = !!m[1];
  let hh = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : 0;
  const ap = m[4]?.toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  const due = new Date(now);
  due.setSeconds(0, 0);
  due.setHours(hh, mm, 0, 0);
  if (isTomorrow || due <= now) due.setDate(due.getDate() + 1);
  return due.toISOString();
}

function followupFromSpec(spec) {
  const d = state.defaults.followup;
  const dQuiet = d.quietHours ?? { start: 23, end: 7 };
  if (!spec || spec.kind === 'use_default') {
    if (d.mode === 'once') return { followupEveryMin: null };
    return { followupEveryMin: d.everyMin ?? 15, followupMaxCount: d.maxCount ?? null, followupQuietHours: dQuiet };
  }
  if (spec.everyMin === null) return { followupEveryMin: null };
  return {
    followupEveryMin: Number(spec.everyMin ?? (d.everyMin ?? 15)),
    followupMaxCount: spec.maxCount ?? null,
    followupQuietHours: spec.quietHours ?? dQuiet
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));
}

function requireAccessKey(req) {
  const expected = process.env.POCKETAGENT_WEB_ACCESS_KEY;
  // Secure-by-default in production: require an access key.
  if (!expected) return process.env.NODE_ENV !== 'production';
  const got = req.headers['x-access-key'];
  if (typeof got !== 'string') return false;

  // Constant-time compare so the key can't be recovered byte-by-byte by
  // timing repeated requests. Hash first so differing lengths are safe to
  // pass to timingSafeEqual (which throws on length mismatch).
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => (buf += d.toString('utf8')));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const apiKeyEnv = 'OPENAI_API_KEY';
const model = process.env.POCKETAGENT_CHAT_MODEL || 'gpt-4o-mini';

const server = http.createServer(async (req, res) => {
  try {
    // Static
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/assets/') || req.url === '/app.js' || req.url === '/style.css')) {
      const url = req.url === '/' ? '/index.html' : req.url;
      const filePath = path.join(__dirname, url);
      if (!filePath.startsWith(__dirname)) return send(res, 403, {}, 'Forbidden');
      const ext = path.extname(filePath);
      const type = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.js' ? 'application/javascript; charset=utf-8'
        : 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      return send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store' }, content);
    }

    // Health
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });

    // Chat turn
    if (req.method === 'POST' && req.url === '/api/turn') {
      if (!requireAccessKey(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });

      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = String(body.text || '');

      const result = await handleUtterance({ baseUrl, apiKeyEnv, model, text, state });

      // Apply defaults patch if present
      if (result.intent === 'update_defaults' && result.defaultsPatch) {
        const p = result.defaultsPatch;
        state.defaults.followup.mode = p.mode === 'once' ? 'once' : 'repeat';
        if (state.defaults.followup.mode === 'repeat') {
          if (p.everyMin != null) state.defaults.followup.everyMin = Number(p.everyMin);
          state.defaults.followup.maxCount = p.maxCount ?? null;
          if (p.quietHours) state.defaults.followup.quietHours = p.quietHours;
        }
        saveJson(defaultsPath, state.defaults);
      }

      // If a full reminder was collected, store it (web tester only)
      if (result.intent === 'set_followup' && state.collected) {
        const dueAtIso = parseDueIso(state.collected.timeText);
        const follow = followupFromSpec(state.collected.followupSpec);
        engine.add({ id: newId(), text: state.collected.reminderText, dueAtIso, ...follow });
        state.collected = null;
      }

      // Query reminders / volume
      let assistant = result.say || '';

      if (result.intent === 'query_reminders') {
        const selected = selectRemindersForQuery(engine, result.queryText);
        assistant = await answerReminderQuery({ baseUrl, apiKeyEnv, model, queryText: result.queryText, reminders: selected });
      }

      if (result.intent === 'set_volume') {
        const pct = await setVolumePercent({
          card: process.env.POCKETAGENT_ALSA_CARD ?? null,
          control: process.env.POCKETAGENT_ALSA_VOLUME_CONTROL || 'Speaker',
          percent: result.percent
        });
        assistant = `Done — volume set to ${pct} percent.`;
      }

      return json(res, 200, {
        ok: true,
        user: text,
        assistant,
        debug: {
          intent: result.intent,
          pending: state.pending,
          defaults: state.defaults,
          reminders_open: engine.listOpen().length
        }
      });
    }

    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PocketAgent web tester listening on ${HOST}:${PORT}`);
  if (HOST === '0.0.0.0' && !process.env.POCKETAGENT_WEB_ACCESS_KEY) {
    console.warn('[web] WARNING: bound to all interfaces with no POCKETAGENT_WEB_ACCESS_KEY set.');
  }
});
