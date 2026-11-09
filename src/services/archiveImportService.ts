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
  alreadyPresent: number;
  creatorsAdded: number;
  skipped: number;
  errors: string[];
  status: ArchiveImportStatus;
}

const UNKNOWN_CREATOR_HANDLE = 'unattributed';
const INSTAGRAM_HANDLE_REGEX = /^[a-zA-Z0-9._]{1,30}$/;
const UTF8_DECODER_FATAL = new TextDecoder('utf-8', { fatal: true });

/**
 * Decodes Meta export Latin-1-wrapped UTF-8 mojibake sequences (e.g. `thereâ\x80\x99s`, `ð\x9F\x98\xad`)
 * back into clean Unicode while preserving genuine Latin-1 text (`Céline`) and stripping leftover C1 controls.
 */
export function normalizeMetaExportText(raw: string | null | undefined): string {
  if (!raw) return '';
  const fixed = String(raw).replace(
    /(?:[\u00C2-\u00DF][\u0080-\u00BF]|[\u00E0-\u00EF][\u0080-\u00BF]{2}|[\u00F0-\u00F4][\u0080-\u00BF]{3})+/g,
    (chunk) => {
      try {
        const bytes = new Uint8Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          bytes[i] = chunk.charCodeAt(i);
        }
        return UTF8_DECODER_FATAL.decode(bytes);
      } catch {
        return chunk;
      }
    }
  );
  return fixed
    .replace(/[\u007F-\u009F]/g, '')
    .replace(/(?:[\uE000-\uF8FF]+[\uF900-\uFAFF]+|[\uF900-\uFAFF]+[\uE000-\uF8FF]+)/gu, '')
    .replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu, '');
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
        console.error('[ArchiveImport] JSON parse error:', err.message);
        return {
          totalProcessed: 0,
          reelsImported: 0,
          alreadyPresent: 0,
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
      } else if (Array.isArray(obj.label_values)) {
        // Support nested collections (e.g. saved_collections.json)
        for (const lv of obj.label_values) {
          if (lv && Array.isArray(lv.dict)) {
            for (const d of lv.dict) {
              if (d && Array.isArray(d.dict)) {
                rawItems.push(d);
              }
            }
          }
        }
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
        alreadyPresent: 0,
        creatorsAdded: 0,
        skipped: 0,
        errors: ['No saved media items found in the provided export file.'],
        status: 'empty',
      };
    }

    let totalProcessed = 0;
    const errors: string[] = [];

    interface ParsedCandidate {
      mediaId: string;
      shortcode: string;
      reel_url: string;
      creatorHandle: string;
      creatorDisplayName: string | null;
      caption: string | null;
      recordDate: string;
      savedAtIso: string | null;
      rank: number;
    }

    const candidatesByShortcode = new Map<string, ParsedCandidate>();

    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== 'object') {
        continue;
      }
      const item = rawItem as RawSavedExportItem;
      totalProcessed++;

      let href: string | undefined;
      let rawTimestamp: unknown = item.timestamp;
      let caption: string | null = typeof item.caption === 'string' && item.caption.trim() ? item.caption.trim() : null;
      let creatorHandle = UNKNOWN_CREATOR_HANDLE;
      let creatorDisplayName: string | null = null;

      // Validate fbid: must be a positive numeric ID (1-30 digits)
      const rawFbid = (item as any).fbid;
      let mediaId: string | null = null;
      if (typeof rawFbid === 'string' && /^\d{1,30}$/.test(rawFbid.trim())) {
        mediaId = rawFbid.trim();
      } else if (typeof rawFbid === 'number' && Number.isFinite(rawFbid) && rawFbid > 0) {
        mediaId = String(rawFbid);
      }

      // 1. Modern Instagram Account Center export format (label_values array)
      if (Array.isArray((item as any).label_values)) {
        for (const lv of (item as any).label_values) {
          if (!lv || typeof lv !== 'object') continue;
          if (lv.label === 'URL') {
            href = (typeof lv.href === 'string' && lv.href) || (typeof lv.value === 'string' && lv.value) || href;
          } else if (lv.label === 'Caption' && typeof lv.value === 'string' && lv.value.trim()) {
            caption = lv.value.trim();
          } else if (lv.title === 'Owner' && Array.isArray(lv.dict)) {
            for (const d of lv.dict) {
              if (d && Array.isArray(d.dict)) {
                for (const sub of d.dict) {
                  if (!sub || typeof sub !== 'object') continue;
                  if (sub.label === 'Username' && typeof sub.value === 'string' && sub.value.trim()) {
                    const clean = sub.value.trim().replace(/^@/, '');
                    if (INSTAGRAM_HANDLE_REGEX.test(clean)) {
                      creatorHandle = clean;
                    }
                  } else if (sub.label === 'Name' && typeof sub.value === 'string' && sub.value.trim()) {
                    creatorDisplayName = sub.value.trim();
                  }
                }
              }
            }
          }
        }
      } else if (Array.isArray((item as any).dict)) {
        // Nested dict format (from collections)
        for (const sub of (item as any).dict) {
          if (sub && typeof sub === 'object') {
            if (sub.label === 'URL') {
              href = (typeof sub.href === 'string' && sub.href) || (typeof sub.value === 'string' && sub.value) || href;
            } else if (sub.label === 'Caption' && typeof sub.value === 'string' && sub.value.trim()) {
              caption = sub.value.trim();
            }
          }
        }
      }

      // 2. Legacy export format (string_map_data)
      if (item.string_map_data && typeof item.string_map_data === 'object') {
        for (const [key, mapData] of Object.entries(item.string_map_data)) {
          if (mapData && typeof mapData === 'object') {
            const normalizedKey = key.toLowerCase();
            if (!href && typeof mapData.href === 'string') {
              href = mapData.href;
              rawTimestamp = mapData.timestamp ?? rawTimestamp;
            }
            if (['author', 'owner', 'user', 'creator'].includes(normalizedKey) && typeof mapData.value === 'string' && mapData.value.trim()) {
              const candidate = mapData.value.trim().replace(/^@/, '');
              if (INSTAGRAM_HANDLE_REGEX.test(candidate)) {
                creatorHandle = candidate;
              }
            }
          }
        }
      }

      // 3. Direct property fallback
      if (!href && typeof item.href === 'string') {
        href = item.href;
      }

      // 4. Creator handle fallback from item.title (legacy exports where title is creator handle)
      if (creatorHandle === UNKNOWN_CREATOR_HANDLE && typeof item.title === 'string' && item.title.trim()) {
        const titleCandidate = item.title.trim().replace(/^@/, '');
        if (INSTAGRAM_HANDLE_REGEX.test(titleCandidate)) {
          creatorHandle = titleCandidate;
        }
      }

      if (!href) {
        continue;
      }

      // Anchored URL parse: validate host and reel/post/tv path
      let shortcode: string | null = null;
      let mediaType: 'reel' | 'p' | 'tv' = 'reel';
      try {
        const parsedUrl = new URL(href);
        const host = parsedUrl.hostname.toLowerCase();
        if (host !== 'instagram.com' && host !== 'www.instagram.com') {
          continue;
        }
        const pathMatch = parsedUrl.pathname.match(/^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?$/i);
        if (!pathMatch) {
          continue;
        }
        const matchedType = pathMatch[1].toLowerCase();
        mediaType = matchedType === 'p' ? 'p' : (matchedType === 'tv' ? 'tv' : 'reel');
        shortcode = pathMatch[2];
      } catch {
        continue;
      }

      if (!shortcode) {
        continue;
      }

      const reel_url = `https://www.instagram.com/${mediaType}/${shortcode}/`;
      if (!mediaId) {
        mediaId = `export_${shortcode}`;
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

      const normalizedCaption = caption ? normalizeMetaExportText(caption).trim() || null : null;
      const normalizedDisplayName = creatorDisplayName ? normalizeMetaExportText(creatorDisplayName).trim() || null : null;

      const candidate: ParsedCandidate = {
        mediaId,
        shortcode,
        reel_url,
        creatorHandle,
        creatorDisplayName: normalizedDisplayName,
        caption: normalizedCaption,
        recordDate,
        savedAtIso,
        rank: totalProcessed,
      };

      // Deduplicate candidates by shortcode, preferring known creator then non-empty caption
      const existing = candidatesByShortcode.get(shortcode);
      if (!existing) {
        candidatesByShortcode.set(shortcode, candidate);
      } else {
        const existingHasCreator = existing.creatorHandle !== UNKNOWN_CREATOR_HANDLE;
        const candidateHasCreator = candidate.creatorHandle !== UNKNOWN_CREATOR_HANDLE;
        if (!existingHasCreator && candidateHasCreator) {
          candidatesByShortcode.set(shortcode, candidate);
        } else if (existingHasCreator === candidateHasCreator && !existing.caption && candidate.caption) {
          candidatesByShortcode.set(shortcode, candidate);
        }
      }
    }

    let reelsImported = 0;
    let alreadyPresent = 0;
    const creatorsSeen = new Set<string>();
    const parsedCandidates = Array.from(candidatesByShortcode.values());

    // Build creatorsToUpsert exclusively from deduplicated surviving candidates
    const creatorsToUpsert = new Map<string, { instagram_user_id: string; username: string; display_name: string | null }>();
    creatorsToUpsert.set(UNKNOWN_CREATOR_HANDLE, {
      instagram_user_id: `creator_${UNKNOWN_CREATOR_HANDLE}`,
      username: UNKNOWN_CREATOR_HANDLE,
      display_name: null,
    });

    for (const c of parsedCandidates) {
      if (!creatorsToUpsert.has(c.creatorHandle)) {
        creatorsToUpsert.set(c.creatorHandle, {
          instagram_user_id: `creator_${c.creatorHandle}`,
          username: c.creatorHandle,
          display_name: c.creatorDisplayName || (c.creatorHandle !== UNKNOWN_CREATOR_HANDLE ? c.creatorHandle : null),
        });
      }
    }

    if (parsedCandidates.length > 0) {
      try {
        // Batch upsert creators
        const creatorMap = await Repository.upsertCreatorsBatch(Array.from(creatorsToUpsert.values()));

        const fallbackCreator = creatorMap.get(UNKNOWN_CREATOR_HANDLE);
        if (!fallbackCreator) {
          const createdFallback = await Repository.upsertCreator({
            instagram_user_id: `creator_${UNKNOWN_CREATOR_HANDLE}`,
            username: UNKNOWN_CREATOR_HANDLE,
            display_name: null,
          });
          creatorMap.set(UNKNOWN_CREATOR_HANDLE, createdFallback);
        }

        // Prepare reels payload with resolved creator IDs
        const reelsPayload: Array<{
          instagram_media_id: string;
          shortcode: string;
          reel_url: string;
          creator_id: string;
          caption: string | null;
          thumbnail_url: string | null;
          taken_at: string;
          saved_at: string | null;
          first_detected_at: string;
          save_order_rank: number;
          watch_status: 'unwatched';
          is_saved_on_instagram: boolean;
          instagram_sender_id: string | null;
        }> = [];

        for (const c of parsedCandidates) {
          if (c.creatorHandle !== UNKNOWN_CREATOR_HANDLE) {
            const creator = creatorMap.get(c.creatorHandle);
            if (!creator?.id) {
              errors.push(`Failed to resolve creator @${c.creatorHandle} for reel ${c.shortcode}`);
              continue;
            }
            creatorsSeen.add(creator.id);
            reelsPayload.push({
              instagram_media_id: c.mediaId,
              shortcode: c.shortcode,
              reel_url: c.reel_url,
              creator_id: creator.id,
              caption: c.caption,
              thumbnail_url: null,
              taken_at: c.recordDate,
              saved_at: c.savedAtIso,
              first_detected_at: c.recordDate,
              save_order_rank: c.rank,
              watch_status: 'unwatched',
              is_saved_on_instagram: true,
              instagram_sender_id: senderId || null,
            });
          } else {
            const fallback = creatorMap.get(UNKNOWN_CREATOR_HANDLE) || fallbackCreator;
            if (fallback?.id) {
              reelsPayload.push({
                instagram_media_id: c.mediaId,
                shortcode: c.shortcode,
                reel_url: c.reel_url,
                creator_id: fallback.id,
                caption: c.caption,
                thumbnail_url: null,
                taken_at: c.recordDate,
                saved_at: c.savedAtIso,
                first_detected_at: c.recordDate,
                save_order_rank: c.rank,
                watch_status: 'unwatched',
                is_saved_on_instagram: true,
                instagram_sender_id: senderId || null,
              });
            } else {
              errors.push(`Failed to resolve fallback unattributed creator for reel ${c.shortcode}`);
              continue;
            }
          }
        }

        // Batch upsert saved reels
        const batchResult = await Repository.upsertSavedReelsBatch(reelsPayload, { ignoreDuplicates: true });
        reelsImported = batchResult.newlyImported;
        alreadyPresent = batchResult.alreadyPresent;

        if (batchResult.failedShortcodes.length > 0) {
          for (const sc of batchResult.failedShortcodes) {
            errors.push(`Failed to import reel with shortcode ${sc}`);
          }
        }
      } catch (batchErr: any) {
        console.error('[ArchiveImport] Batch import error, attempting recovery:', batchErr.message);
        errors.push(`Batch import error: ${batchErr.message || 'unknown error'}`);
      }
    }

    const totalRecognized = reelsImported + alreadyPresent;
    let status: ArchiveImportStatus = 'success';
    if (totalRecognized === 0) {
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
      alreadyPresent,
      creatorsAdded: creatorsSeen.size,
      skipped: totalProcessed - totalRecognized,
      errors: errors.slice(0, 5),
      status,
    };
  }
}
