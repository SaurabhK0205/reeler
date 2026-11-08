import { Repository } from '../db/repository.ts';

export interface RawSavedExportItem {
  title?: string;
  string_map_data?: Record<string, { href?: string; timestamp?: number }>;
  href?: string;
  timestamp?: number;
  caption?: string;
}

export interface ArchiveImportResult {
  totalProcessed: number;
  reelsImported: number;
  creatorsAdded: number;
  skipped: number;
  errors: string[];
}

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
        return {
          totalProcessed: 0,
          reelsImported: 0,
          creatorsAdded: 0,
          skipped: 0,
          errors: [`Failed to parse JSON file: ${err.message}`],
        };
      }
    }

    // Locate the array of saved items across different Instagram export variations
    let rawItems: RawSavedExportItem[] = [];
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
      };
    }

    let totalProcessed = 0;
    let reelsImported = 0;
    const creatorsSeen = new Set<string>();
    const errors: string[] = [];
    const reelRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/i;

    for (const item of rawItems) {
      totalProcessed++;

      // Extract href link and timestamp
      let href = item.href;
      let timestamp = item.timestamp;

      if (!href && item.string_map_data) {
        for (const mapData of Object.values(item.string_map_data)) {
          if (mapData.href) {
            href = mapData.href;
            timestamp = mapData.timestamp || timestamp;
            break;
          }
        }
      }

      if (!href) {
        continue;
      }

      const match = href.match(reelRegex);
      if (!match) {
        continue;
      }

      const shortcode = match[1];

      // Extract username from title if available (Instagram exports usually put creator username in title)
      let creatorHandle = 'instagram_creator';
      let caption: string | null = item.caption || null;

      if (item.title) {
        const cleanedTitle = item.title.trim().replace(/^@/, '');
        // If title looks like a username (no spaces, <= 30 chars), treat it as the creator handle
        if (/^[a-zA-Z0-9._]{1,30}$/.test(cleanedTitle)) {
          creatorHandle = cleanedTitle;
        } else {
          caption = item.title;
        }
      }

      // Format ISO dates
      let savedAtIso: string | null = null;
      if (timestamp) {
        // Timestamps in Instagram exports can be in seconds or milliseconds
        const ms = timestamp > 10000000000 ? timestamp : timestamp * 1000;
        savedAtIso = new Date(ms).toISOString();
      }
      const recordDate = savedAtIso || new Date().toISOString();

      try {
        // Upsert creator
        const creator = await Repository.upsertCreator({
          instagram_user_id: `creator_${creatorHandle}`,
          username: creatorHandle,
          display_name: creatorHandle !== 'instagram_creator' ? creatorHandle : null,
          profile_picture_url: null,
        });
        creatorsSeen.add(creator.id);

        // Upsert saved reel
        await Repository.upsertSavedReel({
          instagram_media_id: `export_${shortcode}`,
          shortcode,
          reel_url: `https://www.instagram.com/reel/${shortcode}/`,
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
        });

        reelsImported++;
      } catch (err: any) {
        errors.push(`Error importing reel ${shortcode}: ${err.message}`);
      }
    }

    return {
      totalProcessed,
      reelsImported,
      creatorsAdded: creatorsSeen.size,
      skipped: totalProcessed - reelsImported,
      errors: errors.slice(0, 5), // Keep only top 5 errors if any
    };
  }
}
