/**
 * Utility for detecting and extracting creator username queries from inbound chat messages.
 */

import type { SavedMediaType } from '../types.ts';

export type CreatorMediaFilter = 'all' | SavedMediaType;

export interface CreatorQueryResult {
  username: string;
  mediaFilter: CreatorMediaFilter;
}

// Common non-creator keywords that should never be interpreted as bare creator usernames
const RESERVED_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'hola', 'sup', 'gm', 'gn',
  'help', 'start', 'menu', 'info', 'ping', 'test', 'status', 'reels', 'reel', 'posts', 'post', 'all', 'list',
  'me', 'it', 'this', 'that', 'none', 'anything', 'something', 'everything', 'snooze', 'later', 'unwatched',
  'reminder', 'reminders',
  'watched', 'done', 'seen', 'finish', 'finished', 'stop', 'cancel', 'halt', 'unsub', 'unsubscribe', 'quit', 'clear',
  'today', 'tomorrow', 'tonight', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'yes', 'no', 'ok', 'okay', 'yep', 'nope', 'thanks', 'thank you', 'ty',
]);

function isDurationShortcut(lower: string): boolean {
  return /^\d+(?:s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)?$/i.test(lower);
}

function isPlausibleInstagramHandle(handle: string): boolean {
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) return false;
  if (!/[a-zA-Z0-9]/.test(handle)) return false;
  if (handle.includes('..') || handle.startsWith('.') || handle.endsWith('.')) return false;
  return true;
}

function keywordToMediaFilter(keyword?: string): CreatorMediaFilter {
  if (!keyword) return 'all';
  const lower = keyword.toLowerCase();
  if (lower.startsWith('post')) return 'post';
  if (lower.startsWith('reel')) return 'reel';
  return 'all';
}

/**
 * Extracts a creator username and optional media-type filter (`'all' | 'reel' | 'post'`) from an inbound message,
 * or returns null if the message is not a creator query.
 *
 * Supported formats:
 * - Direct @mention: "@who.bhartiiiii", "reels by @who.bhartiiiii", "posts by @who.bhartiiiii", "@who.bhartiiiii posts"
 * - Action phrases: "reels by who.bhartiiiii", "posts from who.bhartiiiii", "show who.bhartiiiii", "fetch who.bhartiiiii"
 * - Suffix phrases: "who.bhartiiiii reels", "who.bhartiiiii posts"
 * - Standalone bare username: "who.bhartiiiii" (excluding greetings, bot commands, durations, and reserved words)
 */
export function extractCreatorQueryWithFilter(text: string): CreatorQueryResult | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  // 1a. Explicit typed prefix or suffix with @mention
  const typedAtPrefix = trimmed.match(
    /^(?:(?:show|get|fetch|find)\s+)?(reels?|posts?)\s+(?:by|of|from)\s+@([a-zA-Z0-9._]{1,30})$/i
  );
  if (typedAtPrefix) {
    const candidate = typedAtPrefix[2].toLowerCase();
    return isPlausibleInstagramHandle(candidate)
      ? { username: candidate, mediaFilter: keywordToMediaFilter(typedAtPrefix[1]) }
      : null;
  }

  const typedAtSuffix = trimmed.match(/^@([a-zA-Z0-9._]{1,30})\s+(reels?|posts?)$/i);
  if (typedAtSuffix) {
    const candidate = typedAtSuffix[1].toLowerCase();
    return isPlausibleInstagramHandle(candidate)
      ? { username: candidate, mediaFilter: keywordToMediaFilter(typedAtSuffix[2]) }
      : null;
  }

  // 1b. General @ mention anywhere in message (e.g. "@who.bhartiiiii", "show me posts by @who.bhartiiiii")
  const atMatch = trimmed.match(/(?:^|\s)@([a-zA-Z0-9._]{1,30})(?=$|[\s,!?])/);
  if (atMatch) {
    const candidate = atMatch[1].toLowerCase();
    if (!isPlausibleInstagramHandle(candidate)) return null;
    const contextWithoutMention = trimmed.replace(atMatch[0], ' ').trim();
    const mentionsReels = /\breels?\b/i.test(contextWithoutMention);
    const mentionsPosts = /\bposts?\b/i.test(contextWithoutMention);
    let mediaFilter: CreatorMediaFilter = 'all';
    if (mentionsReels && !mentionsPosts) mediaFilter = 'reel';
    else if (mentionsPosts && !mentionsReels) mediaFilter = 'post';
    return { username: candidate, mediaFilter };
  }

  // 2. Command phrases without @
  const typedPrefixMatch = trimmed.match(
    /^(?:(?:show|get|fetch|find)\s+)?(reels?|posts?)\s+(?:by|of|from)\s+([a-zA-Z0-9._]{2,30})$/i
  );
  if (typedPrefixMatch) {
    const candidate = typedPrefixMatch[2].toLowerCase();
    if (
      RESERVED_WORDS.has(candidate) ||
      isDurationShortcut(candidate) ||
      !isPlausibleInstagramHandle(candidate)
    ) {
      return null;
    }
    return { username: candidate, mediaFilter: keywordToMediaFilter(typedPrefixMatch[1]) };
  }

  const typedSuffixMatch = trimmed.match(/^([a-zA-Z0-9._]{2,30})\s+(reels?|posts?)$/i);
  if (typedSuffixMatch) {
    const candidate = typedSuffixMatch[1].toLowerCase();
    if (
      RESERVED_WORDS.has(candidate) ||
      isDurationShortcut(candidate) ||
      !isPlausibleInstagramHandle(candidate)
    ) {
      return null;
    }
    return { username: candidate, mediaFilter: keywordToMediaFilter(typedSuffixMatch[2]) };
  }

  const untypedPhraseMatch = trimmed.match(
    /^(?:show|get|fetch|find|creator)\s+([a-zA-Z0-9._]{2,30})$/i
  );
  if (untypedPhraseMatch) {
    const candidate = untypedPhraseMatch[1].toLowerCase();
    if (
      RESERVED_WORDS.has(candidate) ||
      isDurationShortcut(candidate) ||
      !isPlausibleInstagramHandle(candidate)
    ) {
      return null;
    }
    return { username: candidate, mediaFilter: 'all' };
  }

  const lower = trimmed.toLowerCase();
  if (RESERVED_WORDS.has(lower) || isDurationShortcut(lower)) {
    return null;
  }

  // 3. Standalone bare username (2-30 chars, valid handle syntax, not starting with /)
  if (/^[a-zA-Z0-9._]{2,30}$/.test(lower) && !lower.startsWith('/') && isPlausibleInstagramHandle(lower)) {
    return { username: lower, mediaFilter: 'all' };
  }

  return null;
}

/**
 * Extracts a creator username from an inbound message, or returns null if not a creator query.
 */
export function extractCreatorQuery(text: string): string | null {
  return extractCreatorQueryWithFilter(text)?.username ?? null;
}
