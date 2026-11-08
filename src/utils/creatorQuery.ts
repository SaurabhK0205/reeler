/**
 * Utility for detecting and extracting creator username queries from inbound chat messages.
 */

// Common non-creator keywords that should never be interpreted as bare creator usernames
const RESERVED_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'hola', 'sup', 'gm', 'gn',
  'help', 'start', 'menu', 'info', 'ping', 'test', 'status', 'reels', 'all', 'list',
  'watched', 'done', 'seen', 'finish', 'finished', 'stop', 'cancel', 'halt', 'quit', 'clear',
  'today', 'tomorrow', 'tonight', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'yes', 'no', 'ok', 'okay', 'yep', 'nope', 'thanks', 'thank you', 'ty',
]);

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
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Explicit @ mention anywhere in message (e.g. "@who.bhartiiiii", "reels by @who.bhartiiiii")
  const atMatch = trimmed.match(/(?:^|\s)@([a-zA-Z0-9._]{1,30})/);
  if (atMatch) {
    return atMatch[1].toLowerCase();
  }

  // 2. Command phrases without @
  // e.g. "reels by who.bhartiiiii", "reels from X", "show X", "fetch X", "find X", "creator X", "get X"
  const phraseMatch =
    trimmed.match(/^(?:reels?\s+(?:by|of|from)\s+|show\s+|get\s+|fetch\s+|find\s+|creator\s+)([a-zA-Z0-9._]{2,30})$/i) ||
    trimmed.match(/^([a-zA-Z0-9._]{2,30})\s+reels?$/i);
  if (phraseMatch) {
    return phraseMatch[1].toLowerCase();
  }

  const lower = trimmed.toLowerCase();
  if (RESERVED_WORDS.has(lower)) {
    return null;
  }

  // Ignore pure numeric strings or duration shortcuts (e.g. "10m", "5s", "2h", "5d", "30mins", "123")
  if (/^\d+(?:s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)?$/i.test(lower)) {
    return null;
  }

  // 3. Standalone bare username (2-30 chars, letters, numbers, dot, underscore, no spaces, not starting with /)
  if (/^[a-zA-Z0-9._]{2,30}$/.test(lower) && !lower.startsWith('/')) {
    return lower;
  }

  return null;
}
