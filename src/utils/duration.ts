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

export function formatTargetTime(target: Date, now: Date = new Date()): string {
  const isSameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    target.getFullYear() === tomorrow.getFullYear() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getDate() === tomorrow.getDate();

  const timeStr = target.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (isSameDay) {
    const diffSec = Math.round((target.getTime() - now.getTime()) / 1000);
    if (diffSec < 60) {
      const secTimeStr = target.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
      return `today at ${secTimeStr}`;
    }
    return `today at ${timeStr}`;
  }

  if (isTomorrow) {
    return `tomorrow at ${timeStr}`;
  }

  const diffDays = Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const monthName = target.toLocaleDateString('en-US', { month: 'short' });
  const dayNum = target.getDate();

  if (diffDays <= 7) {
    const weekday = target.toLocaleDateString('en-US', { weekday: 'short' });
    return `${weekday}, ${monthName} ${dayNum} at ${timeStr}`;
  }

  const yearStr = target.getFullYear() !== now.getFullYear() ? ` ${target.getFullYear()}` : '';
  return `${monthName} ${dayNum}${yearStr} at ${timeStr}`;
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
export function parseDuration(rawText: string, now: Date = new Date()): ParsedDuration | null {
  if (!rawText) return null;

  let text = rawText.toLowerCase().trim()
    .replace(/^(?:remind\s+(?:me\s+)?(?:in\s+|at\s+|on\s+)?|snooze\s+(?:for\s+|in\s+)?|set\s+reminder\s+(?:for\s+)?|in\s+|on\s+|at\s+)/i, '')
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
          formattedTarget: formatTargetTime(targetDate, now),
        };
      }
    }
  }

  // 2. Tomorrow / Tonight / Today
  if (text.includes('tomorrow') || text.includes('tonight') || text.includes('today')) {
    const target = new Date(now);
    const parsedTime = parseTimePart(text);

    if (text.includes('tomorrow')) {
      target.setDate(now.getDate() + 1);
      if (parsedTime) {
        target.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
      } else if (text.includes('morning')) {
        target.setHours(9, 0, 0, 0);
      } else if (text.includes('afternoon')) {
        target.setHours(14, 0, 0, 0);
      } else if (text.includes('evening')) {
        target.setHours(18, 0, 0, 0);
      } else if (text.includes('night')) {
        target.setHours(21, 0, 0, 0);
      } else {
        target.setHours(10, 0, 0, 0); // default 10:00 AM
      }
    } else if (text.includes('tonight')) {
      target.setHours(21, 0, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setTime(now.getTime() + 3 * 3600 * 1000); // 3 hours from now if already past 9pm
      }
    } else if (text.includes('today')) {
      if (parsedTime) {
        target.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1); // roll over to tomorrow if time passed
        }
      }
    }

    const ms = target.getTime() - now.getTime();
    if (ms > 0) {
      return {
        ms,
        seconds: Math.round(ms / 1000),
        label: text.includes('tomorrow') ? 'Tomorrow' : 'Tonight',
        targetDate: target,
        formattedTarget: formatTargetTime(target, now),
      };
    }
  }

  // 3. Day of week (e.g. "friday at 6pm", "next monday")
  for (const [dayName, dayIndex] of Object.entries(DAY_OF_WEEK_MAP)) {
    const dayRegex = new RegExp(`\\b${dayName}\\b`, 'i');
    if (dayRegex.test(text)) {
      const target = new Date(now);
      let diff = (dayIndex - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7; // next week if same day
      target.setDate(now.getDate() + diff);

      const parsedTime = parseTimePart(text);
      if (parsedTime) {
        target.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
      } else {
        target.setHours(10, 0, 0, 0);
      }

      const ms = target.getTime() - now.getTime();
      if (ms > 0) {
        return {
          ms,
          seconds: Math.round(ms / 1000),
          label: `${dayName.charAt(0).toUpperCase() + dayName.slice(1)}`,
          targetDate: target,
          formattedTarget: formatTargetTime(target, now),
        };
      }
    }
  }

  // 4. Particular dates (e.g. "12 nov", "nov 12", "12th november", "15 nov at 4pm", "12/11", "2026-11-12")
  // Match ISO / Slash / Dash dates like "2026-11-12", "12/11/2026", "12/11"
  const numDateMatch = text.match(/\b(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?)\b/);
  if (numDateMatch) {
    let year = now.getFullYear();
    let month = now.getMonth();
    let day = now.getDate();

    if (numDateMatch[1]) {
      // YYYY-MM-DD
      year = parseInt(numDateMatch[1], 10);
      month = parseInt(numDateMatch[2], 10) - 1;
      day = parseInt(numDateMatch[3], 10);
    } else {
      // DD/MM or DD/MM/YYYY
      day = parseInt(numDateMatch[4], 10);
      month = parseInt(numDateMatch[5], 10) - 1;
      if (numDateMatch[6]) year = parseInt(numDateMatch[6], 10);
    }

    const target = new Date(year, month, day);
    const parsedTime = parseTimePart(text.replace(numDateMatch[0], ''));
    if (parsedTime) {
      target.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
    } else {
      target.setHours(10, 0, 0, 0);
    }

    if (target.getTime() < now.getTime() && !numDateMatch[1] && !numDateMatch[6]) {
      target.setFullYear(year + 1);
    }

    const ms = target.getTime() - now.getTime();
    if (ms > 0) {
      return {
        ms,
        seconds: Math.round(ms / 1000),
        label: formatTargetTime(target, now),
        targetDate: target,
        formattedTarget: formatTargetTime(target, now),
      };
    }
  }

  // Match textual dates like "12th nov", "12 november", "nov 12", "november 15th"
  const datePattern = /(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)|([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?)(?:\s+(\d{4}))?/i;
  const dateMatch = text.match(datePattern);
  if (dateMatch) {
    const rawDay = dateMatch[1] || dateMatch[4];
    const rawMonth = (dateMatch[2] || dateMatch[3]).toLowerCase();
    const rawYear = dateMatch[5];

    if (rawDay && rawMonth && MONTH_MAP[rawMonth] !== undefined) {
      const day = parseInt(rawDay, 10);
      const month = MONTH_MAP[rawMonth];
      let year = rawYear ? parseInt(rawYear, 10) : now.getFullYear();

      const target = new Date(year, month, day);
      const parsedTime = parseTimePart(text.replace(dateMatch[0], ''));
      if (parsedTime) {
        target.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
      } else {
        target.setHours(10, 0, 0, 0); // default to 10:00 AM
      }

      // If date is in past and year wasn't explicitly given, roll to next year
      if (!rawYear && target.getTime() < now.getTime()) {
        target.setFullYear(year + 1);
      }

      const ms = target.getTime() - now.getTime();
      if (ms > 0) {
        return {
          ms,
          seconds: Math.round(ms / 1000),
          label: `${rawDay} ${rawMonth.charAt(0).toUpperCase() + rawMonth.slice(1)}`,
          targetDate: target,
          formattedTarget: formatTargetTime(target, now),
        };
      }
    }
  }

  // 5. Standalone time today (e.g. "at 5pm", "5:30pm", "17:00")
  const standaloneTime = parseTimePart(text);
  if (standaloneTime && (text.includes('pm') || text.includes('am') || text.includes(':') || text.startsWith('at '))) {
    const target = new Date(now);
    target.setHours(standaloneTime.hour, standaloneTime.minute, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1); // roll to tomorrow if already passed today
    }
    const ms = target.getTime() - now.getTime();
    if (ms > 0) {
      return {
        ms,
        seconds: Math.round(ms / 1000),
        label: formatTargetTime(target, now),
        targetDate: target,
        formattedTarget: formatTargetTime(target, now),
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
