import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { fetchReelMetadata } from './reelMetadataResolver.ts';
import { parseDuration } from '../utils/duration.ts';

export class MetaInstagramBotService {
  private accessToken: string;
  private verifyToken: string;

  constructor() {
    this.accessToken = process.env.META_PAGE_ACCESS_TOKEN || '';
    this.verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'rea_instagram_saved_token';
  }

  get isConfigured(): boolean {
    return Boolean(this.accessToken);
  }

  /**
   * Validates Meta Webhook Verification Challenge (GET /webhook)
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.verifyToken) {
      return challenge;
    }
    return null;
  }

  /**
   * Sends a message to a user via Meta Graph API
   */
  async sendDirectMessage(recipientId: string, text: string): Promise<boolean> {
    if (!this.accessToken) {
      console.warn('[MetaIG] No META_PAGE_ACCESS_TOKEN configured. Cannot send DM reply.');
      return false;
    }

    try {
      const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${this.accessToken}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text },
        }),
      });

      const data = await res.json() as any;
      if (!res.ok) {
        console.error('[MetaIG] Failed to send DM:', data);
        return false;
      }

      console.log(`[MetaIG] DM sent to ${recipientId}: "${text.slice(0, 40)}..."`);
      return true;
    } catch (e: any) {
      console.error('[MetaIG] Error calling Meta messages API:', e.message);
      return false;
    }
  }

  /**
   * Handles incoming webhook event payload from Meta or ManyChat
   */
  async handleWebhookPayload(body: any): Promise<void> {
    console.log('[MetaIG] 📥 Webhook received body:', JSON.stringify(body, null, 2));

    // 1. ManyChat Webhook Bridge format (supports custom JSON and Full Contact Data)
    if (body.custom_user_id || body.manychat_user_id || body.id || body.user_id || body.last_input_text || body.text) {
      const userId = String(
        body.custom_user_id ||
        body.manychat_user_id ||
        body.id ||
        body.user_id ||
        'instagram_user'
      );
      const text = String(
        body.text ||
        body.last_input_text ||
        body.last_text_input ||
        body.message ||
        ''
      );
      if (text) {
        await this.processIncomingText(userId, text);
      }
      return;
    }

    // 2. Official Meta Graph API Webhook format
    if (body.object === 'instagram' && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        const messaging = entry.messaging || [];
        for (const event of messaging) {
          const senderId = event.sender?.id;
          if (!senderId) continue;

          // Ignore echoes / own sent messages
          if (event.message?.is_echo) continue;

          const text = event.message?.text || '';
          
          // Check for attachments (e.g. shared Reel clip)
          let reelUrl: string | null = null;
          if (event.message?.attachments) {
            for (const att of event.message.attachments) {
              if (att.type === 'share' && att.payload?.url) {
                reelUrl = att.payload.url;
                break;
              }
            }
          }

          const combinedText = reelUrl ? `${reelUrl} ${text}`.trim() : text;
          if (combinedText) {
            await this.processIncomingText(senderId, combinedText);
          }
        }
      }
    }
  }

  /**
   * Processes incoming text/link from an Instagram user
   */
  private async processIncomingText(senderId: string, text: string): Promise<void> {
    console.log(`[MetaIG] 📩 Incoming DM from Instagram user ${senderId}: "${text}"`);

    // Check for Reel URL
    const reelMatch = text.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/i);
    if (reelMatch) {
      const shortcode = reelMatch[1];
      const remaining = text.replace(reelMatch[0], '').trim();
      const customDuration = parseDuration(remaining);

      const durationMs = customDuration ? customDuration.ms : 10 * 3600 * 1000;
      const durationLabel = customDuration ? customDuration.label : '10 hours';
      const durationSec = Math.round(durationMs / 1000);

      // Fetch public metadata
      const meta = await fetchReelMetadata(shortcode);
      const resolvedUsername = meta.username || 'instagram_creator';
      const resolvedDisplayName = meta.displayName || resolvedUsername;

      // Upsert Creator
      const creator = await Repository.upsertCreator({
        instagram_user_id: `creator_${resolvedUsername}`,
        username: resolvedUsername,
        display_name: resolvedDisplayName,
        profile_picture_url: meta.thumbnailUrl || null,
      });

      const nextReminder = new Date(Date.now() + durationMs).toISOString();

      // Upsert Saved Reel linked to this Instagram user ID
      await Repository.upsertSavedReel({
        instagram_media_id: `shortcode_${shortcode}`,
        shortcode,
        reel_url: `https://www.instagram.com/reel/${shortcode}/`,
        creator_id: creator.id,
        caption: meta.caption || null,
        thumbnail_url: meta.thumbnailUrl || null,
        taken_at: new Date().toISOString(),
        first_detected_at: new Date().toISOString(),
        save_order_rank: 1,
        watch_status: 'watch_later',
        reminder_interval_seconds: durationSec,
        next_reminder_at: nextReminder,
        is_saved_on_instagram: true,
      });

      const targetTimeStr = new Date(nextReminder).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const reply = `🎬 Added to your Watch Later!\nCreator: @${resolvedUsername}\n\n⏰ Reminder set for: ${durationLabel} (at ${targetTimeStr})\n\nReply "watched" when done, or "snooze 1h" to delay!`;

      await this.sendDirectMessage(senderId, reply);
      return;
    }

    const lower = text.toLowerCase().trim();

    // Check for creator search (e.g. "@heysiri_jan" or "heysiri_jan")
    if (/^@?[a-zA-Z0-9._]{2,30}$/.test(lower) && !lower.startsWith('/')) {
      const { creator, reels } = await Repository.getReelsByCreatorUsername(lower);
      if (!creator || reels.length === 0) {
        await this.sendDirectMessage(
          senderId,
          `🔍 No saved reels from @${lower.replace(/^@/, '')} yet!\nShare any Reel link from them to start tracking.`
        );
        return;
      }

      let reply = `🎬 Saved Reels from @${creator.username} (${reels.length} total, latest to oldest):\n\n`;
      const sample = reels.slice(0, 5);
      sample.forEach((r, i) => {
        const snippet = r.caption ? `"${r.caption.slice(0, 40).replace(/\n/g, ' ')}..."` : '';
        reply += `${i + 1}. https://instagram.com/reel/${r.shortcode}/ ${snippet}\n`;
      });

      await this.sendDirectMessage(senderId, reply);
      return;
    }

    // Default welcome / help reply
    const helpMsg = `👋 Hi! Whenever you see a Reel you want to save or watch later:\n1. Tap Share (airplane icon)\n2. Send it here!\n\nAdd a time like "30m" or "2h" to set custom reminders.\nType any creator's username to view your saved reels!`;
    await this.sendDirectMessage(senderId, helpMsg);
  }
}
