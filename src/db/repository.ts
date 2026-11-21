import type {
  Creator,
  SavedReel,
  SavedMediaType,
  SavedCollectionSource,
  ReelQueryFilters,
  LibraryStats,
  WatchStatus,
  DateFilterPreset,
  BatchReelsResult
} from '../types.ts';
import { classifySavedMediaType } from '../utils/mediaType.ts';
import { resolveTimeZone } from '../utils/timezone.ts';
import { getSupabase, isSupabaseConfigured } from './client.ts';

/**
 * Error thrown when a different Instagram sender attempts to schedule or overwrite
 * an active Watch Later reminder already owned by another sender on the same item.
 */
export class SenderReminderConflictError extends Error {
  readonly shortcode: string;

  /**
   * Creates a conflict error identifying the shortcode whose active reminder is owned by another sender.
   */
  constructor(shortcode: string) {
    super(`Watch Later reminder already active for another sender on ${shortcode}`);
    this.name = 'SenderReminderConflictError';
    this.shortcode = shortcode;
  }
}

/**
 * Error thrown when a reel write is attempted for a sender whose account data was recently deleted,
 * preventing race-condition re-creation from in-flight webhook requests.
 */
export class SenderDeletionBarrierError extends Error {
  readonly senderId: string;

  constructor(senderId: string) {
    super(`Cannot save reel for sender ${senderId} during active deletion barrier window`);
    this.name = 'SenderDeletionBarrierError';
    this.senderId = senderId;
  }
}

/**
 * Error thrown when an archive import exceeds its bounded execution deadline so the single
 * import execution slot cannot be held indefinitely by a stalled upstream database call.
 */
export class ArchiveImportTimeoutError extends Error {
  constructor(message = 'Archive import exceeded execution deadline') {
    super(message);
    this.name = 'ArchiveImportTimeoutError';
  }
}

function assertImportNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof ArchiveImportTimeoutError
      ? signal.reason
      : new ArchiveImportTimeoutError();
  }
}

function applyAbortSignal<T>(query: T, signal?: AbortSignal): T {
  if (signal && query && typeof (query as any).abortSignal === 'function') {
    return (query as any).abortSignal(signal);
  }
  return query;
}

/**
 * Escapes and quotes a literal string value for inclusion inside a PostgREST filter expression.
 */
function quotePostgrestLiteral(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Returns true when an incoming write would clobber another owner's saved reel:
 * - An unattributed (admin/legacy) write targeting a sender-owned row always conflicts.
 * - An incoming Instagram sender targeting an active `watch_later` reminder owned by a
 *   different sender (or unattributed admin/UI queue) conflicts.
 */
function isConflictingActiveSenderReminder(
  existing: Pick<SavedReel, 'watch_status' | 'instagram_sender_id'>,
  incomingSenderId?: string | null
): boolean {
  const incoming = String(incomingSenderId || '').trim();
  const owner = String(existing.instagram_sender_id || '').trim();
  if (!incoming) {
    return Boolean(owner);
  }
  if (existing.watch_status !== 'watch_later') return false;
  return owner !== incoming;
}

/**
 * Resolves the authoritative save timestamp for sorting and date filtering (`saved_at` with `first_detected_at` fallback).
 */
export function resolveEffectiveSavedAt(reel: {
  saved_at?: string | null;
  first_detected_at?: string | null;
  taken_at?: string | null;
}): string {
  return reel.saved_at || reel.first_detected_at || reel.taken_at || '';
}

/**
 * Determines whether an archive-import `saved_at` timestamp should backfill an existing record
 * that lacks `saved_at` or has a later fallback DM-ingestion timestamp.
 */
export function shouldBackfillSavedAt(
  existing: { instagram_media_id?: string | null; saved_at?: string | null },
  incomingSavedAt?: string | null
): boolean {
  if (!incomingSavedAt) return false;
  const incomingMs = Date.parse(incomingSavedAt);
  if (!Number.isFinite(incomingMs)) return false;
  if (!existing.saved_at) return true;

  const isDmIngested =
    Boolean(existing.instagram_media_id?.startsWith('dm_')) ||
    Boolean(existing.instagram_media_id?.startsWith('shortcode_')) ||
    Boolean(existing.instagram_media_id?.startsWith('id_'));
  if (!isDmIngested) return false;

  const existingMs = Date.parse(existing.saved_at);
  return !Number.isFinite(existingMs) || incomingMs < existingMs;
}

// In-Memory store for offline/demo/development fallback
class InMemoryStore {
  creators: Map<string, Creator> = new Map();
  reels: Map<string, SavedReel> = new Map();

  async upsertCreator(data: {
    instagram_user_id: string;
    username: string;
    display_name?: string | null;
    profile_picture_url?: string | null;
  }): Promise<Creator> {
    let existing: Creator | undefined;
    for (const c of this.creators.values()) {
      if (c.instagram_user_id === data.instagram_user_id) {
        existing = c;
        break;
      }
    }

    const now = new Date().toISOString();
    if (existing) {
      existing.username = data.username;
      existing.display_name = data.display_name ?? existing.display_name;
      existing.profile_picture_url = data.profile_picture_url ?? existing.profile_picture_url;
      existing.updated_at = now;
      return existing;
    }

    const newCreator: Creator = {
      id: `creator_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      instagram_user_id: data.instagram_user_id,
      username: data.username,
      display_name: data.display_name,
      profile_picture_url: data.profile_picture_url,
      created_at: now,
      updated_at: now,
    };
    this.creators.set(newCreator.id, newCreator);
    return newCreator;
  }

  /**
   * Inserts or updates a saved reel/post in the in-memory store, preserving existing `saved_at` when appropriate.
   */
  async upsertSavedReel(data: {
    instagram_media_id: string;
    shortcode: string;
    reel_url: string;
    media_type?: SavedMediaType;
    creator_id: string;
    caption?: string | null;
    thumbnail_url?: string | null;
    taken_at: string;
    saved_at?: string | null;
    first_detected_at: string;
    save_order_rank: number;
    watch_status?: WatchStatus;
    duration_seconds?: number | null;
    reminder_interval_hours?: number | null;
    reminder_interval_seconds?: number | null;
    next_reminder_at?: string | null;
    is_saved_on_instagram?: boolean;
    instagram_sender_id?: string | null;
    awaiting_reminder_choice_until?: string | null;
  }, options?: { ignoreDuplicates?: boolean; skipReturn?: boolean; onInsertResult?: (inserted: boolean) => void }): Promise<SavedReel | null> {
    let existing: SavedReel | undefined;
    for (const r of this.reels.values()) {
      if (r.instagram_media_id === data.instagram_media_id) {
        existing = r;
        break;
      }
    }
    if (!existing) {
      const incomingSender = data.instagram_sender_id ? String(data.instagram_sender_id).trim() || null : null;
      for (const r of this.reels.values()) {
        const rowSender = r.instagram_sender_id ? String(r.instagram_sender_id).trim() || null : null;
        if (r.shortcode === data.shortcode && rowSender === incomingSender) {
          existing = r;
          break;
        }
      }
    }

    const now = new Date().toISOString();

    if (existing) {
      if (options?.ignoreDuplicates) {
        options.onInsertResult?.(false);
        return options.skipReturn ? null : existing;
      }
      if (isConflictingActiveSenderReminder(existing, data.instagram_sender_id)) {
        throw new SenderReminderConflictError(data.shortcode);
      }
      if (data.reel_url) existing.reel_url = data.reel_url;
      existing.media_type = classifySavedMediaType({
        mediaType: data.media_type ?? existing.media_type,
        reelUrl: data.reel_url || existing.reel_url,
      });
      existing.creator_id = data.creator_id || existing.creator_id;
      existing.caption = data.caption ?? existing.caption;
      existing.thumbnail_url = data.thumbnail_url ?? existing.thumbnail_url;
      existing.save_order_rank = data.save_order_rank;
      if (data.watch_status) existing.watch_status = data.watch_status;
      if (data.next_reminder_at !== undefined) existing.next_reminder_at = data.next_reminder_at;
      if (data.awaiting_reminder_choice_until !== undefined) existing.awaiting_reminder_choice_until = data.awaiting_reminder_choice_until;
      if (data.reminder_interval_hours !== undefined && data.reminder_interval_hours !== null) {
        existing.reminder_interval_hours = data.reminder_interval_hours;
      }
      if (data.reminder_interval_seconds !== undefined && data.reminder_interval_seconds !== null) {
        existing.reminder_interval_seconds = data.reminder_interval_seconds;
        existing.reminder_interval_hours = Math.round(data.reminder_interval_seconds / 3600);
      }
      if (data.saved_at !== undefined && data.saved_at !== null) {
        if (existing.saved_at == null || shouldBackfillSavedAt(existing, data.saved_at)) {
          existing.saved_at = data.saved_at;
        }
      }
      if (data.first_detected_at) {
        existing.first_detected_at = existing.first_detected_at || data.first_detected_at;
      }
      // Monotonic source ownership: never demote Instagram-saved -> Bot-sent on stale bot writes
      if (data.is_saved_on_instagram === true) {
        existing.is_saved_on_instagram = true;
      }
      existing.effective_saved_at = resolveEffectiveSavedAt(existing);
      if (data.instagram_sender_id !== undefined) existing.instagram_sender_id = data.instagram_sender_id;
      existing.updated_at = now;
      options?.onInsertResult?.(false);
      return options?.skipReturn ? null : { ...existing, creator: this.creators.get(existing.creator_id) };
    }

    const resolvedMediaType = classifySavedMediaType({
      mediaType: data.media_type,
      reelUrl: data.reel_url,
    });

    const newReel: SavedReel = {
      id: `reel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      instagram_media_id: data.instagram_media_id,
      shortcode: data.shortcode,
      reel_url: data.reel_url,
      media_type: resolvedMediaType,
      creator_id: data.creator_id,
      caption: data.caption,
      thumbnail_url: data.thumbnail_url,
      taken_at: data.taken_at,
      saved_at: data.saved_at,
      first_detected_at: data.first_detected_at,
      effective_saved_at: resolveEffectiveSavedAt(data),
      save_order_rank: data.save_order_rank,
      watch_status: data.watch_status || 'unwatched',
      duration_seconds: data.duration_seconds,
      reminder_interval_hours: data.reminder_interval_seconds
        ? Math.round(data.reminder_interval_seconds / 3600)
        : (data.reminder_interval_hours ?? 10),
      reminder_interval_seconds: data.reminder_interval_seconds ?? undefined,
      reminders_sent_count: 0,
      next_reminder_at: data.next_reminder_at,
      awaiting_reminder_choice_until: data.awaiting_reminder_choice_until,
      is_saved_on_instagram: data.is_saved_on_instagram ?? true,
      instagram_sender_id: data.instagram_sender_id,
      is_unavailable: false,
      created_at: now,
      updated_at: now,
      creator: this.creators.get(data.creator_id),
    };

    this.reels.set(newReel.id, newReel);
    options?.onInsertResult?.(true);
    return options?.skipReturn ? null : newReel;
  }

  async upsertCreatorsBatch(creators: Array<{
    instagram_user_id: string;
    username: string;
    display_name?: string | null;
    profile_picture_url?: string | null;
  }>, options?: { preserveExisting?: boolean }): Promise<Map<string, Creator>> {
    const result = new Map<string, Creator>();
    for (const c of creators) {
      if (options?.preserveExisting) {
        let existing: Creator | undefined;
        for (const existingCreator of this.creators.values()) {
          if (existingCreator.instagram_user_id === c.instagram_user_id) {
            existing = existingCreator;
            break;
          }
        }
        if (existing) {
          result.set(c.username, existing);
          continue;
        }
      }
      const creator = await this.upsertCreator(c);
      result.set(creator.username, creator);
    }
    return result;
  }

  /**
   * Batch-upserts saved items into the in-memory store with duplicate-skipping,
   * bot-to-IG promotion, and missing `saved_at` backfill.
   */
  async upsertSavedReelsBatch(reels: Array<{
    instagram_media_id: string;
    shortcode: string;
    reel_url: string;
    media_type?: SavedMediaType;
    creator_id: string;
    caption?: string | null;
    thumbnail_url?: string | null;
    taken_at: string;
    saved_at?: string | null;
    first_detected_at: string;
    save_order_rank: number;
    watch_status?: WatchStatus;
    duration_seconds?: number | null;
    reminder_interval_hours?: number | null;
    reminder_interval_seconds?: number | null;
    next_reminder_at?: string | null;
    awaiting_reminder_choice_until?: string | null;
    is_saved_on_instagram?: boolean;
    instagram_sender_id?: string | null;
  }>, options?: {
    ignoreDuplicates?: boolean;
    backfillMissingSavedAt?: boolean;
    signal?: AbortSignal;
    onBeforeMemoryWriteForTesting?: (signal?: AbortSignal) => Promise<void>;
  }): Promise<BatchReelsResult> {
    let newlyImported = 0;
    let alreadyPresent = 0;
    let savedAtBackfilled = 0;
    let promotedToSaved = 0;
    let failedCount = 0;
    const failedShortcodes: string[] = [];

    for (const r of reels) {
      try {
        assertImportNotAborted(options?.signal);
        if (options?.onBeforeMemoryWriteForTesting) {
          await options.onBeforeMemoryWriteForTesting(options.signal);
          assertImportNotAborted(options?.signal);
        }
        let existing: SavedReel | undefined;
        const incomingSender = r.instagram_sender_id ? String(r.instagram_sender_id).trim() || null : null;
        if (incomingSender && Repository.isSenderInRecentDeletion(incomingSender)) {
          throw new SenderDeletionBarrierError(incomingSender);
        }
        for (const existingReel of this.reels.values()) {
          const rowSender = existingReel.instagram_sender_id
            ? String(existingReel.instagram_sender_id).trim() || null
            : null;
          if (existingReel.instagram_media_id === r.instagram_media_id && rowSender === incomingSender) {
            existing = existingReel;
            break;
          }
        }
        if (!existing) {
          for (const existingReel of this.reels.values()) {
            const rowSender = existingReel.instagram_sender_id
              ? String(existingReel.instagram_sender_id).trim() || null
              : null;
            if (existingReel.shortcode === r.shortcode && rowSender === incomingSender) {
              existing = existingReel;
              break;
            }
          }
        }

        if (existing && options?.ignoreDuplicates) {
          alreadyPresent++;
          const shouldPromote = r.is_saved_on_instagram !== false && existing.is_saved_on_instagram === false;
          const shouldBackfill = Boolean(
            options.backfillMissingSavedAt && r.saved_at && shouldBackfillSavedAt(existing, r.saved_at)
          );
          if (shouldPromote || shouldBackfill) {
            if (shouldPromote) {
              existing.is_saved_on_instagram = true;
              promotedToSaved++;
            }
            if (shouldBackfill) {
              existing.saved_at = r.saved_at;
              existing.effective_saved_at = resolveEffectiveSavedAt(existing);
              existing.save_order_rank = r.save_order_rank;
              savedAtBackfilled++;
            }
            existing.updated_at = new Date().toISOString();
          }
          continue;
        }

        if (options?.ignoreDuplicates) {
          // Detect incompatible-owner media ID collision (matches Supabase owner-scoped reconciliation)
          let foreignOwnerCollision = false;
          for (const existingReel of this.reels.values()) {
            const rowSender = existingReel.instagram_sender_id
              ? String(existingReel.instagram_sender_id).trim() || null
              : null;
            if (existingReel.instagram_media_id === r.instagram_media_id && rowSender !== incomingSender) {
              foreignOwnerCollision = true;
              break;
            }
          }
          if (foreignOwnerCollision) {
            failedCount++;
            failedShortcodes.push(r.shortcode);
            continue;
          }
        }

        let itemInserted = false;
        await this.upsertSavedReel(r, {
          ignoreDuplicates: options?.ignoreDuplicates,
          skipReturn: true,
          onInsertResult: (inserted) => {
            itemInserted = inserted;
          },
        });
        if (itemInserted || !options?.ignoreDuplicates) {
          newlyImported++;
        } else {
          failedCount++;
          failedShortcodes.push(r.shortcode);
        }
      } catch (err: any) {
        if (err instanceof SenderDeletionBarrierError || err instanceof ArchiveImportTimeoutError) {
          throw err;
        }
        failedCount++;
        failedShortcodes.push(r.shortcode);
      }
    }

    return { newlyImported, alreadyPresent, savedAtBackfilled, promotedToSaved, failedCount, failedShortcodes };
  }

  /**
   * Filters and sorts in-memory saved reels across collection source, media type, creator handles, captions, and shortcodes.
   */
  async getReels(filters: ReelQueryFilters) {
    let list = Array.from(this.reels.values()).map(r => ({
      ...r,
      media_type: classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }),
      creator: this.creators.get(r.creator_id)
    }));

    // Filter by Instagram Sender ID (for non-admin scoped vaults)
    if (filters.instagramSenderId && filters.instagramSenderId !== 'admin') {
      list = list.filter(r => r.instagram_sender_id === filters.instagramSenderId);
    }

    // Filter by Creator
    if (filters.creatorId) {
      list = list.filter(r => r.creator_id === filters.creatorId);
    }

    // Filter by Collection Source (Instagram Saved vs Bot-Sent)
    if (filters.source === 'instagram') {
      list = list.filter(r => r.is_saved_on_instagram !== false);
    } else if (filters.source === 'bot') {
      list = list.filter(r => r.is_saved_on_instagram === false);
    }

    // Filter by Watch Status
    if (filters.watchStatus && filters.watchStatus !== 'all') {
      list = list.filter(r => r.watch_status === filters.watchStatus);
    }

    // Filter by Media Type (Reel vs Post)
    if (filters.mediaType && filters.mediaType !== 'all') {
      list = list.filter(r => r.media_type === filters.mediaType);
    }

    // Filter by Date Preset or Range (uses effective save timestamp)
    const { startDate, endDate } = resolveDateRange(filters.datePreset, filters.startDate, filters.endDate);
    if (startDate) {
      const startMs = parseTimestampMs(startDate);
      list = list.filter(r => parseTimestampMs(resolveEffectiveSavedAt(r)) >= startMs);
    }
    if (endDate) {
      const endMs = parseTimestampMs(endDate);
      list = list.filter(r => parseTimestampMs(resolveEffectiveSavedAt(r)) <= endMs);
    }

    // Search query (captions, creator handles, creator display names, and shortcodes)
    if (filters.search?.trim()) {
      const q = filters.search.toLowerCase().trim();
      const handleQ = q.replace(/^@+/, '');
      list = list.filter(r => {
        const captionMatch = r.caption?.toLowerCase().includes(q) ?? false;
        const shortcodeMatch = r.shortcode?.toLowerCase().includes(q) ?? false;
        const usernameMatch = r.creator?.username.toLowerCase().includes(handleQ) ?? false;
        const nameMatch = (
          r.creator?.display_name?.toLowerCase().includes(q) ||
          (handleQ !== q && Boolean(handleQ) && r.creator?.display_name?.toLowerCase().includes(handleQ))
        ) ?? false;
        return captionMatch || shortcodeMatch || usernameMatch || nameMatch;
      });
    }

    // Sorting with deterministic tie-breakers
    const sort = filters.sortBy || 'newest_saved';
    list.sort((a, b) => {
      if (sort === 'newest_saved') {
        const savedDiff =
          parseTimestampMs(resolveEffectiveSavedAt(b)) -
          parseTimestampMs(resolveEffectiveSavedAt(a));
        if (savedDiff !== 0) return savedDiff;
        const rankDiff = (a.save_order_rank || 0) - (b.save_order_rank || 0);
        if (rankDiff !== 0) return rankDiff;
      } else if (sort === 'oldest_saved') {
        const savedDiff =
          parseTimestampMs(resolveEffectiveSavedAt(a)) -
          parseTimestampMs(resolveEffectiveSavedAt(b));
        if (savedDiff !== 0) return savedDiff;
        const rankDiff = (b.save_order_rank || 0) - (a.save_order_rank || 0);
        if (rankDiff !== 0) return rankDiff;
      } else if (sort === 'newest_published') {
        const pubDiff = parseTimestampMs(b.taken_at) - parseTimestampMs(a.taken_at);
        if (pubDiff !== 0) return pubDiff;
        const savedDiff =
          parseTimestampMs(resolveEffectiveSavedAt(b)) -
          parseTimestampMs(resolveEffectiveSavedAt(a));
        if (savedDiff !== 0) return savedDiff;
      } else if (sort === 'oldest_published') {
        const pubDiff = parseTimestampMs(a.taken_at) - parseTimestampMs(b.taken_at);
        if (pubDiff !== 0) return pubDiff;
        const savedDiff =
          parseTimestampMs(resolveEffectiveSavedAt(b)) -
          parseTimestampMs(resolveEffectiveSavedAt(a));
        if (savedDiff !== 0) return savedDiff;
      }
      const detectedDiff = parseTimestampMs(b.first_detected_at) - parseTimestampMs(a.first_detected_at);
      if (detectedDiff !== 0) return detectedDiff;
      return String(a.id).localeCompare(String(b.id));
    });

    const total = list.length;
    const page = Math.max(1, filters.page || 1);
    const limit = Math.max(1, Math.min(100, filters.limit || 24));
    const offset = (page - 1) * limit;
    const paged = list.slice(offset, offset + limit);

    return { reels: paged, total, page, limit };
  }

  async getCreators(senderId?: string): Promise<Creator[]> {
    const trimmedSender = String(senderId || '').trim();
    const activeReels = trimmedSender && trimmedSender !== 'admin'
      ? Array.from(this.reels.values()).filter(r => r.instagram_sender_id === trimmedSender)
      : Array.from(this.reels.values());

    const counts = new Map<string, number>();
    for (const r of activeReels) {
      counts.set(r.creator_id, (counts.get(r.creator_id) || 0) + 1);
    }

    const list = Array.from(this.creators.values())
      .filter(c => counts.has(c.id))
      .map(c => ({
        ...c,
        saved_count: counts.get(c.id) || 0
      }));

    list.sort((a, b) => (b.saved_count || 0) - (a.saved_count || 0) || a.username.localeCompare(b.username));
    return list;
  }

  /**
   * Computes library totals, weekly/monthly save counts via `effective_saved_at`, and top creators from memory.
   */
  async getStats(senderId?: string): Promise<LibraryStats> {
    const trimmedSender = String(senderId || '').trim();
    const allReels = trimmedSender && trimmedSender !== 'admin'
      ? Array.from(this.reels.values()).filter(r => r.instagram_sender_id === trimmedSender)
      : Array.from(this.reels.values());

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    let reelsCount = 0;
    let postsCount = 0;
    let savedOnInstagramCount = 0;
    let botSentCount = 0;
    let savedThisWeek = 0;
    let savedThisMonth = 0;
    let unwatchedCount = 0;
    let watchedCount = 0;
    let watchLaterCount = 0;

    for (const r of allReels) {
      if (r.is_saved_on_instagram === false) {
        botSentCount++;
      } else {
        savedOnInstagramCount++;
      }

      if (classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }) === 'post') {
        postsCount++;
      } else {
        reelsCount++;
      }

      const effectiveSavedMs = parseTimestampMs(resolveEffectiveSavedAt(r));
      if (effectiveSavedMs >= sevenDaysAgo) savedThisWeek++;
      if (effectiveSavedMs >= thirtyDaysAgo) savedThisMonth++;

      if (r.watch_status === 'unwatched') unwatchedCount++;
      else if (r.watch_status === 'watched') watchedCount++;
      else if (r.watch_status === 'watch_later') watchLaterCount++;
    }

    const creators = await this.getCreators(senderId);
    const topCreators = creators.slice(0, 5).map(c => ({
      id: c.id,
      username: c.username,
      display_name: c.display_name,
      profile_picture_url: c.profile_picture_url,
      count: c.saved_count || 0
    }));

    return {
      totalReels: allReels.length,
      savedOnInstagramCount,
      botSentCount,
      reelsCount,
      postsCount,
      totalCreators: creators.length,
      savedThisWeek,
      savedThisMonth,
      unwatchedCount,
      watchedCount,
      watchLaterCount,
      topCreators
    };
  }

  async updateWatchStatus(id: string, status: WatchStatus, senderId?: string): Promise<SavedReel | null> {
    const reel = this.reels.get(id);
    if (!reel) return null;
    const trimmedSender = String(senderId || '').trim();
    if (trimmedSender && trimmedSender !== 'admin' && reel.instagram_sender_id !== trimmedSender) {
      return null;
    }
    reel.watch_status = status;
    if (status !== 'watch_later') {
      reel.next_reminder_at = null;
      reel.awaiting_reminder_choice_until = null;
    }
    reel.updated_at = new Date().toISOString();
    return { ...reel, creator: this.creators.get(reel.creator_id) };
  }
}

export interface MarkWatchedResult {
  updatedReels: SavedReel[];
  remainingCount: number;
  remainingReels?: SavedReel[];
}

export interface LegacyReelUrlCandidate {
  id: string;
  shortcode: string;
  reel_url: string;
  media_type: SavedMediaType;
}

function parseTimestampMs(iso?: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Orders active Watch Later reels so the most recently reminded or updated reel always comes first,
 * preventing older queued reels from being selected or reported ahead of a just-reminded reel.
 */
export function sortWatchLaterReelsMostRecentFirst(reels: SavedReel[]): SavedReel[] {
  return [...reels].sort((a, b) => {
    const bInteraction = Math.max(parseTimestampMs(b.last_reminded_at), parseTimestampMs(b.updated_at));
    const aInteraction = Math.max(parseTimestampMs(a.last_reminded_at), parseTimestampMs(a.updated_at));
    if (bInteraction !== aInteraction) return bInteraction - aInteraction;

    const bReminded = parseTimestampMs(b.last_reminded_at);
    const aReminded = parseTimestampMs(a.last_reminded_at);
    if (bReminded !== aReminded) return bReminded - aReminded;

    const bUpdated = parseTimestampMs(b.updated_at);
    const aUpdated = parseTimestampMs(a.updated_at);
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;

    const bCreated = parseTimestampMs(b.created_at);
    const aCreated = parseTimestampMs(a.created_at);
    if (bCreated !== aCreated) return bCreated - aCreated;

    return String(a.id).localeCompare(String(b.id));
  });
}

const memoryStore = new InMemoryStore();

function resolveDateRange(preset?: DateFilterPreset, customStart?: string, customEnd?: string) {
  if (preset === 'custom' || (!preset && (customStart || customEnd))) {
    return { startDate: customStart, endDate: customEnd };
  }

  if (!preset || preset === 'all') {
    return { startDate: undefined, endDate: undefined };
  }

  const now = new Date();
  const start = new Date(now);

  switch (preset) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday': {
      start.setDate(now.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    case '7d':
      start.setDate(now.getDate() - 7);
      break;
    case '30d':
      start.setDate(now.getDate() - 30);
      break;
    case '3m':
      start.setMonth(now.getMonth() - 3);
      break;
    case '6m':
      start.setMonth(now.getMonth() - 6);
      break;
    case 'year':
      start.setFullYear(now.getFullYear(), 0, 1);
      start.setHours(0, 0, 0, 0);
      break;
  }

  return { startDate: start.toISOString(), endDate: undefined };
}

/**
 * Sanitizes user search text before interpolating into PostgREST `.or()` / `ilike` filter expressions.
 */
export function sanitizePostgrestSearchTerm(raw: string): { text: string; handle: string } {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[,()\\"*]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .replace(/\s+/g, ' ')
    .trim();
  const handle = cleaned.replace(/^@+/, '').trim();
  return { text: cleaned, handle };
}

/**
 * Detects Supabase PostgREST 416 / PGRST103 errors returned when a paginated `.range()` offset
 * extends past the last available matching row.
 */
export function isPostgrestRangeNotSatisfiableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errObj = error as { code?: unknown; status?: unknown; message?: unknown };
  if (errObj.code === 'PGRST103' || errObj.status === 416) {
    return true;
  }
  return typeof errObj.message === 'string' && /range not satisfiable/i.test(errObj.message);
}

/**
 * Applies resolved reel query predicates onto a Supabase query builder for data and count queries.
 */
function applyReelQueryFilters(
  query: any,
  params: {
    creatorId?: string;
    instagramSenderId?: string | null;
    source?: SavedCollectionSource | 'all';
    watchStatus?: WatchStatus | 'all';
    mediaType?: SavedMediaType | 'all';
    startDate?: string;
    endDate?: string;
    searchClauses: string[];
  }
): any {
  let next = query;
  if (params.instagramSenderId && params.instagramSenderId !== 'admin') {
    next = next.eq('instagram_sender_id', params.instagramSenderId);
  }
  if (params.creatorId) {
    next = next.eq('creator_id', params.creatorId);
  }
  if (params.source === 'instagram') {
    next = next.eq('is_saved_on_instagram', true);
  } else if (params.source === 'bot') {
    next = next.eq('is_saved_on_instagram', false);
  }
  if (params.watchStatus && params.watchStatus !== 'all') {
    next = next.eq('watch_status', params.watchStatus);
  }
  if (params.mediaType && params.mediaType !== 'all') {
    next = next.eq('media_type', params.mediaType);
  }
  if (params.startDate) {
    next = next.gte('effective_saved_at', params.startDate);
  }
  if (params.endDate) {
    next = next.lte('effective_saved_at', params.endDate);
  }
  if (params.searchClauses.length > 0) {
    next = next.or(params.searchClauses.join(','));
  }
  return next;
}

export interface CreatorQueryOptions {
  q?: string;
  limit?: number;
  includeId?: string;
}

export interface CreatorQueryResult {
  creators: Creator[];
  totalCount: number;
  matchCount: number;
}

const CREATORS_CACHE_TTL_MS = 30_000;

export class Repository {
  private static creatorsCache: Creator[] | null = null;
  private static creatorsCacheAt = 0;
  private static creatorsCacheGeneration = 0;
  private static creatorsInFlight: Promise<Creator[]> | null = null;

  /**
   * Clears cached creator directory state and bumps generation so pre-mutation in-flight reads cannot repopulate stale data.
   */
  static invalidateCreatorsCache(): void {
    Repository.creatorsCacheGeneration++;
    Repository.creatorsCache = null;
    Repository.creatorsCacheAt = 0;
    Repository.creatorsInFlight = null;
  }

  static async upsertCreator(data: {
    instagram_user_id: string;
    username: string;
    display_name?: string | null;
    profile_picture_url?: string | null;
  }, options?: { signal?: AbortSignal }): Promise<Creator> {
    assertImportNotAborted(options?.signal);
    Repository.invalidateCreatorsCache();
    if (!isSupabaseConfigured()) {
      return memoryStore.upsertCreator(data);
    }

    const supabase = getSupabase();
    try {
      const { data: creator, error } = await applyAbortSignal(
        supabase
          .from('creators')
          .upsert(
            {
              instagram_user_id: data.instagram_user_id,
              username: data.username,
              display_name: data.display_name,
              profile_picture_url: data.profile_picture_url,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'instagram_user_id' }
          )
          .select()
          .single(),
        options?.signal
      );
      assertImportNotAborted(options?.signal);

      if (error || !creator) {
        throw new Error(`Supabase upsertCreator failed: ${error?.message || 'unknown error'}`);
      }

      return creator as Creator;
    } finally {
      Repository.invalidateCreatorsCache();
    }
  }

  /**
   * Inserts a new saved reel/post or updates an existing row in Supabase while preserving monotonic
   * `is_saved_on_instagram` provenance, `saved_at` timestamps, and active sender reminder ownership.
   */
  static async upsertSavedReel(data: {
    instagram_media_id: string;
    shortcode: string;
    reel_url: string;
    media_type?: SavedMediaType;
    creator_id: string;
    caption?: string | null;
    thumbnail_url?: string | null;
    taken_at: string;
    saved_at?: string | null;
    first_detected_at: string;
    save_order_rank: number;
    watch_status?: WatchStatus;
    duration_seconds?: number | null;
    reminder_interval_hours?: number | null;
    reminder_interval_seconds?: number | null;
    next_reminder_at?: string | null;
    awaiting_reminder_choice_until?: string | null;
    is_saved_on_instagram?: boolean;
    instagram_sender_id?: string | null;
  }, options?: { ignoreDuplicates?: boolean; skipReturn?: boolean }): Promise<SavedReel | null> {
    const sender = String(data.instagram_sender_id || '').trim();
    if (sender && Repository.isSenderInRecentDeletion(sender)) {
      console.warn(`[Repository] Rejecting reel upsert for sender ${sender} due to active deletion window`);
      throw new SenderDeletionBarrierError(sender);
    }

    Repository.invalidateCreatorsCache();
    if (!isSupabaseConfigured()) {
      return memoryStore.upsertSavedReel(data, options);
    }

    const supabase = getSupabase();
    try {
      const intervalSeconds = data.reminder_interval_seconds ?? (data.reminder_interval_hours ? data.reminder_interval_hours * 3600 : 36000);
      const mediaType = classifySavedMediaType({
        mediaType: data.media_type,
        reelUrl: data.reel_url,
      });
      const resolvedSavedOnIg = data.is_saved_on_instagram ?? true;
      const nowIso = new Date().toISOString();
      const insertPayload = {
        instagram_media_id: data.instagram_media_id,
        shortcode: data.shortcode,
        reel_url: data.reel_url,
        media_type: mediaType,
        creator_id: data.creator_id,
        caption: data.caption,
        thumbnail_url: data.thumbnail_url,
        taken_at: data.taken_at,
        saved_at: data.saved_at ?? null,
        first_detected_at: data.first_detected_at,
        save_order_rank: data.save_order_rank,
        watch_status: data.watch_status || 'unwatched',
        duration_seconds: data.duration_seconds,
        reminder_interval_hours: Math.round(intervalSeconds / 3600),
        reminder_interval_seconds: intervalSeconds,
        next_reminder_at: data.next_reminder_at,
        awaiting_reminder_choice_until: data.awaiting_reminder_choice_until ?? null,
        is_saved_on_instagram: resolvedSavedOnIg,
        instagram_sender_id: data.instagram_sender_id,
        updated_at: nowIso,
      };

      const isConflictError = (err: { code?: string; message?: string } | null | undefined) =>
        Boolean(
          err &&
            (err.code === '23505' ||
              err.message?.includes('duplicate key') ||
              err.message?.includes('shortcode') ||
              err.message?.includes('instagram_media_id'))
        );

      // Atomic insert-if-absent so stale bot writes never demote a concurrently promoted IG row via ON CONFLICT DO UPDATE
      const insertQuery = supabase
        .from('saved_reels')
        .upsert(insertPayload, { onConflict: 'instagram_media_id', ignoreDuplicates: true });

      const { data: insertedReel, error } = options?.skipReturn
        ? await insertQuery.select('id').maybeSingle()
        : await insertQuery.select('*, creator:creators(*)').maybeSingle();

      if (error && !isConflictError(error)) {
        throw new Error(`Supabase upsertSavedReel failed: ${error.message}`);
      }

      if (insertedReel) {
        return options?.skipReturn ? null : (insertedReel as SavedReel);
      }

      if (options?.ignoreDuplicates && options.skipReturn) {
        return null;
      }

      const incomingSender = String(data.instagram_sender_id || '').trim();
      const fetchExisting = async () => {
        const byMedia = await supabase
          .from('saved_reels')
          .select('*, creator:creators(*)')
          .eq('instagram_media_id', data.instagram_media_id)
          .maybeSingle();
        if (byMedia.error) {
          throw new Error(`Supabase fetch conflicting reel failed: ${byMedia.error.message}`);
        }
        if (byMedia.data) return byMedia.data as SavedReel;

        let byShortcodeQuery = supabase
          .from('saved_reels')
          .select('*, creator:creators(*)')
          .eq('shortcode', data.shortcode);
        byShortcodeQuery = incomingSender
          ? byShortcodeQuery.eq('instagram_sender_id', incomingSender)
          : byShortcodeQuery.is('instagram_sender_id', null);

        const byShortcode = await byShortcodeQuery.maybeSingle();
        if (byShortcode.error) {
          throw new Error(`Supabase fetch existing reel failed: ${byShortcode.error.message}`);
        }
        return (byShortcode.data as SavedReel | null) ?? null;
      };

      const existing = await fetchExisting();
      if (!existing) {
        throw new Error('Supabase upsertSavedReel could not locate existing record');
      }

      if (options?.ignoreDuplicates) {
        return existing;
      }

      if (isConflictingActiveSenderReminder(existing, incomingSender)) {
        throw new SenderReminderConflictError(data.shortcode);
      }

      const updatePayload: Record<string, any> = {
        reel_url: data.reel_url,
        media_type: mediaType,
        creator_id: data.creator_id || existing.creator_id,
        caption: data.caption ?? existing.caption,
        thumbnail_url: data.thumbnail_url ?? existing.thumbnail_url,
        save_order_rank: data.save_order_rank,
        duration_seconds: data.duration_seconds,
        reminder_interval_hours: Math.round(intervalSeconds / 3600),
        reminder_interval_seconds: intervalSeconds,
        next_reminder_at: data.next_reminder_at,
        awaiting_reminder_choice_until: data.awaiting_reminder_choice_until ?? null,
        updated_at: nowIso,
      };
      if (data.watch_status) {
        updatePayload.watch_status = data.watch_status;
      }
      if (data.instagram_sender_id !== undefined) {
        updatePayload.instagram_sender_id = data.instagram_sender_id;
      }
      // Monotonic transition only (false -> true): never overwrite true -> false or wipe saved_at with null
      if (resolvedSavedOnIg && existing.is_saved_on_instagram === false) {
        updatePayload.is_saved_on_instagram = true;
      }

      const needsNullSafeSavedAtBackfill = Boolean(
        data.saved_at && shouldBackfillSavedAt(existing, data.saved_at) && existing.saved_at == null
      );
      if (data.saved_at && !needsNullSafeSavedAtBackfill && shouldBackfillSavedAt(existing, data.saved_at)) {
        updatePayload.saved_at = data.saved_at;
      }

      const senderOwnershipGuard = incomingSender
        ? `watch_status.neq.watch_later,instagram_sender_id.eq.${quotePostgrestLiteral(incomingSender)}`
        : null;

      let updateQuery = supabase
        .from('saved_reels')
        .update(updatePayload)
        .eq('id', existing.id);
      if (senderOwnershipGuard) {
        updateQuery = updateQuery.or(senderOwnershipGuard);
      } else {
        // Prevent an unattributed/admin write from racing to overwrite a sender-owned row
        updateQuery = updateQuery.is('instagram_sender_id', null);
      }

      const { data: updatedRow, error: updateErr } = await updateQuery
        .select(options?.skipReturn ? 'id' : '*, creator:creators(*)')
        .maybeSingle();

      if (updateErr) {
        throw new Error(`Supabase upsertSavedReel update failed: ${updateErr.message}`);
      }

      if (!updatedRow) {
        const { data: currentState, error: checkErr } = await supabase
          .from('saved_reels')
          .select('id, watch_status, instagram_sender_id')
          .eq('id', existing.id)
          .maybeSingle();
        if (checkErr) {
          throw new Error(`Supabase upsertSavedReel ownership check failed: ${checkErr.message}`);
        }
        if (currentState && isConflictingActiveSenderReminder(currentState as SavedReel, incomingSender)) {
          throw new SenderReminderConflictError(data.shortcode);
        }
        throw new Error('Supabase upsertSavedReel update failed: no record updated');
      }

      if (needsNullSafeSavedAtBackfill && data.saved_at) {
        const { data: backfilledRow, error: backfillErr } = await supabase
          .from('saved_reels')
          .update({ saved_at: data.saved_at, updated_at: nowIso })
          .eq('id', existing.id)
          .is('saved_at', null)
          .select('saved_at')
          .maybeSingle();
        if (backfillErr) {
          throw new Error(`Supabase saved_at backfill failed: ${backfillErr.message}`);
        }
        if (!options?.skipReturn && backfilledRow?.saved_at) {
          (updatedRow as SavedReel).saved_at = backfilledRow.saved_at;
        }
      }

      return options?.skipReturn ? null : (updatedRow as SavedReel);
    } finally {
      Repository.invalidateCreatorsCache();
    }
  }

  static async upsertCreatorsBatch(creators: Array<{
    instagram_user_id: string;
    username: string;
    display_name?: string | null;
    profile_picture_url?: string | null;
  }>, options?: { preserveExisting?: boolean; signal?: AbortSignal }): Promise<Map<string, Creator>> {
    assertImportNotAborted(options?.signal);
    Repository.invalidateCreatorsCache();
    if (!isSupabaseConfigured()) {
      return memoryStore.upsertCreatorsBatch(creators, options);
    }

    const supabase = getSupabase();
    const result = new Map<string, Creator>();
    const CHUNK_SIZE = 400;
    const READ_BATCH_SIZE = 50;
    const preserveExisting = Boolean(options?.preserveExisting);
    const signal = options?.signal;

    const fetchCreatorsSubBatched = async (
      chunkIds: string[],
      requestedUsernameById: Map<string, string>,
      bestEffort: boolean
    ): Promise<boolean> => {
      let allSucceeded = true;
      for (let j = 0; j < chunkIds.length; j += READ_BATCH_SIZE) {
        assertImportNotAborted(signal);
        const subIds = chunkIds.slice(j, j + READ_BATCH_SIZE);
        const { data: rows, error: fetchErr } = await applyAbortSignal(
          supabase
            .from('creators')
            .select('*')
            .in('instagram_user_id', subIds),
          signal
        );
        assertImportNotAborted(signal);
        if (fetchErr) {
          allSucceeded = false;
          if (!bestEffort) {
            console.warn(
              `[Repository] preserveExisting creator sub-batch fetch (${subIds.length} ids) failed:`,
              fetchErr.message
            );
            return false;
          }
          console.error(
            `[Repository] Failed to recover creator sub-batch (${subIds.length} creators):`,
            fetchErr.message
          );
          continue;
        }
        if (rows) {
          for (const c of rows) {
            result.set(requestedUsernameById.get(c.instagram_user_id) ?? c.username, c as Creator);
          }
        }
      }
      return allSucceeded;
    };

    try {
      for (let i = 0; i < creators.length; i += CHUNK_SIZE) {
        assertImportNotAborted(signal);
        const chunk = creators.slice(i, i + CHUNK_SIZE).map(c => ({
          instagram_user_id: c.instagram_user_id,
          username: c.username,
          display_name: c.display_name,
          profile_picture_url: c.profile_picture_url,
          updated_at: new Date().toISOString(),
        }));

        if (preserveExisting) {
          const chunkIds = chunk.map(c => c.instagram_user_id);
          const requestedUsernameById = new Map(chunk.map(c => [c.instagram_user_id, c.username]));
          const MAX_BULK_ATTEMPTS = 2;
          let resolvedChunk = false;

          for (let attempt = 1; attempt <= MAX_BULK_ATTEMPTS; attempt++) {
            assertImportNotAborted(signal);
            const { error: insertErr } = await applyAbortSignal(
              supabase
                .from('creators')
                .upsert(chunk, { onConflict: 'instagram_user_id', ignoreDuplicates: true }),
              signal
            );
            assertImportNotAborted(signal);

            if (insertErr) {
              console.warn(
                `[Repository] preserveExisting creator batch insert attempt ${attempt}/${MAX_BULK_ATTEMPTS} failed:`,
                insertErr.message
              );
              continue;
            }

            if (await fetchCreatorsSubBatched(chunkIds, requestedUsernameById, false)) {
              resolvedChunk = true;
              break;
            }
          }

          if (!resolvedChunk) {
            // Best-effort bounded sub-batch reads for already-existing creators without ever calling merge upsertCreator
            await fetchCreatorsSubBatched(chunkIds, requestedUsernameById, true);
          }
          continue;
        }

        const { data, error } = await applyAbortSignal(
          supabase
            .from('creators')
            .upsert(chunk, { onConflict: 'instagram_user_id' })
            .select(),
          signal
        );
        assertImportNotAborted(signal);

        if (error) {
          for (const c of chunk) {
            assertImportNotAborted(signal);
            try {
              const single = await this.upsertCreator(c, { signal });
              result.set(single.username, single);
            } catch (err: any) {
              if (err instanceof ArchiveImportTimeoutError) throw err;
              console.error(`[Repository] Failed to upsert creator ${c.username}:`, err.message);
            }
          }
        } else if (data) {
          for (const c of data) {
            result.set(c.username, c as Creator);
          }
        }
      }

      return result;
    } finally {
      Repository.invalidateCreatorsCache();
    }
  }

  /**
   * Batch-upserts saved reels/posts and optionally promotes bot-sent items to IG-saved and backfills `saved_at`.
   */
  static async upsertSavedReelsBatch(reels: Array<{
    instagram_media_id: string;
    shortcode: string;
    reel_url: string;
    media_type?: SavedMediaType;
    creator_id: string;
    caption?: string | null;
    thumbnail_url?: string | null;
    taken_at: string;
    saved_at?: string | null;
    first_detected_at: string;
    save_order_rank: number;
    watch_status?: WatchStatus;
    duration_seconds?: number | null;
    reminder_interval_hours?: number | null;
    reminder_interval_seconds?: number | null;
    next_reminder_at?: string | null;
    awaiting_reminder_choice_until?: string | null;
    is_saved_on_instagram?: boolean;
    instagram_sender_id?: string | null;
  }>, options?: {
    ignoreDuplicates?: boolean;
    backfillMissingSavedAt?: boolean;
    expectedDeletionGeneration?: number;
    signal?: AbortSignal;
    onBeforeMemoryWriteForTesting?: (signal?: AbortSignal) => Promise<void>;
  }): Promise<BatchReelsResult> {
    const signal = options?.signal;
    assertImportNotAborted(signal);
    const distinctSenders = new Set<string | null>();
    const nonNullSenders: string[] = [];
    for (const r of reels) {
      const normalized = r.instagram_sender_id ? String(r.instagram_sender_id).trim() || null : null;
      if (!distinctSenders.has(normalized)) {
        distinctSenders.add(normalized);
        if (normalized) {
          nonNullSenders.push(normalized);
        }
      }
    }

    const assertNoActiveDeletion = () => {
      for (const sender of nonNullSenders) {
        if (
          Repository.isSenderInRecentDeletion(sender) ||
          (options?.expectedDeletionGeneration !== undefined &&
            Repository.getSenderDeletionGeneration(sender) !== options.expectedDeletionGeneration)
        ) {
          console.warn(`[Repository] Rejecting batch reel upsert for sender ${sender} due to active or completed deletion`);
          throw new SenderDeletionBarrierError(sender);
        }
      }
    };

    // Register in-flight reel write BEFORE checking the deletion barrier so concurrent deletion waits for
    // any write that cleared the barrier (zero TOCTOU window between check and commit).
    let resolveInFlight!: () => void;
    const inFlightPromise = new Promise<void>((res) => { resolveInFlight = res; });
    for (const sender of nonNullSenders) {
      Repository.trackInFlightReelWrite(sender, inFlightPromise);
    }

    try {
      assertNoActiveDeletion();

      Repository.invalidateCreatorsCache();
      if (!isSupabaseConfigured()) {
        return await memoryStore.upsertSavedReelsBatch(reels, options);
      }

      const supabase = getSupabase();
      let newlyImported = 0;
      let alreadyPresent = 0;
      let savedAtBackfilled = 0;
      let promotedToSaved = 0;
      let failedCount = 0;
      const failedShortcodes: string[] = [];

      let reelsToInsert = reels;
      type ReconcileRow = {
        id: string;
        instagram_media_id: string;
        saved_at: string | null;
        is_saved_on_instagram: boolean;
      };
      const updatesById = new Map<
        string,
        {
          row: ReconcileRow;
          shortcode: string;
          promoteToSaved: boolean;
          saved_at?: string;
          save_order_rank?: number;
          matchedCount: number;
        }
      >();

      const singleOwner = distinctSenders.size === 1 ? distinctSenders.values().next().value : undefined;

      if (options?.ignoreDuplicates) {
        type BatchExistingRow = {
          id: string;
          instagram_media_id: string;
          saved_at: string | null;
          is_saved_on_instagram: boolean;
        };
        const existingByOwnerMediaId = new Map<string, BatchExistingRow>();
        const existingBySenderShortcode = new Map<string, BatchExistingRow>();
        const makeOwnerCompositeKey = (sender: string | null | undefined, value: string) =>
          `${sender ? String(sender).trim() : ''}\u0000${value}`;

        const allShortcodes = Array.from(new Set(reels.map(r => r.shortcode)));
        const LOOKUP_CHUNK = 500;
        const PAGE_SIZE = 1000;

        for (let i = 0; i < allShortcodes.length; i += LOOKUP_CHUNK) {
          assertImportNotAborted(signal);
          const slice = allShortcodes.slice(i, i + LOOKUP_CHUNK);
          let pageOffset = 0;
          while (true) {
            assertImportNotAborted(signal);
            let lookupQuery = supabase
              .from('saved_reels')
              .select('id, instagram_media_id, shortcode, instagram_sender_id, saved_at, is_saved_on_instagram')
              .in('shortcode', slice);
            if (singleOwner !== undefined) {
              lookupQuery = singleOwner === null
                ? lookupQuery.or('instagram_sender_id.is.null,instagram_sender_id.eq.')
                : lookupQuery.eq('instagram_sender_id', singleOwner);
            }
            const { data: matched, error } = await applyAbortSignal(
              lookupQuery
                .order('id', { ascending: true })
                .range(pageOffset, pageOffset + PAGE_SIZE - 1),
              signal
            );
            assertImportNotAborted(signal);

            if (error) {
              throw new Error(`Failed to query existing shortcodes: ${error.message}`);
            }
            const pageRows = matched || [];
            for (const row of pageRows) {
              const entry: BatchExistingRow = {
                id: String(row.id),
                instagram_media_id: String(row.instagram_media_id),
                saved_at: row.saved_at ? String(row.saved_at) : null,
                is_saved_on_instagram: row.is_saved_on_instagram !== false,
              };
              existingByOwnerMediaId.set(
                makeOwnerCompositeKey(row.instagram_sender_id, entry.instagram_media_id),
                entry
              );
              existingBySenderShortcode.set(
                makeOwnerCompositeKey(row.instagram_sender_id, String(row.shortcode)),
                entry
              );
            }
            if (pageRows.length < PAGE_SIZE) {
              break;
            }
            pageOffset += PAGE_SIZE;
          }
        }

        const freshReels: typeof reels = [];
        for (const r of reels) {
          const existing =
            existingByOwnerMediaId.get(makeOwnerCompositeKey(r.instagram_sender_id, r.instagram_media_id)) ||
            existingBySenderShortcode.get(makeOwnerCompositeKey(r.instagram_sender_id, r.shortcode));
          if (existing) {
            const shouldPromote = r.is_saved_on_instagram !== false && existing.is_saved_on_instagram === false;
            const shouldBackfill = Boolean(
              options.backfillMissingSavedAt && r.saved_at && shouldBackfillSavedAt(existing, r.saved_at)
            );
            if (shouldPromote || shouldBackfill) {
              const prev = updatesById.get(existing.id) || {
                row: {
                  id: existing.id,
                  instagram_media_id: existing.instagram_media_id,
                  saved_at: existing.saved_at,
                  is_saved_on_instagram: existing.is_saved_on_instagram,
                },
                shortcode: r.shortcode,
                promoteToSaved: false,
                matchedCount: 0,
              };
              prev.matchedCount++;
              if (shouldPromote) {
                prev.promoteToSaved = true;
              }
              if (shouldBackfill && r.saved_at && !prev.saved_at) {
                prev.saved_at = r.saved_at;
                prev.save_order_rank = r.save_order_rank;
              }
              updatesById.set(existing.id, prev);
            } else {
              alreadyPresent++;
            }
          } else {
            freshReels.push(r);
          }
        }
        reelsToInsert = freshReels;
      }

      /**
       * Applies archive promotion and/or CAS-guarded saved_at backfill to a matched row.
       * Dispatched write queries are awaited to server-side completion (not aborted client-side)
       * so the sender-deletion barrier cannot release while PostgreSQL may still commit a write.
       */
      const applyArchiveRowUpgradeWithCas = async (
        initialRow: ReconcileRow,
        item: {
          shortcode: string;
          is_saved_on_instagram?: boolean;
          saved_at?: string | null;
          save_order_rank?: number;
        }
      ): Promise<{ ok: boolean; promoted: boolean; backfilled: boolean }> => {
        let currentRow: ReconcileRow = initialRow;
        let promoted = false;
        let backfilled = false;
        let completed = false;

        for (let attempt = 0; attempt < 2; attempt++) {
          assertNoActiveDeletion();
          assertImportNotAborted(signal);
          const shouldPromote = item.is_saved_on_instagram !== false && currentRow.is_saved_on_instagram === false;
          const shouldBackfill = Boolean(
            options?.backfillMissingSavedAt && item.saved_at && shouldBackfillSavedAt(currentRow, item.saved_at)
          );
          if (!shouldPromote && !shouldBackfill) {
            completed = true;
            break;
          }

          const payload: Record<string, any> = {
            updated_at: new Date().toISOString(),
          };
          if (shouldPromote) {
            payload.is_saved_on_instagram = true;
          }
          if (shouldBackfill && item.saved_at) {
            payload.saved_at = item.saved_at;
            if (item.save_order_rank !== undefined) {
              payload.save_order_rank = item.save_order_rank;
            }
          }

          const isPromoteOnly = shouldPromote && !shouldBackfill;
          if (isPromoteOnly) {
            const { data: updatedRows, error: updateErr } = await supabase
              .from('saved_reels')
              .update(payload)
              .eq('id', currentRow.id)
              .eq('is_saved_on_instagram', false)
              .select('id');
            assertImportNotAborted(signal);
            if (updateErr) {
              throw new Error(`Failed to promote archive reel: ${updateErr.message}`);
            }
            if ((updatedRows?.length ?? 0) > 0) {
              promoted = true;
            }
            completed = true;
            break;
          }

          let conditionalUpdate = supabase
            .from('saved_reels')
            .update(payload)
            .eq('id', currentRow.id);
          if (shouldPromote) {
            conditionalUpdate = conditionalUpdate.eq('is_saved_on_instagram', false);
          }
          conditionalUpdate =
            currentRow.saved_at === null
              ? conditionalUpdate.is('saved_at', null)
              : conditionalUpdate.eq('saved_at', currentRow.saved_at);

          const { data: updatedRows, error: updateErr } = await conditionalUpdate.select('id');
          assertImportNotAborted(signal);
          if (updateErr) {
            throw new Error(`Failed to backfill archive reel: ${updateErr.message}`);
          }
          if ((updatedRows?.length ?? 0) > 0) {
            if (shouldPromote) promoted = true;
            if (shouldBackfill) backfilled = true;
            completed = true;
            break;
          }

          // Observed saved_at changed concurrently: re-read current row and re-evaluate backfill/promotion
          const { data: refreshed, error: refreshErr } = await applyAbortSignal(
            supabase
              .from('saved_reels')
              .select('id, instagram_media_id, saved_at, is_saved_on_instagram')
              .eq('id', currentRow.id)
              .maybeSingle(),
            signal
          );
          assertImportNotAborted(signal);
          if (refreshErr) {
            throw new Error(`Failed to re-read archive reel during CAS retry: ${refreshErr.message}`);
          }
          if (!refreshed) {
            return { ok: false, promoted: false, backfilled: false };
          }
          currentRow = {
            id: String(refreshed.id),
            instagram_media_id: String(refreshed.instagram_media_id),
            saved_at: refreshed.saved_at ? String(refreshed.saved_at) : null,
            is_saved_on_instagram: refreshed.is_saved_on_instagram !== false,
          };
        }

        if (!completed) {
          const stillNeedsPromote =
            item.is_saved_on_instagram !== false && currentRow.is_saved_on_instagram === false;
          const stillNeedsBackfill = Boolean(
            options?.backfillMissingSavedAt && item.saved_at && shouldBackfillSavedAt(currentRow, item.saved_at)
          );
          if (stillNeedsPromote || stillNeedsBackfill) {
            throw new Error('Concurrent modification prevented archive backfill');
          }
        }

        return { ok: true, promoted, backfilled };
      };

      if (updatesById.size > 0) {
        const upgradeItems = Array.from(updatesById.values());
        const BACKFILL_CONCURRENCY = 20;
        for (let i = 0; i < upgradeItems.length; i += BACKFILL_CONCURRENCY) {
          assertNoActiveDeletion();
          assertImportNotAborted(signal);
          const slice = upgradeItems.slice(i, i + BACKFILL_CONCURRENCY);
          const results = await Promise.all(
            slice.map(async (item) => {
              try {
                const outcome = await applyArchiveRowUpgradeWithCas(item.row, {
                  shortcode: item.shortcode,
                  is_saved_on_instagram: item.promoteToSaved ? true : false,
                  saved_at: item.saved_at ?? null,
                  save_order_rank: item.save_order_rank,
                });
                return { item, outcome, error: null as Error | null };
              } catch (err: any) {
                return { item, outcome: null, error: err };
              }
            })
          );
          for (const { error } of results) {
            if (error instanceof SenderDeletionBarrierError || error instanceof ArchiveImportTimeoutError) {
              throw error;
            }
          }
          assertImportNotAborted(signal);
          for (const { item, outcome, error: updateErr } of results) {
            if (updateErr || !outcome?.ok) {
              if (updateErr) {
                console.error(`[Repository] Failed to update archive metadata for ${item.shortcode}:`, updateErr.message);
              }
              failedCount++;
              failedShortcodes.push(item.shortcode);
            } else {
              alreadyPresent += item.matchedCount;
              if (outcome.promoted) promotedToSaved++;
              if (outcome.backfilled) savedAtBackfilled++;
            }
          }
        }
      }

      const isConflictError = (err: { code?: string; message?: string } | null | undefined) =>
        Boolean(
          err &&
            (err.code === '23505' ||
              err.message?.includes('duplicate key') ||
              err.message?.includes('shortcode') ||
              err.message?.includes('instagram_media_id'))
        );

      const reconcileConflictingArchiveItem = async (item: {
        instagram_media_id: string;
        shortcode: string;
        instagram_sender_id?: string | null;
        is_saved_on_instagram?: boolean;
        saved_at?: string | null;
        save_order_rank: number;
      }): Promise<boolean> => {
        assertNoActiveDeletion();
        assertImportNotAborted(signal);
        const incomingSender = item.instagram_sender_id ? String(item.instagram_sender_id).trim() || null : null;

        let existingRow: ReconcileRow | null = null;

        const { data: byMedia, error: byMediaErr } = await applyAbortSignal(
          supabase
            .from('saved_reels')
            .select('id, instagram_media_id, instagram_sender_id, saved_at, is_saved_on_instagram')
            .eq('instagram_media_id', item.instagram_media_id)
            .maybeSingle(),
          signal
        );
        assertImportNotAborted(signal);
        if (byMediaErr) {
          throw new Error(`Failed to resolve conflicting reel by media id: ${byMediaErr.message}`);
        }
        if (byMedia) {
          const rowSender = byMedia.instagram_sender_id ? String(byMedia.instagram_sender_id).trim() || null : null;
          if (rowSender !== incomingSender) {
            return false;
          }
          existingRow = {
            id: String(byMedia.id),
            instagram_media_id: String(byMedia.instagram_media_id),
            saved_at: byMedia.saved_at ? String(byMedia.saved_at) : null,
            is_saved_on_instagram: byMedia.is_saved_on_instagram !== false,
          };
        } else {
          let bySenderQuery = supabase
            .from('saved_reels')
            .select('id, instagram_media_id, saved_at, is_saved_on_instagram')
            .eq('shortcode', item.shortcode);
          bySenderQuery = incomingSender
            ? bySenderQuery.eq('instagram_sender_id', incomingSender)
            : bySenderQuery.or('instagram_sender_id.is.null,instagram_sender_id.eq.');
          const { data: bySender, error: bySenderErr } = await applyAbortSignal(
            bySenderQuery.maybeSingle(),
            signal
          );
          assertImportNotAborted(signal);
          if (bySenderErr) {
            throw new Error(`Failed to resolve conflicting reel by sender/shortcode: ${bySenderErr.message}`);
          }
          if (bySender) {
            existingRow = {
              id: String(bySender.id),
              instagram_media_id: String(bySender.instagram_media_id),
              saved_at: bySender.saved_at ? String(bySender.saved_at) : null,
              is_saved_on_instagram: bySender.is_saved_on_instagram !== false,
            };
          }
        }

        if (!existingRow) {
          return false;
        }

        const outcome = await applyArchiveRowUpgradeWithCas(existingRow, item);
        if (!outcome.ok) {
          return false;
        }
        if (outcome.promoted) promotedToSaved++;
        if (outcome.backfilled) savedAtBackfilled++;
        alreadyPresent++;
        return true;
      };

      const CHUNK_SIZE = 300;
      const SKIPPED_LOOKUP_BATCH_SIZE = 50;
      for (let i = 0; i < reelsToInsert.length; i += CHUNK_SIZE) {
        assertNoActiveDeletion();
        assertImportNotAborted(signal);
        const chunk = reelsToInsert.slice(i, i + CHUNK_SIZE).map(r => {
          const intervalSeconds = r.reminder_interval_seconds ?? (r.reminder_interval_hours ? r.reminder_interval_hours * 3600 : 36000);
          return {
            instagram_media_id: r.instagram_media_id,
            shortcode: r.shortcode,
            reel_url: r.reel_url,
            media_type: classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }),
            creator_id: r.creator_id,
            caption: r.caption,
            thumbnail_url: r.thumbnail_url,
            taken_at: r.taken_at,
            saved_at: r.saved_at,
            first_detected_at: r.first_detected_at,
            save_order_rank: r.save_order_rank,
            watch_status: r.watch_status || 'unwatched',
            duration_seconds: r.duration_seconds,
            reminder_interval_hours: Math.round(intervalSeconds / 3600),
            reminder_interval_seconds: intervalSeconds,
            next_reminder_at: r.next_reminder_at,
            awaiting_reminder_choice_until: r.awaiting_reminder_choice_until ?? null,
            is_saved_on_instagram: r.is_saved_on_instagram ?? true,
            instagram_sender_id: r.instagram_sender_id,
            updated_at: new Date().toISOString(),
          };
        });

        // Await dispatched write to server-side completion so the sender-deletion barrier cannot
        // release while PostgreSQL is still executing an upsert; abort checks stop subsequent chunks.
        const { data: insertedRows, error } = await supabase
          .from('saved_reels')
          .upsert(chunk, { onConflict: 'instagram_media_id', ignoreDuplicates: options?.ignoreDuplicates ?? false })
          .select('id, instagram_media_id');
        assertImportNotAborted(signal);

        if (error) {
          console.warn(`[Repository] Batch upsert chunk notice (${error.message}), falling back to item-by-item...`);
          for (const item of chunk) {
            assertNoActiveDeletion();
            assertImportNotAborted(signal);
            try {
              const { data: insertedSingle, error: singleErr } = await supabase
                .from('saved_reels')
                .upsert(item, { onConflict: 'instagram_media_id', ignoreDuplicates: options?.ignoreDuplicates ?? false })
                .select('id')
                .maybeSingle();
              assertImportNotAborted(signal);

              if (!singleErr && insertedSingle) {
                newlyImported++;
                continue;
              }

              if (!singleErr || isConflictError(singleErr)) {
                const reconciled = await reconcileConflictingArchiveItem(item);
                if (reconciled) {
                  continue;
                }
                console.error(`[Repository] Conflict unresolved for reel ${item.shortcode}`);
                failedCount++;
                failedShortcodes.push(item.shortcode);
                continue;
              }

              throw new Error(singleErr.message);
            } catch (itemErr: any) {
              if (itemErr instanceof SenderDeletionBarrierError || itemErr instanceof ArchiveImportTimeoutError) {
                throw itemErr;
              }
              console.error(`[Repository] Failed to upsert reel ${item.shortcode}:`, itemErr.message);
              failedCount++;
              failedShortcodes.push(item.shortcode);
            }
          }
        } else {
          const insertedMediaIds = new Set((insertedRows || []).map((row: any) => String(row.instagram_media_id)));
          newlyImported += insertedMediaIds.size;
          if (insertedMediaIds.size < chunk.length) {
            const skippedItems = chunk.filter((item) => !insertedMediaIds.has(item.instagram_media_id));
            const matchedByMediaId = new Map<
              string,
              ReconcileRow & { instagram_sender_id: string | null }
            >();

            // Batch-fetch skipped media IDs in bounded .in() sub-batches to avoid N+1 reads
            const skippedMediaIds = Array.from(new Set(skippedItems.map((it) => it.instagram_media_id)));
            for (let j = 0; j < skippedMediaIds.length; j += SKIPPED_LOOKUP_BATCH_SIZE) {
              assertImportNotAborted(signal);
              const subIds = skippedMediaIds.slice(j, j + SKIPPED_LOOKUP_BATCH_SIZE);
              const { data: existingSkipped, error: skipLookupErr } = await applyAbortSignal(
                supabase
                  .from('saved_reels')
                  .select('id, instagram_media_id, instagram_sender_id, saved_at, is_saved_on_instagram')
                  .in('instagram_media_id', subIds),
                signal
              );
              assertImportNotAborted(signal);
              if (skipLookupErr) {
                console.warn(
                  `[Repository] Skipped archive-reel batch lookup (${subIds.length} ids) failed, falling back to per-item reconciliation:`,
                  skipLookupErr.message
                );
                continue;
              }
              for (const row of existingSkipped || []) {
                matchedByMediaId.set(String(row.instagram_media_id), {
                  id: String(row.id),
                  instagram_media_id: String(row.instagram_media_id),
                  instagram_sender_id: row.instagram_sender_id ? String(row.instagram_sender_id).trim() || null : null,
                  saved_at: row.saved_at ? String(row.saved_at) : null,
                  is_saved_on_instagram: row.is_saved_on_instagram !== false,
                });
              }
            }

            for (const item of skippedItems) {
              assertImportNotAborted(signal);
              const incomingSender = item.instagram_sender_id ? String(item.instagram_sender_id).trim() || null : null;
              const matched = matchedByMediaId.get(item.instagram_media_id);
              if (matched) {
                if (matched.instagram_sender_id !== incomingSender) {
                  failedCount++;
                  failedShortcodes.push(item.shortcode);
                  continue;
                }
                const needsPromote = item.is_saved_on_instagram !== false && matched.is_saved_on_instagram === false;
                const needsBackfill = Boolean(
                  options?.backfillMissingSavedAt && item.saved_at && shouldBackfillSavedAt(matched, item.saved_at)
                );
                if (!needsPromote && !needsBackfill) {
                  alreadyPresent++;
                  continue;
                }
                try {
                  const outcome = await applyArchiveRowUpgradeWithCas(matched, item);
                  if (!outcome.ok) {
                    failedCount++;
                    failedShortcodes.push(item.shortcode);
                  } else {
                    if (outcome.promoted) promotedToSaved++;
                    if (outcome.backfilled) savedAtBackfilled++;
                    alreadyPresent++;
                  }
                } catch (reconcileErr: any) {
                  if (
                    reconcileErr instanceof SenderDeletionBarrierError ||
                    reconcileErr instanceof ArchiveImportTimeoutError
                  ) {
                    throw reconcileErr;
                  }
                  console.error(`[Repository] Failed to upgrade skipped reel ${item.shortcode}:`, reconcileErr.message);
                  failedCount++;
                  failedShortcodes.push(item.shortcode);
                }
                continue;
              }

              try {
                const reconciled = await reconcileConflictingArchiveItem(item);
                if (!reconciled) {
                  failedCount++;
                  failedShortcodes.push(item.shortcode);
                }
              } catch (reconcileErr: any) {
                if (
                  reconcileErr instanceof SenderDeletionBarrierError ||
                  reconcileErr instanceof ArchiveImportTimeoutError
                ) {
                  throw reconcileErr;
                }
                console.error(`[Repository] Failed to reconcile skipped reel ${item.shortcode}:`, reconcileErr.message);
                failedCount++;
                failedShortcodes.push(item.shortcode);
              }
            }
          }
        }
      }

      return { newlyImported, alreadyPresent, savedAtBackfilled, promotedToSaved, failedCount, failedShortcodes };
    } finally {
      for (const sender of nonNullSenders) {
        Repository.untrackInFlightReelWrite(sender, inFlightPromise);
      }
      resolveInFlight();
      Repository.invalidateCreatorsCache();
    }
  }

  static async getReelsDueForReminder(): Promise<SavedReel[]> {
    const now = new Date().toISOString();

    if (!isSupabaseConfigured()) {
      return Array.from(memoryStore.reels.values())
        .filter(r => r.watch_status === 'watch_later' && r.next_reminder_at && r.next_reminder_at <= now)
        .map(r => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }));
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('watch_status', 'watch_later')
      .lte('next_reminder_at', now);

    if (error) {
      throw new Error(`Failed to fetch reminder due reels: ${error.message}`);
    }

    return (data || []) as SavedReel[];
  }

  static async updateReminderSchedule(
    id: string,
    nextReminderAt: string,
    intervalSeconds?: number,
    options?: {
      expectedNextReminderAt?: string | null;
      expectedIntervalSeconds?: number | null;
      expectedUpdatedAt?: string | null;
      expectedWatchStatus?: WatchStatus;
    }
  ): Promise<boolean> {
    const now = new Date().toISOString();
    if (!isSupabaseConfigured()) {
      const reel = memoryStore.reels.get(id);
      if (!reel) return false;
      if (options) {
        if (
          options.expectedNextReminderAt !== undefined &&
          (reel.next_reminder_at ?? null) !== (options.expectedNextReminderAt ?? null)
        ) {
          return false;
        }
        if (
          options.expectedIntervalSeconds !== undefined &&
          (reel.reminder_interval_seconds ?? null) !== (options.expectedIntervalSeconds ?? null)
        ) {
          return false;
        }
        if (
          options.expectedUpdatedAt !== undefined &&
          (reel.updated_at ?? null) !== (options.expectedUpdatedAt ?? null)
        ) {
          return false;
        }
        if (
          options.expectedWatchStatus !== undefined &&
          reel.watch_status !== options.expectedWatchStatus
        ) {
          return false;
        }
      }
      reel.next_reminder_at = nextReminderAt;
      reel.watch_status = 'watch_later';
      reel.awaiting_reminder_choice_until = null;
      reel.updated_at = now;
      if (intervalSeconds) {
        reel.reminder_interval_seconds = intervalSeconds;
        reel.reminder_interval_hours = Math.round(intervalSeconds / 3600);
      }
      return true;
    }

    const supabase = getSupabase();
    const updatePayload: Record<string, any> = {
      next_reminder_at: nextReminderAt,
      watch_status: 'watch_later',
      awaiting_reminder_choice_until: null,
      updated_at: now,
    };
    if (intervalSeconds) {
      updatePayload.reminder_interval_seconds = intervalSeconds;
      updatePayload.reminder_interval_hours = Math.round(intervalSeconds / 3600);
    }

    let query = supabase.from('saved_reels').update(updatePayload).eq('id', id);
    if (options) {
      if (options.expectedNextReminderAt !== undefined) {
        query = options.expectedNextReminderAt === null
          ? query.is('next_reminder_at', null)
          : query.eq('next_reminder_at', options.expectedNextReminderAt);
      }
      if (options.expectedIntervalSeconds !== undefined) {
        query = options.expectedIntervalSeconds === null
          ? query.is('reminder_interval_seconds', null)
          : query.eq('reminder_interval_seconds', options.expectedIntervalSeconds);
      }
      if (options.expectedUpdatedAt !== undefined) {
        query = options.expectedUpdatedAt === null
          ? query.is('updated_at', null)
          : query.eq('updated_at', options.expectedUpdatedAt);
      }
      if (options.expectedWatchStatus !== undefined) {
        query = query.eq('watch_status', options.expectedWatchStatus);
      }
    }

    const { data, error } = await query.select('id');
    if (error) {
      throw new Error(`Supabase updateReminderSchedule failed: ${error.message}`);
    }
    return Array.isArray(data) && data.length > 0;
  }

  static async getActiveAwaitingReelForSender(senderId: string): Promise<SavedReel | null> {
    if (!isSupabaseConfigured()) {
      const match = Array.from(memoryStore.reels.values())
        .filter(r => r.instagram_sender_id === senderId && r.watch_status === 'watch_later' && r.awaiting_reminder_choice_until)
        .sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime())[0];
      return match ? { ...match, creator: memoryStore.creators.get(match.creator_id) } : null;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', senderId)
      .eq('watch_status', 'watch_later')
      .not('awaiting_reminder_choice_until', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch active awaiting reel for sender: ${error.message}`);
    }

    return (data as SavedReel) || null;
  }

  static async getLastReelForInstagramSender(
    senderId: string,
    options?: { includeUnattributedFallback?: boolean }
  ): Promise<SavedReel | null> {
    const trimmedSender = String(senderId || '').trim();
    const allowUnattributedFallback = Boolean(options?.includeUnattributedFallback);
    if (!trimmedSender && !allowUnattributedFallback) {
      return null;
    }

    if (!isSupabaseConfigured()) {
      const activeWatchLater = Array.from(memoryStore.reels.values()).filter(
        (r) => r.watch_status === 'watch_later'
      );
      let candidates = trimmedSender
        ? activeWatchLater.filter((r) => r.instagram_sender_id === trimmedSender)
        : [];

      // Unattributed fallback is strictly opt-in (admin workflow only) so webhook senders cannot access other queues
      if (allowUnattributedFallback && candidates.length === 0) {
        candidates = activeWatchLater.filter((r) => !r.instagram_sender_id);
      }

      if (candidates.length === 0) {
        return null;
      }

      const ordered = sortWatchLaterReelsMostRecentFirst(
        candidates.map((r) => ({ ...r, creator: memoryStore.creators.get(r.creator_id) || r.creator }))
      );
      return ordered[0] || null;
    }

    const supabase = getSupabase();
    if (trimmedSender) {
      const { data: senderCandidates, error } = await supabase
        .from('saved_reels')
        .select('*, creator:creators(*)')
        .eq('instagram_sender_id', trimmedSender)
        .eq('watch_status', 'watch_later')
        .order('updated_at', { ascending: false })
        .order('last_reminded_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) {
        throw new Error(`Failed to fetch last Watch Later reel for sender: ${error.message}`);
      }
      if (senderCandidates && senderCandidates.length > 0) {
        return sortWatchLaterReelsMostRecentFirst(senderCandidates as SavedReel[])[0] || null;
      }
    }

    if (!allowUnattributedFallback) {
      return null;
    }

    // Opt-in fallback strictly scoped to unattributed active Watch Later reels
    const { data: fallbackCandidates, error: fbErr } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('watch_status', 'watch_later')
      .or('instagram_sender_id.is.null,instagram_sender_id.eq.')
      .order('updated_at', { ascending: false })
      .order('last_reminded_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(25);
    if (fbErr) {
      throw new Error(`Failed to fetch fallback Watch Later reel: ${fbErr.message}`);
    }
    if (!fallbackCandidates || fallbackCandidates.length === 0) {
      return null;
    }
    return sortWatchLaterReelsMostRecentFirst(fallbackCandidates as SavedReel[])[0] || null;
  }

  static async recordReminderSent(id: string, nextReminderAt: string | null): Promise<void> {
    const now = new Date().toISOString();

    if (!isSupabaseConfigured()) {
      const reel = memoryStore.reels.get(id);
      if (reel) {
        reel.reminders_sent_count = (reel.reminders_sent_count || 0) + 1;
        reel.last_reminded_at = now;
        reel.next_reminder_at = nextReminderAt;
        reel.updated_at = now;
      }
      return;
    }

    const supabase = getSupabase();
    // fetch current count
    const { data: current } = await supabase.from('saved_reels').select('reminders_sent_count').eq('id', id).single();
    const newCount = (current?.reminders_sent_count || 0) + 1;

    await supabase
      .from('saved_reels')
      .update({
        reminders_sent_count: newCount,
        last_reminded_at: now,
        next_reminder_at: nextReminderAt,
        updated_at: now,
      })
      .eq('id', id);
  }

  /**
   * Cancels a recently added Watch Later reel for an Instagram sender (e.g. if sent by mistake).
   * For items sent directly to the bot (`is_saved_on_instagram === false`), the row is permanently deleted.
   * For items from Instagram saved posts, it reverts `watch_status` to `'unwatched'` and clears reminders.
   */
  static async cancelRecentAdditionForSender(
    senderId: string,
    options?: { targetCreator?: string }
  ): Promise<{ cancelledReel: SavedReel; action: 'deleted' | 'reverted' } | null> {
    const trimmedSender = String(senderId || '').trim();
    if (!trimmedSender) return null;

    const targetCreator = options?.targetCreator?.trim()?.toLowerCase();

    if (!isSupabaseConfigured()) {
      let candidates = Array.from(memoryStore.reels.values()).filter(
        (r) => r.instagram_sender_id === trimmedSender && r.watch_status === 'watch_later'
      );
      if (targetCreator) {
        candidates = candidates.filter((r) => {
          const creator = memoryStore.creators.get(r.creator_id);
          const u = String(creator?.username || '').toLowerCase();
          const d = String(creator?.display_name || '').toLowerCase();
          return u.includes(targetCreator) || d.includes(targetCreator);
        });
      }
      if (candidates.length === 0) return null;

      const ordered = sortWatchLaterReelsMostRecentFirst(
        candidates.map((r) => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }))
      );
      const target = ordered[0];
      const now = new Date().toISOString();

      if (target.is_saved_on_instagram === false) {
        memoryStore.reels.delete(target.id);
        return { cancelledReel: target, action: 'deleted' };
      } else {
        const stored = memoryStore.reels.get(target.id)!;
        stored.watch_status = 'unwatched';
        stored.next_reminder_at = null;
        stored.awaiting_reminder_choice_until = null;
        stored.updated_at = now;
        return {
          cancelledReel: { ...stored, creator: memoryStore.creators.get(stored.creator_id) },
          action: 'reverted',
        };
      }
    }

    const supabase = getSupabase();
    const { data: candidates, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', trimmedSender)
      .eq('watch_status', 'watch_later')
      .order('updated_at', { ascending: false })
      .order('last_reminded_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      throw new Error(`Failed to fetch reel to cancel: ${error.message}`);
    }
    if (!candidates || candidates.length === 0) return null;

    let filtered = candidates as SavedReel[];
    if (targetCreator) {
      filtered = filtered.filter((r) => {
        const u = String(r.creator?.username || '').toLowerCase();
        const d = String(r.creator?.display_name || '').toLowerCase();
        return u.includes(targetCreator) || d.includes(targetCreator);
      });
      if (filtered.length === 0) return null;
    }

    const target = sortWatchLaterReelsMostRecentFirst(filtered)[0];
    const now = new Date().toISOString();

    if (target.is_saved_on_instagram === false) {
      const { error: delErr } = await supabase
        .from('saved_reels')
        .delete()
        .eq('id', target.id)
        .eq('instagram_sender_id', trimmedSender);
      if (delErr) {
        throw new Error(`Failed to delete cancelled reel: ${delErr.message}`);
      }
      return { cancelledReel: target, action: 'deleted' };
    } else {
      const { data: updated, error: upErr } = await supabase
        .from('saved_reels')
        .update({
          watch_status: 'unwatched',
          next_reminder_at: null,
          awaiting_reminder_choice_until: null,
          updated_at: now,
        })
        .eq('id', target.id)
        .eq('instagram_sender_id', trimmedSender)
        .select('*, creator:creators(*)')
        .maybeSingle();
      if (upErr) {
        throw new Error(`Failed to revert cancelled reel: ${upErr.message}`);
      }
      return { cancelledReel: (updated as SavedReel) || target, action: 'reverted' };
    }
  }

  /**
   * Cancels active reminder alarms on Watch Later reels for an Instagram sender
   * while keeping the item safely in their Watch Later list without alerts.
   */
  static async cancelReminderForSender(
    senderId: string,
    options?: { targetCreator?: string }
  ): Promise<{ updatedReel: SavedReel } | null> {
    const trimmedSender = String(senderId || '').trim();
    if (!trimmedSender) return null;

    const targetCreator = options?.targetCreator?.trim()?.toLowerCase();

    if (!isSupabaseConfigured()) {
      let candidates = Array.from(memoryStore.reels.values()).filter(
        (r) =>
          r.instagram_sender_id === trimmedSender &&
          r.watch_status === 'watch_later' &&
          (r.next_reminder_at || r.awaiting_reminder_choice_until)
      );
      if (targetCreator) {
        candidates = candidates.filter((r) => {
          const creator = memoryStore.creators.get(r.creator_id);
          const u = String(creator?.username || '').toLowerCase();
          const d = String(creator?.display_name || '').toLowerCase();
          return u.includes(targetCreator) || d.includes(targetCreator);
        });
      }
      if (candidates.length === 0) return null;

      const ordered = sortWatchLaterReelsMostRecentFirst(
        candidates.map((r) => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }))
      );
      const target = ordered[0];
      const now = new Date().toISOString();
      const stored = memoryStore.reels.get(target.id)!;
      stored.next_reminder_at = null;
      stored.awaiting_reminder_choice_until = null;
      stored.updated_at = now;
      return { updatedReel: { ...stored, creator: memoryStore.creators.get(stored.creator_id) } };
    }

    const supabase = getSupabase();
    const { data: candidates, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', trimmedSender)
      .eq('watch_status', 'watch_later')
      .or('next_reminder_at.not.is.null,awaiting_reminder_choice_until.not.is.null')
      .order('updated_at', { ascending: false })
      .order('last_reminded_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      throw new Error(`Failed to fetch reminder to cancel: ${error.message}`);
    }
    if (!candidates || candidates.length === 0) return null;

    let filtered = candidates as SavedReel[];
    if (targetCreator) {
      filtered = filtered.filter((r) => {
        const u = String(r.creator?.username || '').toLowerCase();
        const d = String(r.creator?.display_name || '').toLowerCase();
        return u.includes(targetCreator) || d.includes(targetCreator);
      });
      if (filtered.length === 0) return null;
    }

    const target = sortWatchLaterReelsMostRecentFirst(filtered)[0];
    const now = new Date().toISOString();

    const { data: updated, error: upErr } = await supabase
      .from('saved_reels')
      .update({
        next_reminder_at: null,
        awaiting_reminder_choice_until: null,
        updated_at: now,
      })
      .eq('id', target.id)
      .eq('instagram_sender_id', trimmedSender)
      .select('*, creator:creators(*)')
      .maybeSingle();

    if (upErr) {
      throw new Error(`Failed to cancel reminder: ${upErr.message}`);
    }
    return { updatedReel: (updated as SavedReel) || target };
  }

  /**
   * Clears Watch Later reels from a specific creator for an Instagram sender.
   * If sent directly to the bot, rows are deleted; if from IG Saved, status reverts to unwatched.
   */
  static async clearWatchLaterForCreator(
    senderId: string,
    creatorHandle: string
  ): Promise<{ clearedReels: SavedReel[] }> {
    const trimmedSender = String(senderId || '').trim();
    const handle = String(creatorHandle || '').trim().replace(/^@+/, '').toLowerCase();
    if (!trimmedSender || !handle) return { clearedReels: [] };

    if (!isSupabaseConfigured()) {
      const candidates = Array.from(memoryStore.reels.values()).filter((r) => {
        if (r.instagram_sender_id !== trimmedSender || r.watch_status !== 'watch_later') return false;
        const creator = memoryStore.creators.get(r.creator_id);
        const u = String(creator?.username || '').toLowerCase();
        const d = String(creator?.display_name || '').toLowerCase();
        return u.includes(handle) || d.includes(handle);
      });
      const clearedReels: SavedReel[] = [];
      const now = new Date().toISOString();
      for (const reel of candidates) {
        if (reel.is_saved_on_instagram === false) {
          memoryStore.reels.delete(reel.id);
          clearedReels.push({ ...reel, creator: memoryStore.creators.get(reel.creator_id) });
        } else {
          reel.watch_status = 'unwatched';
          reel.next_reminder_at = null;
          reel.awaiting_reminder_choice_until = null;
          reel.updated_at = now;
          clearedReels.push({ ...reel, creator: memoryStore.creators.get(reel.creator_id) });
        }
      }
      return { clearedReels };
    }

    const supabase = getSupabase();
    const { data: creators, error: cErr } = await supabase
      .from('creators')
      .select('id, username, display_name')
      .or(`username.ilike.%${handle}%,display_name.ilike.%${handle}%`);
    if (cErr) {
      throw new Error(`Failed to resolve creator for clear: ${cErr.message}`);
    }
    const creatorIds = (creators || []).map((c: any) => c.id).filter(Boolean);
    if (creatorIds.length === 0) return { clearedReels: [] };

    const { data: reels, error: rErr } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', trimmedSender)
      .eq('watch_status', 'watch_later')
      .in('creator_id', creatorIds);
    if (rErr) {
      throw new Error(`Failed to fetch watch-later reels for creator: ${rErr.message}`);
    }
    if (!reels || reels.length === 0) return { clearedReels: [] };

    const now = new Date().toISOString();
    const toDeleteIds = reels.filter((r) => r.is_saved_on_instagram === false).map((r) => r.id);
    const toRevertIds = reels.filter((r) => r.is_saved_on_instagram !== false).map((r) => r.id);

    if (toDeleteIds.length > 0) {
      await supabase.from('saved_reels').delete().in('id', toDeleteIds).eq('instagram_sender_id', trimmedSender);
    }
    if (toRevertIds.length > 0) {
      await supabase
        .from('saved_reels')
        .update({
          watch_status: 'unwatched',
          next_reminder_at: null,
          awaiting_reminder_choice_until: null,
          updated_at: now,
        })
        .in('id', toRevertIds)
        .eq('instagram_sender_id', trimmedSender);
    }
    return { clearedReels: reels as SavedReel[] };
  }

  /**
   * Marks all Watch Later reels from a specific creator as watched for an Instagram sender.
   */
  static async markWatchedForCreator(
    senderId: string,
    creatorHandle: string
  ): Promise<{ updatedReels: SavedReel[] }> {
    const trimmedSender = String(senderId || '').trim();
    const handle = String(creatorHandle || '').trim().replace(/^@+/, '').toLowerCase();
    if (!trimmedSender || !handle) return { updatedReels: [] };

    if (!isSupabaseConfigured()) {
      const candidates = Array.from(memoryStore.reels.values()).filter((r) => {
        if (r.instagram_sender_id !== trimmedSender || r.watch_status !== 'watch_later') return false;
        const creator = memoryStore.creators.get(r.creator_id);
        const u = String(creator?.username || '').toLowerCase();
        const d = String(creator?.display_name || '').toLowerCase();
        return u.includes(handle) || d.includes(handle);
      });
      const updatedReels: SavedReel[] = [];
      const now = new Date().toISOString();
      for (const reel of candidates) {
        reel.watch_status = 'watched';
        reel.next_reminder_at = null;
        reel.awaiting_reminder_choice_until = null;
        reel.updated_at = now;
        updatedReels.push({ ...reel, creator: memoryStore.creators.get(reel.creator_id) });
      }
      return { updatedReels };
    }

    const supabase = getSupabase();
    const { data: creators, error: cErr } = await supabase
      .from('creators')
      .select('id, username, display_name')
      .or(`username.ilike.%${handle}%,display_name.ilike.%${handle}%`);
    if (cErr) {
      throw new Error(`Failed to resolve creator for watch: ${cErr.message}`);
    }
    const creatorIds = (creators || []).map((c: any) => c.id).filter(Boolean);
    if (creatorIds.length === 0) return { updatedReels: [] };

    const { data: reels, error: rErr } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', trimmedSender)
      .eq('watch_status', 'watch_later')
      .in('creator_id', creatorIds);
    if (rErr) {
      throw new Error(`Failed to fetch watch-later reels for creator: ${rErr.message}`);
    }
    if (!reels || reels.length === 0) return { updatedReels: [] };

    const now = new Date().toISOString();
    const reelIds = reels.map((r) => r.id);
    await supabase
      .from('saved_reels')
      .update({
        watch_status: 'watched',
        next_reminder_at: null,
        awaiting_reminder_choice_until: null,
        updated_at: now,
      })
      .in('id', reelIds)
      .eq('instagram_sender_id', trimmedSender);

    return { updatedReels: reels as SavedReel[] };
  }

  /**
   * Fetches paginated reels matching active filters, search across captions/shortcodes/creators,
   * and deterministic sort tie-breakers.
   */
  static async getReels(filters: ReelQueryFilters): Promise<{ reels: SavedReel[]; total: number; page: number; limit: number }> {
    if (!isSupabaseConfigured()) {
      return memoryStore.getReels(filters);
    }

    const supabase = getSupabase();
    const page = Math.max(1, filters.page || 1);
    const limit = Math.max(1, Math.min(100, filters.limit || 24));
    const offset = (page - 1) * limit;

    const { startDate, endDate } = resolveDateRange(filters.datePreset, filters.startDate, filters.endDate);
    const searchClauses: string[] = [];

    if (filters.search?.trim()) {
      const { text, handle } = sanitizePostgrestSearchTerm(filters.search);

      if (text) {
        searchClauses.push(`caption.ilike.%${text}%`);
        searchClauses.push(`shortcode.ilike.%${text}%`);
      }

      if (handle) {
        // PostgREST `.or()` filter capped at 40 deterministically ordered creators so `.in.(...)` stays within URL limits
        const { data: matchedCreators, error: creatorErr } = await supabase
          .from('creators')
          .select('id')
          .or(`username.ilike.%${handle}%,display_name.ilike.%${handle}%`)
          .order('id', { ascending: true })
          .limit(40);
        if (creatorErr) {
          throw new Error(`Supabase creator search failed: ${creatorErr.message}`);
        }
        const creatorIds = (matchedCreators || []).map((c: any) => c.id).filter(Boolean);
        if (creatorIds.length > 0) {
          searchClauses.push(`creator_id.in.(${creatorIds.join(',')})`);
        }
      }
    }

    const filterState = {
      creatorId: filters.creatorId,
      instagramSenderId: filters.instagramSenderId,
      source: filters.source,
      watchStatus: filters.watchStatus,
      mediaType: filters.mediaType,
      startDate,
      endDate,
      searchClauses,
    };

    let query = applyReelQueryFilters(
      supabase.from('saved_reels').select('*, creator:creators(*)', { count: 'exact' }),
      filterState
    );

    const sort = filters.sortBy || 'newest_saved';
    if (sort === 'newest_saved') {
      query = query
        .order('effective_saved_at', { ascending: false })
        .order('save_order_rank', { ascending: true });
    } else if (sort === 'oldest_saved') {
      query = query
        .order('effective_saved_at', { ascending: true })
        .order('save_order_rank', { ascending: false });
    } else if (sort === 'newest_published') {
      query = query
        .order('taken_at', { ascending: false })
        .order('effective_saved_at', { ascending: false });
    } else if (sort === 'oldest_published') {
      query = query
        .order('taken_at', { ascending: true })
        .order('effective_saved_at', { ascending: false });
    }

    query = query
      .order('first_detected_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) {
      if (offset > 0 && isPostgrestRangeNotSatisfiableError(error)) {
        const { count: exactCount, error: countErr } = await applyReelQueryFilters(
          supabase.from('saved_reels').select('*', { count: 'exact', head: true }),
          filterState
        );
        if (countErr) {
          throw new Error(`Supabase getReels count fallback failed: ${countErr.message}`);
        }
        return {
          reels: [],
          total: exactCount || 0,
          page,
          limit,
        };
      }
      throw new Error(`Supabase getReels failed: ${error.message}`);
    }

    return {
      reels: ((data || []) as SavedReel[]).map(r => ({
        ...r,
        media_type: classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }),
      })),
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Fetches all creators across PostgREST 1000-row pages with saved reel counts sorted descending,
   * coalescing concurrent initial scans (`/api/stats` + `/api/creators`) and caching briefly between writes.
   * When `senderId` is provided (non-admin), filters strictly to creators attributed to that sender's reels.
   */
  static async getCreators(senderId?: string): Promise<Creator[]> {
    const trimmedSender = String(senderId || '').trim();
    if (!isSupabaseConfigured()) {
      return memoryStore.getCreators(trimmedSender || undefined);
    }

    if (trimmedSender && trimmedSender !== 'admin') {
      const supabase = getSupabase();
      const counts = new Map<string, number>();
      const PAGE_SIZE = 1000;
      let from = 0;

      while (true) {
        const { data: pageRows, error: reelsErr } = await supabase
          .from('saved_reels')
          .select('creator_id')
          .eq('instagram_sender_id', trimmedSender)
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);

        if (reelsErr) {
          throw new Error(`Supabase getCreators for sender failed: ${reelsErr.message}`);
        }

        if (!pageRows || pageRows.length === 0) {
          break;
        }

        for (const row of pageRows) {
          if (row.creator_id) {
            counts.set(row.creator_id, (counts.get(row.creator_id) || 0) + 1);
          }
        }

        if (pageRows.length < PAGE_SIZE) {
          break;
        }
        from += PAGE_SIZE;
      }

      const creatorIds = Array.from(counts.keys());
      if (creatorIds.length === 0) return [];

      const BATCH_SIZE = 200;
      const creatorRows: any[] = [];
      for (let i = 0; i < creatorIds.length; i += BATCH_SIZE) {
        const batchIds = creatorIds.slice(i, i + BATCH_SIZE);
        const { data: batchData, error: creatorErr } = await supabase
          .from('creators')
          .select('*')
          .in('id', batchIds);

        if (creatorErr) {
          throw new Error(`Supabase getCreators details for sender failed: ${creatorErr.message}`);
        }

        if (batchData) {
          creatorRows.push(...batchData);
        }
      }

      const result: Creator[] = creatorRows.map((c: any) => ({
        id: c.id,
        instagram_user_id: c.instagram_user_id,
        username: c.username,
        display_name: c.display_name,
        profile_picture_url: c.profile_picture_url,
        created_at: c.created_at,
        updated_at: c.updated_at,
        saved_count: counts.get(c.id) || 0,
      }));

      result.sort((a, b) => (b.saved_count || 0) - (a.saved_count || 0) || a.username.localeCompare(b.username));
      return result;
    }

    const now = Date.now();
    if (Repository.creatorsCache && now - Repository.creatorsCacheAt < CREATORS_CACHE_TTL_MS) {
      return Repository.creatorsCache;
    }

    if (Repository.creatorsInFlight) {
      return Repository.creatorsInFlight;
    }

    const generation = Repository.creatorsCacheGeneration;
    const loader = (async () => {
      const supabase = getSupabase();
      const BATCH_SIZE = 1000;
      const { data: firstBatch, count, error } = await supabase
        .from('creators')
        .select('*, saved_reels(count)', { count: 'exact' })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(0, BATCH_SIZE - 1);

      if (error) {
        throw new Error(`Supabase getCreators failed: ${error.message}`);
      }

      const allRows: any[] = [...(firstBatch || [])];
      const totalCount = typeof count === 'number' ? count : allRows.length;
      const MAX_CREATOR_PAGES = 20;

      if (totalCount > BATCH_SIZE && firstBatch && firstBatch.length === BATCH_SIZE) {
        const totalPages = Math.min(MAX_CREATOR_PAGES, Math.ceil(totalCount / BATCH_SIZE));
        if (totalCount > MAX_CREATOR_PAGES * BATCH_SIZE) {
          console.warn(
            `[Repository] Creator directory truncated at ${MAX_CREATOR_PAGES * BATCH_SIZE} of ${totalCount} rows`
          );
        }
        const CREATOR_PAGE_CONCURRENCY = 4;
        for (let startPage = 1; startPage < totalPages; startPage += CREATOR_PAGE_CONCURRENCY) {
          const endPage = Math.min(totalPages, startPage + CREATOR_PAGE_CONCURRENCY);
          const batchRequests: Promise<any>[] = [];
          for (let p = startPage; p < endPage; p++) {
            const from = p * BATCH_SIZE;
            const to = from + BATCH_SIZE - 1;
            batchRequests.push(
              Promise.resolve(
                supabase
                  .from('creators')
                  .select('*, saved_reels(count)')
                  .order('created_at', { ascending: true })
                  .order('id', { ascending: true })
                  .range(from, to)
              )
            );
          }
          const responses = await Promise.all(batchRequests);
          for (const res of responses) {
            if (res.error) {
              throw new Error(`Supabase getCreators page failed: ${res.error.message}`);
            }
            if (Array.isArray(res.data)) {
              allRows.push(...res.data);
            }
          }
        }
      }

      const result: Creator[] = allRows.map((c: any) => ({
        id: c.id,
        instagram_user_id: c.instagram_user_id,
        username: c.username,
        display_name: c.display_name,
        profile_picture_url: c.profile_picture_url,
        created_at: c.created_at,
        updated_at: c.updated_at,
        saved_count: c.saved_reels?.[0]?.count || 0,
      }));

      result.sort((a, b) => (b.saved_count || 0) - (a.saved_count || 0) || a.username.localeCompare(b.username));

      if (generation === Repository.creatorsCacheGeneration) {
        Repository.creatorsCache = result;
        Repository.creatorsCacheAt = Date.now();
      }
      return result;
    })();

    Repository.creatorsInFlight = loader;
    try {
      return await loader;
    } finally {
      if (Repository.creatorsInFlight === loader) {
        Repository.creatorsInFlight = null;
      }
    }
  }

  /**
   * Filters and bounds the sorted creator directory for quick-filter UI requests so clients never
   * download thousands of unused creator rows.
   */
  static async queryCreators(opts: CreatorQueryOptions = {}): Promise<CreatorQueryResult> {
    const all = await Repository.getCreators(opts.instagramSenderId);
    const totalCount = all.length;

    const rawQ = String(opts.q || '').trim().toLowerCase();
    const handleQ = rawQ.replace(/^@+/, '');

    const matched = handleQ
      ? all.filter((c) => {
          const handle = String(c.username || '').toLowerCase();
          const display = String(c.display_name || '').toLowerCase();
          return handle.includes(handleQ) || display.includes(rawQ) || (rawQ !== handleQ && display.includes(handleQ));
        })
      : all;

    const matchCount = matched.length;
    const hasValidLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0;
    const boundedLimit = hasValidLimit ? Math.floor(opts.limit!) : matched.length;
    let sliced = hasValidLimit ? matched.slice(0, boundedLimit) : [...matched];

    if (!handleQ && opts.includeId && !sliced.some((c) => c.id === opts.includeId)) {
      const pinned = all.find((c) => c.id === opts.includeId);
      if (pinned) {
        sliced = hasValidLimit ? [pinned, ...sliced].slice(0, boundedLimit) : [pinned, ...sliced];
      }
    }

    return {
      creators: sliced,
      totalCount,
      matchCount,
    };
  }

  /**
   * Retrieves a creator's saved reels and posts ordered chronologically by `effective_saved_at` descending.
   * When `instagramSenderId` is provided (non-admin), filters items strictly to that sender.
   */
  static async getReelsByCreatorUsername(
    username: string,
    options?: { mediaType?: SavedMediaType | 'all'; instagramSenderId?: string }
  ): Promise<{ creator: Creator | null; reels: SavedReel[]; totalReelsCount: number; totalPostsCount: number }> {
    const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
    const mediaFilter = options?.mediaType ?? 'all';
    const trimmedSender = String(options?.instagramSenderId || '').trim();
    const isScoped = Boolean(trimmedSender && trimmedSender !== 'admin');
    if (!cleanUsername) return { creator: null, reels: [], totalReelsCount: 0, totalPostsCount: 0 };

    const { handle: sanitizedHandle, text: sanitizedText } = sanitizePostgrestSearchTerm(cleanUsername);
    const safeTerm = sanitizedHandle || sanitizedText;
    if (!safeTerm) return { creator: null, reels: [], totalReelsCount: 0, totalPostsCount: 0 };

    const sortCreatorItems = (items: SavedReel[]): SavedReel[] =>
      [...items].sort((a, b) => {
        const effectiveSavedDiff =
          parseTimestampMs(resolveEffectiveSavedAt(b)) -
          parseTimestampMs(resolveEffectiveSavedAt(a));
        if (effectiveSavedDiff !== 0) return effectiveSavedDiff;
        const rankDiff = (a.save_order_rank || 0) - (b.save_order_rank || 0);
        if (rankDiff !== 0) return rankDiff;
        const createdDiff =
          parseTimestampMs(b.created_at || b.first_detected_at) -
          parseTimestampMs(a.created_at || a.first_detected_at);
        if (createdDiff !== 0) return createdDiff;
        return String(a.id).localeCompare(String(b.id));
      });

    if (!isSupabaseConfigured()) {
      let matchedCreators = Array.from(memoryStore.creators.values()).filter(
        c => c.username.toLowerCase() === cleanUsername
      );
      if (matchedCreators.length === 0) {
        matchedCreators = Array.from(memoryStore.creators.values()).filter(
          c => c.username.toLowerCase().includes(cleanUsername) || (c.display_name && c.display_name.toLowerCase().includes(cleanUsername))
        );
      }
      if (matchedCreators.length === 0) return { creator: null, reels: [], totalReelsCount: 0, totalPostsCount: 0 };

      const creatorIds = new Set(matchedCreators.map(c => c.id));
      const primaryCreator = matchedCreators.find(c => c.display_name && c.profile_picture_url)
        || matchedCreators.find(c => c.display_name)
        || matchedCreators[0];

      const allItems = sortCreatorItems(
        Array.from(memoryStore.reels.values())
          .filter(r => creatorIds.has(r.creator_id) && (!isScoped || r.instagram_sender_id === trimmedSender))
          .map(r => ({
            ...r,
            media_type: classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }),
            creator: primaryCreator,
          }))
      );

      let totalReelsCount = 0;
      let totalPostsCount = 0;
      for (const item of allItems) {
        if (item.media_type === 'post') totalPostsCount++;
        else totalReelsCount++;
      }

      const filtered = mediaFilter === 'all'
        ? allItems
        : allItems.filter(r => r.media_type === mediaFilter);

      return { creator: primaryCreator, reels: filtered, totalReelsCount, totalPostsCount };
    }

    const supabase = getSupabase();
    // 1. Try exact match first across all creator records with this username (bounded to 20 rows)
    let { data: creators } = await supabase
      .from('creators')
      .select('*')
      .ilike('username', safeTerm)
      .limit(20);

    // 2. If no exact match, try sanitized partial match on username or display_name
    if (!creators || creators.length === 0) {
      const { data: partialCreators } = await supabase
        .from('creators')
        .select('*')
        .or(`username.ilike.%${safeTerm}%,display_name.ilike.%${safeTerm}%`)
        .limit(10);
      creators = partialCreators || [];
    }

    if (!creators || creators.length === 0) {
      return { creator: null, reels: [], totalReelsCount: 0, totalPostsCount: 0 };
    }

    // Pick best primary creator record for display information
    const primaryCreator = creators.find(c => c.display_name && c.profile_picture_url)
      || creators.find(c => c.display_name)
      || creators[0];

    const creatorIds = creators.map(c => c.id);

    const applySenderScope = (query: any) => {
      return isScoped ? query.eq('instagram_sender_id', trimmedSender) : query;
    };

    const buildTypeQuery = (type: SavedMediaType) =>
      applySenderScope(
        supabase
          .from('saved_reels')
          .select('*, creator:creators(*)')
          .in('creator_id', creatorIds)
          .eq('media_type', type)
      )
        .order('effective_saved_at', { ascending: false })
        .order('save_order_rank', { ascending: true })
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .limit(25);

    const [reelsCountRes, postsCountRes, reelsRowsRes, postsRowsRes] = await Promise.all([
      applySenderScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).in('creator_id', creatorIds).eq('media_type', 'reel')),
      applySenderScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).in('creator_id', creatorIds).eq('media_type', 'post')),
      mediaFilter === 'post' ? Promise.resolve({ data: [], error: null }) : buildTypeQuery('reel'),
      mediaFilter === 'reel' ? Promise.resolve({ data: [], error: null }) : buildTypeQuery('post'),
    ]);

    if (reelsRowsRes.error || postsRowsRes.error) {
      const errMsg = reelsRowsRes.error?.message || postsRowsRes.error?.message || 'unknown error';
      console.error(`[Repository] Error fetching items for creator ${primaryCreator.id}:`, errMsg);
      return {
        creator: primaryCreator as Creator,
        reels: [],
        totalReelsCount: reelsCountRes.count || 0,
        totalPostsCount: postsCountRes.count || 0,
      };
    }

    const combinedRows = [...(reelsRowsRes.data || []), ...(postsRowsRes.data || [])].map(r => ({
      ...r,
      media_type: classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }),
      creator: r.creator || primaryCreator,
    })) as SavedReel[];

    return {
      creator: primaryCreator as Creator,
      reels: sortCreatorItems(combinedRows),
      totalReelsCount: reelsCountRes.count || 0,
      totalPostsCount: postsCountRes.count || 0,
    };
  }

  /**
   * Computes aggregate library counts, weekly/monthly `effective_saved_at` activity, and top creators.
   * When `senderId` is provided (non-admin), scopes all counts and creator rankings strictly to that sender.
   */
  static async getStats(senderId?: string): Promise<LibraryStats> {
    const trimmedSender = String(senderId || '').trim();
    if (!isSupabaseConfigured()) {
      return memoryStore.getStats(trimmedSender || undefined);
    }

    const isScoped = Boolean(trimmedSender && trimmedSender !== 'admin');
    const supabase = getSupabase();
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const applyScope = (query: any) => {
      return isScoped ? query.eq('instagram_sender_id', trimmedSender) : query;
    };

    const [
      totalReelsRes,
      savedOnIgRes,
      botSentRes,
      reelsCountRes,
      postsCountRes,
      creatorsRes,
      weekRes,
      monthRes,
      unwatchedRes,
      watchedRes,
      watchLaterRes,
    ] = await Promise.all([
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true })),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('is_saved_on_instagram', true)),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('is_saved_on_instagram', false)),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('media_type', 'reel')),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('media_type', 'post')),
      Repository.getCreators(trimmedSender || undefined),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).gte('effective_saved_at', sevenDaysAgo)),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).gte('effective_saved_at', thirtyDaysAgo)),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('watch_status', 'unwatched')),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('watch_status', 'watched')),
      applyScope(supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('watch_status', 'watch_later')),
    ]);

    const topCreators = creatorsRes.slice(0, 5).map(c => ({
      id: c.id,
      username: c.username,
      display_name: c.display_name,
      profile_picture_url: c.profile_picture_url,
      count: c.saved_count || 0
    }));

    return {
      totalReels: totalReelsRes.count || 0,
      savedOnInstagramCount: savedOnIgRes.count || 0,
      botSentCount: botSentRes.count || 0,
      reelsCount: reelsCountRes.count || 0,
      postsCount: postsCountRes.count || 0,
      totalCreators: creatorsRes.length,
      savedThisWeek: weekRes.count || 0,
      savedThisMonth: monthRes.count || 0,
      unwatchedCount: unwatchedRes.count || 0,
      watchedCount: watchedRes.count || 0,
      watchLaterCount: watchLaterRes.count || 0,
      topCreators,
    };
  }

  /**
   * Clears in-memory store state for isolated unit tests (no-op when Supabase is configured).
   */
  static resetMemoryStoreForTests(): void {
    if (!isSupabaseConfigured()) {
      memoryStore.creators.clear();
      memoryStore.reels.clear();
    }
  }

  static async updateWatchStatus(id: string, status: WatchStatus, senderId?: string): Promise<SavedReel | null> {
    const trimmedSender = String(senderId || '').trim();
    if (!isSupabaseConfigured()) {
      return memoryStore.updateWatchStatus(id, status, trimmedSender || undefined);
    }

    const supabase = getSupabase();
    const updatePayload: Record<string, any> = {
      watch_status: status,
      updated_at: new Date().toISOString(),
    };
    if (status !== 'watch_later') {
      updatePayload.next_reminder_at = null;
      updatePayload.awaiting_reminder_choice_until = null;
    }

    let query = supabase.from('saved_reels').update(updatePayload).eq('id', id);
    if (trimmedSender && trimmedSender !== 'admin') {
      query = query.eq('instagram_sender_id', trimmedSender);
    }

    const { data, error } = await query
      .select('*, creator:creators(*)')
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to update watch status: ${error.message}`);
    }

    return (data as SavedReel) || null;
  }

  /**
   * Resolves the ordered Watch Later Reel IDs that a watched/stop command targets for an Instagram sender.
   * Callers performing retries can pin these IDs before the first write so newer Reels saved later are never targeted.
   */
  static async selectWatchLaterTargetIdsForSender(
    senderId: string,
    options?: { markAll?: boolean; includeUnattributedFallback?: boolean }
  ): Promise<string[]> {
    const trimmedSender = String(senderId || '').trim();
    const markAll = Boolean(options?.markAll);
    const allowUnattributedFallback = Boolean(options?.includeUnattributedFallback);

    if (!trimmedSender && !allowUnattributedFallback) {
      return [];
    }

    if (!isSupabaseConfigured()) {
      const activeWatchLater = Array.from(memoryStore.reels.values()).filter(
        (r) => r.watch_status === 'watch_later'
      );
      let candidates = trimmedSender
        ? activeWatchLater.filter((r) => r.instagram_sender_id === trimmedSender)
        : [];
      if (allowUnattributedFallback && candidates.length === 0) {
        candidates = activeWatchLater.filter((r) => !String(r.instagram_sender_id || '').trim());
      }
      if (candidates.length === 0) {
        return [];
      }
      const ordered = sortWatchLaterReelsMostRecentFirst(
        candidates.map((r) => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }))
      );
      return (markAll ? ordered : [ordered[0]]).map((r) => r.id);
    }

    const supabase = getSupabase();
    const fetchActiveCandidates = async (senderFilter: 'exact' | 'unattributed'): Promise<SavedReel[]> => {
      let query = supabase
        .from('saved_reels')
        .select('id, updated_at, last_reminded_at, created_at, watch_status, instagram_sender_id')
        .eq('watch_status', 'watch_later')
        .order('updated_at', { ascending: false })
        .order('last_reminded_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (senderFilter === 'exact') {
        query = query.eq('instagram_sender_id', trimmedSender);
      } else {
        query = query.or('instagram_sender_id.is.null,instagram_sender_id.eq.');
      }

      const { data, error } = await query;
      if (error) {
        throw new Error(`Failed to fetch active watch-later reels: ${error.message}`);
      }
      return (data || []) as SavedReel[];
    };

    let candidates = trimmedSender ? await fetchActiveCandidates('exact') : [];
    if (allowUnattributedFallback && candidates.length === 0) {
      candidates = await fetchActiveCandidates('unattributed');
    }
    if (candidates.length === 0) {
      return [];
    }

    const ordered = sortWatchLaterReelsMostRecentFirst(candidates);
    return (markAll ? ordered : [ordered[0]]).map((r) => r.id);
  }

  /**
   * Marks either the most recently reminded/updated active Watch Later reel (default),
   * all active Watch Later reels (`markAll: true`), or an explicit pinned set (`targetReelIds`)
   * as watched for an Instagram sender.
   */
  static async markWatchedForInstagramSender(
    senderId: string,
    options?: { markAll?: boolean; includeUnattributedFallback?: boolean; targetReelIds?: string[] }
  ): Promise<MarkWatchedResult> {
    const trimmedSender = String(senderId || '').trim();
    const markAll = Boolean(options?.markAll);
    const allowUnattributedFallback = Boolean(options?.includeUnattributedFallback);
    const pinnedIdSet = options?.targetReelIds !== undefined ? new Set(options.targetReelIds) : null;
    const now = new Date().toISOString();

    if (!trimmedSender && !allowUnattributedFallback) {
      return { updatedReels: [], remainingCount: 0 };
    }

    if (!isSupabaseConfigured()) {
      const activeWatchLater = Array.from(memoryStore.reels.values()).filter(
        (r) => r.watch_status === 'watch_later'
      );
      let matchedScope: 'exact' | 'unattributed' = 'exact';
      let candidates = trimmedSender
        ? activeWatchLater.filter((r) => r.instagram_sender_id === trimmedSender)
        : [];

      // Unattributed fallback is strictly opt-in (admin workflow only) so webhook senders cannot mark or view admin/UI reels
      if (allowUnattributedFallback && candidates.length === 0) {
        matchedScope = 'unattributed';
        candidates = activeWatchLater.filter((r) => !String(r.instagram_sender_id || '').trim());
      }

      if (candidates.length === 0) {
        return { updatedReels: [], remainingCount: 0 };
      }

      const ordered = sortWatchLaterReelsMostRecentFirst(
        candidates.map((r) => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }))
      );
      const targets = pinnedIdSet
        ? ordered.filter((r) => pinnedIdSet.has(r.id))
        : markAll
          ? ordered
          : [ordered[0]];
      const updatedReels: SavedReel[] = [];

      for (const target of targets) {
        const stored = memoryStore.reels.get(target.id);
        const currentOwner = String(stored?.instagram_sender_id || '').trim();
        const scopeMatches =
          matchedScope === 'exact' ? currentOwner === trimmedSender : currentOwner === '';
        if (stored && stored.watch_status === 'watch_later' && scopeMatches) {
          stored.watch_status = 'watched';
          stored.next_reminder_at = null;
          stored.awaiting_reminder_choice_until = null;
          stored.updated_at = now;
          updatedReels.push({ ...stored, creator: memoryStore.creators.get(stored.creator_id) });
        }
      }

      const updatedIdSet = new Set(updatedReels.map((r) => r.id));
      const remainingReels = ordered.filter((r) => !updatedIdSet.has(r.id));
      const remainingCount = Math.max(0, ordered.length - updatedReels.length);
      return { updatedReels, remainingCount, remainingReels };
    }

    const supabase = getSupabase();

    const fetchActiveCandidates = async (senderFilter: 'exact' | 'unattributed'): Promise<SavedReel[]> => {
      let query = supabase
        .from('saved_reels')
        .select('*, creator:creators(*)')
        .eq('watch_status', 'watch_later')
        .order('updated_at', { ascending: false })
        .order('last_reminded_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (senderFilter === 'exact') {
        query = query.eq('instagram_sender_id', trimmedSender);
      } else {
        query = query.or('instagram_sender_id.is.null,instagram_sender_id.eq.');
      }

      const { data, error } = await query;
      if (error) {
        throw new Error(`Failed to fetch active watch-later reels: ${error.message}`);
      }
      return (data || []) as SavedReel[];
    };

    let matchedScope: 'exact' | 'unattributed' = 'exact';
    let candidates = trimmedSender
      ? await fetchActiveCandidates('exact')
      : [];

    if (allowUnattributedFallback && candidates.length === 0) {
      matchedScope = 'unattributed';
      candidates = await fetchActiveCandidates('unattributed');
    }

    if (candidates.length === 0) {
      return { updatedReels: [], remainingCount: 0 };
    }

    const ordered = sortWatchLaterReelsMostRecentFirst(candidates);
    const targets = pinnedIdSet
      ? ordered.filter((r) => pinnedIdSet.has(r.id))
      : markAll
        ? ordered
        : [ordered[0]];
    if (targets.length === 0) {
      return { updatedReels: [], remainingCount: ordered.length };
    }
    const targetIds = targets.map((r) => r.id);
    const orderIndex = new Map(targetIds.map((id, idx) => [id, idx]));

    const UPDATE_CHUNK_SIZE = 100;
    const allUpdatedRows: SavedReel[] = [];
    for (let i = 0; i < targetIds.length; i += UPDATE_CHUNK_SIZE) {
      const idChunk = targetIds.slice(i, i + UPDATE_CHUNK_SIZE);
      let updateQuery = supabase
        .from('saved_reels')
        .update({
          watch_status: 'watched',
          next_reminder_at: null,
          awaiting_reminder_choice_until: null,
          updated_at: now,
        })
        .in('id', idChunk)
        .eq('watch_status', 'watch_later');

      if (matchedScope === 'exact') {
        updateQuery = updateQuery.eq('instagram_sender_id', trimmedSender);
      } else {
        updateQuery = updateQuery.or('instagram_sender_id.is.null,instagram_sender_id.eq.');
      }

      const { data: updatedRows, error: updateErr } = await updateQuery.select('*, creator:creators(*)');

      if (updateErr) {
        throw new Error(`Failed to mark watch-later reels as watched: ${updateErr.message}`);
      }
      if (Array.isArray(updatedRows)) {
        allUpdatedRows.push(...(updatedRows as SavedReel[]));
      }
    }

    const updatedReels = allUpdatedRows.sort(
      (a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)
    );
    const postUpdateRemaining = await fetchActiveCandidates(matchedScope);
    const remainingReels = sortWatchLaterReelsMostRecentFirst(postUpdateRemaining);
    const remainingCount = remainingReels.length;

    return { updatedReels, remainingCount, remainingReels };
  }

  static async getReelsAwaitingChoiceDue(): Promise<SavedReel[]> {
    const now = new Date().toISOString();
    if (!isSupabaseConfigured()) {
      return Array.from(memoryStore.reels.values())
        .filter(r => r.watch_status === 'watch_later' && r.awaiting_reminder_choice_until && r.awaiting_reminder_choice_until <= now)
        .map(r => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }));
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('watch_status', 'watch_later')
      .not('awaiting_reminder_choice_until', 'is', null)
      .lte('awaiting_reminder_choice_until', now);

    if (error || !data) return [];
    return data as SavedReel[];
  }

  static async activateDefaultReminder(
    id: string,
    expectedDeadline: string,
    defaultHours: number = 10
  ): Promise<{ reel: SavedReel | null; targetTime: Date }> {
    const now = new Date();
    const targetTime = new Date(now.getTime() + defaultHours * 3600 * 1000);
    const targetIso = targetTime.toISOString();

    if (!isSupabaseConfigured()) {
      const reel = memoryStore.reels.get(id);
      if (reel) {
        if (reel.awaiting_reminder_choice_until !== expectedDeadline) {
          return { reel: null, targetTime };
        }
        reel.awaiting_reminder_choice_until = null;
        reel.reminder_interval_hours = defaultHours;
        reel.reminder_interval_seconds = defaultHours * 3600;
        reel.next_reminder_at = targetIso;
        reel.updated_at = now.toISOString();
        return { reel: { ...reel, creator: memoryStore.creators.get(reel.creator_id) }, targetTime };
      }
      return { reel: null, targetTime };
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .update({
        awaiting_reminder_choice_until: null,
        reminder_interval_hours: defaultHours,
        reminder_interval_seconds: defaultHours * 3600,
        next_reminder_at: targetIso,
        updated_at: now.toISOString(),
      })
      .eq('id', id)
      .eq('awaiting_reminder_choice_until', expectedDeadline)
      .select('*, creator:creators(*)')
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to activate default reminder: ${error.message}`);
    }
    if (!data) {
      return { reel: null, targetTime };
    }

    return { reel: data as SavedReel, targetTime };
  }

  /**
   * Lists saved items still classified as `'reel'` with legacy `/reel/` URLs so a one-off recovery
   * job can re-check whether any DM-shared items were actually `/p/` posts.
   */
  static async getLegacyReelUrlCandidates(options?: {
    limit?: number;
    offset?: number;
  }): Promise<LegacyReelUrlCandidate[]> {
    const limit = Math.min(Math.max(1, Math.floor(options?.limit ?? 200)), 500);
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));

    if (!isSupabaseConfigured()) {
      const matches = Array.from(memoryStore.reels.values())
        .filter(
          (r) =>
            classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }) === 'reel' &&
            /instagram\.com\/(?:[a-zA-Z0-9._]+\/)?reel\//i.test(r.reel_url)
        )
        .sort((a, b) => {
          const cmp = b.first_detected_at.localeCompare(a.first_detected_at);
          return cmp !== 0 ? cmp : String(a.id).localeCompare(String(b.id));
        });

      return matches.slice(offset, offset + limit).map((r) => ({
        id: r.id,
        shortcode: r.shortcode,
        reel_url: r.reel_url,
        media_type: 'reel',
      }));
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .select('id, shortcode, reel_url, media_type')
      .eq('media_type', 'reel')
      .ilike('reel_url', '%/reel/%')
      .order('first_detected_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to query legacy reel URL candidates: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      id: String(row.id),
      shortcode: String(row.shortcode),
      reel_url: String(row.reel_url),
      media_type: 'reel',
    }));
  }

  /**
   * Updates both `media_type` and canonical `reel_url` for a recovered saved item so backfill
   * migrations remain idempotent on future reruns.
   */
  static async repairRecoveredMediaClassification(
    id: string,
    mediaType: SavedMediaType,
    canonicalUrl: string
  ): Promise<boolean> {
    const now = new Date().toISOString();

    if (!isSupabaseConfigured()) {
      const existing = memoryStore.reels.get(id);
      if (!existing) return false;
      existing.media_type = mediaType;
      existing.reel_url = canonicalUrl;
      existing.updated_at = now;
      return true;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .update({
        media_type: mediaType,
        reel_url: canonicalUrl,
        updated_at: now,
      })
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to update recovered media classification for ${id}: ${error.message}`);
    }

    return Boolean(data?.id);
  }

  /**
   * Looks up a saved item (with creator attribution) by Instagram shortcode across both
   * Supabase and in-memory fallback storage.
   *
   * - When `senderId` is a non-empty string, matches only that sender's row.
   * - When `senderId` is `null`, matches only an unattributed (admin/archive) row.
   * - When `senderId` is `undefined`, returns a deterministic match (preferring unattributed rows).
   */
  static async getSavedItemByShortcode(shortcode: string, senderId?: string | null): Promise<SavedReel | null> {
    const cleanCode = String(shortcode || '').trim();
    if (!cleanCode) return null;

    const hasExplicitScope = senderId !== undefined;
    const normalizedSender =
      senderId === null || senderId === undefined ? null : String(senderId).trim() || null;

    if (!isSupabaseConfigured()) {
      let fallbackMatch: SavedReel | null = null;
      for (const reel of memoryStore.reels.values()) {
        if (reel.shortcode !== cleanCode) continue;
        const rowSender = reel.instagram_sender_id ? String(reel.instagram_sender_id).trim() || null : null;
        if (hasExplicitScope) {
          if (rowSender === normalizedSender) {
            return {
              ...reel,
              media_type: classifySavedMediaType({ mediaType: reel.media_type, reelUrl: reel.reel_url }),
              creator: memoryStore.creators.get(reel.creator_id),
            };
          }
          continue;
        }
        if (rowSender === null) {
          return {
            ...reel,
            media_type: classifySavedMediaType({ mediaType: reel.media_type, reelUrl: reel.reel_url }),
            creator: memoryStore.creators.get(reel.creator_id),
          };
        }
        if (!fallbackMatch) {
          fallbackMatch = reel;
        }
      }
      if (!fallbackMatch) return null;
      return {
        ...fallbackMatch,
        media_type: classifySavedMediaType({ mediaType: fallbackMatch.media_type, reelUrl: fallbackMatch.reel_url }),
        creator: memoryStore.creators.get(fallbackMatch.creator_id),
      };
    }

    const supabase = getSupabase();
    let query = supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('shortcode', cleanCode);

    if (hasExplicitScope) {
      query = normalizedSender
        ? query.eq('instagram_sender_id', normalizedSender)
        : query.is('instagram_sender_id', null);
    } else {
      query = query.order('instagram_sender_id', { ascending: true, nullsFirst: true }).limit(1);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      throw new Error(`Failed to look up saved item ${cleanCode}: ${error.message}`);
    }
    if (!data) {
      return null;
    }

    const row = data as SavedReel;
    return {
      ...row,
      media_type: classifySavedMediaType({ mediaType: row.media_type, reelUrl: row.reel_url }),
    };
  }

  private static senderDeletionTimestamps = new Map<string, number>();
  private static activeSenderDeletions = new Map<string, number>();
  private static senderDeletionGenerations = new Map<string, number>();
  private static senderTimezones = new Map<string, string>();
  private static senderTimezoneGenerations = new Map<string, number>();
  private static inFlightPreferenceWrites = new Map<string, Set<Promise<any>>>();
  private static inFlightReelWrites = new Map<string, Set<Promise<any>>>();

  /**
   * Clears in-memory caches for testing.
   */
  static resetSenderTimezonesForTesting(): void {
    Repository.senderTimezones.clear();
    Repository.senderTimezoneGenerations.clear();
    Repository.inFlightPreferenceWrites.clear();
    Repository.inFlightReelWrites.clear();
    Repository.activeSenderDeletions.clear();
  }

  private static trackInFlightPreferenceWrite(senderId: string, promise: Promise<any>): void {
    let set = Repository.inFlightPreferenceWrites.get(senderId);
    if (!set) {
      set = new Set();
      Repository.inFlightPreferenceWrites.set(senderId, set);
    }
    set.add(promise);
  }

  private static untrackInFlightPreferenceWrite(senderId: string, promise: Promise<any>): void {
    const set = Repository.inFlightPreferenceWrites.get(senderId);
    if (set) {
      set.delete(promise);
      if (set.size === 0) {
        Repository.inFlightPreferenceWrites.delete(senderId);
      }
    }
  }

  static async waitForInFlightPreferenceWrites(senderId: string): Promise<void> {
    const set = Repository.inFlightPreferenceWrites.get(senderId);
    if (set && set.size > 0) {
      await Promise.allSettled(Array.from(set));
    }
  }

  private static trackInFlightReelWrite(senderId: string, promise: Promise<any>): void {
    let set = Repository.inFlightReelWrites.get(senderId);
    if (!set) {
      set = new Set();
      Repository.inFlightReelWrites.set(senderId, set);
    }
    set.add(promise);
  }

  private static untrackInFlightReelWrite(senderId: string, promise: Promise<any>): void {
    const set = Repository.inFlightReelWrites.get(senderId);
    if (set) {
      set.delete(promise);
      if (set.size === 0) {
        Repository.inFlightReelWrites.delete(senderId);
      }
    }
  }

  static async waitForInFlightReelWrites(senderId: string): Promise<void> {
    const set = Repository.inFlightReelWrites.get(senderId);
    if (set && set.size > 0) {
      await Promise.allSettled(Array.from(set));
    }
  }

  /**
   * Retrieves the configured timezone for an Instagram sender ID, falling back to
   * APP_TIMEZONE or 'UTC'.
   */
  static async getSenderTimezone(senderId: string): Promise<string> {
    const trimmed = String(senderId || '').trim();
    if (!trimmed) {
      return process.env.APP_TIMEZONE || process.env.TZ || 'UTC';
    }

    if (Repository.senderTimezones.has(trimmed)) {
      return Repository.senderTimezones.get(trimmed)!;
    }

    const lookupGen = Repository.senderTimezoneGenerations.get(trimmed) || 0;

    if (isSupabaseConfigured()) {
      try {
        const supabase = getSupabase();
        const { data, error } = await supabase
          .from('sender_preferences')
          .select('timezone')
          .eq('sender_id', trimmed)
          .maybeSingle();

        const currentGen = Repository.senderTimezoneGenerations.get(trimmed) || 0;
        if (currentGen !== lookupGen) {
          return Repository.senderTimezones.get(trimmed) || process.env.APP_TIMEZONE || process.env.TZ || 'UTC';
        }

        if (!error && data?.timezone) {
          Repository.senderTimezones.set(trimmed, data.timezone);
          return data.timezone;
        }
      } catch {
        // Table may not exist yet in older Supabase instances; fall back gracefully
      }
    }

    const currentGen = Repository.senderTimezoneGenerations.get(trimmed) || 0;
    if (currentGen !== lookupGen) {
      return Repository.senderTimezones.get(trimmed) || process.env.APP_TIMEZONE || process.env.TZ || 'UTC';
    }

    return process.env.APP_TIMEZONE || process.env.TZ || 'UTC';
  }

  /**
   * Persists the preferred timezone for an Instagram sender ID.
   * Resolves common abbreviations (e.g. IST, EST, PST, London) to canonical IANA names.
   */
  static async setSenderTimezone(senderId: string, timezoneInput: string): Promise<string | null> {
    const trimmed = String(senderId || '').trim();
    if (!trimmed) return null;

    if (Repository.isSenderInRecentDeletion(trimmed)) {
      console.warn(`[Repository] Rejecting timezone upsert for sender ${trimmed} due to active deletion barrier window`);
      throw new SenderDeletionBarrierError(trimmed);
    }

    const resolved = resolveTimeZone(timezoneInput);
    if (!resolved) return null;

    let resolveInFlight!: () => void;
    const inFlightPromise = new Promise<void>((res) => { resolveInFlight = res; });
    Repository.trackInFlightPreferenceWrite(trimmed, inFlightPromise);

    try {
      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        const { error } = await supabase
          .from('sender_preferences')
          .upsert(
            {
              sender_id: trimmed,
              timezone: resolved,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'sender_id' }
          );
        if (error) {
          throw new Error(`Failed to persist sender timezone preference for ${trimmed}: ${error.message}`);
        }
      }

      if (Repository.isSenderInRecentDeletion(trimmed)) {
        console.warn(`[Repository] Rejecting timezone cache commit for sender ${trimmed} due to active deletion barrier window`);
        throw new SenderDeletionBarrierError(trimmed);
      }

      const nextGen = (Repository.senderTimezoneGenerations.get(trimmed) || 0) + 1;
      Repository.senderTimezoneGenerations.set(trimmed, nextGen);
      Repository.senderTimezones.set(trimmed, resolved);

      return resolved;
    } finally {
      Repository.untrackInFlightPreferenceWrite(trimmed, inFlightPromise);
      resolveInFlight();
    }
  }

  static recordSenderDeletion(senderId: string): void {
    const trimmed = String(senderId || '').trim();
    if (trimmed) {
      Repository.senderDeletionTimestamps.set(trimmed, Date.now());
    }
  }

  static isSenderInRecentDeletion(senderId: string, windowMs = 60_000): boolean {
    const trimmed = String(senderId || '').trim();
    if (!trimmed) return false;
    if ((Repository.activeSenderDeletions.get(trimmed) || 0) > 0) {
      return true;
    }
    const ts = Repository.senderDeletionTimestamps.get(trimmed);
    if (!ts) return false;
    if (Date.now() - ts > windowMs) {
      Repository.senderDeletionTimestamps.delete(trimmed);
      return false;
    }
    return true;
  }

  static getSenderDeletionGeneration(senderId: string): number {
    const trimmed = String(senderId || '').trim();
    if (!trimmed) return 0;
    return Repository.senderDeletionGenerations.get(trimmed) || 0;
  }

  static resetDeletionTimestampsForTesting(): void {
    Repository.activeSenderDeletions.clear();
    Repository.senderDeletionTimestamps.clear();
    Repository.senderDeletionGenerations.clear();
  }

  /**
   * Permanently deletes all saved reels and data associated with an Instagram sender ID
   * for compliance with Meta User Data Deletion requests.
   */
  static async deleteUserDataForSender(senderId: string): Promise<number> {
    const trimmed = String(senderId || '').trim();
    if (!trimmed) return 0;

    const currentActive = (Repository.activeSenderDeletions.get(trimmed) || 0) + 1;
    Repository.activeSenderDeletions.set(trimmed, currentActive);
    Repository.recordSenderDeletion(trimmed);

    try {
      await Promise.all([
        Repository.waitForInFlightPreferenceWrites(trimmed),
        Repository.waitForInFlightReelWrites(trimmed),
      ]);

      const nextGen = (Repository.senderTimezoneGenerations.get(trimmed) || 0) + 1;
      Repository.senderTimezoneGenerations.set(trimmed, nextGen);
      Repository.senderTimezones.delete(trimmed);

      if (!isSupabaseConfigured()) {
        let count = 0;
        for (const [id, reel] of memoryStore.reels.entries()) {
          if (reel.instagram_sender_id === trimmed) {
            memoryStore.reels.delete(id);
            count++;
          }
        }
        return count;
      }

      const supabase = getSupabase();
      try {
        const { error: prefError } = await supabase
          .from('sender_preferences')
          .delete()
          .eq('sender_id', trimmed);

        if (prefError) {
          throw new Error(`Failed to delete sender preferences for sender ${trimmed}: ${prefError.message}`);
        }
      } finally {
        const postDeleteGen = (Repository.senderTimezoneGenerations.get(trimmed) || 0) + 1;
        Repository.senderTimezoneGenerations.set(trimmed, postDeleteGen);
        Repository.senderTimezones.delete(trimmed);
      }

      const { data, error } = await supabase
        .from('saved_reels')
        .delete()
        .eq('instagram_sender_id', trimmed)
        .select('id');

      if (error) {
        throw new Error(`Failed to delete user data for sender ${trimmed}: ${error.message}`);
      }
      return data?.length || 0;
    } finally {
      Repository.recordSenderDeletion(trimmed);
      Repository.senderDeletionGenerations.set(
        trimmed,
        (Repository.senderDeletionGenerations.get(trimmed) || 0) + 1
      );
      const remainingActive = (Repository.activeSenderDeletions.get(trimmed) || 1) - 1;
      if (remainingActive <= 0) {
        Repository.activeSenderDeletions.delete(trimmed);
      } else {
        Repository.activeSenderDeletions.set(trimmed, remainingActive);
      }
      const finalGen = (Repository.senderTimezoneGenerations.get(trimmed) || 0) + 1;
      Repository.senderTimezoneGenerations.set(trimmed, finalGen);
      Repository.senderTimezones.delete(trimmed);
    }
  }
}
