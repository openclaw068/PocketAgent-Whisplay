#!/usr/bin/env node
// Smoke test for recurring reminders + ask-mode followups.
// Starts reminders_daemon (in-process), adds a recurring reminder due soon,
// then acks+reschedules and verifies dueAtIso advanced.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function req({ method, port, path: pathname, payload }) {
  const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
  const opts = {
    method,
    hostname: '127.0.0.1',
    port,
    path: pathname,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {},
    timeout: 5000
  };
  return new Promise((resolve, reject) => {
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function waitForHealth(port, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await req({ method: 'GET', port, path: '/health' });
      if (r.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('daemon not healthy');
}

async function main() {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const dataDir = path.join(root, 'tmp-smoke');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 4791;

  // Start daemon as a child process so it uses its normal main().
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(root, 'pocketagent', 'reminders_daemon.js')], {
    env: {
      ...process.env,
      POCKETAGENT_DATA_DIR: dataDir,
      POCKETAGENT_REMINDERS_PORT: String(port),
      POCKETAGENT_NOTIFY_URL: 'http://127.0.0.1:9999/notify' // dead endpoint OK
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));

  try {
    await waitForHealth(port);

    // Add recurring reminder with ask-mode followup default.
    const add = await req({
      method: 'POST',
      port,
      path: '/reminders/add',
      payload: {
        reminderText: 'smoke: stretch',
        timeText: 'in 1 minute',
        followupSpec: { kind: 'use_default' },
        recurrence: { kind: 'rrule', rrule: 'FREQ=MINUTELY;INTERVAL=2', timezone: 'UTC' }
      }
    });
    if (!add.json?.ok) throw new Error('add failed: ' + add.raw);
    const r0 = add.json.reminder;
    if (!r0.isRecurring || !r0.rrule) throw new Error('recurrence not persisted');

    // Ack+reschedule using next occurrence.
    const { nextFromRRule } = await import(path.join(root, 'pocketagent', 'recurrence.js'));
    const nextDueAtIso = nextFromRRule({ rrule: r0.rrule, dtStart: new Date(r0.dueAtIso), after: new Date(), tz: r0.timezone });
    if (!nextDueAtIso) throw new Error('nextFromRRule returned null');

    const ack = await req({ method: 'POST', port, path: '/reminders/ack_and_reschedule', payload: { id: r0.id, nextDueAtIso } });
    if (!ack.json?.ok) throw new Error('ack_and_reschedule failed: ' + ack.raw);

    const all = await req({ method: 'GET', port, path: '/reminders/all' });
    const r1 = (all.json?.reminders || []).find(x => x.id === r0.id);
    if (!r1) throw new Error('reminder missing after ack');
    if (r1.dueAtIso !== nextDueAtIso) throw new Error('dueAtIso not advanced');

    console.log('OK', { id: r0.id, dueAtIso: r1.dueAtIso, followupMode: r1.followupMode, isRecurring: r1.isRecurring });
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    // give it a moment
    await new Promise(r => setTimeout(r, 150));
    if (logs.length) {
      // comment out if too noisy
      // console.log(logs.join(''));
    }
  }
}

main().catch(e => {
  console.error('FAIL', e);
  process.exit(1);
});
