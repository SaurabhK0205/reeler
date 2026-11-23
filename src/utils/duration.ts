import {
  getTimeInZone,
  zonedDateTimeToUtc,
  getTimeZoneAbbreviation,
  isValidTimeZone,
} from './timezone.ts';

export interface ParsedDuration {
  ms: number;
  seconds: number;
  label: string;
  targetDate: Date;
  formattedTarget: string;
}

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const DAY_OF_WEEK_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function getEffectiveTimeZone(explicitZone?: string): string {
  if (explicitZone && isValidTimeZone(explicitZone)) return explicitZone;
  if (process.env.APP_TIMEZONE && isValidTimeZone(process.env.APP_TIMEZONE)) return process.env.APP_TIMEZONE;
  if (process.env.TZ && isValidTimeZone(process.env.TZ)) return process.env.TZ;
  return 'UTC';
}

export function formatTargetTime(target: Date, now: Date = new Date(), timeZone?: string): string {
  const safeZone = getEffectiveTimeZone(timeZone);
  const nowParts = getTimeInZone(now, safeZone);
  const targetParts = getTimeInZone(target, safeZone);

  const isSameDay =
    targetParts.year === nowParts.year &&
    targetParts.month === nowParts.month &&
    targetParts.day === nowParts.day;

  const nowDateInZone = new Date(Date.UTC(nowParts.year, nowParts.month, nowParts.day));
  const targetDateInZone = new Date(Date.UTC(targetParts.year, targetParts.month, targetParts.day));
  const dayDiff = Math.round((targetDateInZone.getTime() - nowDateInZone.getTime()) / (1000 * 60 * 60 * 24));
  const isTomorrow = dayDiff === 1;

  const tzAbbr = getTimeZoneAbbreviation(target, safeZone);
  const tzSuffix = tzAbbr ? ` ${tzAbbr}` : '';

  const timeStr = target.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: safeZone,
  });

  if (isSameDay) {
    const diffSec = Math.round((target.getTime() - now.getTime()) / 1000);
    if (diffSec < 60) {
      const secTimeStr = target.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: safeZone,
      });
      return `today at ${secTimeStr}${tzSuffix}`;
    }
    return `today at ${timeStr}${tzSuffix}`;
  }

  if (isTomorrow) {
    return `tomorrow at ${timeStr}${tzSuffix}`;
  }

  const monthName = target.toLocaleDateString('en-US', { month: 'short', timeZone: safeZone });
  const dayNum = targetParts.day;

  if (dayDiff <= 7 && dayDiff > 0) {
    const weekday = target.toLocaleDateString('en-US', { weekday: 'short', timeZone: safeZone });
    return `${weekday}, ${monthName} ${dayNum} at ${timeStr}${tzSuffix}`;
  }

  const yearStr = targetParts.year !== nowParts.year ? ` ${targetParts.year}` : '';
  return `${monthName} ${dayNum}${yearStr} at ${timeStr}${tzSuffix}`;
}

function parseTimePart(text: string): { hour: number; minute: number } | null {
  // Matches e.g. "5pm", "5:30pm", "5:30 pm", "17:00", "5 am"
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3] ? m[3].toLowerCase() : null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  return { hour, minute };
}

/**
 * Parses time expressions:
 * - Relative: '5s', '30s', '45 sec', '5m', '10 mins', '2h', '5 days', 'in 15m', 'remind me in 5 days'
 * - Natural: 'tomorrow', 'tomorrow at 5pm', 'tonight', 'friday at 6pm'
 * - Dates: '12 nov', 'nov 12 at 3pm', '15th november', '12/11', '2026-11-12'
 */
export function parseDuration(
  rawText: string,
  now: Date = new Date(),
  timeZone?: string
): ParsedDuration | null {
  if (!rawText) return null;
  const safeZone = getEffectiveTimeZone(timeZone);

  let text = rawText
    .toLowerCase()
    .trim()
    .replace(/^(?:remind\s+(?:me\s+)?(?:in\s+|at\s+|on\s+)?|snooze\s+(?:for\s+|in\s+)?|reschedule\s+(?:for\s+|in\s+|to\s+)?|set\s+reminder\s+(?:for\s+)?|in\s+|on\s+|at\s+)/i, '')
    .trim();

  // 1. Relative units (e.g. 5s, 34 mins, 5. hours, 5 days, 2 weeks)
  const relMatch = text.match(/^(\d+(?:\.\d*)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months)?$/i);
  if (relMatch) {
    const val = parseFloat(relMatch[1]);
    if (!isNaN(val) && val > 0) {
      const unit = (relMatch[2] || 'm').toLowerCase();
      let ms = 0;
      let label = '';
      if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) {
        ms = Math.round(val * 1000);
        label = `${val} second${val === 1 ? '' : 's'}`;
      } else if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) {
        ms = Math.round(val * 60 * 1000);
        label = `${val} minute${val === 1 ? '' : 's'}`;
      } else if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {
        ms = Math.round(val * 60 * 60 * 1000);
        label = `${val} hour${val === 1 ? '' : 's'}`;
      } else if (['d', 'day', 'days'].includes(unit)) {
        ms = Math.round(val * 24 * 60 * 60 * 1000);
        label = `${val} day${val === 1 ? '' : 's'}`;
      } else if (['w', 'week', 'weeks'].includes(unit)) {
        ms = Math.round(val * 7 * 24 * 60 * 60 * 1000);
        label = `${val} week${val === 1 ? '' : 's'}`;
      } else if (['mo', 'month', 'months'].includes(unit)) {
        ms = Math.round(val * 30 * 24 * 60 * 60 * 1000);
        label = `${val} month${val === 1 ? '' : 's'}`;
      }
      if (ms > 0) {
        const targetDate = new Date(now.getTime() + ms);
        return {
          ms,
          seconds: Math.round(ms / 1000),
          label,
          targetDate,
          formattedTarget: formatTargetTime(targetDate, now, safeZone),
        };
      }
    }
  }

  const nowParts = getTimeInZone(now, safeZone);

  // 2. Tomorrow / Tonight / Today
  if (text.includes('tomorrow') || text.includes('tonight') || text.includes('today')) {
    const parsedTime = parseTimePart(text);
    let targetParts: { year: number; month: number; day: number; hour: number; minute: number; second: number } = {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: 10,
      minute: 0,
      second: 0,
    };

    if (text.includes('tomorrow')) {
      targetParts.day = nowParts.day + 1;
      if (parsedTime) {
        targetParts.hour = parsedTime.hour;
        targetParts.minute = parsedTime.minute;
      } else if (text.includes('morning')) {
        targetParts.hour = 9;
      } else if (text.includes('afternoon')) {
        targetParts.hour = 14;
      } else if (text.includes('evening')) {
        targetParts.hour = 18;
      } else if (text.includes('night')) {
        targetParts.hour = 21;
      } else {
        targetParts.hour = 10;
      }
    } else if (text.includes('tonight')) {
      targetParts.hour = 21;
    } else if (text.includes('today')) {
      if (parsedTime) {
        targetParts.hour = parsedTime.hour;
        targetParts.minute = parsedTime.minute;
      }
    }

    let target = zonedDateTimeToUtc(targetParts, safeZone);

    if (text.includes('tonight') && target.getTime() <= now.getTime()) {
      target = new Date(now.getTime() + 3 * 3600 * 1000); // 3 hours from now if already past 9pm
    } else if (text.includes('today') && target.getTime() <= now.getTime()) {
      targetParts.day += 1;
      target = zonedDateTimeToUtc(targetParts, safeZone);
    }

    const ms = target.getTime() - now.getTime();
    if (ms > 0) {
      return {
        ms,
        seconds: Math.round(ms / 1000),
        label: text.includes('tomorrow') ? 'Tomorrow' : 'Tonight',
        targetDate: target,
        formattedTarget: formatTargetTime(target, now, safeZone),
      };
    }
  }

  // 3. Day of week (e.g. "friday at 6pm", "next monday")
  for (const [dayName, dayIndex] of Object.entries(DAY_OF_WEEK_MAP)) {
    const dayRegex = new RegExp(`\\b${dayName}\\b`, 'i');
    if (dayRegex.test(text)) {
      const nowDayOfWeek = new Date(Date.UTC(nowParts.year, nowParts.month, nowParts.day)).getUTCDay();
      let diff = (dayIndex - nowDayOfWeek + 7) % 7;
      if (diff === 0) diff = 7; // next week if same day

      const parsedTime = parseTimePart(text);
      const targetParts = {
        year: nowParts.year,
        month: nowParts.month,
        day: nowParts.day + diff,
        hour: parsedTime ? parsedTime.hour : 10,
        minute: parsedTime ? parsedTime.minute : 0,
        second: 0,
      };

      const target = zonedDateTimeToUtc(targetParts, safeZone);
      const ms = target.getTime() - now.getTime();
      if (ms > 0) {
        return {
          ms,
          seconds: Math.round(ms / 1000),
          label: `${dayName.charAt(0).toUpperCase() + dayName.slice(1)}`,
          targetDate: target,
          formattedTarget: formatTargetTime(target, now, safeZone),
        };
      }
    }
  }

  // 4. Particular dates (e.g. "12 nov", "nov 12", "12th november", "15 nov at 4pm", "12/11", "2026-11-12")
  const numDateMatch = text.match(/\b(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?)\b/);
  if (numDateMatch) {
    let year = nowParts.year;
    let month = nowParts.month;
    let day = nowParts.day;

    if (numDateMatch[1]) {
      year = parseInt(numDateMatch[1], 10);
      month = parseInt(numDateMatch[2], 10) - 1;
      day = parseInt(numDateMatch[3], 10);
    } else {
      day = parseInt(numDateMatch[4], 10);
      month = parseInt(numDateMatch[5], 10) - 1;
      if (numDateMatch[6]) year = parseInt(numDateMatch[6], 10);
    }

    const parsedTime = parseTimePart(text.replace(numDateMatch[0], ''));
    let target = zonedDateTimeToUtc({
      year,
      month,
      day,
      hour: parsedTime ? parsedTime.hour : 10,
      minute: parsedTime ? parsedTime.minute : 0,
      second: 0,
    }, safeZone);

    if (target.getTime() < now.getTime() && !numDateMatch[1] && !numDateMatch[6]) {
      target = zonedDateTimeToUtc({
        year: year + 1,
        month,
        day,
        hour: parsedTime ? parsedTime.hour : 10,
        minute: parsedTime ? parsedTime.minute : 0,
        second: 0,
      }, safeZone);
    }

    const ms = target.getTime() - now.getTime();
    if (ms > 0) {
      return {
        ms,
        seconds: Math.round(ms / 1000),
        label: formatTargetTime(target, now, safeZone),
        targetDate: target,
        formattedTarget: formatTargetTime(target, now, safeZone),
      };
    }
  }

  // Match textual dates like "12th nov", "12 november", "nov 12", "november 15th"
  const datePattern = /(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})|([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?)(?:\s+(\d{4}))?/i;
  const dateMatch = text.match(datePattern);
  if (dateMatch) {
    const rawDay = dateMatch[1] || dateMatch[4];
    const rawMonth = (dateMatch[2] || dateMatch[3]).toLowerCase();
    const rawYear = dateMatch[5];

    if (rawDay && rawMonth && MONTH_MAP[rawMonth] !== undefined) {
      const day = parseInt(rawDay, 10);
      const month = MONTH_MAP[rawMonth];
      let year = rawYear ? parseInt(rawYear, 10) : nowParts.year;

      const parsedTime = parseTimePart(text.replace(dateMatch[0], ''));
      let target = zonedDateTimeToUtc({
        year,
        month,
        day,
        hour: parsedTime ? parsedTime.hour : 10,
        minute: parsedTime ? parsedTime.minute : 0,
        second: 0,
      }, safeZone);

      if (!rawYear && target.getTime() < now.getTime()) {
        target = zonedDateTimeToUtc({
          year: year + 1,
          month,
          day,
          hour: parsedTime ? parsedTime.hour : 10,
          minute: parsedTime ? parsedTime.minute : 0,
          second: 0,
        }, safeZone);
      }

      const ms = target.getTime() - now.getTime();
      if (ms > 0) {
        return {
          ms,
          seconds: Math.round(ms / 1000),
          label: `${rawDay} ${rawMonth.charAt(0).toUpperCase() + rawMonth.slice(1)}`,
          targetDate: target,
          formattedTarget: formatTargetTime(target, now, safeZone),
        };
      }
    }
  }

  // 5. Standalone time today (e.g. "at 5pm", "5:30pm", "17:00")
  const standaloneTime = parseTimePart(text);
  if (standaloneTime && (text.includes('pm') || text.includes('am') || text.includes(':') || text.startsWith('at '))) {
    let target = zonedDateTimeToUtc({
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: standaloneTime.hour,
      minute: standaloneTime.minute,
      second: 0,
    }, safeZone);

    if (target.getTime() <= now.getTime()) {
      target = zonedDateTimeToUtc({
        year: nowParts.year,
        month: nowParts.month,
        day: nowParts.day + 1,
        hour: standaloneTime.hour,
        minute: standaloneTime.minute,
        second: 0,
      }, safeZone);
    }

    const ms = target.getTime() - now.getTime();
    if (ms > 0) {
      return {
        ms,
        seconds: Math.round(ms / 1000),
        label: formatTargetTime(target, now, safeZone),
        targetDate: target,
        formattedTarget: formatTargetTime(target, now, safeZone),
      };
    }
  }

  return null;
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

/**
 * Validates and parses an ISO date or calendar date string.
 * Strictly verifies calendar components to reject impossible rollover dates (e.g. February 30, April 31,
 * or expanded-year variants like +002026-02-30) that standard JavaScript Date.parse silently shifts to subsequent months.
 * Rejects unsupported or malformed representations before native Date construction.
 * Returns the parsed Date object, or null if invalid or malformed.
 */
export function parseDurationOrDateInput(input: unknown): Date | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 64) return null;

  // Strict ISO pattern supporting 4-digit years or 6-digit expanded years (e.g. +002026)
  const isoMatch = trimmed.match(
    /^(?:([+-]\d{6})|(\d{4}))-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|([+-])(\d{2}):?(\d{2})?)?)?$/i
  );
  if (!isoMatch) {
    return null; // Reject unsupported or malformed representations
  }

  const rawYear = isoMatch[1] !== undefined ? isoMatch[1] : isoMatch[2];
  const year = Number(rawYear);
  const month = Number(isoMatch[3]);
  const day = Number(isoMatch[4]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Determine exact maximum valid days for the given month and year using proleptic Gregorian rules
  // (avoiding Date.UTC's legacy 0-99 year remapping to 1900-1999)
  let daysInMonth = 31;
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    daysInMonth = isLeap ? 29 : 28;
  } else if (month === 4 || month === 6 || month === 9 || month === 11) {
    daysInMonth = 30;
  }
  if (day > daysInMonth) return null;

  if (isoMatch[5] !== undefined) {
    const hour = Number(isoMatch[5]);
    const minute = Number(isoMatch[6]);
    const second = isoMatch[7] !== undefined ? Math.floor(Number(isoMatch[7])) : 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;

  return new Date(timestamp);
}

/**
 * Compares two ISO date/time strings by parsed millisecond instant rather than exact string equality,
 * safely handling timezone offsets, sub-second precision, and null/undefined values.
 */
export function isSameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const normA = a ?? null;
  const normB = b ?? null;
  if (normA === null || normB === null) return normA === normB;
  const timeA = new Date(normA).getTime();
  const timeB = new Date(normB).getTime();
  return !Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA === timeB;
}


