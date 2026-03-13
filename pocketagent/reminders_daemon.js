import http from 'node:http';
import { URL } from 'node:url';

import { DEFAULTS } from './config.js';
import { ReminderEngine, newId } from './reminders.js';
import { loadJson, saveJson } from './store.js';

const DATA_DIR = process.env.POCKETAGENT_DATA_DIR || './data';
const defaultsPath = process.env.POCKETAGENT_DEFAULTS_FILE || `${DATA_DIR}/defaults.json`;
const remindersPath = process.env.POCKETAGENT_REMINDERS_DB || `${DATA_DIR}/reminders.json`;

const PORT = Number(process.env.POCKETAGENT_REMINDERS_PORT || 3791);
const HOST = process.env.POCKETAGENT_REMINDERS_HOST || '127.0.0.1';

// Where to send due/followup events (chat agent listens here)
const NOTIFY_URL = process.env.POCKETAGENT_NOTIFY_URL || 'http://127.0.0.1:3781/notify';

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function postJson(url, payload, timeoutMs = 10_000) {
  const u = new URL(url);
  const body = Buffer.from(JSON.stringify(payload));

  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length
    },
    timeout: timeoutMs
  };

  return await new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      // consume
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('notify timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function followupFromDefaults(spec, defaults) {
  const d = defaults.followup;
  const dQuiet = d.quietHours ?? { start: 23, end: 7 };

  if (!spec || spec.kind === 'use_default') {
    if (d.mode === 'once') return { followupEveryMin: null };
    return {
      followupEveryMin: d.everyMin ?? 15,
      followupMaxCount: d.maxCount ?? null,
      followupQuietHours: dQuiet
    };
  }

  if (spec.everyMin === null) return { followupEveryMin: null };
  return {
    followupEveryMin: Number(spec.everyMin ?? (d.everyMin ?? 15)),
    followupMaxCount: spec.maxCount ?? null,
    followupQuietHours: spec.quietHours ?? dQuiet
  };
}

function normalizeTimeText(s) {
  return String(s || '')
    .trim()
    // normalize punctuation variants: "a.m." -> "am", "p.m." -> "pm"
    .replace(/\b([ap])\s*\.?\s*m\.?\b/gi, (_, ap) => `${ap.toLowerCase()}m`)
    // drop day words that shouldn't affect time parsing
    .replace(/\b(today)\b/gi, '')
    // drop leftover periods
    .replace(/\./g, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    // strip common filler
    .replace(/^at\s+/i, '')
    .trim();
}

function parseDue(timeText) {
  const now = new Date();
  const t = normalizeTimeText(timeText).toLowerCase();

  // Relative times: "in 5 minutes", "in one minute", "in an hour"
  let m = t.match(/^in\s+(a|an|one|\d+)\s+(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b/);
  if (m) {
    const nRaw = m[1];
    const unit = m[2];
    const n = (nRaw === 'a' || nRaw === 'an' || nRaw === 'one') ? 1 : Number(nRaw);
    const mult = unit.startsWith('hour') || unit.startsWith('hr') ? 3600_000 : unit.startsWith('sec') ? 1000 : 60_000;
    return new Date(Date.now() + n * mult).toISOString();
  }

  // Absolute-ish times: "7am", "tomorrow 7am"
  m = t.match(/^(tomorrow\s+)?(at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return new Date(Date.now() + 60_000).toISOString();

  const isTomorrow = !!m[1];
  let hh = Number(m[3]);
  const mm = m[4] ? Number(m[4]) : 0;
  const ap = m[5]?.toLowerCase();

  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;

  const due = new Date(now);
  due.setSeconds(0, 0);
  due.setHours(hh, mm, 0, 0);

  if (isTomorrow || due <= now) due.setDate(due.getDate() + 1);
  return due.toISOString();
}

const state = {
  defaults: loadJson(defaultsPath, {
    timezone: DEFAULTS.timezone,
    followup: {
      mode: 'ask',
      everyMin: 15,
      maxCount: null,
      quietHours: { start: 23, end: 7 }
    }
  })
};

const engine = new ReminderEngine({ dbFile: remindersPath, timezone: state.defaults.timezone });
engine.start(async (r, meta) => {
  try {
    await postJson(NOTIFY_URL, { id: r.id, text: r.text, kind: meta.kind, dueAtIso: r.dueAtIso });
  } catch (e) {
    console.error('[reminders-daemon] notify failed:', e?.message ?? e);
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && u.pathname === '/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/defaults/update') {
      const body = await readJson(req);
      const p = body?.defaultsPatch || {};

      state.defaults.followup.mode = p.mode === 'once' ? 'once' : 'repeat';
      if (state.defaults.followup.mode === 'repeat') {
        if (p.everyMin != null) state.defaults.followup.everyMin = Number(p.everyMin);
        state.defaults.followup.maxCount = p.maxCount ?? null;
        if (p.quietHours) state.defaults.followup.quietHours = p.quietHours;
      } else {
        state.defaults.followup.maxCount = null;
      }

      saveJson(defaultsPath, state.defaults);
      return json(res, 200, { ok: true, defaults: state.defaults });
    }

    if (req.method === 'POST' && u.pathname === '/reminders/add') {
      const body = await readJson(req);
      const reminderText = String(body?.reminderText || '').trim();
      const timeText = String(body?.timeText || '').trim();
      const followupSpec = body?.followupSpec ?? null;

      if (!reminderText) return json(res, 400, { ok: false, error: 'missing reminderText' });
      if (!timeText) return json(res, 400, { ok: false, error: 'missing timeText' });

      const dueAtIso = parseDue(timeText);
      const follow = followupFromDefaults(followupSpec, state.defaults);
      const r = engine.add({ id: newId(), text: reminderText, dueAtIso, ...follow });
      return json(res, 200, { ok: true, reminder: r });
    }

    if (req.method === 'POST' && u.pathname === '/reminders/ack') {
      const body = await readJson(req);
      const id = String(body?.id || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'missing id' });
      const r = engine.acknowledge(id);
      return json(res, 200, { ok: true, reminder: r });
    }

    if (req.method === 'POST' && u.pathname === '/reminders/delete') {
      const body = await readJson(req);
      const id = String(body?.id || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'missing id' });
      const r = engine.delete(id);
      if (!r) return json(res, 404, { ok: false, error: 'not found' });
      return json(res, 200, { ok: true, reminder: r });
    }

    if (req.method === 'POST' && u.pathname === '/reminders/update') {
      const body = await readJson(req);
      const id = String(body?.id || '').trim();
      const patch = body?.patch ?? {};
      if (!id) return json(res, 400, { ok: false, error: 'missing id' });
      const r = engine.update(id, patch);
      if (!r) return json(res, 404, { ok: false, error: 'not found' });
      return json(res, 200, { ok: true, reminder: r });
    }

    if (req.method === 'GET' && u.pathname === '/reminders/open') {
      return json(res, 200, { ok: true, reminders: engine.listOpen() });
    }

    if (req.method === 'GET' && u.pathname === '/reminders/all') {
      return json(res, 200, { ok: true, reminders: engine.listAll() });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[reminders-daemon] error:', e);
    return json(res, 500, { ok: false, error: e?.message ?? String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('[reminders-daemon] listening:', { host: HOST, port: PORT, notifyUrl: NOTIFY_URL });
});
