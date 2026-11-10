import type { Creator, SavedMediaType, SavedReel } from '../types.ts';
import type { CreatorMediaFilter } from './creatorQuery.ts';
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

/**
 * Parses an inbound DM text command to determine whether the user is marking
 * a reel as watched / stopping reminders, and whether they requested clearing all active reminders.
 */
export function parseWatchedStopCommand(text: string): WatchedStopCommand {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) {
    return { isCommand: false, markAll: false };
  }

  // Explicit creator-lookup messages (e.g. "@stop.motion", "reels by @done", "posts by @done", "done posts", "show @done")
  // must route to creator search rather than being misread as watch/stop commands.
  if (
    /^(?:(?:show|get|fetch|find)\s+)?(?:(?:reels?|posts?)\s+(?:by|of|from)|show|get|fetch|find|creator)\s+@?[a-z0-9._]+$/i.test(lower) ||
    /^@?[a-z0-9._]+\s+(?:reels?|posts?)$/i.test(lower)
  ) {
    return { isCommand: false, markAll: false };
  }

  const withoutMentions = lower.replace(/(?:^|\s)@[a-z0-9._]+/g, ' ').trim();
  if (!withoutMentions) {
    return { isCommand: false, markAll: false };
  }

  const isCommand =
    /(?<![\w.@])(watched|done|seen|finish|finished|stop|cancel|halt|unsub|unsubscribe|quit)(?![\w]|(?:\.[a-z0-9_]))/i.test(
      withoutMentions
    ) ||
    /^watch[!.\s]*$/i.test(withoutMentions) ||
    /(?<![\w.@])clear\s+(?:them\s+)?(?:all|everything|reminders?)(?![\w]|(?:\.[a-z0-9_]))/i.test(withoutMentions) ||
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
  const profileLine = formatCreatorProfileLine(creator);
  return profileLine ? `\nCreator: ${label}\n${profileLine}` : `\nCreator: ${label}`;
}

/**
 * Formats the "Reminder set" DM with creator attribution, clickable profile URL (when available),
 * and human-readable reel or post context (never shortcodes).
 */
export function formatReminderSetMessage(
  reel: Pick<SavedReel, 'caption' | 'creator' | 'media_type' | 'reel_url' | 'is_saved_on_instagram'>,
  durationLabel: string,
  formattedTarget: string
): string {
  const creatorDisplay = formatCreatorDisplayLabel(reel.creator, { includeProfileUrl: false });
  const targetText = creatorDisplay || formatHumanReelLabel(reel, 40);
  const profileLine = formatCreatorProfileLine(reel.creator);
  const profileBlock = profileLine ? `\n${profileLine}` : '';

  return (
    `⏰ Reminder set for ${targetText}: ${durationLabel} (${formattedTarget})!` +
    `${profileBlock}\n\nReply "watched" when done.`
  );
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
  const profileLine = formatCreatorProfileLine(reel.creator);
  const profileBlock = profileLine ? `\n${profileLine}` : '';

  return (
    `⏰ No reminder time received for ${targetText} — I've scheduled your reminder for ${defaultHours} hours from now (${targetStr}).` +
    `${profileBlock}\n\nReply e.g. "2h" or "tomorrow 5pm" anytime to change it, or "watched" when done!`
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
  const profileLine = publicHandle ? `\n${formatCreatorProfileLine(creatorRef)}` : '';
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
      `🔍 No saved reels found for Creator: ${creatorLabel} yet.${profileLine}\n\n` +
      `They do have ${postsStr} — reply "posts by ${cmdTarget}" to view ${totalPosts === 1 ? 'it' : 'them'}.`;
  } else if (mediaFilter === 'post' && totalReels > 0) {
    const reelsStr = totalReels === 1 ? '1 saved reel' : `${totalReels} saved reels`;
    notFound =
      `🔍 No saved posts found for Creator: ${creatorLabel} yet.${profileLine}\n\n` +
      `They do have ${reelsStr} — reply "reels by ${cmdTarget}" to view ${totalReels === 1 ? 'it' : 'them'}.`;
  } else if (mediaFilter === 'reel') {
    notFound =
      `🔍 No saved reels found for Creator: ${creatorLabel} yet!${profileLine}\n\n` +
      `Share any Reel link from them here to start tracking.`;
  } else if (mediaFilter === 'post') {
    notFound =
      `🔍 No saved posts found for Creator: ${creatorLabel} yet!${profileLine}\n\n` +
      `Share any Post link from them here to start tracking.`;
  } else {
    notFound =
      `🔍 No saved reels or posts found for Creator: ${creatorLabel} yet!${profileLine}\n\n` +
      `Share any Reel or Post link from them here to start tracking.`;
  }

  // Mixed creator library: isolate Reels vs Posts into dedicated sections
  if (mediaFilter === 'all' && totalReels > 0 && totalPosts > 0) {
    const totalItems = totalReels + totalPosts;
    const reelsPart = totalReels === 1 ? '1 reel' : `${totalReels} reels`;
    const postsPart = totalPosts === 1 ? '1 post' : `${totalPosts} posts`;
    const header =
      `📂 Saved Library\n` +
      `Creator: ${creatorLabel}${profileLine}\n` +
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
        ? `... and ${remParts.join(' & ')} from ${creatorLabel} in your library!${profileLine}\n\n` +
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
      header: `🖼️ Saved Posts\nCreator: ${creatorLabel}${profileLine}\nFound: ${countLabel}\n\n${latestLabel}`,
      reelsSectionHeader: null,
      postsSectionHeader: null,
      footer:
        remPosts > 0
          ? `... and ${remPosts} more ${remPosts === 1 ? 'post' : 'posts'} from ${creatorLabel} in your library!${profileLine}\n\n` +
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
    header: `🎬 Saved Reels\nCreator: ${creatorLabel}${profileLine}\nFound: ${countLabel}\n\n${latestLabel}`,
    reelsSectionHeader: null,
    postsSectionHeader: null,
    footer:
      remReels > 0
        ? `... and ${remReels} more ${remReels === 1 ? 'reel' : 'reels'} from ${creatorLabel} in your library!${profileLine}\n\n` +
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
  const publicHandle = extractPublicCreatorUsername(reel.creator);
  const creatorDisplay = formatCreatorDisplayLabel(reel.creator, { includeProfileUrl: false });
  const fallbackHeader = isPost
    ? (isSavedOnIg ? '🖼️ Saved Post' : '🖼️ Watch Later Post')
    : (isSavedOnIg ? '🎬 Saved Reel' : '🎬 Watch Later Reel');
  const creatorHeader = creatorDisplay
    ? `${isPost ? '🖼️' : '🎬'} ${creatorDisplay}`
    : fallbackHeader;
  const actionLabel = isPost ? '👉 View Post:' : '👉 Watch Reel:';
  const captionSnippet = formatHumanCaptionSnippet(reel.caption, 70);
  const captionLine = captionSnippet ? `"${captionSnippet}"\n` : '';
  const profileLine = publicHandle
    ? `\n👤 Creator Profile: ${formatCreatorProfileUrl(publicHandle)}`
    : '';

  return (
    `🔔 Watch Later Reminder!\n\n` +
    `${creatorHeader}\n` +
    `${captionLine}` +
    `${actionLabel} ${reel.reel_url}` +
    `${profileLine}\n\n` +
    `Reply "watched" when done, or reply e.g. "5m" or "snooze 1h" to delay!`
  );
}

/**
 * Formats the confirmation DM sent after marking one or all Watch Later items as watched.
 */
export function formatWatchedConfirmationMessage(
  updatedReels: SavedReel[],
  remainingCount: number,
  markAll: boolean
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
