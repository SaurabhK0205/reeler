/**
 * Timezone resolution and conversion utilities for global multi-user support.
 */

const TIMEZONE_ABBREVIATIONS: Record<string, string> = {
  // Asia / Pacific
  ist: 'Asia/Kolkata',
  jst: 'Asia/Tokyo',
  kst: 'Asia/Seoul',
  cst_china: 'Asia/Shanghai',
  sgt: 'Asia/Singapore',
  hkt: 'Asia/Hong_Kong',
  ict: 'Asia/Bangkok',
  wib: 'Asia/Jakarta',
  pkt: 'Asia/Karachi',
  bst_bangladesh: 'Asia/Dhaka',
  npt: 'Asia/Kathmandu',
  aest: 'Australia/Sydney',
  aedt: 'Australia/Sydney',
  acst: 'Australia/Adelaide',
  acdt: 'Australia/Adelaide',
  awst: 'Australia/Perth',
  nzst: 'Pacific/Auckland',
  nzdt: 'Pacific/Auckland',

  // Americas
  est: 'America/New_York',
  edt: 'America/New_York',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  akst: 'America/Anchorage',
  akdt: 'America/Anchorage',
  hst: 'Pacific/Honolulu',
  ast: 'America/Halifax',
  brt: 'America/Sao_Paulo',
  art: 'America/Argentina/Buenos_Aires',

  // Europe & Middle East / Africa
  utc: 'UTC',
  gmt: 'UTC',
  z: 'UTC',
  bst: 'Europe/London',
  wet: 'Europe/Lisbon',
  cet: 'Europe/Paris',
  cest: 'Europe/Paris',
  eet: 'Europe/Athens',
  eest: 'Europe/Athens',
  msk: 'Europe/Moscow',
  trt: 'Europe/Istanbul',
  gst: 'Asia/Dubai',
  ast_arabia: 'Asia/Riyadh',
  cat: 'Africa/Harare',
  eat: 'Africa/Nairobi',
  wat: 'Africa/Lagos',
  sast: 'Africa/Johannesburg',
};

const COMMON_CITY_TIMEZONES: Record<string, string> = {
  // India & South Asia
  india: 'Asia/Kolkata',
  kolkata: 'Asia/Kolkata',
  calcutta: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata',
  bengaluru: 'Asia/Kolkata',
  hyderabad: 'Asia/Kolkata',
  chennai: 'Asia/Kolkata',
  pune: 'Asia/Kolkata',
  karachi: 'Asia/Karachi',
  lahore: 'Asia/Karachi',
  dhaka: 'Asia/Dhaka',
  colombo: 'Asia/Colombo',
  kathmandu: 'Asia/Kathmandu',

  // Americas
  'new york': 'America/New_York',
  nyc: 'America/New_York',
  brooklyn: 'America/New_York',
  boston: 'America/New_York',
  miami: 'America/New_York',
  atlanta: 'America/New_York',
  toronto: 'America/Toronto',
  montreal: 'America/Toronto',
  chicago: 'America/Chicago',
  houston: 'America/Chicago',
  dallas: 'America/Chicago',
  austin: 'America/Chicago',
  denver: 'America/Denver',
  phoenix: 'America/Phoenix',
  'los angeles': 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  sf: 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  vancouver: 'America/Vancouver',
  'mexico city': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires',

  // Europe & UK
  london: 'Europe/London',
  uk: 'Europe/London',
  england: 'Europe/London',
  manchester: 'Europe/London',
  dublin: 'Europe/Dublin',
  ireland: 'Europe/Dublin',
  paris: 'Europe/Paris',
  france: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  germany: 'Europe/Berlin',
  munich: 'Europe/Berlin',
  amsterdam: 'Europe/Amsterdam',
  netherlands: 'Europe/Amsterdam',
  brussels: 'Europe/Brussels',
  madrid: 'Europe/Madrid',
  spain: 'Europe/Madrid',
  barcelona: 'Europe/Madrid',
  rome: 'Europe/Rome',
  italy: 'Europe/Rome',
  milan: 'Europe/Rome',
  zurich: 'Europe/Zurich',
  vienna: 'Europe/Vienna',
  stockholm: 'Europe/Stockholm',
  oslo: 'Europe/Oslo',
  copenhagen: 'Europe/Copenhagen',
  helsinki: 'Europe/Helsinki',
  warsaw: 'Europe/Warsaw',
  athens: 'Europe/Athens',
  istanbul: 'Europe/Istanbul',
  moscow: 'Europe/Moscow',

  // Middle East & Africa
  dubai: 'Asia/Dubai',
  uae: 'Asia/Dubai',
  'abu dhabi': 'Asia/Dubai',
  doha: 'Asia/Qatar',
  riyadh: 'Asia/Riyadh',
  cairo: 'Africa/Cairo',
  egypt: 'Africa/Cairo',
  johannesburg: 'Africa/Johannesburg',
  'cape town': 'Africa/Johannesburg',
  nairobi: 'Africa/Nairobi',
  lagos: 'Africa/Lagos',

  // Asia / Pacific
  singapore: 'Asia/Singapore',
  'hong kong': 'Asia/Hong_Kong',
  hk: 'Asia/Hong_Kong',
  tokyo: 'Asia/Tokyo',
  japan: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  korea: 'Asia/Seoul',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  china: 'Asia/Shanghai',
  taipei: 'Asia/Taipei',
  bangkok: 'Asia/Bangkok',
  thailand: 'Asia/Bangkok',
  jakarta: 'Asia/Jakarta',
  indonesia: 'Asia/Jakarta',
  manila: 'Asia/Manila',
  philippines: 'Asia/Manila',
  'kuala lumpur': 'Asia/Kuala_Lumpur',
  malaysia: 'Asia/Kuala_Lumpur',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  brisbane: 'Australia/Brisbane',
  perth: 'Australia/Perth',
  adelaide: 'Australia/Adelaide',
  auckland: 'Pacific/Auckland',
  'new zealand': 'Pacific/Auckland',
};

/**
 * Validates if an IANA timezone identifier is recognized by the V8 runtime.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves user input (abbreviation, city, offset, or IANA name) to a canonical IANA timezone.
 * Returns null if the timezone cannot be resolved.
 */
export function resolveTimeZone(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  const lowerRaw = raw.toLowerCase();

  // 1. Explicit abbreviations take priority (maps legacy/ambiguous aliases to canonical IANA)
  if (TIMEZONE_ABBREVIATIONS[lowerRaw]) {
    return TIMEZONE_ABBREVIATIONS[lowerRaw];
  }

  // 2. City and region names
  if (COMMON_CITY_TIMEZONES[lowerRaw]) {
    return COMMON_CITY_TIMEZONES[lowerRaw];
  }

  // 3. UTC/GMT numeric offset parsing: e.g. "+5:30", "+05:30", "+5", "-5", "-04:00"
  const offsetMatch = raw.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (offsetMatch) {
    const sign = offsetMatch[1];
    const hours = parseInt(offsetMatch[2], 10);
    const minutes = offsetMatch[3] ? parseInt(offsetMatch[3], 10) : 0;

    if (hours <= 14 && minutes < 60) {
      if (sign === '+' && hours === 5 && minutes === 30) return 'Asia/Kolkata';
      if (sign === '+' && hours === 5 && minutes === 45) return 'Asia/Kathmandu';
      if (sign === '+' && hours === 9 && minutes === 30) return 'Australia/Adelaide';
      if (sign === '+' && hours === 3 && minutes === 30) return 'Asia/Tehran';
      if (sign === '+' && hours === 4 && minutes === 30) return 'Asia/Kabul';
      if (sign === '+' && hours === 6 && minutes === 30) return 'Asia/Yangon';

      const pad = (n: number) => String(n).padStart(2, '0');
      const isoOffset = `${sign}${pad(hours)}:${pad(minutes)}`;
      if (isValidTimeZone(isoOffset)) return isoOffset;
    }
  }

  // 4. Clean prefixes e.g. "tz <val>", "in <city>"
  const stripped = lowerRaw
    .replace(/^(?:timezone|tz|my timezone is|set timezone to|set tz to|in)\s+/i, '')
    .trim();

  if (TIMEZONE_ABBREVIATIONS[stripped]) {
    return TIMEZONE_ABBREVIATIONS[stripped];
  }
  if (COMMON_CITY_TIMEZONES[stripped]) {
    return COMMON_CITY_TIMEZONES[stripped];
  }

  // 4. Direct IANA match check
  if (isValidTimeZone(raw)) {
    try {
      const canonical = Intl.DateTimeFormat(undefined, { timeZone: raw }).resolvedOptions().timeZone;
      if (canonical === 'Asia/Calcutta') return 'Asia/Kolkata';
      return canonical || raw;
    } catch {
      return raw;
    }
  }

  if (isValidTimeZone(stripped)) {
    try {
      const canonical = Intl.DateTimeFormat(undefined, { timeZone: stripped }).resolvedOptions().timeZone;
      if (canonical === 'Asia/Calcutta') return 'Asia/Kolkata';
      return canonical || stripped;
    } catch {
      return stripped;
    }
  }

  return null;
}

/**
 * Returns a human-friendly display label with the timezone code and current local time.
 * E.g. "Asia/Kolkata (IST) · 10:15 PM"
 */
export function getTimeZoneSummary(timeZone: string, now: Date = new Date()): string {
  const safeZone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const abbr = getTimeZoneAbbreviation(now, safeZone);
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: safeZone,
  });

  const isUtc = safeZone === 'UTC';
  const label = isUtc ? 'UTC' : `${safeZone} (${abbr})`;
  return `${label} · ${timeStr}`;
}

/**
 * Returns the short timezone abbreviation (e.g. IST, EST, GMT, UTC).
 */
export function getTimeZoneAbbreviation(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (tzPart) {
      // Normalize GMT+5:30 to IST if timezone is Asia/Kolkata
      if ((timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta') && tzPart.includes('GMT')) {
        return 'IST';
      }
      return tzPart;
    }
  } catch {
    // fallback
  }
  return timeZone === 'UTC' ? 'UTC' : timeZone;
}

export interface ZoneDateTimeParts {
  year: number;
  month: number; // 0-indexed
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Extracts calendar date and time parts for an instant evaluated in a specific timezone.
 */
export function getTimeInZone(date: Date, timeZone: string): ZoneDateTimeParts {
  const safeZone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
  return {
    year: getPart('year'),
    month: getPart('month') - 1,
    day: getPart('day'),
    hour: getPart('hour') % 24,
    minute: getPart('minute'),
    second: getPart('second'),
  };
}

/**
 * Converts calendar year/month/day/hour/minute defined in a target timezone into a UTC Date.
 */
export function zonedDateTimeToUtc(parts: Partial<ZoneDateTimeParts>, timeZone: string): Date {
  const safeZone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const year = parts.year ?? 1970;
  const month = parts.month ?? 0;
  const day = parts.day ?? 1;
  const hour = parts.hour ?? 0;
  const minute = parts.minute ?? 0;
  const second = parts.second ?? 0;

  // 1. Initial UTC timestamp guess
  const guessUtc = Date.UTC(year, month, day, hour, minute, second);
  // 2. Measure what safeZone reports for guessUtc
  const inZone = getTimeInZone(new Date(guessUtc), safeZone);
  const inZoneUtc = Date.UTC(inZone.year, inZone.month, inZone.day, inZone.hour, inZone.minute, inZone.second);
  // 3. Offset difference adjusts guess to exact UTC target
  const diff = inZoneUtc - guessUtc;
  return new Date(guessUtc - diff);
}
