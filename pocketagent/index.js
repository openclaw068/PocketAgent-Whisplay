import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULTS } from './config.js';
import { recordToWav, playWav, runHook } from './audio.js';
import { whisperTranscribe, ttsToAudio, chat as openaiChat, embed } from './openai.js';
import http from 'node:http';

import { handleUtterance } from './agent.js';
import { routeUtterance } from './router.js';
import { loadJson, saveJson } from './store.js';
// (openaiChat is imported above with whisperTranscribe/ttsToAudio)
import { answerReminderQuery, selectRemindersForQuery } from './query.js';
import { setVolumePercent, setVolumePercentRaw, nudgeVolumePercent, getVolumeRaw, rawToPercent } from './volume.js';
import { startButtonWatcher } from './gpio_button.js';
import { startWhisplayButtonWatcher } from './whisplay_button.js';
import { bestReminderMatch } from './match.js';
import { displayUpdate } from './display_client.js';
import { SemanticMemory } from './semantic_memory.js';
import { getWifiStatus } from './wifi_status.js';
import { wifiOn, wifiOff } from './wifi_power.js';
import { classifyMemoryUtterance } from './memory_nlu.js';
import { getPisugarStatus } from './pisugar_client.js';

const DATA_DIR = process.env.POCKETAGENT_DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultsPath = process.env.POCKETAGENT_DEFAULTS_FILE || path.join(DATA_DIR, 'defaults.json');
const remindersPath = process.env.POCKETAGENT_REMINDERS_DB || path.join(DATA_DIR, 'reminders.json');
const memoryPath = process.env.POCKETAGENT_MEMORY_DB || path.join(DATA_DIR, 'memory.json');

const baseUrl = DEFAULTS.openaiBaseUrl;
const apiKeyEnv = DEFAULTS.openaiApiKeyEnv;

const semMemory = new SemanticMemory({ dbFile: memoryPath });

const runtime = {
  state: {
    pending: null,
    defaults: loadJson(defaultsPath, {
      timezone: DEFAULTS.timezone,
      followup: {
        mode: 'ask', // ask|once|repeat
        everyMin: 15,
        maxCount: null,
        quietHours: { start: 23, end: 7 }
      }
    }),

    // Semantic memory flow
    memory: {
      pendingForget: null
    },

    // Chat mode conversation memory
    chat: {
      sessionId: null,
      messages: [],
      carryover: []
    }
  }
};

function loadChatHistory() {
  return loadJson(DEFAULTS.chatHistoryFile, {
    last10: [],
    lastSessionId: null,
    updatedAtIso: null
  });
}

function saveChatHistory(last10, sessionId = null) {
  saveJson(DEFAULTS.chatHistoryFile, {
    last10,
    lastSessionId: sessionId,
    updatedAtIso: new Date().toISOString()
  });
}

function newSessionId() {
  return Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
}

function bootstrapChatSession() {
  const h = loadChatHistory();
  runtime.state.chat.sessionId = newSessionId();
  runtime.state.chat.carryover = Array.isArray(h.last10) ? h.last10.slice(-DEFAULTS.chatCarryoverCount) : [];
  runtime.state.chat.messages = [...runtime.state.chat.carryover];
  console.log('[PocketAgent] chat session:', { sessionId: runtime.state.chat.sessionId, carryover: runtime.state.chat.carryover.length });
}

function followupFromSpec(spec) {
  const d = runtime.state.defaults.followup;
  const dQuiet = d.quietHours ?? { start: 23, end: 7 };

  if (!spec || spec.kind === 'use_default') {
    if (d.mode === 'once' || d.mode === 'ask') return { followupEveryMin: null, followupMode: d.mode };
    return {
      followupEveryMin: d.everyMin ?? 15,
      followupMaxCount: d.maxCount ?? null,
      followupQuietHours: dQuiet,
      followupMode: d.mode
    };
  }

  // custom
  if (spec.everyMin === null) return { followupEveryMin: null, followupMode: 'once' };
  return {
    followupEveryMin: Number(spec.everyMin ?? (d.everyMin ?? 15)),
    followupMaxCount: spec.maxCount ?? null,
    followupQuietHours: spec.quietHours ?? dQuiet,
    followupMode: 'repeat'
  };
}

function normalizeTimeText(s) {
  return String(s || '')
    .trim()
    // normalize punctuation variants: "a.m." -> "am", "p.m." -> "pm"
    .replace(/\b([ap])\s*\.?\s*m\.?\b/gi, (_, ap) => `${ap.toLowerCase()}m`)
    // drop leftover periods ("a.m."/"p.m." variants)
    .replace(/\./g, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    // strip common filler words
    .replace(/^at\s+/i, '')
    .trim();
}

function parseDue(timeText) {
  // V1: interpret common short phrases as next occurrence today/tomorrow in local time.
  // For now we use system time. On Pi, set timezone properly.
  const now = new Date();
  const t = normalizeTimeText(timeText);

  // Accept:
  // - "7am", "7 am", "7 a.m.";
  // - "7:30pm", "7:30 pm";
  // - optional "tomorrow" prefix;
  // - optional "at" prefix.
  const m = t.match(/^(tomorrow\s+)?(at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) {
    // fallback: 1 minute from now
    return new Date(Date.now() + 60_000).toISOString();
  }

  const isTomorrow = !!m[1];
  let hh = Number(m[3]);
  const mm = m[4] ? Number(m[4]) : 0;
  const ap = m[5]?.toLowerCase();

  // If no am/pm given, assume next occurrence in the future (24h clock-ish behavior)
  // (e.g. "7" at 6pm -> tomorrow 7:00; at 6am -> today 7:00)
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;

  const due = new Date(now);
  due.setSeconds(0, 0);
  due.setHours(hh, mm, 0, 0);

  if (isTomorrow || due <= now) {
    due.setDate(due.getDate() + 1);
  }
  return due.toISOString();
}

async function say(text) {
  // Never let TTS/audio failures crash the whole loop.
  const spoken = String(text || '').trim();
  try {
    // Reset pending-idle timer so we don't clear pending state while we're speaking.
    try { touchTurn(); } catch {}

    // Show what we're about to say on the display.
    // IMPORTANT: don't truncate too aggressively — the Whisplay subtitle bubble can scroll.
    const displayText = spoken.length > 600 ? (spoken.slice(0, 600) + '…') : spoken;
    void displayUpdate({ status: 'speaking', line1: 'PocketAgent', line2: displayText });

    const ttsSpeed = Number(process.env.POCKETAGENT_TTS_SPEED ?? 1.0);
    const { audio, contentType } = await ttsToAudio({
      baseUrl,
      apiKeyEnv,
      model: DEFAULTS.ttsModel,
      voice: DEFAULTS.ttsVoice,
      text: spoken,
      format: 'wav',
      speed: ttsSpeed
    });
    const out = path.join(DATA_DIR, 'tts.wav');
    fs.writeFileSync(out, audio);
    // Repair WAV header quirks (we've seen invalid length fields that cause quiet/distorted playback).
    // Re-encode in-place via sox to ensure a clean PCM WAV container.
    try {
      // Requires: sudo apt-get install -y sox
      execFileSync('sox', [out, '-r', '24000', '-c', '1', '-b', '16', out + '.fixed.wav']);
      fs.renameSync(out + '.fixed.wav', out);
    } catch (e) {
      console.warn('[PocketAgent] sox wav-fix failed (continuing):', e?.message || e);
    }

    // Quick sanity check to avoid blasting static if the provider returns MP3/etc.
    if (!audio?.slice?.(0, 4)?.equals?.(Buffer.from('RIFF')) && !(contentType || '').includes('wav')) {
      throw new Error(`TTS did not return WAV (content-type=${contentType || 'unknown'})`);
    }

    await playWav({ wavPath: out, cmd: DEFAULTS.playbackCommand, device: DEFAULTS.playbackDevice });

    // Return to idle once audio playback ends.
    void displayUpdate({ status: 'idle', line1: 'PocketAgent', line2: spoken.slice(0, 160) });
  } catch (e) {
    console.error('say() failed:', e?.message ?? e);
    void displayUpdate({ status: 'error', line1: 'PocketAgent', line2: 'TTS failed' });

    // Fallback: log the prompt so the system stays usable even if quota is exhausted.
    console.log('SAY:', spoken);
  }
}

async function listenForAck({ secondsMax = 5 }) {
  const wavPath = path.join(DATA_DIR, 'ack.wav');
  try {
    await recordToWav({
      outPath: wavPath,
      sampleRateHertz: DEFAULTS.sampleRateHertz,
      device: DEFAULTS.recordingDevice,
      secondsMax
    });
    const text = await whisperTranscribe({
      baseUrl,
      apiKeyEnv,
      audioPath: wavPath,
      model: DEFAULTS.whisperModel,
      prompt: process.env.POCKETAGENT_WHISPER_PROMPT || null,
      language: process.env.POCKETAGENT_WHISPER_LANGUAGE || null,
      responseFormat: process.env.POCKETAGENT_WHISPER_RESPONSE_FORMAT || 'json'
    });
    return (text || '').trim();
  } catch {
    return '';
  }
}

function isAck(text) {
  return /\b(yes|yeah|yep|done|did it|i did|completed)\b/i.test(text);
}

async function notifyAndMaybeAck({ id, text, kind }) {
  // Track which reminder we most recently spoke, so "done" can clear the right one.
  runtime.state.lastNotifiedReminderId = id;

  const prompt = kind === 'due'
    ? `Reminder: ${text}. Did you do it?`
    : `Did you do it yet? ${text}`;

  void displayUpdate({ status: 'speaking', line1: 'Reminder', line2: String(text || '').slice(0, 160) });
  await say(prompt);

  // Ack behavior:
  // - ptt: do not auto-record; user can press and say "yes/done" and we fast-path ack.
  // - auto: auto-record briefly for a yes/done.
  if (ACK_MODE === 'auto') {
    let heard = '';
    const tries = Number(process.env.POCKETAGENT_ACK_LISTEN_TRIES ?? 3);
    const retryDelayMs = Number(process.env.POCKETAGENT_ACK_LISTEN_RETRY_DELAY_MS ?? 350);

    for (let i = 0; i < tries; i++) {
      heard = await listenForAck({ secondsMax: 5 });
      if (heard) break;
      if (i < tries - 1) await new Promise(r => setTimeout(r, retryDelayMs));
    }

    if (isAck(heard)) {
      await remindersPost('/reminders/ack', { id });
      await say("Awesome — I’ll take it off the list.");
    }
  }
  // else: ptt mode does nothing here (user can still ack via button; fast-path handles it)
}

// Reminders run in a separate daemon (see reminders_daemon.js). The chat agent only
// receives notify callbacks.
if (DEFAULTS.mode === 'chat') {
  bootstrapChatSession();
}

const REMINDERS_HOST = process.env.POCKETAGENT_REMINDERS_HOST || '127.0.0.1';
const REMINDERS_PORT = Number(process.env.POCKETAGENT_REMINDERS_PORT || 3791);

const NOTIFY_HOST = process.env.POCKETAGENT_NOTIFY_HOST || '127.0.0.1';
const NOTIFY_PORT = Number(process.env.POCKETAGENT_NOTIFY_PORT || 3781);

let busy = false;
const notifyQueue = [];

// Ack behavior after a reminder fires:
// - "ptt" (default): do NOT auto-record; user can press-to-talk "yes/done" and we fast-path ack.
// - "auto": after speaking the reminder prompt, auto-record briefly for a yes/done.
const ACK_MODE = (process.env.POCKETAGENT_ACK_MODE || 'ptt').toLowerCase();

function remindersReqOptions(pathname, method, bodyBuf = null) {
  const headers = bodyBuf
    ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bodyBuf.length }
    : {};
  return {
    method,
    hostname: REMINDERS_HOST,
    port: REMINDERS_PORT,
    path: pathname,
    headers,
    timeout: 10_000
  };
}

async function remindersGet(pathname) {
  return await new Promise((resolve, reject) => {
    const req = http.request(remindersReqOptions(pathname, 'GET'), res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('reminders GET timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function remindersPost(pathname, payload) {
  const bodyBuf = Buffer.from(JSON.stringify(payload ?? {}));
  return await new Promise((resolve, reject) => {
    const req = http.request(remindersReqOptions(pathname, 'POST', bodyBuf), res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('reminders POST timeout')));
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function drainNotifyQueue() {
  if (busy) return;
  if (!notifyQueue.length) return;
  busy = true;
  try {
    while (notifyQueue.length) {
      const ev = notifyQueue.shift();
      await notifyAndMaybeAck(ev);
    }
  } finally {
    busy = false;
  }
}

// If we're waiting for user input (pending flow) and nothing happens for N seconds,
// revert back to idle.
const PENDING_IDLE_TIMEOUT_SECS = Number(process.env.POCKETAGENT_PENDING_IDLE_TIMEOUT_SECS ?? 15);
let _pendingIdleTimer = null;
let _lastTurnAt = Date.now();

function touchTurn() {
  _lastTurnAt = Date.now();
  schedulePendingIdleTimeout();
}

function schedulePendingIdleTimeout() {
  if (_pendingIdleTimer) clearTimeout(_pendingIdleTimer);
  if (!PENDING_IDLE_TIMEOUT_SECS || PENDING_IDLE_TIMEOUT_SECS <= 0) return;

  _pendingIdleTimer = setTimeout(() => {
    try {
      if (runtime.state?.pending?.kind) {
        console.log('[PocketAgent] pending timeout -> idle', { pending: runtime.state.pending.kind });
        runtime.state.pending = null;
        runtime.state._routedIntent = null;
        void displayUpdate({ status: 'idle', line1: 'PocketAgent', line2: '' });
      }
    } catch {}
  }, PENDING_IDLE_TIMEOUT_SECS * 1000);
}

function startNotifyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && u.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/notify') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const body = raw ? JSON.parse(raw) : {};

        // Enqueue and only speak when idle.
        notifyQueue.push({ id: body.id, text: body.text, kind: body.kind });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: notifyQueue.length }));

        // If idle, drain immediately.
        void drainNotifyQueue();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }));
    }
  });

  server.listen(NOTIFY_PORT, NOTIFY_HOST, () => {
    console.log('[PocketAgent] notify server listening:', { host: NOTIFY_HOST, port: NOTIFY_PORT });
  });
}

startNotifyServer();

// Periodically publish Wi‑Fi signal bars to the display.
(function startWifiIndicator() {
  const enabled = (process.env.POCKETAGENT_WIFI_INDICATOR ?? 'true').toLowerCase() === 'true';
  if (!enabled) return;

  const iface = process.env.POCKETAGENT_WIFI_IFACE || 'wlan0';
  const intervalMs = Number(process.env.POCKETAGENT_WIFI_POLL_MS ?? 60000);

  const tick = async () => {
    try {
      const st = await getWifiStatus({ iface });
      const wifi = st.connected
        ? { connected: true, ssid: st.ssid, bars: st.bars, signalPct: st.signalPct }
        : { connected: false, ssid: '', bars: 0, signalPct: 0 };
      void displayUpdate({ wifi });
    } catch {}
  };

  void tick();
  setInterval(tick, Math.max(5000, intervalMs));
})();

async function maybeAnnounceStartupOncePerBoot() {
  if ((process.env.POCKETAGENT_STARTUP_ANNOUNCE ?? 'false').toLowerCase() !== 'true') return;
  if (DEFAULTS.mode !== 'chat') return;

  const bootIdPath = '/proc/sys/kernel/random/boot_id';
  let bootId = null;
  try {
    bootId = fs.readFileSync(bootIdPath, 'utf8').trim();
  } catch {
    // If boot_id isn’t available, fall back to “once per process start”.
    bootId = null;
  }

  const markerPath = path.join(DATA_DIR, 'startup_announce_boot_id.txt');
  let lastBootId = null;
  try {
    lastBootId = fs.readFileSync(markerPath, 'utf8').trim();
  } catch {
    lastBootId = null;
  }

  if (bootId && lastBootId === bootId) return;

  const delayMs = Number(process.env.POCKETAGENT_STARTUP_ANNOUNCE_DELAY_MS ?? 1500);
  const text = (process.env.POCKETAGENT_STARTUP_ANNOUNCE_TEXT || 'PocketAgent is online.').trim();

  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  await say(text);

  // Persist boot marker so we don’t announce again until the next reboot.
  try {
    fs.writeFileSync(markerPath, bootId ? `${bootId}\n` : `started:${new Date().toISOString()}\n`);
  } catch {}
}

// Fire and forget
void maybeAnnounceStartupOncePerBoot();

async function oneTurn({ abortSignal = null } = {}) {
  touchTurn();
  busy = true;
  try {
    const wavPath = path.join(DATA_DIR, `input-${Date.now()}.wav`);
    console.log('[PocketAgent] wavPath:', wavPath);

    if ((process.env.POCKETAGENT_PROMPT_ON_PRESS ?? 'true').toLowerCase() === 'true') {
      // Don't block recording start on TTS playback; it can delay arecord long enough that release aborts immediately.
      void say('Hold the button and speak.');
    }

    // User is holding the button: show LISTENING.
    void displayUpdate({ status: 'listening', line1: 'PocketAgent', line2: 'Listening…' });

    console.log('[PocketAgent] starting recordToWav at', new Date().toISOString());
    const rec = await recordToWav({
      outPath: wavPath,
      sampleRateHertz: DEFAULTS.sampleRateHertz,
      channels: DEFAULTS.recordingChannels,
      device: DEFAULTS.recordingDevice,
      secondsMax: 8,
      abortSignal
    });

    try {
      const st = fs.statSync(wavPath);
      console.log('[PocketAgent] recorded bytes:', st.size, 'aborted=', !!rec?.aborted);
    } catch {
      console.log('[PocketAgent] recorded bytes: <missing>', 'aborted=', !!rec?.aborted);
    }
    // If we have a WAV header but no real audio, don't send it to STT.
    // (This happens when arecord is interrupted very quickly.)
    try {
      const st2 = fs.statSync(wavPath);
      if (st2.size < 2048) {
        console.log('[PocketAgent] recording too small; ignoring');
        return;
      }
    } catch {}

    if (rec?.aborted && !fs.existsSync(wavPath)) {
      console.log('Recording aborted before audio was written; ignoring.');
      return;
    }

    if (!fs.existsSync(wavPath)) {
      console.error('Missing recorded audio file:', wavPath);
      await say('I did not capture any audio. Try holding the button a bit longer.');
      return;
    }

  // Battery: optional Wi‑Fi burst mode for cloud calls (STT, chat, embeddings, TTS)
  const wifiBurst = !!DEFAULTS.wifiBurst;
  const wifiIface = DEFAULTS.wifiIface || 'wlan0';

  if (wifiBurst) {
    void displayUpdate({ status: 'wifi', line1: 'PocketAgent', line2: 'Connecting Wi‑Fi…' });
    await wifiOn({ iface: wifiIface, timeoutMs: Number(process.env.POCKETAGENT_WIFI_ON_TIMEOUT_MS ?? 12000) });
  }

  let text = '';
  try {
    text = await whisperTranscribe({
      baseUrl,
      apiKeyEnv,
      audioPath: wavPath,
      model: DEFAULTS.whisperModel,
      prompt: process.env.POCKETAGENT_WHISPER_PROMPT || null,
      language: process.env.POCKETAGENT_WHISPER_LANGUAGE || null,
      responseFormat: process.env.POCKETAGENT_WHISPER_RESPONSE_FORMAT || 'json'
    });
  } finally {
    if (wifiBurst) {
      await wifiOff({ iface: wifiIface });
    }
  }

  console.log('Heard:', text);
  void displayUpdate({ status: 'transcribing', line1: 'You', line2: String(text || '').slice(0, 160) });

  // Fast-path: if the user says "done"/"yes" after a reminder fired, ack the latest reminder.
  // This avoids router misclassification and makes PTT acknowledgement reliable.
  try {
    if (runtime.state.lastNotifiedReminderId && isAck(text || '')) {
      const id = runtime.state.lastNotifiedReminderId;
      console.log('[PocketAgent] ack latest (fast-path):', { id, heard: String(text || '').trim() });
      try {
        const all = await remindersGet('/reminders/all');
        const cur = (all?.json?.reminders || []).find(x => x.id === id);
        if (cur?.isRecurring && cur.rrule) {
          const { nextFromRRule } = await import('./recurrence.js');
          const nextDueAtIso = nextFromRRule({ rrule: cur.rrule, dtStart: new Date(cur.dueAtIso), after: new Date(), tz: cur.timezone ?? null });
          if (nextDueAtIso) await remindersPost('/reminders/ack_and_reschedule', { id, nextDueAtIso });
          else await remindersPost('/reminders/ack', { id });
        } else {
          await remindersPost('/reminders/ack', { id });
        }
      } catch {
        await remindersPost('/reminders/ack', { id });
      }
      await say('Nice — I’ll mark that as done.');
      return;
    }
  } catch (e) {
    console.error('[PocketAgent] fast-path ack failed:', e?.message ?? e);
  }

  // CHAT MODE: general voice assistant + reminder control.
  // In chat mode, route with the LLM (natural language) and execute local reminder actions.
  // Fall back to open-ended chat only when the router says it's general chat.
  if (DEFAULTS.mode === 'chat') {
    // If we are mid-flow (e.g., collecting reminder details / confirmations),
    // DO NOT run the LLM router. It can misclassify short replies ("yes", "every 5 minutes")
    // and overwrite the pending state machine.
    let routed = null;
    if (runtime.state?.pending?.kind) {
      const r0 = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text, state: runtime.state });
      runtime.state = r0.state ?? runtime.state;
      runtime.state._routedIntent = r0;
    } else {
      // 1) LLM router (broad NL understanding)
      routed = await routeUtterance({
        baseUrl,
        apiKeyEnv,
        model: DEFAULTS.chatModel,
        text,
        hasLastNotified: !!runtime.state.lastNotifiedReminderId
      });
      console.log('[PocketAgent] router:', routed);
    }

    // 2) Translate router output into the existing reminders state machine where helpful
    // (keeps time/follow-up confirmation flows intact).
    // If the deterministic state machine already produced an intent (e.g., confirm_ack -> ack_by_id),
    // run it and skip routing.
    if (runtime.state?._routedIntent?.intent && runtime.state._routedIntent.intent !== 'unknown' && runtime.state._routedIntent.intent !== 'out_of_scope') {
      const r1 = runtime.state._routedIntent;
      runtime.state._routedIntent = null;

      if (r1.intent === 'ack_by_id' && r1.id) {
        // If recurring, reschedule to the next occurrence.
        try {
          const all = await remindersGet('/reminders/all');
          const cur = (all?.json?.reminders || []).find(x => x.id === r1.id);
          if (cur?.isRecurring && cur.rrule) {
            const { nextFromRRule } = await import('./recurrence.js');
            const nextDueAtIso = nextFromRRule({ rrule: cur.rrule, dtStart: new Date(cur.dueAtIso), after: new Date(), tz: cur.timezone ?? null });
            if (nextDueAtIso) {
              await remindersPost('/reminders/ack_and_reschedule', { id: r1.id, nextDueAtIso });
              await say(r1.say || 'Done.');
              return;
            }
          }
        } catch (e) {
          console.error('[PocketAgent] recurring reschedule failed:', e?.message ?? e);
        }

        await remindersPost('/reminders/ack', { id: r1.id });
        await say(r1.say || 'Done.');
        return;
      }

      if (r1.intent === 'delete_by_id' && r1.id) {
        await remindersPost('/reminders/delete', { id: r1.id });
        await say(r1.say || 'Deleted.');
        return;
      }

      if (r1.intent === 'update_by_id' && r1.id) {
        await remindersPost('/reminders/update', { id: r1.id, patch: r1.patch || {} });
        await say(r1.say || 'Updated.');
        return;
      }

      if (r1.say) {
        await say(r1.say);

        // IMPORTANT: some intents (like completing reminder creation) require follow-on actions
        // after the user confirms. Don't return early before we persist.
        if (r1.intent === 'set_followup' && runtime.state.collected) {
          const { reminderText, timeText, followupSpec, recurrence } = runtime.state.collected;
          runtime.state.collected = null;

          console.log('[PocketAgent] saving reminder via daemon:', { reminderText, timeText, followupSpec, recurrence });
          const r = await remindersPost('/reminders/add', { reminderText, timeText, followupSpec, recurrence });
          console.log('[PocketAgent] /reminders/add response:', { status: r?.status, ok: r?.json?.ok, json: r?.json ?? null, raw: r?.raw ?? null });

          if (r?.json?.ok) {
            void displayUpdate({ status: 'idle', line1: 'Reminder saved', line2: `${timeText}: ${String(reminderText || '').slice(0, 120)}` });
            const tt = String(timeText || '').trim();
            const when = /^in\b/i.test(tt) ? tt : `at ${tt}`;
            await say(`Perfect — I’ll remind you ${when}.`);
          } else {
            await say('I had trouble saving that reminder. Check the logs.');
          }
          return;
        }

        return;
      }
    }

    // Semantic memory routed intents (must run BEFORE reminder creation)
    if (routed?.intent === 'remember_fact') {
      try {
        const fact = String(routed.factText || routed.reminderText || text || '').trim();
        if (!fact) {
          await say('What should I remember?');
          return;
        }
        const vec = await embed({ baseUrl, apiKeyEnv, model: DEFAULTS.embeddingModel, input: fact });
        semMemory.add({ text: fact, embedding: vec, meta: { source: 'voice', kind: 'fact' } });
        await say('Got it — I’ll remember that.');
        return;
      } catch (e) {
        console.error('[PocketAgent] remember_fact failed:', e?.message ?? e);
        await say('I had trouble saving that memory. Check the logs.');
        return;
      }
    }

    if (routed?.intent === 'query_memory') {
      try {
        const q = String(routed.memoryQuery || routed.queryText || text || '').trim();
        if (!q) {
          await say('What should I look up?');
          return;
        }
        const qvec = await embed({ baseUrl, apiKeyEnv, model: DEFAULTS.embeddingModel, input: q });
        const hits = semMemory.search({ queryEmbedding: qvec, k: 3, minScore: 0.18 });

        // No relevant memories? Fall back to normal chat.
        if (!hits.length) {
          throw new Error('no_memory_hits');
        }

        const sys =
          'You are PocketAgent. Answer the user using ONLY the provided memory snippets. ' +
          'If the memory does not contain the answer, say you do not know. Keep it brief.';

        const answer = await openaiChat({
          baseUrl,
          apiKeyEnv,
          model: DEFAULTS.chatModel,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: JSON.stringify({ query: q, memories: hits }, null, 2) }
          ]
        });

        await say((answer || '').trim() || 'Okay.');
        return;
      } catch (e) {
        if ((e?.message ?? '') !== 'no_memory_hits') {
          console.error('[PocketAgent] query_memory failed:', e?.message ?? e);
          await say('I had trouble searching memory. Check the logs.');
          return;
        }
        // no_memory_hits -> fall through to normal chat
      }
    }

    if (routed?.intent === 'forget_memory') {
      try {
        const q = String(routed.forgetQuery || text || '').trim();
        const qvec = await embed({ baseUrl, apiKeyEnv, model: DEFAULTS.embeddingModel, input: q });
        const hits = semMemory.search({ queryEmbedding: qvec, k: 1, minScore: 0.18 });
        const top = hits?.[0]?.item;
        if (!top) {
          await say("I couldn't find a memory to forget.");
          return;
        }
        runtime.state.memory.pendingForget = top;
        await say(`Do you want me to forget: ${top.text}?`);
        return;
      } catch (e) {
        console.error('[PocketAgent] forget_memory failed:', e?.message ?? e);
        await say('I had trouble forgetting that. Check the logs.');
        return;
      }
    }

    if (routed?.intent === 'create_reminder') {
      // Kick off the existing reminder creation flow.
      // If timeText was provided, we can skip ask_time and go straight to followup collection.
      const recurrence = routed.recurrence ?? null;
      if (routed.timeText) {
        runtime.state.pending = { kind: 'ask_followup', reminderText: routed.reminderText || text, timeText: routed.timeText, recurrence };
        await say(`Okay — ${routed.timeText}. If I remind you and you don’t respond, how should I handle follow-ups?`);
        return;
      }
      runtime.state.pending = { kind: 'ask_time', reminderText: routed.reminderText || text, recurrence };
      await say('Sure — what time should I remind you?');
      return;
    }

    if (routed?.intent === 'query_reminders') {
      const q = routed.queryText || text;
      // Reuse existing query handler logic by simulating the state machine intent.
      const r1 = { intent: 'query_reminders', queryText: q };
      // (execution continues in the shared handlers below)
      // fall through by setting a variable
      runtime.state._routedIntent = r1;
    } else if (routed?.intent === 'ack_reminder') {
      // If user indicates completion, ack latest when we have recent context.
      if (routed.ackTarget === 'latest') {
        const id = runtime.state.lastNotifiedReminderId;
        if (id) {
          await remindersPost('/reminders/ack', { id });
          await say('Nice — I’ll mark that as done.');
        } else {
          await say('Okay — which reminder do you mean?');
        }
        return;
      }

      // Ack by fuzzy match (by text), then confirm yes/no.
      if (routed.ackTarget === 'by_text' && routed.ackText) {
        const open = await remindersGet('/reminders/open');
        const reminders = open?.json?.reminders || [];
        const { best, bestScore } = bestReminderMatch({ reminders, queryText: routed.ackText });

        if (!best) {
          await say("I couldn't find a matching reminder. What should I mark complete?");
          return;
        }

        // If confidence is low, ask for clarification rather than guessing.
        if (bestScore < 25) {
          await say('I found a few reminders, but I’m not sure which one you mean. Can you say a bit more?');
          return;
        }

        // Set pending confirmation so a plain "yes" completes it.
        runtime.state.pending = { kind: 'confirm_ack', ackId: best.id };
        await say(`Do you mean: ${best.text}?`);
        return;
      }

      // Default ack behavior
      const id = runtime.state.lastNotifiedReminderId;
      if (id) {
        await remindersPost('/reminders/ack', { id });
        await say('Nice — I’ll mark that as done.');
      } else {
        await say('Okay — which reminder do you mean?');
      }
      return;
    } else if (routed?.intent === 'get_battery_status') {
      try {
        const st = await getPisugarStatus();
        if (typeof st.percent !== 'number') {
          await say("I can't read the battery right now. Is PiSugar Power Manager running?");
          return;
        }

        const parts = [];
        parts.push(`Battery is at ${Math.round(st.percent)} percent.`);

        if (st.plugged === true) {
          if (st.charging === true) parts.push('It looks like I am charging.');
          else parts.push('I am plugged in.');
        } else if (st.plugged === false) {
          parts.push('I am on battery power.');
        }

        await say(parts.join(' '));
        return;
      } catch (e) {
        console.error('[PocketAgent] get_battery_status failed:', e?.message ?? e);
        await say("I had trouble checking the battery. Check the logs.");
        return;
      }
    } else if (routed?.intent === 'set_volume') {
      // Support:
      // - absolute: "set volume to 60%"
      // - directional step: "volume up/down" (5% step)
      // - delta: "raise volume 10%" / "lower volume by 10%"

      const step = Number(process.env.POCKETAGENT_VOLUME_STEP_PERCENT ?? 5);

      const hasAbs = routed.volumePercent != null;
      const hasDelta = routed.volumeDeltaPercent != null;
      const dir = routed.volumeDirection;

      let targetPct = null;

      if (hasAbs) {
        targetPct = Number(routed.volumePercent);
      } else {
        // Determine current percent (only supported for raw mapping right now)
        if (DEFAULTS.alsaVolumeRawControl) {
          const raw = await getVolumeRaw({ card: DEFAULTS.alsaCard, control: DEFAULTS.alsaVolumeRawControl });
          const curPct = rawToPercent({ raw, min: DEFAULTS.alsaVolumeRawMin, max: DEFAULTS.alsaVolumeRawMax });

          if (hasDelta) {
            targetPct = curPct + Number(routed.volumeDeltaPercent);
          } else if (dir === 'up') {
            targetPct = curPct + step;
          } else if (dir === 'down') {
            targetPct = curPct - step;
          }
        }
      }

      if (targetPct == null || Number.isNaN(targetPct)) {
        // If we can't compute an absolute target (e.g. no raw mapping), still support
        // simple "volume up/down" by nudging the ALSA control relatively.
        if (!hasAbs && !hasDelta && (dir === 'up' || dir === 'down') && !DEFAULTS.alsaVolumeRawControl) {
          const delta = (dir === 'up' ? step : -step);
          await nudgeVolumePercent({
            card: DEFAULTS.alsaCard,
            control: DEFAULTS.alsaVolumeControl,
            deltaPercent: delta
          });
          await say(`Okay — volume ${dir === 'up' ? 'up' : 'down'} ${step} percent.`);
          return;
        }

        await say('Tell me a percent, like “set volume to 60 percent.”');
        return;
      }

      let pct = null;
      if (DEFAULTS.alsaVolumeRawControl) {
        const r = await setVolumePercentRaw({
          card: DEFAULTS.alsaCard,
          control: DEFAULTS.alsaVolumeRawControl,
          percent: targetPct,
          min: DEFAULTS.alsaVolumeRawMin,
          max: DEFAULTS.alsaVolumeRawMax
        });
        pct = r.percent;
      } else {
        pct = await setVolumePercent({ card: DEFAULTS.alsaCard, control: DEFAULTS.alsaVolumeControl, percent: targetPct });
      }

      await say(`Done — volume set to ${pct} percent.`);
      return;
    } else if (routed?.intent === 'delete_reminder') {
      // Delete reminder (latest or by text) with confirmation when ambiguous.
      // Use ALL reminders so the user can delete old/done reminders too.
      const all = await remindersGet('/reminders/all');
      const reminders = all?.json?.reminders || [];

      const openOnly = reminders.filter(r => r.status === 'open');

      let target = null;
      if (routed.target === 'latest') {
        // Prefer latest open; else fall back to most recent by createdAt.
        target = openOnly[0] || reminders.sort((a,b) => new Date(b.createdAtIso) - new Date(a.createdAtIso))[0] || null;
      } else if (reminders.length === 1) {
        target = reminders[0] || null;
      } else if (routed.target === 'by_text' && routed.targetText) {
        const { best, bestScore } = bestReminderMatch({ reminders, queryText: routed.targetText });
        if (best && bestScore >= 25) target = best;
      }

      if (!target) {
        await say("I couldn't find that reminder. Which one should I delete?");
        return;
      }

      // Confirm deletion
      runtime.state.pending = { kind: 'confirm_ack', ackId: target.id, _deleteOnConfirm: true };
      await say(`Do you want me to delete: ${target.text}?`);
      return;
    } else if (routed?.intent === 'update_reminder') {
      const all = await remindersGet('/reminders/all');
      const reminders = all?.json?.reminders || [];

      let target = null;
      if (routed.target === 'latest' || (reminders.length === 1)) {
        target = reminders[0] || null;
      } else if (routed.target === 'by_text' && routed.targetText) {
        const { best, bestScore } = bestReminderMatch({ reminders, queryText: routed.targetText });
        if (best && bestScore >= 25) target = best;
      }

      if (!target) {
        await say("I couldn't find that reminder. Which one do you want to change?");
        return;
      }

      // For now we support updating followupEveryMin and/or timeText and/or text.
      const update = routed.update || {};
      const patch = {};

      if (update.followupEveryMin != null) patch.followupEveryMin = Number(update.followupEveryMin);
      if (update.reminderText) patch.text = String(update.reminderText);

      if (update.timeText) {
        // Reuse daemon's parseDue by just sending timeText through a small helper here is overkill.
        // We accept the timeText string and let daemon parse it by sending dueAtIso? (not available).
        // So: for now, we update by re-creating dueAtIso locally using same parseDue logic as daemon.
        const dueAtIso = (function parseDue(timeText) {
          const now = new Date();
          const t = String(timeText || '').trim().toLowerCase();
          let m = t.match(/^in\s+(a|an|one|\d+)\s+(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b/);
          if (m) {
            const nRaw = m[1];
            const unit = m[2];
            const n = (nRaw === 'a' || nRaw === 'an' || nRaw === 'one') ? 1 : Number(nRaw);
            const mult = unit.startsWith('hour') || unit.startsWith('hr') ? 3600_000 : unit.startsWith('sec') ? 1000 : 60_000;
            return new Date(Date.now() + n * mult).toISOString();
          }
          // fallback to existing absolute-time parser pattern used in daemon
          const t2 = t.replace(/\b([ap])\s*\.?\s*m\.?\b/g, (_, ap) => `${ap}m`).replace(/\./g, '').replace(/\s+/g, ' ').replace(/^at\s+/i, '').trim();
          const mm = t2.match(/^(tomorrow\s+)?(at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
          if (!mm) return new Date(Date.now() + 60_000).toISOString();
          const isTomorrow = !!mm[1];
          let hh = Number(mm[3]);
          const mins = mm[4] ? Number(mm[4]) : 0;
          const ap = mm[5]?.toLowerCase();
          if (ap === 'pm' && hh < 12) hh += 12;
          if (ap === 'am' && hh === 12) hh = 0;
          const due = new Date(now);
          due.setSeconds(0, 0);
          due.setHours(hh, mins, 0, 0);
          if (isTomorrow || due <= now) due.setDate(due.getDate() + 1);
          return due.toISOString();
        })(update.timeText);
        patch.dueAtIso = dueAtIso;
      }

      if (!Object.keys(patch).length) {
        await say('Okay — what do you want to change about it?');
        return;
      }

      // Confirm update
      runtime.state.pending = { kind: 'confirm_ack', ackId: target.id, _updatePatch: patch };
      await say(`Just to confirm — update "${target.text}". Sound right?`);
      return;
    } else if (routed?.intent !== 'general_chat') {
      // If router produced something we don't handle yet, fall back to the legacy state machine.
      const r1 = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text, state: runtime.state });
      runtime.state = r1.state ?? runtime.state;
      runtime.state._routedIntent = r1;
    }

    // If we have an intent from routing/state machine, execute the existing handlers.
    const r1 = runtime.state._routedIntent;
    if (r1?.intent && r1.intent !== 'unknown' && r1.intent !== 'out_of_scope') {
      runtime.state._routedIntent = null;
      // Handle defaults updates
      if (r1.intent === 'update_defaults' && r1.defaultsPatch) {
        const p = r1.defaultsPatch;
        runtime.state.defaults.followup.mode = p.mode === 'once' ? 'once' : (p.mode === 'ask' ? 'ask' : 'repeat');
        if (runtime.state.defaults.followup.mode === 'repeat') {
          if (p.everyMin != null) runtime.state.defaults.followup.everyMin = Number(p.everyMin);
          runtime.state.defaults.followup.maxCount = p.maxCount ?? null;
          if (p.quietHours) runtime.state.defaults.followup.quietHours = p.quietHours;
        } else if (runtime.state.defaults.followup.mode === 'once') {
          runtime.state.defaults.followup.maxCount = null;
        } else {
          // ask mode
          runtime.state.defaults.followup.maxCount = null;
        }
        saveJson(defaultsPath, runtime.state.defaults);
      }

      // If we just collected a full reminder
      if (r1.intent === 'set_followup' && runtime.state.collected) {
        const { reminderText, timeText, followupSpec, recurrence } = runtime.state.collected;
        runtime.state.collected = null;

        console.log('[PocketAgent] saving reminder via daemon:', { reminderText, timeText, followupSpec, recurrence });
        const r = await remindersPost('/reminders/add', { reminderText, timeText, followupSpec, recurrence });
        console.log('[PocketAgent] /reminders/add response:', { status: r?.status, ok: r?.json?.ok, json: r?.json ?? null, raw: r?.raw ?? null });

        if (r?.json?.ok) {
          void displayUpdate({ status: 'idle', line1: 'Reminder saved', line2: `${timeText}: ${String(reminderText || '').slice(0, 120)}` });
          const tt = String(timeText || '').trim();
          const when = /^in\b/i.test(tt) ? tt : `at ${tt}`;
          await say(`Perfect — I’ll remind you ${when}.`);
        } else {
          await say('I had trouble saving that reminder. Check the logs.');
        }
        return;
      }

      // Ack latest reminder (from notification context)
      if (r1.intent === 'ack_latest') {
        const id = runtime.state.lastNotifiedReminderId;
        if (id) {
          try {
            const all = await remindersGet('/reminders/all');
            const cur = (all?.json?.reminders || []).find(x => x.id === id);
            if (cur?.isRecurring && cur.rrule) {
              const { nextFromRRule } = await import('./recurrence.js');
              const nextDueAtIso = nextFromRRule({ rrule: cur.rrule, dtStart: new Date(cur.dueAtIso), after: new Date(), tz: cur.timezone ?? null });
              if (nextDueAtIso) {
                await remindersPost('/reminders/ack_and_reschedule', { id, nextDueAtIso });
              } else {
                await remindersPost('/reminders/ack', { id });
              }
            } else {
              await remindersPost('/reminders/ack', { id });
            }
          } catch {
            await remindersPost('/reminders/ack', { id });
          }
        }
        if (r1.say) {
          await say(r1.say);
        }
        return;
      }

      // Ack explicit reminder id (from confirm_ack pending flow)
      if (r1.intent === 'ack_by_id' && r1.id) {
        // If recurring, reschedule to the next occurrence.
        try {
          const all = await remindersGet('/reminders/all');
          const cur = (all?.json?.reminders || []).find(x => x.id === r1.id);
          if (cur?.isRecurring && cur.rrule) {
            const { nextFromRRule } = await import('./recurrence.js');
            const nextDueAtIso = nextFromRRule({ rrule: cur.rrule, dtStart: new Date(cur.dueAtIso), after: new Date(), tz: cur.timezone ?? null });
            if (nextDueAtIso) {
              await remindersPost('/reminders/ack_and_reschedule', { id: r1.id, nextDueAtIso });
              if (r1.say) await say(r1.say);
              return;
            }
          }
        } catch (e) {
          console.error('[PocketAgent] recurring reschedule failed:', e?.message ?? e);
        }

        await remindersPost('/reminders/ack', { id: r1.id });
        if (r1.say) await say(r1.say);
        return;
      }

      // Query reminders (list/what’s next/etc)
      if (r1.intent === 'query_reminders') {
        const all = await remindersGet('/reminders/all');
        const reminders = all?.json?.reminders || [];

        const engineLike = {
          listAll: () => reminders,
          listOpen: () => reminders.filter(r => r.status === 'open'),
          listByDateRange: ({ startIso, endIso, status = null }) => {
            const start = startIso ? new Date(startIso).getTime() : -Infinity;
            const end = endIso ? new Date(endIso).getTime() : Infinity;
            return reminders
              .filter(r => {
                const t = new Date(r.dueAtIso).getTime();
                if (Number.isNaN(t)) return false;
                if (t < start || t > end) return false;
                if (status && r.status !== status) return false;
                return true;
              })
              .sort((a, b) => new Date(a.dueAtIso) - new Date(b.dueAtIso));
          }
        };

        const selected = selectRemindersForQuery(engineLike, r1.queryText);
        const answer = await answerReminderQuery({
          baseUrl,
          apiKeyEnv,
          model: DEFAULTS.chatModel,
          queryText: r1.queryText,
          reminders: selected
        });
        await say(answer);
        return;
      }

      // Volume
      if (r1.intent === 'set_volume') {
        // Legacy/state-machine volume intent is absolute only.
        const targetPct = Number(r1.percent);

        let pct = null;
        if (DEFAULTS.alsaVolumeRawControl) {
          const r = await setVolumePercentRaw({
            card: DEFAULTS.alsaCard,
            control: DEFAULTS.alsaVolumeRawControl,
            percent: targetPct,
            min: DEFAULTS.alsaVolumeRawMin,
            max: DEFAULTS.alsaVolumeRawMax
          });
          pct = r.percent;
        } else {
          pct = await setVolumePercent({
            card: DEFAULTS.alsaCard,
            control: DEFAULTS.alsaVolumeControl,
            percent: targetPct
          });
        }
        await say(`Done — volume set to ${pct} percent.`);
        return;
      }

      // Default: speak state machine response if provided
      if (r1.say) {
        console.log('[PocketAgent] handled intent:', { intent: r1.intent, pending: runtime.state?.pending?.kind ?? null });
        await say(r1.say);
        return;
      }
    }

    // Semantic memory (facts like "remember I put my keys by the door" / queries like "where are my keys")
    // Run this before general chat fallback so memory behaves like a "central place for remembering".
    try {
      const mem = await classifyMemoryUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text });

      if (mem?.intent === 'remember_fact' && (mem.factText || text)) {
        const fact = String(mem.factText || text).trim();
        const vec = await embed({ baseUrl, apiKeyEnv, model: DEFAULTS.embeddingModel, input: fact });
        semMemory.add({ text: fact, embedding: vec, meta: { source: 'voice', kind: 'fact' } });
        await say('Got it — I’ll remember that.');
        return;
      }

      if (mem?.intent === 'query_memory' && (mem.queryText || text)) {
        const q = String(mem.queryText || text).trim();
        const qvec = await embed({ baseUrl, apiKeyEnv, model: DEFAULTS.embeddingModel, input: q });
        const hits = semMemory.search({ queryEmbedding: qvec, k: 3, minScore: 0.18 });

        // If we have no relevant memories, fall back to normal chat.
        // This prevents generic questions (e.g. "who owns Costco") from getting a memory-nothing response.
        if (!hits.length) {
          throw new Error('no_memory_hits');
        }

        // Ask the LLM to answer using ONLY the returned memories.
        const sys =
          'You are PocketAgent. Answer the user using ONLY the provided memory snippets. ' +
          'If the memory does not contain the answer, say you do not know. Keep it brief.';

        const answer = await openaiChat({
          baseUrl,
          apiKeyEnv,
          model: DEFAULTS.chatModel,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: JSON.stringify({ query: q, memories: hits }, null, 2) }
          ]
        });

        await say((answer || '').trim() || 'Okay.');
        return;
      }

      if (mem?.intent === 'forget_memory' && (mem.forgetQuery || text)) {
        const q = String(mem.forgetQuery || text).trim();
        const qvec = await embed({ baseUrl, apiKeyEnv, model: DEFAULTS.embeddingModel, input: q });
        const hits = semMemory.search({ queryEmbedding: qvec, k: 1, minScore: 0.18 });
        const top = hits?.[0]?.item;
        if (!top) {
          await say("I couldn't find a memory to forget.");
          return;
        }
        runtime.state.memory.pendingForget = top;
        await say(`Do you want me to forget: ${top.text}?`);
        return;
      }

      // If we are confirming a pending forget
      if (runtime.state.memory?.pendingForget) {
        const t0 = String(text || '').toLowerCase();
        if (/\b(yes|yep|yeah|confirm|do it|ok|okay)\b/.test(t0)) {
          const target = runtime.state.memory.pendingForget;
          runtime.state.memory.pendingForget = null;
          semMemory.deleteById(target.id);
          await say('Okay — forgotten.');
          return;
        }
        if (/\b(no|nope|cancel|never mind|stop)\b/.test(t0)) {
          runtime.state.memory.pendingForget = null;
          await say('Okay — I will keep it.');
          return;
        }
        await say('Just say yes to forget it, or no to cancel.');
        return;
      }
    } catch (e) {
      if ((e?.message ?? '') !== 'no_memory_hits') {
        console.error('[PocketAgent] semantic memory handling failed:', e?.message ?? e);
      }
      // Fall through to general chat.
    }

    // Otherwise: fall back to general chat with conversation memory.
    runtime.state.chat.messages.push({ role: 'user', content: text });

    const systemPrompt = (process.env.POCKETAGENT_CHAT_SYSTEM_PROMPT || '').trim() ||
      'You are a helpful, concise voice assistant. Keep replies short and conversational.';

    const messages = [{ role: 'system', content: systemPrompt }, ...runtime.state.chat.messages];

    void displayUpdate({ status: 'thinking', line1: 'PocketAgent', line2: 'Thinking…' });
    const reply = await openaiChat({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, messages });
    const assistantText = (reply || '').trim();

    runtime.state.chat.messages.push({ role: 'assistant', content: assistantText });

    const last10 = runtime.state.chat.messages.slice(-DEFAULTS.chatCarryoverCount);
    saveChatHistory(last10, runtime.state.chat.sessionId);

    await say(assistantText || 'Okay.');

    const chatAuto = (process.env.POCKETAGENT_CHAT_AUTO_LISTEN ?? 'false').toLowerCase() === 'true';
    if (chatAuto) {
      const maxTurns = Number(process.env.POCKETAGENT_CHAT_AUTO_LISTEN_MAX_TURNS ?? 2);
      for (let i = 0; i < maxTurns; i++) {
        const text2 = await autoListenOnce();
        if (!text2) break;

        runtime.state.chat.messages.push({ role: 'user', content: text2 });
        const messages2 = [{ role: 'system', content: systemPrompt }, ...runtime.state.chat.messages];
        const reply2 = await openaiChat({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, messages: messages2 });
        const assistantText2 = (reply2 || '').trim();
        runtime.state.chat.messages.push({ role: 'assistant', content: assistantText2 });

        const last10b = runtime.state.chat.messages.slice(-DEFAULTS.chatCarryoverCount);
        saveChatHistory(last10b, runtime.state.chat.sessionId);

        await say(assistantText2 || 'Okay.');
      }
    }

    return;
  }

  // REMINDERS MODE: state machine
  const result = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text, state: runtime.state });

  if (result.intent === 'update_defaults' && result.defaultsPatch) {
    const p = result.defaultsPatch;
    runtime.state.defaults.followup.mode = p.mode === 'once' ? 'once' : (p.mode === 'ask' ? 'ask' : 'repeat');
    if (runtime.state.defaults.followup.mode === 'repeat') {
      if (p.everyMin != null) runtime.state.defaults.followup.everyMin = Number(p.everyMin);
      runtime.state.defaults.followup.maxCount = p.maxCount ?? null;
      if (p.quietHours) runtime.state.defaults.followup.quietHours = p.quietHours;
    } else if (runtime.state.defaults.followup.mode === 'once') {
      runtime.state.defaults.followup.maxCount = null;
    } else {
      // ask mode
      runtime.state.defaults.followup.maxCount = null;
    }

    saveJson(defaultsPath, runtime.state.defaults);

    const d = runtime.state.defaults.followup;
    const quiet = d.quietHours ? `${d.quietHours.start}:00 to ${d.quietHours.end}:00` : 'no quiet hours';
    const summary = d.mode === 'once'
      ? `Got it. Default follow-ups set to just once.`
      : (d.mode === 'ask'
        ? `Got it. Default follow-ups set to ask once when a reminder is due.`
        : `Got it. Default follow-ups: every ${d.everyMin ?? 15} minutes, max ${d.maxCount ?? 'no limit'}, quiet hours ${quiet}.`);

    await say(summary);
    return;
  }

  runtime.state = result.state ?? runtime.state;

  // If we just collected a full reminder
  if (result.intent === 'set_followup' && runtime.state.collected) {
    const { reminderText, timeText, followupSpec, recurrence } = runtime.state.collected;
    const r = await remindersPost('/reminders/add', { reminderText, timeText, followupSpec, recurrence });
    runtime.state.collected = null;
    if (r?.json?.ok) {
      void displayUpdate({ status: 'idle', line1: 'Reminder saved', line2: `${timeText}: ${String(reminderText || '').slice(0, 120)}` });
      const tt = String(timeText || '').trim();
    const when = /^in\b/i.test(tt) ? tt : `at ${tt}`;
    await say(`Perfect — I’ll remind you ${when}.`);
    } else {
      await say('I had trouble saving that reminder. Check the logs.');
    }
    return;
  }

  async function autoListenOnce() {
    const secondsMax = Number(process.env.POCKETAGENT_AUTO_LISTEN_SECONDS ?? 6);
    const delayMs = Number(process.env.POCKETAGENT_AUTO_LISTEN_DELAY_MS ?? 250);
    const wavPath2 = path.join(DATA_DIR, 'input.wav');
    try { fs.unlinkSync(wavPath2); } catch {}

    // Give ALSA a moment to settle after playback before opening the capture device.
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

    try {
      const attempts = Number(process.env.POCKETAGENT_AUTO_LISTEN_RECORD_RETRIES ?? 4);
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          await recordToWav({
            outPath: wavPath2,
            sampleRateHertz: DEFAULTS.sampleRateHertz,
            channels: DEFAULTS.recordingChannels,
            device: DEFAULTS.recordingDevice,
            secondsMax
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // backoff a bit and retry (ALSA can be briefly busy right after playback)
          await new Promise(r => setTimeout(r, 250));
        }
      }
      if (lastErr) {
        console.error('[PocketAgent] auto-listen record failed:', lastErr?.message ?? lastErr);
        return '';
      }
    } catch (e) {
      console.error('[PocketAgent] auto-listen record failed:', e?.message ?? e);
      return '';
    }

    if (!fs.existsSync(wavPath2)) return '';

    const text2 = await whisperTranscribe({
      baseUrl,
      apiKeyEnv,
      audioPath: wavPath2,
      model: DEFAULTS.whisperModel,
      prompt: process.env.POCKETAGENT_WHISPER_PROMPT || null,
      language: process.env.POCKETAGENT_WHISPER_LANGUAGE || null,
      responseFormat: process.env.POCKETAGENT_WHISPER_RESPONSE_FORMAT || 'json'
    });
    console.log('Heard (auto):', text2);
    return (text2 || '').trim();
  }

  // Conversation mode: after we speak a question (pending state), auto-listen for a reply.
  const autoListenEnabled = (process.env.POCKETAGENT_AUTO_LISTEN_ON_PROMPTS ?? 'false').toLowerCase() === 'true';
  const maxAutoTurns = Number(process.env.POCKETAGENT_AUTO_LISTEN_MAX_TURNS ?? 2);

  // Speak the immediate response first.
  if (result.say) {
    await say(result.say);
  }

  if (autoListenEnabled) {
    for (let i = 0; i < maxAutoTurns; i++) {
      const pendingKind = runtime.state?.pending?.kind;
      if (!pendingKind) break;

      const text2 = await autoListenOnce();
      if (!text2) {
        // If we heard nothing, repeat the question once, then exit.
        if (pendingKind === 'ask_time') await say('What time should I remind you? For example: 7am.');
        break;
      }

      const result2 = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text: text2, state: runtime.state });
      runtime.state = result2.state ?? runtime.state;

      if (result2.say) {
        await say(result2.say);
      }
    }
  }

  if (result.intent === 'ack_latest') {
    const id = runtime.state.lastNotifiedReminderId;
    if (id) await remindersPost('/reminders/ack', { id });
    await say(result.say);
    return;
  }

  if (result.intent === 'query_reminders') {
    // Pull reminders from daemon and answer via LLM
    const all = await remindersGet('/reminders/all');
    const reminders = all?.json?.reminders || [];

    // Minimal engine-like wrapper for selectRemindersForQuery() expectations
    const engineLike = {
      listAll: () => reminders,
      listOpen: () => reminders.filter(r => r.status === 'open'),
      listByDateRange: ({ startIso, endIso, status = null }) => {
        const start = startIso ? new Date(startIso).getTime() : -Infinity;
        const end = endIso ? new Date(endIso).getTime() : Infinity;
        return reminders
          .filter(r => {
            const t = new Date(r.dueAtIso).getTime();
            if (Number.isNaN(t)) return false;
            if (t < start || t > end) return false;
            if (status && r.status !== status) return false;
            return true;
          })
          .sort((a, b) => new Date(a.dueAtIso) - new Date(b.dueAtIso));
      }
    };

    const selected = selectRemindersForQuery(engineLike, result.queryText);
    const answer = await answerReminderQuery({
      baseUrl,
      apiKeyEnv,
      model: DEFAULTS.chatModel,
      queryText: result.queryText,
      reminders: selected
    });
    await say(answer);
    return;
  }

  if (result.intent === 'set_volume') {
    let pct = null;
    if (DEFAULTS.alsaVolumeRawControl) {
      const r = await setVolumePercentRaw({
        card: DEFAULTS.alsaCard,
        control: DEFAULTS.alsaVolumeRawControl,
        percent: result.percent,
        min: DEFAULTS.alsaVolumeRawMin,
        max: DEFAULTS.alsaVolumeRawMax
      });
      pct = r.percent;
    } else {
      pct = await setVolumePercent({
        card: DEFAULTS.alsaCard,
        control: DEFAULTS.alsaVolumeControl,
        percent: result.percent
      });
    }
    await say(`Done — volume set to ${pct} percent.`);
    return;
  }

  await say(result.say || 'Okay.');
  } finally {
    busy = false;
    // If any reminders arrived while we were busy, speak them now.
    void drainNotifyQueue();
  }
}

const PTT_MODE = (process.env.POCKETAGENT_PTT_MODE || 'gpio').toLowerCase();

async function safeOneTurn(abortSignal = null) {
  const onStart = process.env.POCKETAGENT_ON_TURN_START_CMD || '';
  const onEnd = process.env.POCKETAGENT_ON_TURN_END_CMD || '';
  const onEndDelayMs = Number(process.env.POCKETAGENT_ON_TURN_END_DELAY_MS ?? 0);

  try {
    // Stop/duck external audio sources (e.g., shairport-sync) before recording.
    try { await runHook(onStart); } catch (e) { console.error('[PocketAgent] on-turn-start hook failed:', e?.message ?? e); }

    await oneTurn({ abortSignal });
  } catch (e) {
    console.error(e);
    try { await say('Something went wrong. Check the logs.'); } catch {}
  } finally {
    // Resume external audio sources after we finish speaking.
    try {
      if (onEndDelayMs > 0) await new Promise(r => setTimeout(r, onEndDelayMs));
      await runHook(onEnd);
    } catch (e) {
      console.error('[PocketAgent] on-turn-end hook failed:', e?.message ?? e);
    }
  }
}

function logConfig() {
  const sttModel = DEFAULTS.whisperModel;
  const chatModel = DEFAULTS.chatModel;
  const ttsModel = DEFAULTS.ttsModel;
  console.log('[PocketAgent] mode:', PTT_MODE);
  console.log('[PocketAgent] models:', { stt: sttModel, chat: chatModel, tts: ttsModel, voice: DEFAULTS.ttsVoice });
  console.log('[PocketAgent] audio:', {
    sampleRateHertz: DEFAULTS.sampleRateHertz,
    recordingDevice: DEFAULTS.recordingDevice,
    playbackCommand: DEFAULTS.playbackCommand,
    playbackDevice: DEFAULTS.playbackDevice
  });
  if (PTT_MODE !== 'stdin') {
    console.log('[PocketAgent] gpio:', {
      chip: process.env.POCKETAGENT_GPIO_CHIP || 'gpiochip0',
      line: Number(process.env.POCKETAGENT_PTT_GPIO_LINE ?? 23),
      activeLow: (process.env.POCKETAGENT_PTT_ACTIVE_LOW ?? 'true')
    });
  }
}

logConfig();
console.log('[PocketAgent] cwd:', process.cwd());

if (PTT_MODE === 'stdin') {
  // Dev mode: press ENTER to simulate a button press.
  console.log('PocketAgent running. Press ENTER to simulate hold-to-talk.');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async () => safeOneTurn(null));
} else {
  // Hardware mode: use ULTRA++ button on GPIO23 by default.
  console.log('PocketAgent running. Waiting for push-to-talk button.');

  let inTurn = false;
  let controller = null;
  let pressAtMs = 0;
  let holdTimer = null;

  // Tap vs hold behavior:
  // - Quick tap: ONLY wake the display (no recording, no reminder state machine)
  // - Hold: start a voice turn after HOLD_TO_TALK_MS
  const HOLD_TO_TALK_MS = Number(process.env.POCKETAGENT_HOLD_TO_TALK_MS ?? 350);
  const MIN_HOLD_MS = Number(process.env.POCKETAGENT_PTT_MIN_HOLD_MS ?? 600);

  const watcher = (PTT_MODE === 'whisplay') ? startWhisplayButtonWatcher() : startButtonWatcher();
  watcher
    .onPress(() => {
      if (inTurn) return;
      pressAtMs = Date.now();

      // Wake display immediately on any press.
      try { void displayUpdate({ status: 'idle' }); } catch {}

      // Do NOT start recording yet. Wait to see if this is a hold.
      holdTimer = setTimeout(() => {
        if (inTurn) return;
        inTurn = true;
        controller = new AbortController();

        // Start recording; release will abort.
        void safeOneTurn(controller.signal).finally(() => {
          setTimeout(() => {
            inTurn = false;
            controller = null;
            pressAtMs = 0;
          }, Number(process.env.POCKETAGENT_PTT_COOLDOWN_MS ?? 200));
        });
      }, Math.max(0, HOLD_TO_TALK_MS));
    })
    .onRelease(() => {
      // If user released before we started a turn, it's a tap: do nothing else.
      if (!inTurn) {
        if (holdTimer) {
          try { clearTimeout(holdTimer); } catch {}
          holdTimer = null;
        }
        pressAtMs = 0;
        return;
      }

      // If we *did* start a turn, stop recording when user releases button.
      const elapsed = pressAtMs ? (Date.now() - pressAtMs) : Infinity;
      const delay = Math.max(0, MIN_HOLD_MS - elapsed);
      if (delay > 0) {
        setTimeout(() => {
          try { controller?.abort(); } catch {}
        }, delay);
      } else {
        try { controller?.abort(); } catch {}
      }
    });
}
