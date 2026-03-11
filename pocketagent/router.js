import { chat } from './openai.js';

// LLM-based intent router for natural reminder speech.
// This replaces brittle regex-based phrase matching.
// The reminders daemon remains the source of truth; we only decide which local API to call.

export async function routeUtterance({ baseUrl, apiKeyEnv, model, text, hasLastNotified = false }) {
  const schema = {
    intent: [
      'create_reminder',
      'query_reminders',
      'ack_reminder',
      'update_followup_defaults',
      'update_reminder',
      'delete_reminder',

      // semantic memory
      'remember_fact',
      'query_memory',
      'forget_memory',

      'set_volume',
      'general_chat',
      'unknown'
    ],
    // create_reminder
    reminderText: 'string|null',
    timeText: 'string|null',
    // recurrence (optional)
    recurrence: {
      kind: 'none|rrule',
      // RFC5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=TU;INTERVAL=2
      rrule: 'string|null',
      timezone: 'string|null'
    },
    // query_reminders
    queryText: 'string|null',
    // ack_reminder
    ackTarget: 'latest|by_text|null',
    ackText: 'string|null',
    // update_followup_defaults
    defaultsText: 'string|null',

    // update/delete reminders
    target: 'latest|by_text|null',
    targetText: 'string|null',
    update: {
      timeText: 'string|null',
      reminderText: 'string|null',
      followupEveryMin: 'number|null'
    },

    // semantic memory fields
    factText: 'string|null',
    memoryQuery: 'string|null',
    forgetQuery: 'string|null',

    // set_volume
    volumePercent: 'number|null',
    volumeDeltaPercent: 'number|null',
    volumeDirection: 'up|down|null'
  };

  const sys =
    'You are PocketAgent. Your job is to route the user\'s utterance into intents for a local reminders system AND a simple semantic memory. ' +
    'Return ONLY valid JSON with no markdown. ' +
    'Prefer reminder intents when the user is explicitly scheduling/asking about timed reminders. ' +
    'Prefer semantic memory when the user is asking you to remember a fact/location with no time. ' +

    'SEMANTIC MEMORY RULES: ' +
    'If user says things like "remember I put...", "remember that I put...", "remember I left...", "remember where I put...", "store this", "save this", "note that", intent MUST be "remember_fact" and put the fact in factText. ' +
    'If user asks "where is/are ...", "where did I put ...", "what did I do with ...", "do you remember ...", intent MUST be "query_memory" and put the question in memoryQuery. ' +
    'If user says "forget"/"delete that memory" intent MUST be "forget_memory" and put what to forget in forgetQuery. ' +

    'REMINDERS RULES: ' +
    'IMPORTANT: If the user says anything like "remind me" / "set a reminder" / "remind" / "don\'t let me forget" / "remember to" AND includes a time, then intent MUST be "create_reminder". ' +
    'If the user says "remember" but does NOT provide a time and is phrasing it like a fact (e.g. "remember I put my balance board in the guest closet"), choose semantic memory (remember_fact), not create_reminder. ' +
    'IMPORTANT: If the user is answering a follow-up timing question with something like "every 5 minutes", "every five minutes", "every hour", etc., set intent="unknown" (do NOT change defaults). ' +
    'Only choose intent="update_followup_defaults" when the user clearly says they want to change DEFAULTS (e.g. "set my default follow-ups to every 5 minutes"). ' +
    'For updating reminders: if user says "change/update/edit" a reminder, choose intent="update_reminder". Use target="latest" when they say "latest" or if there is only one open reminder. Use target="by_text" when they describe it; put that description in targetText. Put changes in update (timeText, reminderText, followupEveryMin). ' +
    'For deleting reminders: if user says "delete/remove/cancel" a reminder, choose intent="delete_reminder" with the same target fields. ' +
    'For acknowledgements: if user indicates completion (done/complete/finished) and there is a recent reminder context, choose intent="ack_reminder" with ackTarget="latest". ' +
    'If the user says to complete a specific reminder by description, choose ackTarget="by_text" and set ackText to the short description (e.g., "trash"). ' +
    'VOLUME RULES: ' +
    'If user says set volume to X percent, intent="set_volume" and set volumePercent=X. ' +
    'If user says volume up / turn it up / louder, intent="set_volume" and set volumeDirection="up". ' +
    'If user says volume down / turn it down / quieter, intent="set_volume" and set volumeDirection="down". ' +
    'If user says raise/increase volume by X percent, intent="set_volume" and set volumeDeltaPercent=X. ' +
    'If user says lower/decrease volume by X percent, intent="set_volume" and set volumeDeltaPercent=-X (or set direction="down" and delta). ' +
    'If user provides both an absolute percent and a delta, prefer the absolute. ' +

    'For creating reminders, extract reminderText and timeText in the user\'s words. timeText can be a clock time ("7am") OR a relative time ("in 5 minutes", "in one minute"). ' +
    'If the user asks for a repeating reminder (e.g. "every other Tuesday", "weekends", "every day"), set recurrence.kind="rrule" and provide an RFC5545 RRULE string (no DTSTART) plus timezone (usually America/Chicago unless user says otherwise). ' +
    'If it is not repeating, set recurrence.kind="none". ' +
    'If time is missing for reminder creation, still choose create_reminder and leave timeText=null.';

  const user = {
    text,
    hasLastNotified,
    schema
  };

  const content = await chat({
    baseUrl,
    apiKeyEnv,
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(user) }
    ]
  });

  try {
    return JSON.parse(content);
  } catch {
    return { intent: 'general_chat' };
  }
}
