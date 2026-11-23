import type { Creator, SavedMediaType, SavedReel } from '../types.ts';
import type { CreatorMediaFilter } from './creatorQuery.ts';
import {
  extractCreatorQuery,
  isDurationShortcut,
  isPlausibleInstagramHandle,
  RESERVED_WORDS,
} from './creatorQuery.ts';
import { parseDuration, formatTargetTime } from './duration.ts';
import { classifySavedMediaType } from './mediaType.ts';

const INSTAGRAM_HANDLE_REGEX = /^[a-zA-Z0-9._]{1,30}$/;

const PLACEHOLDER_CREATOR_NAMES = new Set([
  'instagram_creator',
  'instagram_user',
  'instagram creator',
  'instagram reel',
  'instagram',
  'unattributed',
]);

export interface WatchedStopCommand {
  isCommand: boolean;
  markAll: boolean;
}

export interface CancelCommand {
  isCancelAddition: boolean;
  isCancelReminder: boolean;
  targetCreator?: string;
  invalidCreatorTarget?: string;
}

function stripTrailingPunctuation(str: string): string {
  let s = str.trim();
  while (s.length > 0) {
    const last = s[s.length - 1];
    if (last === '!' || last === '.' || last === ',' || last === ';' || last === ':' || last === '~' || last === '?') {
      s = s.slice(0, -1).trimEnd();
    } else {
      break;
    }
  }
  return s;
}

/**
 * Parses an inbound DM to determine if the user wants to cancel a recently added reel
 * (sent by mistake), cancel a scheduled reminder alarm, or clear a specific creator.
 */
export function parseCancelCommand(text: string): CancelCommand | null {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return null;

  const normalized = stripTrailingPunctuation(lower).replace(/\s+/g, ' ');

  // Explicit bulk commands like "cancel reminders" or "stop reminders" or "cancel all" belong to bulk watch/stop
  if (/^(?:cancel|stop|clear) (?:all|everything|reminders)$/i.test(normalized)) {
    return null;
  }

  // 1. Scoped or single cancel reminder:
  // First, check if user explicitly targeted a creator with "for": e.g. "cancel reminder for @ann", "stop reminders for @ann please"
  const targetedReminderMatch = normalized.match(
    /^(?:cancel|stop|remove|no) reminders? for ([^\s].*)$/i
  );
  if (targetedReminderMatch) {
    const rawArg = targetedReminderMatch[1].trim();
    const cleaned = stripTrailingPunctuation(rawArg);
    const targetCreator = extractCreatorQuery(cleaned);
    if (!targetCreator) {
      return {
        isCancelAddition: false,
        isCancelReminder: true,
        invalidCreatorTarget: rawArg,
      };
    }
    return {
      isCancelAddition: false,
      isCancelReminder: true,
      targetCreator,
    };
  }

  // Next, check single cancel reminder without "for": e.g. "cancel reminder", "stop reminder @ann", "no reminder"
  const reminderMatch = normalized.match(
    /^(?:cancel|stop|remove|no) reminders?(?: ([^\s].*))?$/i
  );
  if (reminderMatch) {
    const rawArg = reminderMatch[1]?.trim();
    if (rawArg) {
      const cleaned = stripTrailingPunctuation(rawArg);
      const targetCreator = extractCreatorQuery(cleaned);
      if (!targetCreator) {
        return {
          isCancelAddition: false,
          isCancelReminder: true,
          invalidCreatorTarget: rawArg,
        };
      }
      return {
        isCancelAddition: false,
        isCancelReminder: true,
        targetCreator,
      };
    }
    return {
      isCancelAddition: false,
      isCancelReminder: true,
      targetCreator: undefined,
    };
  }

  // 2. Clear / remove / cancel by creator: e.g. "clear @ykittois", "clear ykittois", "remove @ann", "delete ann"
  const clearMatch = normalized.match(
    /^(?:clear|remove|delete|cancel) (@?(?:\[|<)?[a-z0-9._]{1,30}(?:\]|>)?)$/i
  );
  if (clearMatch) {
    const rawArg = stripTrailingPunctuation(clearMatch[1].trim());
    if (!/^(?:all|everything|reminders|that|it|reel|post|addition|my|data|account)$/i.test(rawArg)) {
      const targetCreator = extractCreatorQuery(rawArg);
      if (targetCreator) {
        return {
          isCancelAddition: true,
          isCancelReminder: false,
          targetCreator,
        };
      }
      if (rawArg.startsWith('@')) {
        return {
          isCancelAddition: true,
          isCancelReminder: false,
          invalidCreatorTarget: rawArg,
        };
      }
    }
  }

  // 3. Cancel / Undo addition (e.g. sent by mistake): e.g. "cancel", "undo", "remove", "delete", "cancel that", "undo that", "remove that"
  if (/^(?:cancel|undo|remove|delete)(?: (?:that|it|reel|post|addition))?$/i.test(normalized)) {
    return {
      isCancelAddition: true,
      isCancelReminder: false,
    };
  }

  return null;
}

export interface TargetedWatchedCommand {
  targetCreator?: string;
  invalidCreatorTarget?: string;
}

/**
 * Parses targeted watched commands for a specific creator:
 * e.g. "watched @creator", "done @creator", "mark @creator as watched", "watched @creator,"
 */
export function parseTargetedWatchedCommand(text: string): TargetedWatchedCommand | null {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return null;

  const normalized = stripTrailingPunctuation(lower).replace(/\s+/g, ' ');

  const match = normalized.match(
    /^(?:watched|done|seen|finish|finished|mark) ([^\s].*?)(?: as watched)?$/i
  );
  if (!match) return null;

  const rawArg = match[1].trim();
  const cleaned = stripTrailingPunctuation(rawArg);

  // Bulk targets and conversational/temporal modifiers belong to parseWatchedStopCommand
  if (/^(?:all|everything|reminders|posts?|reels?|now|already|today|pls|please|that|it|them|this)$/i.test(cleaned)) {
    return null;
  }

  const targetCreator = extractCreatorQuery(cleaned);
  if (targetCreator) {
    return { targetCreator };
  }

  // If the user explicitly specified an invalid handle starting with @,
  // capture it as invalidCreatorTarget rather than dropping into unscoped single-watched command.
  if (cleaned.startsWith('@')) {
    return { invalidCreatorTarget: rawArg };
  }

  return null;
}

export interface TargetedReminderUpdateCommand {
  targetCreator?: string;
  duration?: ReturnType<typeof parseDuration>;
  durationText?: string;
  invalidCreatorTarget?: string;
  invalidDurationText?: string;
}

const PREPOSITIONS_SET = new Set([
  'in', 'at', 'on', 'for', 'to', 'by', 'from', 'about', 'with', 'of', 'the', 'a', 'an',
]);

const MONTH_NAMES = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

function cleanCreatorCandidate(raw: string): string {
  let cleaned = raw.trim().replace(/^[@<(\[]+/, '');
  while (cleaned.endsWith('>') || cleaned.endsWith(')') || cleaned.endsWith(']')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned.trim().toLowerCase();
}

function resolveTargetCreatorCandidate(rawCreator: string): { targetCreator?: string; invalidCreatorTarget?: string } | null {
  const trimmed = rawCreator.trim();
  const hasCreatorSigil = trimmed.startsWith('@') || trimmed.startsWith('[') || trimmed.startsWith('<');
  if (hasCreatorSigil) {
    const extracted = extractCreatorQuery(trimmed);
    if (!extracted) {
      return { invalidCreatorTarget: trimmed };
    }
    return { targetCreator: extracted };
  }

  const cleaned = cleanCreatorCandidate(trimmed);
  if (
    PREPOSITIONS_SET.has(cleaned) ||
    RESERVED_WORDS.has(cleaned) ||
    MONTH_NAMES.has(cleaned) ||
    isDurationShortcut(cleaned) ||
    !isPlausibleInstagramHandle(cleaned)
  ) {
    return null;
  }
  return { targetCreator: cleaned };
}

/**
 * Parses targeted reminder update / reschedule / snooze commands for a specific creator:
 * e.g. "remind @creator in 2h", "remind @[creator] 2h", "update reminder for @creator to 2h",
 * "update @creator 5pm", "snooze @creator 1h", "snooze 1h for @creator".
 */
export function parseTargetedReminderUpdateCommand(
  text: string,
  refDate: Date = new Date(),
  senderTz?: string
): TargetedReminderUpdateCommand | null {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return null;

  const normalized = stripTrailingPunctuation(lower).replace(/\s+/g, ' ');

  // Pattern 1 (Duration first, creator after):
  // e.g. "snooze 1h for @creator", "remind in 2h for @creator", "remind me in 2h about @creator", "reschedule 2h for @creator"
  const p1 = normalized.match(
    /^(?:remind(?: me)?|snooze|update(?: reminders?)?|reschedule(?: reminders?)?) ([^\s].*?) (?:for|about|of|on) (@?\S+)$/i
  );
  if (p1) {
    const rawDur = p1[1].trim();
    const rawCreator = p1[2].trim();
    const candidate = resolveTargetCreatorCandidate(rawCreator);
    if (candidate) {
      if (candidate.invalidCreatorTarget) {
        return { invalidCreatorTarget: candidate.invalidCreatorTarget, durationText: rawDur };
      }
      const dur = parseDuration(rawDur, refDate, senderTz);
      if (!dur) {
        return { targetCreator: candidate.targetCreator, invalidDurationText: rawDur };
      }
      return { targetCreator: candidate.targetCreator, duration: dur, durationText: rawDur };
    }
  }

  // Pattern 2 (Creator first, duration after):
  // e.g. "remind @creator in 2h", "update reminder for @creator to 2h", "snooze @creator 1h", "reschedule @creator tomorrow"
  const p2 = normalized.match(
    /^(?:remind(?: me)?(?: (?:about|for|of))?|update(?: reminders?)?(?: (?:for|of|on))?|change(?: reminders?)?(?: (?:for|of|on))?|snooze(?: reminders?)?(?: (?:for|of|on))?|reschedule(?: reminders?)?(?: (?:for|of|on))?) (@?\S+)(?: (?:to|in|at|for))? ([^\s].*)$/i
  );
  if (p2) {
    const rawCreator = p2[1].trim();
    const rawDur = stripTrailingPunctuation(p2[2]);
    const candidate = resolveTargetCreatorCandidate(rawCreator);
    if (candidate) {
      if (candidate.invalidCreatorTarget) {
        return { invalidCreatorTarget: candidate.invalidCreatorTarget, durationText: rawDur };
      }
      const dur = parseDuration(rawDur, refDate, senderTz);
      if (!dur) {
        return { targetCreator: candidate.targetCreator, invalidDurationText: rawDur };
      }
      return { targetCreator: candidate.targetCreator, duration: dur, durationText: rawDur };
    }
  }

  return null;
}

/**
 * Detects common casual greetings, help, and instruction queries.
 */
export function isGreetingOrHelpMessage(text: string): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.startsWith('@')) return false;

  const lower = trimmed.toLowerCase();
  let cleaned = lower;
  while (cleaned.length > 0 && !/[a-z0-9]/.test(cleaned[0])) {
    cleaned = cleaned.slice(1);
  }
  while (cleaned.length > 0 && !/[a-z0-9]/.test(cleaned[cleaned.length - 1])) {
    cleaned = cleaned.slice(0, -1);
  }
  if (!cleaned) return false;
  cleaned = cleaned.replace(/\s+/g, ' ');

  const greetings = new Set([
    'hi', 'hello', 'hey', 'heya', 'yo', 'sup', 'wassup', "what's up", 'whats up', 'howdy', 'hola', 'greetings', 'gm', 'gn',
    'bro', 'dude', 'homie', 'pal', 'buddy', 'help', 'command', 'commands', 'menu', 'start', 'info',
    'instruction', 'instructions', 'guide', 'option', 'options',
    'how to use', 'what can you do', 'what do you do', 'how does this work', 'how it works'
  ]);

  if (greetings.has(cleaned)) {
    return true;
  }

  const parts = cleaned.split(' ');
  if (parts.length === 2) {
    const greetingWords = new Set(['hi', 'hello', 'hey', 'yo', 'sup', "what's up", 'whats up']);
    const targets = new Set(['bot', 'there', 'reeler', 'bro', 'dude', 'man', 'homie', 'mate', 'friend', 'pal', 'buddy']);
    if (greetingWords.has(parts[0]) && targets.has(parts[1])) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the comprehensive user instructions and command reference for the bot.
 * Fits within Instagram DM's 950-character single-bubble threshold.
 */
export function formatBotHelpMessage(): string {
  return (
    `👋 Welcome to Reeler! Your Reels & Posts Vault.\n\n` +
    `📥 Save & Reminders\n` +
    `• Share any Reel or Post here to save it.\n` +
    `• Add a time in share text ("30s", "2h", "5pm") to set a reminder!\n` +
    `• Or reply with a time anytime (e.g. "1h", "snooze 2h").\n\n` +
    `⏰ Manage Reminders & Watch Later\n` +
    `• "queue" or "reminders": View your upcoming items.\n` +
    `• "watched" or "done": Mark latest reminder as watched.\n` +
    `• "cancel" or "undo": Remove recent item sent by mistake.\n` +
    `• "cancel reminder": Stop alerts but keep in Watch Later.\n` +
    `• "update @[creator] 2h" / "watched @[creator]": Manage by creator.\n` +
    `• "stop all": Mark all as watched & clear reminders.\n\n` +
    `🔍 Search & Web Vault\n` +
    `• "@[creator]" or "reels by @[creator]": View your saved items.\n` +
    `• "vault": Open your private web vault.\n` +
    `• "code": Get a 6-digit login code for PC/laptop access.\n\n` +
    `⚙️ Settings\n` +
    `• "tz <city>" (e.g. "tz IST", "tz London"): Set your timezone.\n` +
    `• "delete my data": Wipe all your data and history.`
  );
}

/**
 * Determines whether an inbound DM text is a request to view the Watch Later queue or upcoming reminders.
 */
export function parseQueueCommand(text: string): boolean {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return false;

  // Reject creator queries or targeted commands (e.g. "@creator", "reels by @creator", "queue for @creator")
  if (lower.includes('@')) return false;

  return (
    /^(?:(?:my|show|view|the|get|check|all|active)\s+)?(?:queue|reminders?|upcoming(?:\s+(?:reels?|posts?|reminders?|items?))?|list(?:\s+(?:reels?|posts?|reminders?|items?))?)$/i.test(
      lower
    ) ||
    /^(?:what(?:'s|\s+is)?\s+(?:in\s+)?(?:my\s+)?(?:queue|reminders?)|what\s+reminders(?:\s+do\s+i\s+have)?)$/i.test(
      lower
    )
  );
}

/**
 * Parses an inbound DM text command to determine whether the user is marking
 * a reel as watched / stopping reminders, and whether they requested clearing all active reminders.
 */
export function parseWatchedStopCommand(text: string): WatchedStopCommand {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) {
    return { isCommand: false, markAll: false };
  }

  // Normalize bracketed handle syntax like @[username], @<username>, [username] -> @username
  const normalizedLower = lower.replace(
    /(?:^|\s)@?(?:\[|<)([a-z0-9._]{1,30})(?:\]|>)(?=$|[\s,!?])/g,
    (match, handle) => {
      const leadingMatch = match.match(/^\s/);
      const prefix = leadingMatch ? leadingMatch[0] : '';
      return `${prefix}@${handle}`;
    }
  );

  // Explicit creator-lookup messages (e.g. "@stop.motion", "reels by @done", "posts by @done", "done posts", "show @done")
  // must route to creator search rather than being misread as watch/stop commands.
  if (
    /^(?:(?:show|get|fetch|find)\s+)?(?:(?:reels?|posts?)\s+(?:by|of|from)|show|get|fetch|find|creator)\s+@?[a-z0-9._]+$/i.test(normalizedLower) ||
    /^@?[a-z0-9._]+\s+(?:reels?|posts?)$/i.test(normalizedLower)
  ) {
    return { isCommand: false, markAll: false };
  }

  // Explicit scoped reminder cancellation requests (e.g. "stop reminders for @[creator]", "stop reminder @[creator]")
  // belong to cancel routing rather than bulk watch/stop.
  if (/(?:cancel|stop|remove|no)\s+reminders?(?:\s+for)?\s+/i.test(normalizedLower)) {
    return { isCommand: false, markAll: false };
  }

  // Explicit targeted watched commands with creator mentions (e.g. "watched @ann", "done @[creator]")
  // belong to parseTargetedWatchedCommand rather than unscoped single-item watch marking.
  if (/(?:watched|done|seen|finish|finished|mark)\s+@/i.test(normalizedLower)) {
    return { isCommand: false, markAll: false };
  }

  const withoutMentions = normalizedLower.replace(/(?:^|\s)@[a-z0-9._]+/g, ' ').trim();
  if (!withoutMentions) {
    return { isCommand: false, markAll: false };
  }

  const isCommand =
    /(?<![\w.@])(watched|done|seen|finish|finished|stop|halt|unsub|unsubscribe|quit)(?![\w]|(?:\.[a-z0-9_]))/i.test(
      withoutMentions
    ) ||
    /^watch[!.\s]*$/i.test(withoutMentions) ||
    /(?<![\w.@])clear\s+(?:them\s+)?(?:all|everything|reminders?)(?![\w]|(?:\.[a-z0-9_]))/i.test(withoutMentions) ||
    /(?<![\w.@])cancel\s+(?:them\s+)?(?:all|everything|reminders)(?![\w]|(?:\.[a-z0-9_]))/i.test(withoutMentions) ||
    /(?<![\w.@])mark\s+(?:them\s+)?(?:all|everything)(?![\w]|(?:\.[a-z0-9_]))/i.test(withoutMentions);

  if (!isCommand) {
    return { isCommand: false, markAll: false };
  }

  const markAll =
    /(?<![\w.@])(?:watched|done|seen|finish|finished|stop|cancel|halt|clear|mark)\s+(?:them\s+)?(?:all|everything)(?![\w]|(?:\.[a-z0-9_]))/i.test(
      withoutMentions
    ) ||
    /(?<![\w.@])(?:unsub|unsubscribe|(?:stop|cancel|halt|clear)\s+reminders)(?![\w]|(?:\.[a-z0-9_]))/i.test(
      withoutMentions
    );
  return { isCommand: true, markAll };
}

/**
 * Extracts a validated public Instagram handle suitable for profile URL generation,
 * rejecting placeholders, dot-only paths, and arbitrary display strings containing whitespace.
 */
export function extractPublicCreatorUsername(
  creator?: Pick<Creator, 'username' | 'display_name'> | null
): string | null {
  const raw = String(creator?.username || '').trim().replace(/^@+/, '');
  if (!raw || PLACEHOLDER_CREATOR_NAMES.has(raw.toLowerCase())) {
    return null;
  }
  if (
    !INSTAGRAM_HANDLE_REGEX.test(raw) ||
    !/[a-zA-Z0-9]/.test(raw) ||
    raw.includes('..') ||
    raw.startsWith('.') ||
    raw.endsWith('.')
  ) {
    return null;
  }
  return raw;
}

/**
 * Checks whether a creator reference is an unattributed placeholder (e.g. 'Instagram Creator')
 * or lacks a valid public Instagram username.
 */
export function isPlaceholderCreator(
  creator?: Pick<Creator, 'username' | 'display_name'> | null
): boolean {
  if (!creator) return true;
  const externalId = String((creator as any).instagram_user_id || '').trim();
  if (externalId.startsWith('creator_unattributed_')) return true;
  return !extractPublicCreatorUsername(creator);
}

/**
 * Builds a canonical HTTPS Instagram profile URL for a validated username.
 */
export function formatCreatorProfileUrl(username: string): string {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

/**
 * Formats a human-readable creator reference, optionally pairing `@handle` with a clickable profile URL.
 */
export function formatCreatorDisplayLabel(
  creator?: Pick<Creator, 'username' | 'display_name'> | null,
  options?: { includeProfileUrl?: boolean }
): string | null {
  const handle = extractPublicCreatorUsername(creator);
  if (handle) {
    return options?.includeProfileUrl
      ? `@${handle} (${formatCreatorProfileUrl(handle)})`
      : `@${handle}`;
  }

  const displayName = String(creator?.display_name || '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (displayName && !PLACEHOLDER_CREATOR_NAMES.has(displayName.toLowerCase())) {
    const chars = Array.from(displayName);
    return chars.length <= 80 ? displayName : `${chars.slice(0, 77).join('').trimEnd()}...`;
  }

  return null;
}

/**
 * Normalizes and truncates a caption by Unicode code point boundaries (avoiding orphan surrogate pairs).
 */
export function formatHumanCaptionSnippet(caption?: string | null, maxChars = 48): string | null {
  if (!caption) return null;
  const cleaned = String(caption)
    .replace(/[\u0000-\u001F\u007F-\u009F\uE000-\uF8FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) {
    return cleaned;
  }

  const sliceLen = Math.max(1, maxChars - 3);
  return `${chars.slice(0, sliceLen).join('').trimEnd()}...`;
}

/**
 * Formats an optional standalone profile link line when a creator has a valid public Instagram handle.
 */
export function formatCreatorProfileLine(
  creator?: Pick<Creator, 'username' | 'display_name'> | null,
  prefix = '👤 Profile: '
): string {
  const handle = extractPublicCreatorUsername(creator);
  return handle ? `${prefix}${formatCreatorProfileUrl(handle)}` : '';
}

/**
 * Formats creator attribution block for "Added to Watch Later" confirmation messages.
 */
export function formatAddedToWatchLaterCreatorBlock(
  creator?: Pick<Creator, 'username' | 'display_name'> | null
): string {
  const label = formatCreatorDisplayLabel(creator, { includeProfileUrl: false });
  if (!label) return '';
  return `\nCreator: ${label}`;
}

/**
 * Returns true if the target date is scheduled more than 24 hours in the future.
 */
export function isScheduleBeyond24Hours(targetDate: Date | string, now: Date = new Date()): boolean {
  const targetMs = typeof targetDate === 'string' ? new Date(targetDate).getTime() : targetDate.getTime();
  return !Number.isNaN(targetMs) && targetMs - now.getTime() > 24 * 3600 * 1000;
}

/**
 * Friendly notice regarding Instagram's 24-hour standard messaging policy for long-term reminders.
 */
export function format24HourWindowNotice(): string {
  return `💡 Note: Instagram limits automated DMs to 24 hours from your last chat. Say "hi" or type "queue" anytime to check your items!`;
}

/**
 * Formats the reminder confirmation DM with creator attribution, clickable profile URL (when available),
 * and human-readable reel or post context (never shortcodes).
 */
export function formatReminderSetMessage(
  reel: Pick<SavedReel, 'caption' | 'creator' | 'media_type' | 'reel_url' | 'is_saved_on_instagram'>,
  durationLabel: string,
  formattedTarget: string,
  updatesReshare = false,
  isBeyond24Hours = false
): string {
  const creatorDisplay = formatCreatorDisplayLabel(reel.creator, { includeProfileUrl: false });
  const targetText = creatorDisplay || formatHumanReelLabel(reel, 40);
  const heading = updatesReshare
    ? `⏰ Reminder updated for: ${durationLabel} (${formattedTarget})!\nFor: ${targetText}`
    : `⏰ Reminder set for ${targetText}: ${durationLabel} (${formattedTarget})!`;

  let msg = heading + `\n\nReply "watched" when done.`;
  if (isBeyond24Hours) {
    msg += `\n\n${format24HourWindowNotice()}`;
  }
  return msg;
}

/**
 * Formats the automatic 10-hour default reminder notice when a custom duration wait window expires.
 */
export function formatDefaultReminderNotice(
  reel: Pick<SavedReel, 'caption' | 'creator' | 'media_type' | 'reel_url' | 'is_saved_on_instagram'>,
  defaultHours: number,
  targetStr: string
): string {
  const creatorDisplay = formatCreatorDisplayLabel(reel.creator, { includeProfileUrl: false });
  const targetText = creatorDisplay || formatHumanReelLabel(reel, 40);

  return (
    `⏰ No reminder time received for ${targetText}. I've scheduled your reminder for ${defaultHours} hours from now (${targetStr}).\n\n` +
    `Reply e.g. "2h" or "tomorrow 5pm" anytime to change it, or "watched" when done!`
  );
}

export interface CreatorSearchMessages {
  notFound: string;
  header: string;
  reelsSectionHeader: string | null;
  postsSectionHeader: string | null;
  footer: string;
}

/**
 * Formats creator-search header, empty-state, split Reels/Posts section headers, and pagination footer messages
 * with tappable profile URLs.
 */
export function formatCreatorSearchMessages(params: {
  username: string;
  displayName?: string | null;
  totalCount?: number;
  limit?: number;
  totalReelsCount?: number;
  totalPostsCount?: number;
  shownReelsCount?: number;
  shownPostsCount?: number;
  mediaFilter?: CreatorMediaFilter;
}): CreatorSearchMessages {
  const creatorRef = { username: params.username, display_name: params.displayName ?? null };
  const publicHandle = extractPublicCreatorUsername(creatorRef);
  const creatorLabel = formatCreatorDisplayLabel(creatorRef, { includeProfileUrl: false }) || 'this creator';
  const rawQueryHint = String(params.username || '').trim().replace(/^@+/, '');
  const searchHint =
    publicHandle ||
    (!PLACEHOLDER_CREATOR_NAMES.has(rawQueryHint.toLowerCase()) ? rawQueryHint.slice(0, 60) : '') ||
    creatorLabel;
  const cmdTarget = publicHandle ? `@${publicHandle}` : searchHint;
  const mediaFilter: CreatorMediaFilter = params.mediaFilter ?? 'all';

  const totalReels =
    typeof params.totalReelsCount === 'number'
      ? params.totalReelsCount
      : mediaFilter === 'post'
        ? 0
        : (params.totalCount ?? 0);
  const totalPosts =
    typeof params.totalPostsCount === 'number'
      ? params.totalPostsCount
      : mediaFilter === 'post'
        ? (params.totalCount ?? 0)
        : 0;
  const shownReels =
    typeof params.shownReelsCount === 'number'
      ? params.shownReelsCount
      : mediaFilter === 'post'
        ? 0
        : (params.limit ?? totalReels);
  const shownPosts =
    typeof params.shownPostsCount === 'number'
      ? params.shownPostsCount
      : mediaFilter === 'post'
        ? (params.limit ?? totalPosts)
        : 0;

  let notFound: string;
  if (mediaFilter === 'reel' && totalPosts > 0) {
    const postsStr = totalPosts === 1 ? '1 saved post' : `${totalPosts} saved posts`;
    notFound =
      `🔍 No saved reels found for Creator: ${creatorLabel} yet.\n\n` +
      `They do have ${postsStr}. Reply "posts by ${cmdTarget}" to view ${totalPosts === 1 ? 'it' : 'them'}.`;
  } else if (mediaFilter === 'post' && totalReels > 0) {
    const reelsStr = totalReels === 1 ? '1 saved reel' : `${totalReels} saved reels`;
    notFound =
      `🔍 No saved posts found for Creator: ${creatorLabel} yet.\n\n` +
      `They do have ${reelsStr}. Reply "reels by ${cmdTarget}" to view ${totalReels === 1 ? 'it' : 'them'}.`;
  } else if (mediaFilter === 'reel') {
    notFound =
      `🔍 No saved reels found for Creator: ${creatorLabel} yet!\n\n` +
      `Share any Reel link from them here to start tracking.`;
  } else if (mediaFilter === 'post') {
    notFound =
      `🔍 No saved posts found for Creator: ${creatorLabel} yet!\n\n` +
      `Share any Post link from them here to start tracking.`;
  } else {
    notFound =
      `🔍 No saved reels or posts found for Creator: ${creatorLabel} yet!\n\n` +
      `Share any Reel or Post link from them here to start tracking.`;
  }

  // Mixed creator library: isolate Reels vs Posts into dedicated sections
  if (mediaFilter === 'all' && totalReels > 0 && totalPosts > 0) {
    const totalItems = totalReels + totalPosts;
    const reelsPart = totalReels === 1 ? '1 reel' : `${totalReels} reels`;
    const postsPart = totalPosts === 1 ? '1 post' : `${totalPosts} posts`;
    const header =
      `📂 Saved Library\n` +
      `Creator: ${creatorLabel}\n` +
      `Found: ${totalItems} saved items (${reelsPart} · ${postsPart})\n\n` +
      `Reply "reels by ${cmdTarget}" or "posts by ${cmdTarget}" to filter by type.`;

    const reelsSectionHeader =
      shownReels === 1 && totalReels === 1
        ? '🎬 Saved Reel (1):'
        : `🎬 Latest Reels (showing ${shownReels} of ${totalReels}):`;
    const postsSectionHeader =
      shownPosts === 1 && totalPosts === 1
        ? '🖼️ Saved Post (1):'
        : `🖼️ Latest Posts (showing ${shownPosts} of ${totalPosts}):`;

    const remReels = Math.max(0, totalReels - shownReels);
    const remPosts = Math.max(0, totalPosts - shownPosts);
    const remParts: string[] = [];
    if (remReels > 0) remParts.push(`${remReels} more ${remReels === 1 ? 'reel' : 'reels'}`);
    if (remPosts > 0) remParts.push(`${remPosts} more ${remPosts === 1 ? 'post' : 'posts'}`);
    const footer =
      remParts.length > 0
        ? `... and ${remParts.join(' & ')} from ${creatorLabel} in your library!\n\n` +
          `Reply "reels by ${cmdTarget}" or "posts by ${cmdTarget}", or search "${searchHint}" on your web dashboard to see all.`
        : '';

    return { notFound, header, reelsSectionHeader, postsSectionHeader, footer };
  }

  // Posts-only (homogeneous posts creator or explicit "posts by @...")
  if (mediaFilter === 'post' || (totalPosts > 0 && totalReels === 0)) {
    const countLabel = totalPosts === 1 ? '1 saved post' : `${totalPosts} saved posts`;
    const latestLabel = shownPosts === 1 ? 'Here is the latest post:' : `Here are the latest ${shownPosts} posts:`;
    const remPosts = Math.max(0, totalPosts - shownPosts);
    return {
      notFound,
      header: `🖼️ Saved Posts\nCreator: ${creatorLabel}\nFound: ${countLabel}\n\n${latestLabel}`,
      reelsSectionHeader: null,
      postsSectionHeader: null,
      footer:
        remPosts > 0
          ? `... and ${remPosts} more ${remPosts === 1 ? 'post' : 'posts'} from ${creatorLabel} in your library!\n\n` +
            `Search "${searchHint}" on your web dashboard to see all.`
          : '',
    };
  }

  // Reels-only (homogeneous reels creator or explicit "reels by @...")
  const countLabel = totalReels === 1 ? '1 saved reel' : `${totalReels} saved reels`;
  const latestLabel = shownReels === 1 ? 'Here is the latest reel:' : `Here are the latest ${shownReels} reels:`;
  const remReels = Math.max(0, totalReels - shownReels);
  return {
    notFound,
    header: `🎬 Saved Reels\nCreator: ${creatorLabel}\nFound: ${countLabel}\n\n${latestLabel}`,
    reelsSectionHeader: null,
    postsSectionHeader: null,
    footer:
      remReels > 0
        ? `... and ${remReels} more ${remReels === 1 ? 'reel' : 'reels'} from ${creatorLabel} in your library!\n\n` +
          `Search "${searchHint}" on your web dashboard to see all.`
        : '',
  };
}

/**
 * Formats a human-readable identifier for a saved reel or post using creator identity, media type, and caption context,
 * never falling back to opaque shortcodes or database IDs.
 */
export function formatHumanReelLabel(
  reel: Pick<SavedReel, 'caption' | 'creator' | 'media_type' | 'reel_url' | 'is_saved_on_instagram'>,
  maxCaptionChars = 48
): string {
  const creatorLabel = formatCreatorDisplayLabel(reel.creator, { includeProfileUrl: false });
  const captionSnippet = formatHumanCaptionSnippet(reel.caption, maxCaptionChars);
  const mediaNoun = classifySavedMediaType({ mediaType: reel.media_type, reelUrl: reel.reel_url }) === 'post' ? 'post' : 'reel';
  const isSavedOnIg = reel.is_saved_on_instagram !== false;

  if (creatorLabel && captionSnippet) {
    return `${creatorLabel}'s ${mediaNoun} ("${captionSnippet}")`;
  }
  if (creatorLabel) {
    return isSavedOnIg ? `${creatorLabel}'s saved ${mediaNoun}` : `${creatorLabel}'s ${mediaNoun}`;
  }
  if (captionSnippet) {
    return isSavedOnIg ? `your saved ${mediaNoun} ("${captionSnippet}")` : `that ${mediaNoun} ("${captionSnippet}")`;
  }
  return isSavedOnIg ? `your saved ${mediaNoun}` : `that ${mediaNoun}`;
}

/**
 * Formats the Watch Later reminder DM so the Item URL appears BEFORE the creator profile URL,
 * keeping Instagram's rich thumbnail preview intact while making both Item and Creator Profile clickable.
 */
export function formatWatchLaterReminderMessage(
  reel: Pick<SavedReel, 'reel_url' | 'caption' | 'creator' | 'media_type' | 'is_saved_on_instagram'>
): string {
  const isPost = classifySavedMediaType({ mediaType: reel.media_type, reelUrl: reel.reel_url }) === 'post';
  const isSavedOnIg = reel.is_saved_on_instagram !== false;
  const creatorDisplay = formatCreatorDisplayLabel(reel.creator, { includeProfileUrl: false });
  const itemHeader = isPost
    ? (isSavedOnIg ? '🖼️ Saved Post' : '🖼️ Watch Later Post')
    : (isSavedOnIg ? '🎬 Saved Reel' : '🎬 Watch Later Reel');
  const creatorLine = creatorDisplay ? `\nCreator: ${creatorDisplay}` : '';
  const actionLabel = isPost ? '👉 View Post:' : '👉 Watch Reel:';
  const captionSnippet = formatHumanCaptionSnippet(reel.caption, 70);
  const captionLine = captionSnippet ? `"${captionSnippet}"\n` : '';

  return (
    `🔔 Watch Later Reminder!\n\n` +
    `${itemHeader}` +
    `${creatorLine}\n` +
    `${captionLine}` +
    `${actionLabel} ${reel.reel_url}\n\n` +
    `Reply "watched" when done, or reply e.g. "5m" or "snooze 1h" to delay!`
  );
}

/**
 * Formats the confirmation DM sent after marking one or all Watch Later items as watched.
 */
export function formatWatchedConfirmationMessage(
  updatedReels: SavedReel[],
  remainingCount: number,
  markAll: boolean,
  remainingReels?: SavedReel[]
): string {
  if (updatedReels.length === 0) {
    return '👍 All set! No pending reels right now.';
  }

  const primaryLabel = formatHumanReelLabel(updatedReels[0], 48);

  if (markAll && updatedReels.length > 1) {
    const types = new Set<SavedMediaType>(
      updatedReels.map((r) => classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }))
    );
    const bulkNoun = types.size === 1 ? (types.has('post') ? 'posts' : 'reels') : 'items';

    if (remainingCount === 0) {
      return `✅ Marked all ${updatedReels.length} pending ${bulkNoun} as watched (latest: ${primaryLabel})! All reminders stopped.`;
    }
    return `✅ Marked ${updatedReels.length} pending ${bulkNoun} as watched (latest: ${primaryLabel}). ${remainingCount} other Watch Later ${remainingCount === 1 ? 'reminder remains' : 'reminders remain'} active.`;
  }

  if (remainingCount > 0) {
    if (remainingReels && remainingReels.length > 0) {
      const firstRemaining = remainingReels[0];
      const remainingLabel = formatHumanReelLabel(firstRemaining, 40);
      if (remainingCount === 1) {
        return (
          `✅ Marked ${primaryLabel} as watched! Reminders stopped.\n\n` +
          `📌 You still have 1 other Watch Later reminder active: ${remainingLabel}.\n` +
          `Reply "watched" to mark it watched, or "stop all" to clear all.`
        );
      }
      return (
        `✅ Marked ${primaryLabel} as watched! Reminders stopped.\n\n` +
        `📌 You still have ${remainingCount} other Watch Later reminders active (next: ${remainingLabel}).\n` +
        `Reply "stop all" to clear all.`
      );
    }

    const plural = remainingCount === 1 ? 'reminder' : 'reminders';
    return (
      `✅ Marked ${primaryLabel} as watched! Reminders stopped.\n\n` +
      `📌 You still have ${remainingCount} other Watch Later ${plural} active. Reply "stop all" to clear all.`
    );
  }

  return `✅ Marked ${primaryLabel} as watched! Reminders stopped.`;
}

/**
 * Formats an honest rejection DM when a webhook sender shares an item that already has an active
 * Watch Later reminder owned by another sender or the unattributed admin/UI queue, without exposing shortcodes or IDs.
 */
export function formatSenderConflictRejectionMessage(mediaType?: SavedMediaType | string): string {
  const noun = mediaType === 'post' ? 'post' : 'reel';
  return (
    `⚠️ Unable to schedule Watch Later for that ${noun} because it already has an active reminder. ` +
    `Its existing reminder schedule was left unchanged.`
  );
}

/**
 * Formats a user-facing list of active Watch Later items and their reminder schedules.
 * Filters exclusively to upcoming reminders (future next_reminder_at).
 */
export function formatWatchLaterQueueMessage(
  reels: SavedReel[],
  timeZone?: string,
  now: Date = new Date()
): string {
  // Defense-in-depth: only include items with an active future reminder
  const upcoming = reels.filter((reel) => {
    if (!reel.next_reminder_at) return false;
    const reminderDate = new Date(reel.next_reminder_at);
    return !Number.isNaN(reminderDate.getTime()) && reminderDate.getTime() > now.getTime();
  });

  if (upcoming.length === 0) {
    return (
      `📋 You have no upcoming reminders scheduled!\n\n` +
      `Share any Reel or Post here to save it and set a reminder, or type "update @[creator] [time]" to schedule one.\n\n` +
      `Type "vault" to view all your saved items.`
    );
  }

  const MAX_DISPLAY = 5;
  const count = upcoming.length;
  const header = `📋 Your Upcoming Reminders (${count} item${count === 1 ? '' : 's'}):\n`;

  const items = upcoming.slice(0, MAX_DISPLAY).map((reel, index) => {
    const targetLabel = formatHumanReelLabel(reel, 35);
    const reminderDate = new Date(reel.next_reminder_at!);
    const scheduleText = formatTargetTime(reminderDate, now, timeZone);

    return `${index + 1}. ${targetLabel}\n   ⏰ ${scheduleText}`;
  });

  let message = `${header}\n${items.join('\n\n')}`;

  if (count > MAX_DISPLAY) {
    const remaining = count - MAX_DISPLAY;
    message += `\n\n...and ${remaining} more upcoming reminder${remaining === 1 ? '' : 's'}.`;
  }

  message +=
    `\n\n💡 Quick actions:\n` +
    `• "update @[creator] 2h" to reschedule\n` +
    `• "watched" or "watched @[creator]" when done\n` +
    `• "vault" to open your web vault`;

  return message;
}
