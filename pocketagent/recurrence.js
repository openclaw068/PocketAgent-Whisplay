import pkg from 'rrule';
const { RRule } = pkg;

// Build a next occurrence timestamp from an RFC5545 RRULE (no DTSTART assumed).
// We treat DTSTART as the provided dtStart (usually the first due date).

export function nextFromRRule({ rrule, dtStart, after = new Date(), tz = null }) {
  if (!rrule) return null;

  // dtStart should be a Date.
  const options = RRule.parseString(rrule);
  options.dtstart = dtStart instanceof Date ? dtStart : new Date(dtStart);

  const rule = new RRule(options);
  const next = rule.after(after, false);
  return next ? next.toISOString() : null;
}

export function isRRule(str) {
  return typeof str === 'string' && /FREQ=/.test(str);
}
