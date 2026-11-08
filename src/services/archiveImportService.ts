import { Repository } from '../db/repository.ts';
import type { Creator } from '../types.ts';

export interface RawSavedExportItem {
  title?: string;
  string_map_data?: Record<string, { href?: string; timestamp?: number; value?: string }>;
  href?: string;
  timestamp?: number;
  caption?: string;
}

export type ArchiveImportStatus = 'success' | 'empty' | 'failed' | 'partial';

export interface ArchiveImportResult {
  totalProcessed: number;
  reelsImported: number;
  creatorsAdded: number;
  skipped: number;
  errors: string[];
  status: ArchiveImportStatus;
}

const UNKNOWN_CREATOR_HANDLE = 'unattributed';
const INSTAGRAM_HANDLE_REGEX = /^[a-zA-Z0-9._]{1,30}$/;

export class ArchiveImportService {
  /**
   * Imports saved reels from an official Instagram data export (saved_posts.json).
   *
   * @param input Raw parsed JSON object, array, or JSON string from Instagram data download
   * @param senderId Optional Instagram sender ID to associate imported reels with
   */
  static async importArchive(input: unknown, senderId?: string): Promise<ArchiveImportResult> {
    let data = input;
    if (typeof input === 'string') {
      try {
        data = JSON.parse(input);
      } catch (err: any) {
        console.error('[ArchiveImport] JSON parse error:', err.message);
        return {
          totalProcessed: 0,
          reelsImported: 0,
          creatorsAdded: 0,
          skipped: 0,
          errors: ['Failed to parse JSON file: malformed JSON format.'],
          status: 'empty',
        };
      }
    }

    // Locate the array of saved items across different Instagram export variations
    let rawItems: unknown[] = [];
    if (Array.isArray(data)) {
      rawItems = data;
    } else if (data && typeof data === 'object') {
      const obj = data as Record<string, any>;
      if (Array.isArray(obj.saved_saved_media)) {
        rawItems = obj.saved_saved_media;
      } else if (Array.isArray(obj.saved_media)) {
        rawItems = obj.saved_media;
      } else if (Array.isArray(obj.items)) {
        rawItems = obj.items;
      } else {
        // Look for any array inside the object
        for (const val of Object.values(obj)) {
          if (Array.isArray(val)) {
            rawItems = val;
            break;
          }
        }
      }
    }

    if (rawItems.length === 0) {
      return {
        totalProcessed: 0,
        reelsImported: 0,
        creatorsAdded: 0,
        skipped: 0,
        errors: ['No saved media items found in the provided export file.'],
        status: 'empty',
      };
    }

    let totalProcessed = 0;
    let reelsImported = 0;
    const creatorsSeen = new Set<string>();
    const creatorCache = new Map<string, Creator>();
    const errors: string[] = [];

    for (const rawItem of rawItems) {
      // Runtime validation of raw item
      if (!rawItem || typeof rawItem !== 'object') {
        continue;
      }
      const item = rawItem as RawSavedExportItem;
      totalProcessed++;

      // Extract and validate href link and timestamp
      let href: string | undefined;
      let rawTimestamp: unknown = item.timestamp;

      if (typeof item.href === 'string') {
        href = item.href;
      } else if (item.string_map_data && typeof item.string_map_data === 'object') {
        for (const mapData of Object.values(item.string_map_data)) {
          if (mapData && typeof mapData === 'object') {
            if (typeof mapData.href === 'string') {
              href = mapData.href;
              rawTimestamp = mapData.timestamp ?? rawTimestamp;
              break;
            }
          }
        }
      }

      if (!href) {
        continue;
      }

      // Anchored URL parse: validate host and reel/post path
      let shortcode: string | null = null;
      let mediaType: 'reel' | 'p' = 'reel';
      try {
        const parsedUrl = new URL(href);
        const host = parsedUrl.hostname.toLowerCase();
        if (host !== 'instagram.com' && host !== 'www.instagram.com') {
          continue;
        }
        const pathMatch = parsedUrl.pathname.match(/^\/(reel|reels|p)\/([A-Za-z0-9_-]+)\/?$/i);
        if (!pathMatch) {
          continue;
        }
        mediaType = pathMatch[1].toLowerCase() === 'p' ? 'p' : 'reel';
        shortcode = pathMatch[2];
      } catch {
        continue;
      }

      if (!shortcode) {
        continue;
      }

      // Preserve original URL path type
      const reel_url = `https://www.instagram.com/${mediaType}/${shortcode}/`;

      // Extract creator identity from reliable metadata fields or use sentinel
      let creatorHandle = UNKNOWN_CREATOR_HANDLE;
      const caption: string | null = typeof item.caption === 'string' && item.caption.trim() ? item.caption.trim() : null;

      if (item.string_map_data && typeof item.string_map_data === 'object') {
        for (const [key, mapData] of Object.entries(item.string_map_data)) {
          if (mapData && typeof mapData === 'object') {
            const normalizedKey = key.toLowerCase();
            if (['author', 'owner', 'user', 'creator'].includes(normalizedKey) && typeof mapData.value === 'string' && mapData.value.trim()) {
              const candidate = mapData.value.trim().replace(/^@/, '');
              if (INSTAGRAM_HANDLE_REGEX.test(candidate)) {
                creatorHandle = candidate;
                break;
              }
            }
          }
        }
      }

      // If creator was not found in string_map_data, check item.title.
      // In official Instagram saved_posts.json exports, item.title holds the creator handle
      // while "Saved on" provides href and timestamp.
      // Treat item.title as creator candidate ONLY when it matches Instagram handle grammar,
      // and never store it as caption.
      if (creatorHandle === UNKNOWN_CREATOR_HANDLE && typeof item.title === 'string' && item.title.trim()) {
        const titleCandidate = item.title.trim().replace(/^@/, '');
        if (INSTAGRAM_HANDLE_REGEX.test(titleCandidate)) {
          creatorHandle = titleCandidate;
        }
      }

      // Format ISO dates with strict runtime checks
      let savedAtIso: string | null = null;
      if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
        const ms = rawTimestamp > 10000000000 ? rawTimestamp : rawTimestamp * 1000;
        const date = new Date(ms);
        if (!isNaN(date.getTime())) {
          savedAtIso = date.toISOString();
        }
      }
      const recordDate = savedAtIso || new Date().toISOString();

      try {
        // Upsert creator with cache to avoid redundant database round trips
        let creator = creatorCache.get(creatorHandle);
        if (!creator) {
          creator = await Repository.upsertCreator({
            instagram_user_id: `creator_${creatorHandle}`,
            username: creatorHandle,
            display_name: creatorHandle !== UNKNOWN_CREATOR_HANDLE ? creatorHandle : null,
            profile_picture_url: null,
          });
          creatorCache.set(creatorHandle, creator);
        }

        // Only count actual identified creators (exclude unattributed sentinel)
        if (creatorHandle !== UNKNOWN_CREATOR_HANDLE) {
          creatorsSeen.add(creator.id);
        }

        // Upsert saved reel with ignoreDuplicates and skipReturn to preserve existing status and avoid redundant fetch
        await Repository.upsertSavedReel(
          {
            instagram_media_id: `export_${shortcode}`,
            shortcode,
            reel_url,
            creator_id: creator.id,
            caption,
            thumbnail_url: null,
            taken_at: recordDate,
            saved_at: savedAtIso,
            first_detected_at: recordDate,
            save_order_rank: totalProcessed,
            watch_status: 'unwatched',
            is_saved_on_instagram: true,
            instagram_sender_id: senderId || null,
          },
          { ignoreDuplicates: true, skipReturn: true }
        );

        reelsImported++;
      } catch (err: any) {
        console.error(`[ArchiveImport] Failed to import reel ${shortcode}:`, err.message || err);
        errors.push(`Failed to import item with shortcode ${shortcode}`);
      }
    }

    let status: ArchiveImportStatus = 'success';
    if (reelsImported === 0) {
      status = totalProcessed === 0 || errors.length === 0 ? 'empty' : 'failed';
      if (status === 'empty' && errors.length === 0) {
        errors.push(
          totalProcessed === 0
            ? 'No items found in archive export payload.'
            : 'No valid Instagram reel links found in export (all items skipped or non-reel links).'
        );
      }
    } else if (errors.length > 0) {
      status = 'partial';
    }

    return {
      totalProcessed,
      reelsImported,
      creatorsAdded: creatorsSeen.size,
      skipped: totalProcessed - reelsImported,
      errors: errors.slice(0, 5),
      status,
    };
  }
}
