import { InstagramSavedClient } from './instagramClient.ts';
import { Repository } from '../db/repository.ts';
import type { Result } from '../types.ts';
import { ok, err } from '../types.ts';

export interface SyncResult {
  pagesFetched: number;
  reelsProcessed: number;
  newReelsCount: number;
  creatorsUpserted: number;
  completedAt: string;
}

export class SyncService {
  private client = new InstagramSavedClient();

  /**
   * Synchronize the user's saved reels from Instagram into the database.
   * @param maxPages Maximum number of pages to fetch (default: 5 pages, ~100-150 items)
   */
  async syncSavedReels(maxPages = 5): Promise<Result<SyncResult>> {
    let pagesFetched = 0;
    let reelsProcessed = 0;
    let newReelsCount = 0;
    const creatorsSeen = new Set<string>();

    let currentMaxId: string | undefined = undefined;
    let moreAvailable = true;
    let currentRank = 1;
    const syncTimestamp = new Date().toISOString();

    console.log(`[SyncService] Starting sync (maxPages: ${maxPages})...`);

    try {
      while (moreAvailable && pagesFetched < maxPages) {
        pagesFetched++;
        console.log(`[SyncService] Fetching page ${pagesFetched}...`);

        const pageResult = await this.client.fetchSavedPage(currentMaxId);
        if (!pageResult.success) {
          console.error(`[SyncService] Error on page ${pagesFetched}:`, pageResult.error.message);
          return err(pageResult.error);
        }

        const { items, nextMaxId, moreAvailable: hasMore } = pageResult.data;
        if (items.length === 0) {
          console.log(`[SyncService] No more items found on page ${pagesFetched}.`);
          break;
        }

        for (const item of items) {
          const media = item.media;
          reelsProcessed++;

          // 1. Upsert Creator
          const user = media.user;
          const creator = await Repository.upsertCreator({
            instagram_user_id: String(user.pk),
            username: user.username,
            display_name: user.full_name || null,
            profile_picture_url: user.profile_pic_url || null,
          });
          creatorsSeen.add(creator.id);

          // 2. Extract best thumbnail candidate
          const candidates = media.image_versions2?.candidates || [];
          const bestThumb = candidates[0]?.url || null;

          // 3. Upsert Saved Reel
          const shortcode = media.code;
          const takenAtDate = new Date(media.taken_at * 1000).toISOString();

          await Repository.upsertSavedReel({
            instagram_media_id: String(media.id),
            shortcode,
            reel_url: `https://www.instagram.com/reel/${shortcode}/`,
            creator_id: creator.id,
            caption: media.caption?.text || null,
            thumbnail_url: bestThumb,
            taken_at: takenAtDate,
            saved_at: null, // Saved date is not historically exposed by Instagram
            first_detected_at: syncTimestamp,
            save_order_rank: currentRank++,
            watch_status: 'unwatched',
            duration_seconds: media.video_duration || null,
          });

          newReelsCount++;
        }

        currentMaxId = nextMaxId;
        moreAvailable = hasMore && Boolean(currentMaxId);

        // Friendly jitter to respect rate limits
        if (moreAvailable) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      console.log(`[SyncService] Sync finished: ${reelsProcessed} reels processed across ${pagesFetched} page(s).`);

      return ok({
        pagesFetched,
        reelsProcessed,
        newReelsCount,
        creatorsUpserted: creatorsSeen.size,
        completedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      return err(new Error(`Sync failed: ${e.message}`));
    }
  }
}
