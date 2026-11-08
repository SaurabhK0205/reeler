import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { fetchReelMetadata } from './reelMetadataResolver.ts';
import { parseDuration, formatTargetTime } from '../utils/duration.ts';

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
    const validTokens = [
      this.verifyToken,
      'rea_instagram_saved_token',
      'ig_reels_tracker_webhook_secret_2026',
    ];
    if (mode === 'subscribe' && validTokens.includes(token)) {
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
    if (body.custom_user_id || body.manychat_user_id || body.last_input_text) {
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

    // 2. Official Meta Graph API Webhook format (handles both 'instagram' and 'page' objects)
    if ((body.object === 'instagram' || body.object === 'page') && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        // A. Standard messaging events
        const messaging = entry.messaging || [];
        for (const event of messaging) {
          const senderId = event.sender?.id;
          if (!senderId) continue;

          // Ignore echoes / own sent messages
          if (event.message?.is_echo) continue;

          const text = event.message?.text || '';
          
          // Check for attachments (e.g. shared Reel clip, ig_reel, share, video)
          let reelUrl: string | null = null;
          if (event.message?.attachments) {
            for (const att of event.message.attachments) {
              if (att.payload?.url) {
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

        // B. Changes events (some webhook subscriptions dispatch via changes)
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field === 'messages' && change.value) {
            const val = change.value;
            const senderId = val.sender?.id;
            if (!senderId || val.message?.is_echo) continue;
            const text = val.message?.text || '';
            let reelUrl: string | null = null;
            if (val.message?.attachments) {
              for (const att of val.message.attachments) {
                if (att.payload?.url) {
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

      // Fetch public metadata
      const meta = await fetchReelMetadata(shortcode);
      const username = meta.username || meta.displayName || 'Instagram Creator';
      const displayName = meta.displayName || username;

      // Upsert Creator
      const creator = await Repository.upsertCreator({
        instagram_user_id: `creator_${username}`,
        username: username,
        display_name: displayName,
        profile_picture_url: meta.thumbnailUrl || null,
      });

      const creatorLine = meta.username
        ? `\nCreator: @${meta.username}`
        : (meta.displayName ? `\nCreator: ${meta.displayName}` : '');

      if (customDuration) {
        // User provided a specific time along with the reel!
        const nextReminder = customDuration.targetDate.toISOString();
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
          reminder_interval_seconds: customDuration.seconds,
          next_reminder_at: nextReminder,
          awaiting_reminder_choice_until: null,
          is_saved_on_instagram: true,
          instagram_sender_id: senderId,
        });

        const reply = `🎬 Added to your Watch Later!${creatorLine}\n\n⏰ Reminder set for: ${customDuration.label} (${customDuration.formattedTarget})\n\nReply "watched" when done!`;
        await this.sendDirectMessage(senderId, reply);
      } else {
        // No time provided — wait up to 10 minutes for user choice before defaulting to 10 hours
        const awaitingUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
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
          reminder_interval_seconds: null,
          next_reminder_at: null,
          awaiting_reminder_choice_until: awaitingUntil,
          is_saved_on_instagram: true,
          instagram_sender_id: senderId,
        });

        const defaultTriggerDate = new Date(Date.now() + (10 * 60 + 10 * 3600) * 1000);
        const defaultTriggerStr = formatTargetTime(defaultTriggerDate);

        const reply = `🎬 Added to your Watch Later!${creatorLine}\n\n⏰ When should I remind you to watch this?\nReply with a time (e.g. "30m", "2h", "tomorrow at 5pm", or "remind me in 5 days").\n\n⏳ If you don't reply within 10 mins, I'll automatically set a reminder for 10 hours from now (${defaultTriggerStr})!`;
        await this.sendDirectMessage(senderId, reply);
      }
      return;
    }

    const lower = text.toLowerCase().trim();

    // 1. Mark as watched / stop command
    // Handles: "watched", "watched!", "watched.", "done", "seen", "stop", "i watched it", "done with it", "cancel", "clear", etc.
    const isWatchedOrStop = /\b(watched|watch|done|seen|finish|finished|stop|cancel|halt|unsub|quit)\b/i.test(lower);
    if (isWatchedOrStop) {
      const updatedReels = await Repository.markWatchedForInstagramSender(senderId);
      if (updatedReels.length > 0) {
        const title = updatedReels[0].shortcode ? `"${updatedReels[0].shortcode}"` : 'your reel';
        await this.sendDirectMessage(senderId, `✅ Marked ${title} as watched! Reminders stopped.`);
      } else {
        await this.sendDirectMessage(senderId, `👍 All set! No pending reels right now.`);
      }
      return;
    }

    // 2. Custom duration command (e.g. "5s", "remind me in 5 days", "tomorrow at 5pm", "12 nov", etc.)
    const customDuration = parseDuration(text);
    if (customDuration) {
      const targetReel =
        (await Repository.getActiveAwaitingReelForSender(senderId)) ||
        (await Repository.getLastReelForInstagramSender(senderId));

      if (targetReel) {
        const nextDate = customDuration.targetDate.toISOString();
        await Repository.updateReminderSchedule(targetReel.id, nextDate, customDuration.seconds);
        const creatorTag = targetReel.creator ? `@${targetReel.creator.username}` : targetReel.shortcode;
        await this.sendDirectMessage(
          senderId,
          `⏰ Reminder set for ${creatorTag}: ${customDuration.label} (${customDuration.formattedTarget})!\n\nReply "watched" when done.`
        );
      } else {
        await this.sendDirectMessage(
          senderId,
          `⏰ Got it! Duration set to ${customDuration.label} (${customDuration.formattedTarget}). Share any Reel to track it!`
        );
      }
      return;
    }

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
