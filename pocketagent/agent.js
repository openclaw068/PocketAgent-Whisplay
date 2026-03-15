import { chat } from './openai.js';

async function parseFollowupSpec({ baseUrl, apiKeyEnv, model, userText }) {
  // Returns a structured follow-up policy (or "use default") extracted from natural language.
  // Fast-path: avoid LLM calls for common short phrases.
  const t0 = String(userText || '').trim().toLowerCase();

  const numberWords = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    fifteen: 15,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fortyfive: 45,
    'forty-five': 45,
    sixty: 60
  };

  const parseEveryMin = (t) => {
    // Goal: catch as many natural follow-up phrases as possible WITHOUT needing the LLM.
    // Examples we want to support:
    // - "every 5 minutes", "every five minutes", "every few minutes"
    // - "in 10 minutes" (interpreted as follow up cadence)
    // - "ping me again in 10", "nudge me in 15"
    // - "keep reminding me", "keep bugging me", "blow me up" (fallback to default cadence)
    // - "hourly", "every hour", "every half hour"
    const s0 = String(t || '').trim().toLowerCase();
    if (!s0) return null;

    // Normalize punctuation and filler
    const s = s0
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Direct intents: hourly / half-hourly
    if (/\b(hourly|every\s+hour|each\s+hour|once\s+an\s+hour)\b/.test(s)) return 60;
    if (/\b(half\s+hour|every\s+half\s+hour|each\s+half\s+hour|every\s+30\s+minutes)\b/.test(s)) return 30;

    // Common shorthand
    if (/\b(q\s*\d+)\b/.test(s)) {
      // q15 -> every 15
      const m = s.match(/\bq\s*(\d+)\b/);
      if (m) return Number(m[1]);
    }

    // "every few mins" / "every couple mins"
    if (/\bevery\s+few\s+(min|mins|minute|minutes)\b/.test(s)) return 5;
    if (/\bevery\s+couple\s+(min|mins|minute|minutes)\b/.test(s)) return 2;

    // "every X minutes" where X is digits
    {
      const m = s.match(/\b(?:every|each)\s+(\d+)\s*(min|mins|minute|minutes)\b/);
      if (m) return Number(m[1]);
    }

    // "every five minutes" where X is word
    {
      const m = s.match(/\b(?:every|each)\s+([a-z-]+)\s*(min|mins|minute|minutes)\b/);
      if (m) {
        const w = m[1];
        const n = numberWords[w] ?? NaN;
        if (Number.isFinite(n) && n > 0) return Number(n);
      }
    }

    // "in 10 minutes" / "in ten minutes" (treat as cadence)
    {
      const m = s.match(/\bin\s+(\d+)\s*(min|mins|minute|minutes)\b/);
      if (m) return Number(m[1]);
    }
    {
      const m = s.match(/\bin\s+([a-z-]+)\s*(min|mins|minute|minutes)\b/);
      if (m) {
        const w = m[1];
        const n = numberWords[w] ?? NaN;
        if (Number.isFinite(n) && n > 0) return Number(n);
      }
    }

    // "in 2 hours" for follow-up cadence (rare but plausible)
    {
      const m = s.match(/\bin\s+(\d+)\s*(hour|hours|hr|hrs)\b/);
      if (m) return Number(m[1]) * 60;
    }
    {
      const m = s.match(/\bin\s+([a-z-]+)\s*(hour|hours|hr|hrs)\b/);
      if (m) {
        const w = m[1];
        const n = numberWords[w] ?? NaN;
        if (Number.isFinite(n) && n > 0) return Number(n) * 60;
      }
    }

    // "ping/nudge/remind me again" without explicit cadence: pick a sane default.
    // "keep reminding/pinging" style requests with no explicit cadence
    if (
      (/\b(ping|nudge|remind|check\s+in|follow\s+up|bug|nag|poke)\b/.test(s) && /\b(again|until)\b/.test(s)) ||
      /\bkeep\s+(reminding|pinging|nudging|bugging|nagging|checking\s+in|following\s+up)\b/.test(s)
    ) {
      return 15;
    }

    // Aggressive slang (still interpret as default cadence)
    if (/\b(blow\s+me\s+up|spam\s+me|keep\s+spamming|keep\s+texting|don'?t\s+let\s+me\s+forget)\b/.test(s)) {
      return 10;
    }

    return null;
  };

  if (!t0) return { kind: 'use_default' };
  if (/(\bdefault\b|\busual\b)/.test(t0)) return { kind: 'use_default' };
  if (/(\bno\s+follow\b|\bdon'?t\s+follow\b|\bjust\s+once\b|\bonce\b|\bno\s+repeat\b)/.test(t0)) {
    return { kind: 'custom', everyMin: null, maxCount: null, quietHours: null };
  }

  {
    const everyMin = parseEveryMin(t0);
    if (everyMin != null) return { kind: 'custom', everyMin, maxCount: null, quietHours: null };
  }

  const schemaHint = {
    kind: 'use_default | custom',
    everyMin: 'number|null',
    maxCount: 'number|null',
    quietHours: { start: '0-23', end: '0-23' }
  };

  const content = await chat({
    baseUrl,
    apiKeyEnv,
    model,
    messages: [
      {
        role: 'system',
        content:
          'Extract reminder follow-up settings from the user. Respond with ONLY valid JSON. ' +
          'If the user wants defaults, set kind="use_default". ' +
          'If user says once/no followups, set kind="custom" and everyMin=null. ' +
          'quietHours uses local time. If user doesn\'t specify quiet hours, return null for quietHours. '
      },
      { role: 'user', content: `User said: ${userText}\nSchema: ${JSON.stringify(schemaHint)}` }
    ]
  });

  try {
    return JSON.parse(content);
  } catch {
    // heuristic fallback
    const t = t0;
    if (t.includes('default')) return { kind: 'use_default' };
    if (t.includes('once')) return { kind: 'custom', everyMin: null, maxCount: null, quietHours: null };
    const m = t.match(/every\s+(\d+)\s*(min|mins|minute|minutes)/);
    if (m) return { kind: 'custom', everyMin: Number(m[1]), maxCount: null, quietHours: null };
    return { kind: 'use_default' };
  }
}

async function parseDefaultUpdate({ baseUrl, apiKeyEnv, model, userText }) {
  // Update defaults.followup based on natural language.
  const schemaHint = {
    mode: 'once | repeat',
    everyMin: 'number|null',
    maxCount: 'number|null',
    quietHours: { start: '0-23', end: '0-23' }
  };

  const content = await chat({
    baseUrl,
    apiKeyEnv,
    model,
    messages: [
      {
        role: 'system',
        content:
          'Extract DEFAULT follow-up settings the user wants. Respond with ONLY valid JSON. ' +
          'If user wants no followups, mode="once". ' +
          'If user wants repeating followups, mode="repeat" and set everyMin. ' +
          'Also extract maxCount and quietHours when mentioned.'
      },
      { role: 'user', content: `User said: ${userText}\nSchema: ${JSON.stringify(schemaHint)}` }
    ]
  });

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function handleUtterance({ baseUrl, apiKeyEnv, model, text, state }) {
  // state: { pending, defaults }
  const t = text.trim();
  if (!t) return { say: "I didn't catch that. Try again.", state };

  // Pending: confirm volume change
  if (state.pending?.kind === 'confirm_volume') {
    if (/\b(yes|yep|yeah|do it|confirm|ok|okay)\b/i.test(t)) {
      const pct = state.pending.percent;
      return { intent: 'set_volume', percent: pct, say: `Okay — setting volume to ${pct} percent.`, state: { ...state, pending: null } };
    }
    if (/\b(no|nope|cancel|stop|never mind)\b/i.test(t)) {
      return { intent: 'cancel', say: `Okay — not changing the volume.`, state: { ...state, pending: null } };
    }
    return { intent: 'clarify', say: `Just say yes to set volume to ${state.pending.percent} percent, or no to cancel.`, state };
  }

  // Pending: confirm follow-up policy for a reminder
  if (state.pending?.kind === 'confirm_ack') {
    if (/\b(yes|yep|yeah|yas|ya|yup|sure|correct|sounds right|sounds good|ok|okay|do it|jas)\b/i.test(t)) {
      const { ackId } = state.pending;
      // Reuse this confirmation step for delete/update actions as well.
      if (state.pending._deleteOnConfirm) {
        return {
          intent: 'delete_by_id',
          id: ackId,
          say: `Okay — deleting it.`,
          state: { ...state, pending: null }
        };
      }
      if (state.pending._updatePatch) {
        return {
          intent: 'update_by_id',
          id: ackId,
          patch: state.pending._updatePatch,
          say: `Okay — updating it.`,
          state: { ...state, pending: null }
        };
      }

      return {
        intent: 'ack_by_id',
        id: ackId,
        say: `Done — I’ll mark it complete.`,
        state: { ...state, pending: null }
      };
    }
    if (/\b(no|nope|cancel|stop|never mind)\b/i.test(t)) {
      return {
        intent: 'clarify',
        say: `Okay — which reminder do you mean?`,
        state: { ...state, pending: null }
      };
    }
    return { intent: 'clarify', say: `Just say yes to confirm, or no to cancel.`, state };
  }

  if (state.pending?.kind === 'confirm_followup') {
    if (/\b(yes|yep|yeah|yas|ya|yup|sure|correct|sounds right|sounds good|ok|okay|do it|jas)\b/i.test(t)) {
      const { reminderText, timeText, followupSpec, recurrence } = state.pending;
      return {
        intent: 'set_followup',
        followupSpec,
        recurrence: recurrence ?? null,
        say: `Perfect.`,
        state: {
          ...state,
          pending: null,
          collected: { reminderText, timeText, followupSpec, recurrence: recurrence ?? null }
        }
      };
    }
    if (/\b(no|nope|cancel|stop|never mind)\b/i.test(t)) {
      // Ask again
      return {
        intent: 'clarify',
        say: `Okay — how do you want me to handle follow-ups if you don’t respond?`,
        state: {
          ...state,
          pending: { kind: 'ask_followup', reminderText: state.pending.reminderText, timeText: state.pending.timeText, recurrence: state.pending.recurrence ?? null }
        }
      };
    }
    return { intent: 'clarify', say: `Just say yes if that follow-up plan is right, or no to change it.`, state };
  }

  function looksLikeTime(text) {
    let s = text.trim().toLowerCase();
    if (!s) return false;

    // Accept relative times too (common for voice):
    // - "in 5 minutes", "in one minute", "in 2 hours"
    // - "in a minute", "in an hour"
    if (/^in\s+(a|an|one|\d+)\s+(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b/.test(s)) {
      return true;
    }

    // normalize common spoken variants:
    // "a.m."/"p.m." -> "am"/"pm", remove periods, collapse whitespace
    s = s
      .replace(/\b([ap])\s*\.?\s*m\.?\b/g, (_, ap) => `${ap}m`)
      .replace(/\./g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Accept patterns like:
    // - "7am", "7 am", "7 a.m."
    // - "7:30pm", "7:30 pm"
    // - "tomorrow 7am" or "tomorrow at 7am"
    return /^(tomorrow\s+)?(at\s+)?\d{1,2}(?::\d{2})?\s*(am|pm)?$/.test(s);
  }

  // Mid-flow: ask for time
  if (state.pending?.kind === 'ask_time') {
    // If the user says yes/no here, they're probably responding to a previous confirmation.
    if (/\b(yes|yep|yeah|no|nope|ok|okay)\b/i.test(t)) {
      return { intent: 'clarify', say: `What time should I remind you? For example: “7am” or “tomorrow 7am”.`, state };
    }

    if (!looksLikeTime(t)) {
      return { intent: 'clarify', say: `I didn’t catch a time. Say something like “7am” or “tomorrow 7am”.`, state };
    }

    return {
      intent: 'set_time',
      timeText: t,
      say: `Okay — ${t}. If I remind you and you don’t respond, how should I handle follow-ups?`,
      state: { ...state, pending: { kind: 'ask_followup', reminderText: state.pending.reminderText, timeText: t, recurrence: state.pending.recurrence ?? null } }
    };
  }

  // Mid-flow: follow-up policy
  if (state.pending?.kind === 'ask_followup') {
    // If the user gives a time here, they probably meant to answer the time question.
    if (looksLikeTime(t)) {
      return {
        intent: 'set_time',
        timeText: t,
        say: `Okay — ${t}. If I remind you and you don’t respond, how should I handle follow-ups?`,
        state: { ...state, pending: { kind: 'ask_followup', reminderText: state.pending.reminderText, timeText: t, recurrence: state.pending.recurrence ?? null } }
      };
    }

    const spec = await parseFollowupSpec({ baseUrl, apiKeyEnv, model, userText: t });

    // If the user asked for defaults, we can save immediately.
    const wantsDefault = spec?.kind === 'use_default';
    if (wantsDefault) {
      return {
        intent: 'set_followup',
        followupSpec: spec,
        say: `Got it — I’ll use your default follow-ups.`,
        state: {
          ...state,
          pending: null,
          collected: {
            reminderText: state.pending.reminderText,
            timeText: state.pending.timeText,
            followupSpec: spec,
            recurrence: state.pending.recurrence ?? null
          }
        }
      };
    }

    // Natural-language follow-up like "every five minutes" should NOT force another yes/no confirmation.
    // Confirmations are what is causing users to get stuck in the flow.
    return {
      intent: 'set_followup',
      followupSpec: spec,
      say: `Okay — I’ll follow up like that.`,
      state: {
        ...state,
        pending: null,
        collected: {
          reminderText: state.pending.reminderText,
          timeText: state.pending.timeText,
          followupSpec: spec,
          recurrence: state.pending.recurrence ?? null
        }
      }
    };
  }

  // Update default follow-up settings conversationally
  if (/\b(default|defaults)\b/i.test(t) && /\bfollow\s*-?ups?\b/i.test(t)) {
    const upd = await parseDefaultUpdate({ baseUrl, apiKeyEnv, model, userText: t });
    if (upd) {
      return {
        intent: 'update_defaults',
        defaultsPatch: upd,
        say: `Okay — I updated your default follow-up settings.`,
        state
      };
    }
  }

  // If user says they completed something
  // Support common natural phrases like “mark that reminder as complete”.
  if (/\b(done|did it|complete|completed|mark (it|that) as complete|mark (it|that) complete|yes i did|yeah i did|yep i did)\b/i.test(t)) {
    return { intent: 'ack_latest', say: `Nice — I’ll mark that as done.`, state };
  }

  // Volume commands
  // Examples: "set volume to 60%", "volume 30", "turn it down", "mute"
  if (/\b(volume|louder|quieter|turn it up|turn it down|mute)\b/i.test(t)) {
    if (/\bmute\b/i.test(t)) {
      return {
        intent: 'volume_request',
        say: `Okay. What volume percent do you want (0 to 100)?`,
        state: { ...state, pending: { kind: 'ask_volume' } }
      };
    }
    const m = t.match(/(\d{1,3})\s*%?/);
    if (m) {
      const pct = Math.max(0, Math.min(100, Number(m[1])));
      return {
        intent: 'confirm_volume',
        say: `Just to confirm — should I set the volume to ${pct} percent?`,
        state: { ...state, pending: { kind: 'confirm_volume', percent: pct } }
      };
    }
    return {
      intent: 'volume_request',
      say: `Sure — what volume percent do you want (0 to 100)?`,
      state: { ...state, pending: { kind: 'ask_volume' } }
    };
  }

  if (state.pending?.kind === 'ask_volume') {
    const m = t.match(/(\d{1,3})/);
    if (!m) return { intent: 'clarify', say: `Give me a number from 0 to 100.`, state };
    const pct = Math.max(0, Math.min(100, Number(m[1])));
    return {
      intent: 'confirm_volume',
      say: `Just to confirm — set volume to ${pct} percent?`,
      state: { ...state, pending: { kind: 'confirm_volume', percent: pct } }
    };
  }

  // Reminder queries
  // Avoid triggering on standalone words like "tomorrow" inside reminder creation utterances.
  const wantsList = /\b(list reminders|my reminders|show reminders)\b/i.test(t);
  const wantsComingUp = /\b(what do i have|what\s*'?s coming up|whats coming up|coming up|do i have (any )?reminders|any reminders|what reminders do i have)\b/i.test(t);
  const mentionsDayWord = /\b(today|tomorrow|yesterday)\b/i.test(t);
  const hasQueryVerb = /\b(what|show|list|coming up|do i have)\b/i.test(t);

  if (wantsList || wantsComingUp || (mentionsDayWord && hasQueryVerb)) {
    return { intent: 'query_reminders', queryText: t, say: `Let me check your reminders.`, state };
  }

  // Basic reminder creation
  if (/\b(remind me|i need to remember|don't let me forget|remember to)\b/i.test(t)) {
    return {
      intent: 'new_reminder',
      say: `Sure — what time should I remind you?`,
      state: { ...state, pending: { kind: 'ask_time', reminderText: t } }
    };
  }

  // Guardrails: only reminders + volume.
  return {
    intent: 'out_of_scope',
    say: `I can help with reminders and volume — set a reminder, ask what’s coming up, or say “set volume to 60 percent.”`,
    state
  };
}
