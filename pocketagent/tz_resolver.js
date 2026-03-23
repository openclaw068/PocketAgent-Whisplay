// Timezone resolver (rough match) for PocketAgent.
// Maps user phrases/cities (e.g. "St Paul", "west coast", "PST") to an IANA timezone.

const ALIASES = [
  // Central
  { re: /\b(central|cst|cdt|central time)\b/i, tz: 'America/Chicago', label: 'Central Time (America/Chicago)' },
  { re: /\b(st\.?\s*paul|saint\s*paul|minneapolis|mpls)\b/i, tz: 'America/Chicago', label: 'Central Time (America/Chicago)' },
  { re: /\b(chicago|dallas|houston|austin|san\s*antonio|kansas\s*city)\b/i, tz: 'America/Chicago', label: 'Central Time (America/Chicago)' },

  // Pacific
  { re: /\b(pacific|pst|pdt|pacific time|west coast|westcoast)\b/i, tz: 'America/Los_Angeles', label: 'Pacific Time (America/Los_Angeles)' },
  { re: /\b(san\s*diego|los\s*angeles|la\b|seattle|portland|san\s*francisco|sf\b)\b/i, tz: 'America/Los_Angeles', label: 'Pacific Time (America/Los_Angeles)' },

  // Mountain
  { re: /\b(mountain|mst|mdt|mountain time)\b/i, tz: 'America/Denver', label: 'Mountain Time (America/Denver)' },
  { re: /\b(denver|phoenix)\b/i, tz: 'America/Denver', label: 'Mountain Time (America/Denver)' },

  // Eastern
  { re: /\b(eastern|est|edt|east coast|eastern time)\b/i, tz: 'America/New_York', label: 'Eastern Time (America/New_York)' },
  { re: /\b(new\s*york|nyc|boston|miami|atlanta|dc\b|washington)\b/i, tz: 'America/New_York', label: 'Eastern Time (America/New_York)' },
];

export function resolveTimezone(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  // If user already gave an IANA timezone, accept it.
  if (/^[A-Za-z_]+\/[A-Za-z_]+$/.test(s)) {
    return { tz: s, label: s, source: 'iana' };
  }

  for (const a of ALIASES) {
    if (a.re.test(s)) return { tz: a.tz, label: a.label, source: 'alias' };
  }

  return null;
}
