export interface ParsedDuration {
  ms: number;
  seconds: number;
  label: string;
}

/**
 * Parses time expressions like '30s', '45 sec', '5m', '10 mins', '2h', '3 days', 'in 15m'
 */
export function parseDuration(text: string): ParsedDuration | null {
  if (!text) return null;
  const cleaned = text.toLowerCase().trim()
    .replace(/^(?:remind\s+(?:me\s+)?(?:in\s+)?|snooze\s+(?:for\s+|in\s+)?|set\s+reminder\s+(?:for\s+)?|in\s+)/i, '')
    .trim();

  // Regex patterns (supporting e.g. 5s, 5. hours, 34 mins)
  const match = cleaned.match(/^(\d+(?:\.\d*)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (isNaN(value) || value <= 0) return null;

  const unit = (match[2] || 'm').toLowerCase();

  let ms = 0;
  let label = '';

  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) {
    ms = Math.round(value * 1000);
    label = `${value} second${value === 1 ? '' : 's'}`;
  } else if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) {
    ms = Math.round(value * 60 * 1000);
    label = `${value} minute${value === 1 ? '' : 's'}`;
  } else if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {
    ms = Math.round(value * 60 * 60 * 1000);
    label = `${value} hour${value === 1 ? '' : 's'}`;
  } else if (['d', 'day', 'days'].includes(unit)) {
    ms = Math.round(value * 24 * 60 * 60 * 1000);
    label = `${value} day${value === 1 ? '' : 's'}`;
  } else if (['w', 'week', 'weeks'].includes(unit)) {
    ms = Math.round(value * 7 * 24 * 60 * 60 * 1000);
    label = `${value} week${value === 1 ? '' : 's'}`;
  } else {
    // default to minutes if unspecified
    ms = Math.round(value * 60 * 1000);
    label = `${value} minute${value === 1 ? '' : 's'}`;
  }

  return {
    ms,
    seconds: Math.round(ms / 1000),
    label,
  };
}

export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'now';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return `${days}d`;
}
