import { loadConfig } from '../config.ts';
import type { Result } from '../types.ts';
import { ok, err } from '../types.ts';
import crypto from 'node:crypto';

export interface InboundMessage {
  itemId: string;
  userId: string;
  timestamp: number;
  itemType: string;
  text?: string;
  reel?: {
    mediaId: string;
    shortcode: string;
    caption?: string;
    authorUsername?: string;
    thumbnailUrl?: string;
  };
}

export class InstagramActionClient {
  private baseUrl = 'https://www.instagram.com';
  private igAppId = '936619743392459'; // Instagram Web Client App ID

  private getHeaders(): Record<string, string> {
    const config = loadConfig();
    if (!config.instagram.isConfigured || !config.instagram.sessionId || !config.instagram.csrfToken || !config.instagram.userId) {
      throw new Error('Instagram session cookies not configured in .env');
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
      'Referer': `${this.baseUrl}/direct/inbox/`,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  /**
   * Saves a Reel/Media natively into the user's Instagram Saved collection!
   */
  async saveMedia(mediaId: string): Promise<Result<boolean>> {
    try {
      const url = `${this.baseUrl}/api/v1/media/${mediaId}/save/`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
      });

      if (!response.ok) {
        return err(new Error(`Failed to save media to Instagram: HTTP ${response.status}`));
      }

      const json = await response.json() as Record<string, any>;
      return ok(json.status === 'ok');
    } catch (e: any) {
      return err(new Error(`Save media error: ${e.message}`));
    }
  }

  /**
   * Sends a Direct Message to a thread or recipient user.
   */
  async sendDirectMessage(recipientUserId: string, text: string): Promise<Result<boolean>> {
    try {
      const url = `${this.baseUrl}/api/v1/direct_v2/threads/broadcast/text/`;
      const clientContext = crypto.randomUUID();

      const params = new URLSearchParams({
        recipient_users: JSON.stringify([recipientUserId]),
        text,
        client_context: clientContext,
        action: 'send_item',
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        return err(new Error(`Failed to send DM: HTTP ${response.status}`));
      }

      const json = await response.json() as Record<string, any>;
      return ok(json.status === 'ok');
    } catch (e: any) {
      return err(new Error(`Send DM error: ${e.message}`));
    }
  }

  /**
   * Fetch recent messages from a thread.
   */
  async getThreadMessages(threadId: string): Promise<Result<InboundMessage[]>> {
    try {
      const url = `${this.baseUrl}/api/v1/direct_v2/threads/${threadId}/`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return err(new Error(`HTTP ${response.status} fetching thread messages`));
      }

      const json = await response.json() as Record<string, any>;
      const rawItems = json.thread?.items || [];

      const parsed: InboundMessage[] = rawItems.map((item: any) => {
        const itemType = item.item_type || 'unknown';
        let reel: InboundMessage['reel'] | undefined;

        // Clip / Reel share
        if (itemType === 'clip' && item.clip?.media) {
          const m = item.clip.media;
          reel = {
            mediaId: String(m.id || ''),
            shortcode: m.code || '',
            caption: m.caption?.text,
            authorUsername: m.user?.username,
            thumbnailUrl: m.image_versions2?.candidates?.[0]?.url,
          };
        } else if ((itemType === 'reel_share' || itemType === 'media_share') && (item.reel_share?.media || item.media_share)) {
          const m = item.reel_share?.media || item.media_share;
          reel = {
            mediaId: String(m.id || ''),
            shortcode: m.code || '',
            caption: m.caption?.text,
            authorUsername: m.user?.username,
            thumbnailUrl: m.image_versions2?.candidates?.[0]?.url,
          };
        } else if (item.text) {
          const match = item.text.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/i);
          if (match) {
            reel = {
              mediaId: '',
              shortcode: match[1],
            };
          }
        }

        return {
          itemId: String(item.item_id || ''),
          userId: String(item.user_id || ''),
          timestamp: Math.floor(Number(item.timestamp || 0) / 1000),
          itemType,
          text: item.text,
          reel,
        };
      });

      return ok(parsed);
    } catch (e: any) {
      return err(new Error(`Get thread messages error: ${e.message}`));
    }
  }

  /**
   * Finds the DM thread with the user's admin username.
   */
  async findAdminThread(adminUsername: string): Promise<Result<{ threadId: string; adminUserId: string } | null>> {
    try {
      const url = `${this.baseUrl}/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=20`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return err(new Error(`HTTP ${response.status} fetching inbox`));
      }

      const json = await response.json() as Record<string, any>;
      const threads = json.inbox?.threads || [];

      const cleanAdmin = adminUsername.toLowerCase().trim();
      for (const t of threads) {
        const users = t.users || [];
        const match = users.find((u: any) => u.username?.toLowerCase() === cleanAdmin);
        if (match) {
          return ok({
            threadId: t.thread_id,
            adminUserId: String(match.pk),
          });
        }
      }

      return ok(null);
    } catch (e: any) {
      return err(new Error(`Find admin thread error: ${e.message}`));
    }
  }
}
