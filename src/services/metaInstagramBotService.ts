import crypto from 'node:crypto';
import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { fetchReelMetadata } from './reelMetadataResolver.ts';
import { parseDuration, formatTargetTime } from '../utils/duration.ts';
import { extractCreatorQuery } from '../utils/creatorQuery.ts';
import {
  parseWatchedStopCommand,
  extractPublicCreatorUsername,
  formatAddedToWatchLaterCreatorBlock,
  formatWatchedConfirmationMessage,
  formatReminderSetMessage,
  formatCreatorSearchMessages,
} from '../utils/reelMessages.ts';

export class MetaInstagramBotService {
  private accessToken: string;
  private verifyToken: string;
  private appSecret: string;

  constructor() {
    this.accessToken = process.env.META_PAGE_ACCESS_TOKEN || '';
    this.verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'rea_instagram_saved_token';
    this.appSecret = process.env.META_APP_SECRET || '';
  }

  get isConfigured(): boolean {
    return Boolean(this.accessToken);
  }

  /**
   * Validates Meta X-Hub-Signature-256 header using SHA-256 HMAC
   */
  verifySignature(rawBody: Buffer | string | undefined, signatureHeader?: string): boolean {
    if (!this.appSecret) {
      // Insecure bypass is strictly opt-in and forbidden in production
      const allowInsecure = process.env.ALLOW_INSECURE_WEBHOOK === 'true' && process.env.NODE_ENV !== 'production';
      if (allowInsecure) {
        console.warn('[MetaBot] WARNING: Webhook signature verification bypassed via ALLOW_INSECURE_WEBHOOK=true in non-production.');
        return true;
      }
      console.error('[MetaBot] Webhook rejected: META_APP_SECRET is not configured. Set META_APP_SECRET or explicit ALLOW_INSECURE_WEBHOOK=true for local dev.');
      return false;
    }

    if (!signatureHeader || !rawBody) {
      return false;
    }

    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') {
      return false;
    }

    const providedSignature = parts[1];
    const hmac = crypto.createHmac('sha256', this.appSecret);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');

    if (providedSignature.length !== expectedSignature.length) {
      return false;
    }

    try {
      return crypto.timingSafeEqual(
        Buffer.from(providedSignature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch {
      return false;
    }
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
   * Sends a message to a user via Meta Graph API (automatically splits into safe chunks <= 950 chars)
   */
  async sendDirectMessage(recipientId: string, text: string): Promise<boolean> {
    if (!this.accessToken) {
      console.warn('[MetaIG] No META_PAGE_ACCESS_TOKEN configured. Cannot send DM reply.');
      return false;
    }

    const chunks = this.splitMessageIntoChunks(text, 950);
    let allSuccess = true;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${this.accessToken}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: chunk },
          }),
          signal: AbortSignal.timeout(10000),
        });

        const data = await res.json() as any;
        if (!res.ok) {
          console.error('[MetaIG] Failed to send DM:', data);
          allSuccess = false;
          // Stop sending subsequent chunks on failure to avoid out-of-order partial messages
          break;
        } else {
          console.log(`[MetaIG] DM sent to ${recipientId}: "${chunk.slice(0, 40)}..."`);
        }
      } catch (e: any) {
        console.error('[MetaIG] Error calling Meta messages API:', e.message);
        allSuccess = false;
        // Stop sending on network or timeout exceptions
        break;
      }

      // Apply inter-chunk delay only between consecutive chunks, never after the final chunk
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    return allSuccess;
  }

  /**
   * Splits a single continuous block of text into chunks of <= maxLen,
   * breaking on newline or space where possible, without emitting empty chunks
   * and handling leading whitespace safely.
   */
  private splitSingleBlock(text: string, maxLen: number): string[] {
    const result: string[] = [];
    let remaining = text.trim();

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        if (remaining.trim()) {
          result.push(remaining);
        }
        break;
      }

      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx === -1 || splitIdx < maxLen / 2) {
        splitIdx = remaining.lastIndexOf(' ', maxLen);
      }
      if (splitIdx <= 0) {
        splitIdx = maxLen;
      }

      const chunk = remaining.slice(0, splitIdx).trim();
      if (chunk) {
        result.push(chunk);
      }

      remaining = remaining.slice(splitIdx).replace(/^[\r\n\t ]+/, '');
    }

    return result;
  }

  /**
   * Splits message text into chunks of at most maxLen characters (default 950),
   * respecting paragraph boundaries where possible to fit Meta Graph API DM limits.
   */
  public splitMessageIntoChunks(text: string, maxLen = 950): string[] {
    if (!text) return [];
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split('\n\n');
    let current = '';

    const flushCurrent = () => {
      if (!current) return;
      if (current.length <= maxLen) {
        chunks.push(current);
      } else {
        chunks.push(...this.splitSingleBlock(current, maxLen));
      }
      current = '';
    };

    for (const rawPara of paragraphs) {
      const para = rawPara.trim();
      if (!para) continue;

      if (para.length > maxLen) {
        flushCurrent();
        chunks.push(...this.splitSingleBlock(para, maxLen));
        continue;
      }

      if (!current) {
        current = para;
      } else if (current.length + 2 + para.length <= maxLen) {
        current += '\n\n' + para;
      } else {
        flushCurrent();
        current = para;
      }
    }

    flushCurrent();
    return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
  }

  /**
   * Handles incoming webhook event payload from Meta Graph API
   */
  async handleWebhookPayload(body: any): Promise<void> {
    console.log('[MetaIG] 📥 Webhook received body:', JSON.stringify(body, null, 2));

    // Official Meta Graph API Webhook format (handles both 'instagram' and 'page' objects)
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

      // Fetch public metadata (keep arbitrary displayName out of username so placeholders stay clean)
      const meta = await fetchReelMetadata(shortcode);
      const validHandle = extractPublicCreatorUsername({ username: meta.username });
      const username = validHandle || 'Instagram Creator';
      const displayName = meta.displayName || validHandle || username;
      const creatorExternalId = validHandle
        ? `creator_${validHandle}`
        : `creator_unattributed_${shortcode}`;

      // Upsert Creator
      const creator = await Repository.upsertCreator({
        instagram_user_id: creatorExternalId,
        username: username,
        display_name: displayName,
        profile_picture_url: meta.thumbnailUrl || null,
      });

      const creatorLine = formatAddedToWatchLaterCreatorBlock({
        username: creator.username,
        display_name: creator.display_name,
      });

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

    // 1. Mark as watched / stop command
    // Handles single ("watched", "done", "stop") and bulk ("stop all", "watched all", "clear all", "unsub")
    const { isCommand, markAll } = parseWatchedStopCommand(text);
    if (isCommand) {
      const { updatedReels, remainingCount } = await Repository.markWatchedForInstagramSender(senderId, { markAll });
      const reply = formatWatchedConfirmationMessage(updatedReels, remainingCount, markAll);
      await this.sendDirectMessage(senderId, reply);
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
        const reply = formatReminderSetMessage(targetReel, customDuration.label, customDuration.formattedTarget);
        await this.sendDirectMessage(senderId, reply);
      } else {
        await this.sendDirectMessage(
          senderId,
          `⏰ Got it! Duration set to ${customDuration.label} (${customDuration.formattedTarget}). Share any Reel to track it!`
        );
      }
      return;
    }

    // 3. Creator reels search (e.g. "@_docthor_", "who.bhartiiiii", "reels by @_docthor_", "show @_docthor_")
    const creatorQuery = extractCreatorQuery(text);
    if (creatorQuery) {
      const { creator, reels } = await Repository.getReelsByCreatorUsername(creatorQuery);
      const cleanHandle = creatorQuery.replace(/^@/, '').trim();
      const resolvedUsername = creator?.username || cleanHandle;
      const totalCount = reels.length;
      const limit = Math.min(reels.length, 5);
      const searchCopy = formatCreatorSearchMessages({
        username: resolvedUsername,
        displayName: creator?.display_name,
        totalCount,
        limit,
      });

      if (!creator || reels.length === 0) {
        await this.sendDirectMessage(senderId, searchCopy.notFound);
        return;
      }

      // 1. Send header message with clean @mention and clickable profile link
      const headerSent = await this.sendDirectMessage(senderId, searchCopy.header);
      if (!headerSent) {
        console.warn(`[MetaIG] Failed to send creator query header to ${senderId}`);
        return;
      }

      // 2. Send each reel in a separate single message (allows Instagram client to unfurl interactive Reel cards)
      for (let i = 0; i < limit; i++) {
        const r = reels[i];
        await new Promise((resolve) => setTimeout(resolve, 350));
        const reelSent = await this.sendDirectMessage(senderId, `https://www.instagram.com/reel/${r.shortcode}/`);
        if (!reelSent) {
          console.warn(`[MetaIG] Failed to send reel ${r.shortcode} message to ${senderId}`);
          break;
        }
      }

      // 3. Send footer message if additional reels exist in the user's library
      if (reels.length > limit) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await this.sendDirectMessage(senderId, searchCopy.footer);
      }
      return;
    }

    // Default welcome / help reply
    const helpMsg = `👋 Hi! Whenever you see a Reel you want to save or watch later:\n1. Tap Share (airplane icon)\n2. Send it here!\n\nAdd a time like "30m" or "2h" to set custom reminders.\nType any creator's username to view your saved reels!`;
    await this.sendDirectMessage(senderId, helpMsg);
  }
}
