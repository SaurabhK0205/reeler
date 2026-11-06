import type { RawInstagramSavedItem, Result } from '../types.ts';
import { ok, err } from '../types.ts';
import { loadConfig } from '../config.ts';

export interface InstagramSavedPage {
  items: RawInstagramSavedItem[];
  nextMaxId?: string;
  moreAvailable: boolean;
}

export class InstagramSavedClient {
  private baseUrl = 'https://www.instagram.com';
  private igAppId = '936619743392459'; // Official Instagram Web Client ID

  private getHeaders(): Record<string, string> {
    const config = loadConfig();
    if (!config.instagram.isConfigured || !config.instagram.sessionId || !config.instagram.csrfToken || !config.instagram.userId) {
      throw new Error('Instagram session cookies not configured. Please set them in .env');
    }

    const cookies = [
      `sessionid=${config.instagram.sessionId}`,
      `ds_user_id=${config.instagram.userId}`,
      `csrftoken=${config.instagram.csrfToken}`,
    ].join('; ');

    return {
      'User-Agent': config.instagram.userAgent,
      'Cookie': cookies,
      'X-IG-App-ID': this.igAppId,
      'X-CSRFToken': config.instagram.csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${this.baseUrl}/`,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  /**
   * Fetches a single page of saved items from Instagram Web.
   */
  async fetchSavedPage(maxId?: string): Promise<Result<InstagramSavedPage>> {
    try {
      const url = new URL(`${this.baseUrl}/api/v1/feed/saved/posts/`);
      url.searchParams.set('include_igtv_preview', 'false');
      if (maxId) {
        url.searchParams.set('max_id', maxId);
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return err(new Error(`Authentication failed (HTTP ${response.status}). Session cookies may have expired.`));
        }
        return err(new Error(`Instagram API HTTP error: ${response.status} ${response.statusText}`));
      }

      const json = await response.json() as Record<string, any>;
      if (json.status !== 'ok') {
        return err(new Error(json.message || 'Instagram returned an error'));
      }

      const rawItems = json.items || [];
      const items: RawInstagramSavedItem[] = [];

      for (const item of rawItems) {
        // We focus on Reels (product_type === 'clips' or media_type === 2)
        const media = item.media || item;
        if (media && media.id && media.code) {
          items.push({ media });
        }
      }

      return ok({
        items,
        nextMaxId: json.next_max_id,
        moreAvailable: Boolean(json.more_available && json.next_max_id),
      });
    } catch (e: any) {
      return err(new Error(`Fetch saved page failed: ${e.message}`));
    }
  }
}
