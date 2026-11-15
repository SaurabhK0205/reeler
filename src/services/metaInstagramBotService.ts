import crypto from 'node:crypto';
import { generateUserVaultKey, getAdminVaultKey, createOtp } from './vaultAuthService.ts';
import { loadConfig } from '../config.ts';
import { Repository, SenderReminderConflictError } from '../db/repository.ts';
import { fetchReelMetadata } from './reelMetadataResolver.ts';
import { parseDuration, formatTargetTime } from '../utils/duration.ts';
import { extractCreatorQueryWithFilter } from '../utils/creatorQuery.ts';
import {
  classifySavedMediaType,
  extractInstagramShortcodeAndPath,
  formatCanonicalInstagramUrl,
  resolveInboundMediaClassification,
} from '../utils/mediaType.ts';
import {
  parseWatchedStopCommand,
  extractPublicCreatorUsername,
  formatAddedToWatchLaterCreatorBlock,
  formatWatchedConfirmationMessage,
  formatReminderSetMessage,
  formatCreatorSearchMessages,
  formatSenderConflictRejectionMessage,
} from '../utils/reelMessages.ts';

/**
 * Options for sending messages via Meta Graph API.
 */
export interface SendDirectMessageOptions {
  /**
   * Optional message tag (e.g. 'HUMAN_AGENT' to message users up to 7 days after their last interaction).
   */
  tag?: 'HUMAN_AGENT';
  /**
   * If true (default), automatically attempts fallback with the HUMAN_AGENT tag
   * when standard delivery fails due to the 24-hour messaging window having elapsed.
   */
  allowHumanAgentFallback?: boolean;
}

/**
 * Determines whether a Meta Graph API response error indicates that the 24-hour
 * standard messaging window has closed for the given recipient.
 * @param {unknown} errorData - The parsed JSON error payload from Meta Graph API.
 * @returns {boolean} True if the error indicates an expired 24-hour messaging window.
 */
export function isMetaMessagingWindowError(errorData: unknown): boolean {
  if (!errorData || typeof errorData !== 'object') return false;
  const errorObj = (errorData as Record<string, unknown>).error;
  if (!errorObj || typeof errorObj !== 'object') return false;

  const code = (errorObj as Record<string, unknown>).code;
  const subcode = (errorObj as Record<string, unknown>).error_subcode;
  const message = (errorObj as Record<string, unknown>).message;

  if (code === 10 && subcode === 2018278) return true;
  if (typeof message === 'string' && /outside.*window|allowed window|24 hour/i.test(message)) {
    return true;
  }
  return false;
}

export class MetaInstagramBotService {
  private accessToken: string;
  private verifyToken: string;
  private appSecret: string;
  public adminUserId: string | null = null;

  constructor(options?: { adminUserId?: string | null }) {
    this.accessToken = process.env.META_PAGE_ACCESS_TOKEN || '';
    this.verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'rea_instagram_saved_token';
    this.appSecret = process.env.META_APP_SECRET || '';
    this.adminUserId =
      options?.adminUserId ||
      process.env.ADMIN_SENDER_ID ||
      process.env.INSTAGRAM_ADMIN_SENDER_ID ||
      null;
  }

  setAdminUserId(adminUserId: string | null): void {
    this.adminUserId = adminUserId;
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
   * Sends a message to a user via Meta Graph API (automatically splits into safe chunks <= 950 chars).
   * Supports HUMAN_AGENT tag and automatic fallback when the standard 24-hour messaging window has elapsed.
   * @param {string} recipientId - The Instagram-scoped ID of the message recipient.
   * @param {string} text - Message text to send.
   * @param {SendDirectMessageOptions} [options] - Optional messaging configuration including tags and fallback behavior.
   * @returns {Promise<boolean>} Resolves to true if all message chunks were delivered successfully.
   */
  async sendDirectMessage(recipientId: string, text: string, options?: SendDirectMessageOptions): Promise<boolean> {
    if (!this.accessToken) {
      console.warn('[MetaIG] No META_PAGE_ACCESS_TOKEN configured. Cannot send DM reply.');
      return false;
    }

    const chunks = this.splitMessageIntoChunks(text, 950);
    let allSuccess = true;
    const initialTag = options?.tag;
    const allowFallback = options?.allowHumanAgentFallback !== false;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${this.accessToken}`;
        const basePayload: Record<string, unknown> = {
          recipient: { id: recipientId },
          message: { text: chunk },
        };
        if (initialTag) {
          basePayload.tag = initialTag;
        }

        let res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(basePayload),
          signal: AbortSignal.timeout(10000),
        });

        let data = (await res.json()) as any;

        // If standard delivery failed because the 24h window closed, attempt fallback with HUMAN_AGENT tag
        if (!res.ok && !initialTag && allowFallback && isMetaMessagingWindowError(data)) {
          console.warn(
            `[MetaIG] 24-hour messaging window closed for ${recipientId}. Attempting fallback with HUMAN_AGENT tag...`
          );
          const fallbackPayload = {
            recipient: { id: recipientId },
            message: { text: chunk },
            tag: 'HUMAN_AGENT',
          };
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fallbackPayload),
            signal: AbortSignal.timeout(10000),
          });
          data = (await res.json()) as any;
          if (res.ok) {
            console.log(
              `[MetaIG] DM delivered to ${recipientId} via HUMAN_AGENT tag: "${chunk.slice(0, 40)}..."`
            );
          } else {
            console.error(
              `[MetaIG] HUMAN_AGENT tag fallback failed (requires Meta App Review approval for the Human Agent feature):`,
              data
            );
          }
        }

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
    console.log('[MetaIG] Webhook received body:', JSON.stringify(body, null, 2));

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
          
          // Check for attachments (e.g. shared Reel clip, ig_reel, share, photo/carousel post)
          let reelUrl: string | null = null;
          let attachmentType: string | null = null;
          if (event.message?.attachments) {
            for (const att of event.message.attachments) {
              if (att.payload?.url) {
                reelUrl = att.payload.url;
                attachmentType = typeof att.type === 'string' ? att.type : null;
                break;
              }
            }
          }

          const combinedText = reelUrl ? `${reelUrl} ${text}`.trim() : text;
          if (combinedText) {
            try {
              await this.processIncomingText(senderId, combinedText, attachmentType);
            } catch (error) {
              console.error(`[MetaIG] Failed to process messaging event for sender ${senderId}:`, error);
            }
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
            let attachmentType: string | null = null;
            if (val.message?.attachments) {
              for (const att of val.message.attachments) {
                if (att.payload?.url) {
                  reelUrl = att.payload.url;
                  attachmentType = typeof att.type === 'string' ? att.type : null;
                  break;
                }
              }
            }
            const combinedText = reelUrl ? `${reelUrl} ${text}`.trim() : text;
            if (combinedText) {
              try {
                await this.processIncomingText(senderId, combinedText, attachmentType);
              } catch (error) {
                console.error(`[MetaIG] Failed to process change event for sender ${senderId}:`, error);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Processes incoming text/link from an Instagram user
   */
  private async processIncomingText(senderId: string, text: string, attachmentType?: string | null): Promise<void> {
    console.log(`[MetaIG] Incoming DM from Instagram user ${senderId}: "${text}"`);

    // Check for Reel or Post URL
    const mediaLink = extractInstagramShortcodeAndPath(text);
    if (mediaLink) {
      const { shortcode, pathType, matchedText } = mediaLink;
      const remaining = text.replace(matchedText, '').trim();
      const customDuration = parseDuration(remaining);

      // Fetch public metadata (probe /p/ first for post links, /reel/ first for reel/tv links)
      const preferredPath = pathType === 'p' ? 'p' : 'reel';
      const [meta, existingItem] = await Promise.all([
        fetchReelMetadata(shortcode, undefined, preferredPath),
        Repository.getSavedItemByShortcode(shortcode),
      ]);

      const { mediaType, canonicalUrl } = resolveInboundMediaClassification({
        shortcode,
        pathType,
        matchedText,
        isClips: meta.isClips,
        mediaKind: meta.mediaKind,
        attachmentType,
        existing: existingItem,
      });

      const activeOwner = String(existingItem?.instagram_sender_id || '').trim();
      if (
        existingItem &&
        existingItem.watch_status === 'watch_later' &&
        activeOwner !== senderId
      ) {
        console.warn(
          `[MetaIG] Rejected Watch Later update for ${shortcode} from sender ${senderId}: active reminder already exists (${activeOwner ? 'another sender' : 'unattributed admin/UI'}).`
        );
        await this.sendDirectMessage(senderId, formatSenderConflictRejectionMessage(mediaType));
        return;
      }

      const validHandle = extractPublicCreatorUsername({ username: meta.username });
      const existingCreator = existingItem?.creator;
      const existingHandle = extractPublicCreatorUsername(existingCreator);

      let creator: NonNullable<typeof existingCreator>;
      if (!validHandle && !meta.displayName && existingCreator) {
        creator = existingCreator;
      } else {
        const resolvedHandle = validHandle || existingHandle;
        const matchesExistingHandle =
          Boolean(resolvedHandle && existingHandle && resolvedHandle.toLowerCase() === existingHandle.toLowerCase());
        const reuseExistingCreatorId = matchesExistingHandle || (!validHandle && Boolean(existingCreator));
        const creatorExternalId = reuseExistingCreatorId
          ? existingCreator!.instagram_user_id
          : resolvedHandle
            ? `creator_${resolvedHandle}`
            : `creator_unattributed_${shortcode}`;

        creator = await Repository.upsertCreator({
          instagram_user_id: creatorExternalId,
          username: resolvedHandle || existingCreator?.username || 'Instagram Creator',
          display_name: meta.displayName || existingCreator?.display_name || resolvedHandle || 'Instagram Creator',
          profile_picture_url: existingCreator?.profile_picture_url || meta.thumbnailUrl || null,
        });
      }

      const instagramMediaId = existingItem?.instagram_media_id || `shortcode_${shortcode}`;
      const caption = meta.caption || existingItem?.caption || null;
      const thumbnailUrl = meta.thumbnailUrl || existingItem?.thumbnail_url || null;
      const nowIso = new Date().toISOString();
      const takenAt = existingItem?.taken_at || nowIso;
      // Preserve native IG membership/save date for existing IG items; new DM shares live under "Sent to Bot" (false, saved_at=null)
      const isSavedOnInstagram = existingItem ? existingItem.is_saved_on_instagram !== false : false;
      const savedAt = existingItem ? (existingItem.saved_at ?? null) : null;
      const firstDetectedAt = existingItem?.first_detected_at || nowIso;
      const saveOrderRank = existingItem?.save_order_rank ?? 1;

      const creatorLine = formatAddedToWatchLaterCreatorBlock({
        username: creator.username,
        display_name: creator.display_name,
      });

      const addedHeading = mediaType === 'post' ? '🖼️ Added post to your Watch Later!' : '🎬 Added to your Watch Later!';

      const nextReminder = customDuration ? customDuration.targetDate.toISOString() : null;
      const awaitingUntil = customDuration ? null : new Date(Date.now() + 10 * 60 * 1000).toISOString();

      try {
        await Repository.upsertSavedReel({
          instagram_media_id: instagramMediaId,
          shortcode,
          reel_url: canonicalUrl,
          media_type: mediaType,
          creator_id: creator.id,
          caption,
          thumbnail_url: thumbnailUrl,
          taken_at: takenAt,
          saved_at: savedAt,
          first_detected_at: firstDetectedAt,
          save_order_rank: saveOrderRank,
          watch_status: 'watch_later',
          reminder_interval_seconds: customDuration ? customDuration.seconds : null,
          next_reminder_at: nextReminder,
          awaiting_reminder_choice_until: awaitingUntil,
          is_saved_on_instagram: isSavedOnInstagram,
          instagram_sender_id: senderId,
        });
      } catch (error) {
        if (error instanceof SenderReminderConflictError) {
          console.warn(
            `[MetaIG] Concurrent Watch Later conflict for ${shortcode} from sender ${senderId}; existing reminder preserved.`
          );
          await this.sendDirectMessage(senderId, formatSenderConflictRejectionMessage(mediaType));
          return;
        }
        throw error;
      }

      if (customDuration) {
        // User provided a specific time along with the item!
        const reply = `${addedHeading}${creatorLine}\n\n⏰ Reminder set for: ${customDuration.label} (${customDuration.formattedTarget})\n\nReply "watched" when done!`;
        await this.sendDirectMessage(senderId, reply);
      } else {
        // No time provided — wait up to 10 minutes for user choice before defaulting to 10 hours
        const defaultTriggerDate = new Date(Date.now() + (10 * 60 + 10 * 3600) * 1000);
        const defaultTriggerStr = formatTargetTime(defaultTriggerDate);
        const promptQuestion = mediaType === 'post'
          ? '⏰ When should I remind you to view this?'
          : '⏰ When should I remind you to watch this?';

        const reply = `${addedHeading}${creatorLine}\n\n${promptQuestion}\nReply with a time (e.g. "30m", "2h", "tomorrow at 5pm", or "remind me in 5 days").\n\n⏳ If you don't reply within 10 mins, I'll automatically set a reminder for 10 hours from now (${defaultTriggerStr})!`;
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

    // 1b. User data deletion command (e.g. "delete my data", "delete account", "purge data", "erase my data")
    const normalizedText = text.trim().toLowerCase();
    if (['delete my data', 'delete account', 'purge data', 'purge my data', 'erase my data', 'delete all my data'].includes(normalizedText)) {
      const deletedCount = await Repository.deleteUserDataForSender(senderId);
      const reply =
        `🗑️ Your data deletion request has been processed.\n\n` +
        `Permanently removed ${deletedCount} saved item(s) and cleared your user records from our systems.`;
      await this.sendDirectMessage(senderId, reply);
      return;
    }

    // 2. Personal Vault / Web library link request (e.g. "vault", "library", "web", "dashboard", "link")
    if (['vault', 'library', 'web', 'dashboard', 'link', 'my vault'].includes(normalizedText)) {
      const isSenderAdmin = Boolean(this.adminUserId && senderId === this.adminUserId);
      const userKey = isSenderAdmin ? getAdminVaultKey() : generateUserVaultKey(senderId);
      const baseUrl = process.env.APP_URL || process.env.PUBLIC_URL || 'https://reeler-bot.fly.dev';
      const vaultUrl = `${baseUrl.replace(/\/+$/, '')}/?key=${userKey}`;

      const reply =
        `🎬 Your Personal Vault Link:\n${vaultUrl}\n\n` +
        `Tap to view your saved items in your browser. No login or password required!\n\n` +
        `Tip: If opening on a PC or laptop, you can also message "code" to get a 6-digit login code.\n\n` +
        `Note: The web library is an optional companion—you can manage reminders and searches entirely here in DMs.`;
      await this.sendDirectMessage(senderId, reply);
      return;
    }

    // 2b. 6-Digit Login Code request for PC / Laptop browser vault access (e.g. "code", "otp", "login")
    if (['code', 'otp', 'login', 'login code', 'get code', 'passcode'].includes(normalizedText)) {
      const isSenderAdmin = Boolean(this.adminUserId && senderId === this.adminUserId);
      const session = isSenderAdmin ? { role: 'admin' as const } : { role: 'user' as const, senderId };
      const otpCode = createOtp(session);

      const reply =
        `🔐 Your Reeler Login Code:\n${otpCode}\n\n` +
        `Enter this 6-digit code on your PC or laptop browser to unlock your private vault (valid for 10 minutes).`;
      await this.sendDirectMessage(senderId, reply);
      return;
    }

    // 3. Custom duration command (e.g. "5s", "remind me in 5 days", "tomorrow at 5pm", "12 nov", etc.)
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
          `⏰ Got it! Duration set to ${customDuration.label} (${customDuration.formattedTarget}). Share any Reel or Post to track it!`
        );
      }
      return;
    }

    // 3. Creator reels & posts search (e.g. "@_docthor_", "reels by @_docthor_", "posts by @the_political_compass")
    const creatorQuery = extractCreatorQueryWithFilter(text);
    if (creatorQuery) {
      const { creator, reels, totalReelsCount, totalPostsCount } = await Repository.getReelsByCreatorUsername(
        creatorQuery.username,
        { mediaType: creatorQuery.mediaFilter }
      );
      const cleanHandle = creatorQuery.username.replace(/^@/, '').trim();
      const resolvedUsername = creator?.username || cleanHandle;

      const reelItems = reels.filter(
        (r) => classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }) === 'reel'
      );
      const postItems = reels.filter(
        (r) => classifySavedMediaType({ mediaType: r.media_type, reelUrl: r.reel_url }) === 'post'
      );

      const isMixed = creatorQuery.mediaFilter === 'all' && totalReelsCount > 0 && totalPostsCount > 0;
      const reelsToSend = isMixed
        ? reelItems.slice(0, 3)
        : creatorQuery.mediaFilter === 'post'
          ? []
          : reelItems.slice(0, 5);
      const postsToSend = isMixed
        ? postItems.slice(0, 3)
        : creatorQuery.mediaFilter === 'reel'
          ? []
          : postItems.slice(0, 5);

      const searchCopy = formatCreatorSearchMessages({
        username: resolvedUsername,
        displayName: creator?.display_name,
        totalReelsCount,
        totalPostsCount,
        shownReelsCount: reelsToSend.length,
        shownPostsCount: postsToSend.length,
        mediaFilter: creatorQuery.mediaFilter,
      });

      if (!creator || (reelsToSend.length === 0 && postsToSend.length === 0)) {
        await this.sendDirectMessage(senderId, searchCopy.notFound);
        return;
      }

      // 1. Send header message with clean @mention and clickable profile link
      const headerSent = await this.sendDirectMessage(senderId, searchCopy.header);
      if (!headerSent) {
        console.warn(`[MetaIG] Failed to send creator query header to ${senderId}`);
        return;
      }

      const sendItemsBatch = async (
        items: typeof reels,
        sectionHeader: string | null
      ): Promise<boolean> => {
        if (items.length === 0) return true;
        if (sectionHeader) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          const sectionSent = await this.sendDirectMessage(senderId, sectionHeader);
          if (!sectionSent) {
            console.warn(`[MetaIG] Failed to send section header to ${senderId}`);
            return false;
          }
        }
        for (const r of items) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          const canonicalItemUrl = formatCanonicalInstagramUrl(r.shortcode, r.media_type, r.reel_url);
          const itemSent = await this.sendDirectMessage(senderId, canonicalItemUrl);
          if (!itemSent) {
            console.warn(`[MetaIG] Failed to send item ${r.shortcode} message to ${senderId}`);
            return false;
          }
        }
        return true;
      };

      const reelsOk = await sendItemsBatch(reelsToSend, searchCopy.reelsSectionHeader);
      if (!reelsOk) return;

      const postsOk = await sendItemsBatch(postsToSend, searchCopy.postsSectionHeader);
      if (!postsOk) return;

      // 3. Send footer message if additional items exist in the user's library
      if (searchCopy.footer) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await this.sendDirectMessage(senderId, searchCopy.footer);
      }
      return;
    }

    // Default welcome / help reply
    const helpMsg = `👋 Hi! Whenever you see a Reel or Post you want to track or watch later:\n1. Tap Share (airplane icon)\n2. Send it here!\n\nAdd a time like "30m" or "2h" to set custom reminders.\nType any creator's username (or "reels by @name" / "posts by @name") to view your tracked items!\nType "vault" to browse your saved items on the web, or "code" to get a 6-digit login code for your laptop.`;
    await this.sendDirectMessage(senderId, helpMsg);
  }
}
