import schedule from 'node-schedule';
import { loadJson, saveJson } from './store.js';

function nowMs() { return Date.now(); }

export class ReminderEngine {
  constructor({ dbFile, timezone }) {
    this.dbFile = dbFile;
    this.tz = timezone;
    this.state = loadJson(dbFile, { reminders: [] });
    this.jobs = new Map();
    this.followupTimers = new Map(); // id -> timeout handle
  }

  save() {
    saveJson(this.dbFile, this.state);
  }

  listOpen() {
    return this.state.reminders.filter(r => r.status === 'open');
  }

  listAll() {
    return [...this.state.reminders];
  }

  listByDateRange({ startIso, endIso, status = null }) {
    const start = startIso ? new Date(startIso).getTime() : -Infinity;
    const end = endIso ? new Date(endIso).getTime() : Infinity;
    return this.state.reminders
      .filter(r => {
        const t = new Date(r.dueAtIso).getTime();
        if (Number.isNaN(t)) return false;
        if (t < start || t > end) return false;
        if (status && r.status !== status) return false;
        return true;
      })
      .sort((a,b) => new Date(a.dueAtIso) - new Date(b.dueAtIso));
  }

  add(reminder) {
    const r = {
      id: reminder.id,
      text: reminder.text,
      dueAtIso: reminder.dueAtIso,
      createdAtIso: new Date().toISOString(),
      status: 'open',

      // recurrence (v2)
      isRecurring: reminder.isRecurring ?? false,
      rrule: reminder.rrule ?? null,
      timezone: reminder.timezone ?? null,

      // follow-up policy
      followupMode: reminder.followupMode ?? null, // ask|once|repeat|null
      followupEveryMin: reminder.followupEveryMin ?? null,
      followupMaxCount: reminder.followupMaxCount ?? null,
      followupQuietHours: reminder.followupQuietHours ?? { start: 23, end: 7 },
      followupCount: 0,
      lastNotifiedAtIso: null,
      acknowledgedAtIso: null,
      followupAskedAtIso: null
    };
    this.state.reminders.push(r);
    this.save();
    this._scheduleReminder(r);
    return r;
  }

  update(id, patch = {}) {
    const r = this.state.reminders.find(x => x.id === id);
    if (!r) return null;

    // Apply supported patches
    if (patch.text != null) r.text = String(patch.text);
    if (patch.dueAtIso != null) r.dueAtIso = String(patch.dueAtIso);

    if (patch.followupMode !== undefined) r.followupMode = patch.followupMode;
    if (patch.followupEveryMin !== undefined) r.followupEveryMin = patch.followupEveryMin === null ? null : Number(patch.followupEveryMin);
    if (patch.followupMaxCount !== undefined) r.followupMaxCount = patch.followupMaxCount === null ? null : Number(patch.followupMaxCount);
    if (patch.followupQuietHours !== undefined) r.followupQuietHours = patch.followupQuietHours;

    // Reset follow-up counters if relevant settings changed
    r.followupCount = 0;
    r.lastNotifiedAtIso = null;
    r.followupAskedAtIso = null;

    this.save();
    this._scheduleReminder(r);
    this._cancelFollowup(r.id);

    return r;
  }

  delete(id) {
    const idx = this.state.reminders.findIndex(x => x.id === id);
    if (idx < 0) return null;
    const r = this.state.reminders[idx];
    this.state.reminders.splice(idx, 1);
    this.save();
    this._cancel(id);
    this._cancelFollowup(id);
    return r;
  }

  acknowledge(id) {
    const r = this.state.reminders.find(x => x.id === id);
    if (!r) return null;

    // For recurring reminders, we treat acknowledgement as completing this occurrence.
    // The daemon/main process should update dueAtIso to the next occurrence.
    // (We keep status open here so it remains active.)
    if (r.isRecurring) {
      r.acknowledgedAtIso = new Date().toISOString();
      r.lastNotifiedAtIso = null;
      r.followupCount = 0;
      this.save();
      this._cancel(id);
      this._cancelFollowup(id);
      return r;
    }

    r.status = 'done';
    r.acknowledgedAtIso = new Date().toISOString();
    this.save();
    this._cancel(id);
    this._cancelFollowup(id);
    return r;
  }

  start(notifyFn) {
    this.notifyFn = notifyFn;

    const now = Date.now();
    // schedule all open reminders, but also handle overdue reminders + resume follow-ups
    for (const r of this.listOpen()) {
      const dueMs = new Date(r.dueAtIso).getTime();

      // If overdue and never notified, fire ASAP.
      if (!Number.isNaN(dueMs) && dueMs <= now && !r.lastNotifiedAtIso) {
        setTimeout(() => this._fire(r.id), 1000);
        continue;
      }

      // If overdue and ask-mode already asked, do NOT re-notify on restart.
      if (!Number.isNaN(dueMs) && dueMs <= now && r.followupMode === 'ask' && r.followupAskedAtIso) {
        // still ensure the base job is scheduled (in case dueAtIso is updated later)
        this._scheduleReminder(r);
        continue;
      }

      this._scheduleReminder(r);

      // If already notified and followups are enabled, resume followup loop based on lastNotifiedAt.
      if (r.lastNotifiedAtIso && r.followupEveryMin && r.followupEveryMin > 0) {
        this._scheduleFollowup(r);
      }
    }
  }

  _cancel(id) {
    const job = this.jobs.get(id);
    if (job) job.cancel();
    this.jobs.delete(id);
  }

  _cancelFollowup(id) {
    const t = this.followupTimers.get(id);
    if (t) clearTimeout(t);
    this.followupTimers.delete(id);
  }

  _scheduleReminder(r) {
    // One-shot reminder: schedule directly on the Date.
    // Timezone correctness comes from the system timezone on the Pi.
    this._cancel(r.id);
    const date = new Date(r.dueAtIso);
    const job = schedule.scheduleJob(date, async () => {
      await this._fire(r.id);
    });
    this.jobs.set(r.id, job);
  }

  async _fire(id) {
    const r = this.state.reminders.find(x => x.id === id);
    if (!r || r.status !== 'open') return;

    const nowIso = new Date().toISOString();
    r.lastNotifiedAtIso = nowIso;

    // ask-mode: we want a single prompt after due, and then never repeat followups.
    // We track that we already asked so restarts don't re-ask.
    if (r.followupMode === 'ask' && !r.followupAskedAtIso) {
      r.followupAskedAtIso = nowIso;
    }

    this.save();
    await this.notifyFn?.(r, { kind: 'due' });

    // schedule follow-ups as separate timers (repeat mode only)
    if (r.followupEveryMin && r.followupEveryMin > 0 && r.followupMode !== 'ask') {
      this._scheduleFollowup(r);
    }
  }

  _inQuietHours(quiet, d = new Date()) {
    const h = d.getHours();
    const start = quiet?.start ?? 23;
    const end = quiet?.end ?? 7;
    if (start === end) return false;
    if (start < end) return h >= start && h < end;
    return h >= start || h < end; // wraps midnight
  }

  _scheduleFollowup(r) {
    this._cancelFollowup(r.id);

    const everyMs = r.followupEveryMin * 60_000;

    const scheduleNext = () => {
      const rr = this.state.reminders.find(x => x.id === r.id);
      if (!rr || rr.status !== 'open') return;

      const lastMs = rr.lastNotifiedAtIso ? new Date(rr.lastNotifiedAtIso).getTime() : Date.now();
      const nextMs = lastMs + everyMs;
      const delay = Math.max(1_000, nextMs - Date.now());

      const handle = setTimeout(tick, delay);
      this.followupTimers.set(r.id, handle);
    };

    const tick = async () => {
      const rr = this.state.reminders.find(x => x.id === r.id);
      if (!rr || rr.status !== 'open') return this._cancelFollowup(r.id);
      if (rr.followupMaxCount != null && rr.followupCount >= rr.followupMaxCount) return this._cancelFollowup(r.id);

      if (this._inQuietHours(rr.followupQuietHours)) {
        // During quiet hours, keep trying at the same cadence.
        scheduleNext();
        return;
      }

      rr.followupCount += 1;
      rr.lastNotifiedAtIso = new Date().toISOString();
      this.save();
      await this.notifyFn?.(rr, { kind: 'followup' });
      scheduleNext();
    };

    scheduleNext();
  }
}

export function newId() {
  return Math.random().toString(16).slice(2) + '-' + nowMs().toString(16);
}
