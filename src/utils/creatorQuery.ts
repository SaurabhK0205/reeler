/**
 * Utility for detecting and extracting creator username queries from inbound chat messages.
 */

// Common non-creator keywords that should never be interpreted as bare creator usernames
const RESERVED_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'hola', 'sup', 'gm', 'gn',
  'help', 'start', 'menu', 'info', 'ping', 'test', 'status', 'reels', 'reel', 'all', 'list',
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

/**
 * Extracts a creator username from an inbound message, or returns null if not a creator query.
 *
 * Supported formats:
 * - Direct @mention: "@who.bhartiiiii", "reels by @who.bhartiiiii", "show me @who.bhartiiiii"
 * - Action phrases: "reels by who.bhartiiiii", "reels from who.bhartiiiii", "show who.bhartiiiii", "fetch who.bhartiiiii"
 * - Suffix phrases: "who.bhartiiiii reels"
 * - Standalone bare username: "who.bhartiiiii" (excluding greetings, bot commands, durations)
 */
export function extractCreatorQuery(text: string): string | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  // 1. Explicit @ mention anywhere in message (e.g. "@who.bhartiiiii", "reels by @who.bhartiiiii")
  const atMatch = trimmed.match(/(?:^|\s)@([a-zA-Z0-9._]{1,30})(?=$|[\s,!?])/);
  if (atMatch) {
    const candidate = atMatch[1].toLowerCase();
    return isPlausibleInstagramHandle(candidate) ? candidate : null;
  }

  // 2. Command phrases without @
  // e.g. "reels by who.bhartiiiii", "reels from X", "show X", "fetch X", "find X", "creator X", "get X"
  const phraseMatch =
    trimmed.match(/^(?:reels?\s+(?:by|of|from)\s+|show\s+|get\s+|fetch\s+|find\s+|creator\s+)([a-zA-Z0-9._]{2,30})$/i) ||
    trimmed.match(/^([a-zA-Z0-9._]{2,30})\s+reels?$/i);
  if (phraseMatch) {
    const candidate = phraseMatch[1].toLowerCase();
    if (
      RESERVED_WORDS.has(candidate) ||
      isDurationShortcut(candidate) ||
      !isPlausibleInstagramHandle(candidate)
    ) {
      return null;
    }
    return candidate;
  }

  const lower = trimmed.toLowerCase();
  if (RESERVED_WORDS.has(lower) || isDurationShortcut(lower)) {
    return null;
  }

  // 3. Standalone bare username (2-30 chars, valid handle syntax, not starting with /)
  if (/^[a-zA-Z0-9._]{2,30}$/.test(lower) && !lower.startsWith('/') && isPlausibleInstagramHandle(lower)) {
    return lower;
  }

  return null;
}
