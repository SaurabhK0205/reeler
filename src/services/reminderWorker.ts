import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { InstagramActionClient } from './instagramActionClient.ts';
import type { InboundMessage } from './instagramActionClient.ts';
import { MetaInstagramBotService } from './metaInstagramBotService.ts';
import { formatTargetTime } from '../utils/duration.ts';
import { classifySavedMediaType, formatCanonicalInstagramUrl } from '../utils/mediaType.ts';
import {
  parseWatchedStopCommand,
  formatAddedToWatchLaterCreatorBlock,
  formatWatchedConfirmationMessage,
  formatWatchLaterReminderMessage,
  formatDefaultReminderNotice,
} from '../utils/reelMessages.ts';

export class ReminderWorker {
  private actionClient = new InstagramActionClient();
  private metaBot = new MetaInstagramBotService();
  private processedItemIds = new Set<string>();
  private isRunning = false;
  private dmInterval: NodeJS.Timeout | null = null;
  private reminderInterval: NodeJS.Timeout | null = null;
  private adminThreadId: string | null = null;
  private adminUserId: string | null = null;
  private isDispatching = false;
  private failedReelSuppression = new Map<string, number>();

  /**
   * Starts the background DM polling and reminder dispatch loops.
   */
  start() {
    const config = loadConfig();
    if (!config.instagram.isConfigured) {
      console.log('[ReminderWorker] Instagram credentials not configured. Inbound DM and reminder worker idle.');
      return;
    }

    if (!config.instagram.adminUsername) {
      console.log('[ReminderWorker] ADMIN_USERNAME not set in .env. DM listener will not know who to listen to.');
      return;
    }

    this.isRunning = true;
    console.log(`[ReminderWorker] Starting DM listener & reminder scheduler for @${config.instagram.adminUsername}...`);

    // 1. Initial check & loop for inbound DMs
    this.pollInboundDMs();
    this.dmInterval = setInterval(() => {
      this.pollInboundDMs().catch((err) => console.error('[ReminderWorker] DM poll error:', err.message));
    }, config.reminders.dmPollingIntervalMs);

    // 2. Loop for dispatching due reminders and checking 10-minute awaiting choice windows
    this.checkDueReminders();
    this.checkAwaitingChoices();
    this.reminderInterval = setInterval(() => {
      this.checkDueReminders().catch((err) => console.error('[ReminderWorker] Reminder dispatch error:', err.message));
      this.checkAwaitingChoices().catch((err) => console.error('[ReminderWorker] Choice check error:', err.message));
    }, 3000);
  }

  /**
   * Stops background polling and interval timers cleanly.
   */
  stop() {
    this.isRunning = false;
    if (this.dmInterval) clearInterval(this.dmInterval);
    if (this.reminderInterval) clearInterval(this.reminderInterval);
    console.log('[ReminderWorker] Stopped.');
  }

  /**
   * Polls the admin DM thread to process shared Reels and commands.
   */
  async pollInboundDMs() {
    const config = loadConfig();
    const adminUsername = config.instagram.adminUsername;
    if (!adminUsername) return;

    // Locate admin thread if not cached
    if (!this.adminThreadId || !this.adminUserId) {
      const threadRes = await this.actionClient.findAdminThread(adminUsername);
      if (!threadRes.success || !threadRes.data) {
        return; // No thread yet with admin
      }
      this.adminThreadId = threadRes.data.threadId;
      this.adminUserId = threadRes.data.adminUserId;
      console.log(`[ReminderWorker] Connected to Admin DM thread: ${this.adminThreadId} (Admin User ID: ${this.adminUserId})`);
    }

    const messagesRes = await this.actionClient.getThreadMessages(this.adminThreadId);
    if (!messagesRes.success) return;

    const messages = messagesRes.data;
    // Process messages from admin only (newest items first)
    for (const msg of messages) {
      if (this.processedItemIds.has(msg.itemId)) continue;
      this.processedItemIds.add(msg.itemId);

      // Only handle incoming messages from the admin (not bot's own replies)
      if (msg.userId === config.instagram.userId) continue;

      await this.handleAdminMessage(msg);
    }
  }

  /**
   * Handles an individual inbound message from the admin.
   */
  private async handleAdminMessage(msg: InboundMessage) {
    const config = loadConfig();
    const intervalHours = config.reminders.defaultIntervalHours;

    // Case 1: Reel or Post was shared!
    if (msg.reel) {
      const { mediaId, shortcode, authorUsername, caption, thumbnailUrl, mediaType, reelUrl } = msg.reel;
      const existingItem = !mediaId && shortcode ? await Repository.getSavedItemByShortcode(shortcode) : null;
      const isTextFallbackReel = !mediaId && mediaType === 'reel' && !/\/p\//i.test(reelUrl || '');
      const resolvedMediaType =
        isTextFallbackReel && existingItem
          ? classifySavedMediaType({ mediaType: existingItem.media_type, reelUrl: existingItem.reel_url })
          : classifySavedMediaType({ mediaType, reelUrl });
      const canonicalUrl =
        isTextFallbackReel && existingItem
          ? formatCanonicalInstagramUrl(shortcode, resolvedMediaType, existingItem.reel_url)
          : formatCanonicalInstagramUrl(shortcode, resolvedMediaType, reelUrl);
      console.log(`[ReminderWorker] ${resolvedMediaType === 'post' ? '🖼️' : '🎬'} Detected shared ${resolvedMediaType} from admin: ${shortcode} (Media ID: ${mediaId})`);

      // 1. Save to native Instagram Saved collection
      let savedOnIg = false;
      if (mediaId) {
        const saveRes = await this.actionClient.saveMedia(mediaId);
        savedOnIg = saveRes.success && saveRes.data;
        if (savedOnIg) {
          console.log(`[ReminderWorker] ✅ Saved ${resolvedMediaType} ${mediaId} natively on Instagram!`);
        }
      }

      // 2. Upsert creator
      const creatorUsername = authorUsername || existingItem?.creator?.username || 'instagram_user';
      const creator = await Repository.upsertCreator({
        instagram_user_id: existingItem?.creator?.instagram_user_id || creatorUsername,
        username: creatorUsername,
        display_name: existingItem?.creator?.display_name || creatorUsername,
      });

      // 3. Upsert item into Supabase with watch_status = 'watch_later'
      const nextReminderDate = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
      await Repository.upsertSavedReel({
        instagram_media_id: existingItem?.instagram_media_id || mediaId || `id_${shortcode}`,
        shortcode,
        reel_url: canonicalUrl,
        media_type: resolvedMediaType,
        creator_id: creator.id,
        caption: caption || existingItem?.caption || null,
        thumbnail_url: thumbnailUrl || existingItem?.thumbnail_url || null,
        taken_at: existingItem?.taken_at || new Date().toISOString(),
        saved_at: existingItem?.saved_at || new Date().toISOString(),
        first_detected_at: existingItem?.first_detected_at || new Date().toISOString(),
        save_order_rank: existingItem?.save_order_rank ?? 1,
        watch_status: 'watch_later',
        reminder_interval_hours: intervalHours,
        next_reminder_at: nextReminderDate,
        is_saved_on_instagram: savedOnIg,
      });

      // 4. Send immediate confirmation DM to admin
      if (this.adminUserId) {
        const creatorLine = formatAddedToWatchLaterCreatorBlock(creator);
        const itemHeading =
          resolvedMediaType === 'post'
            ? '🖼️ Post saved to Watch Later & bookmarked to your Instagram Saved!'
            : '🎬 Saved to Watch Later & bookmarked to your Instagram Saved!';
        const confirmText = `${itemHeading}${creatorLine}\n\nI will remind you about this in ${intervalHours} hours ⏰\n(Reply "done" when you've watched it)`;
        await this.actionClient.sendDirectMessage(this.adminUserId, confirmText);
      }
      return;
    }

    // Case 2: Text command (e.g. "done", "watched", "stop all")
    if (msg.text) {
      const { isCommand, markAll } = parseWatchedStopCommand(msg.text);
      if (isCommand) {
        const { updatedReels, remainingCount } = await Repository.markWatchedForInstagramSender(
          this.adminUserId || '',
          { markAll, includeUnattributedFallback: true }
        );
        if (this.adminUserId) {
          const reply = formatWatchedConfirmationMessage(updatedReels, remainingCount, markAll);
          await this.actionClient.sendDirectMessage(this.adminUserId, reply);
        }
        return;
      }
    }
  }

  /**
   * Dispatches reminders for any Reels that are due.
   */
  async checkDueReminders() {
    if (this.isDispatching) {
      console.log('[ReminderWorker] Reminder dispatch already in progress, skipping tick.');
      return;
    }
    this.isDispatching = true;

    try {
      const allDueReels = await Repository.getReelsDueForReminder();
      if (allDueReels.length === 0) return;

      const now = Date.now();
      // Clean up expired entries in the suppression map
      for (const [id, expireTime] of this.failedReelSuppression.entries()) {
        if (now >= expireTime) {
          this.failedReelSuppression.delete(id);
        }
      }

      // Filter out temporarily suppressed reels whose persistence failed
      const eligibleReels = allDueReels.filter((r) => !this.failedReelSuppression.has(r.id));
      if (eligibleReels.length === 0) return;

      // Limit batch size per dispatch tick to avoid unbounded execution latency
      const BATCH_LIMIT = 10;
      const dueReels = eligibleReels.slice(0, BATCH_LIMIT);

      const config = loadConfig();
      const intervalHours = config.reminders.defaultIntervalHours;

      console.log(`[ReminderWorker] 🔔 Found ${allDueReels.length} Reel(s) due for reminder (dispatching batch of ${dueReels.length}).`);

      for (const reel of dueReels) {
        const reminderText = formatWatchLaterReminderMessage(reel);

        let delivered = false;

        try {
          if (reel.instagram_sender_id && this.metaBot.isConfigured) {
            console.log(`[ReminderWorker] 🔔 Dispatching Instagram DM reminder to ${reel.instagram_sender_id}...`);
            delivered = await this.metaBot.sendDirectMessage(reel.instagram_sender_id, reminderText);
          } else if (!reel.instagram_sender_id && this.adminUserId && config.instagram.isConfigured) {
            // Supported delivery fallback for legacy or unattributed sender reels
            console.log(`[ReminderWorker] 🔔 Dispatching fallback reminder to admin (${this.adminUserId})...`);
            const sendResult = await this.actionClient.sendDirectMessage(this.adminUserId, reminderText);
            delivered = sendResult.success && sendResult.data === true;
          } else {
            console.warn(`[ReminderWorker] ⚠️ No active delivery channel or recipient found for reel ${reel.shortcode}.`);
          }
        } catch (err: any) {
          console.error(`[ReminderWorker] Delivery error for reel ${reel.shortcode}:`, err.message || err);
          delivered = false;
        }

        if (delivered) {
          // Calculate next reminder date only after confirmed delivery:
          // Short intervals (< 1 hour) are one-time reminders (next_reminder_at = null)
          // Longer intervals (>= 1 hour) repeat with a gentle 24-hour cadence
          const intervalSec = reel.reminder_interval_seconds ?? (reel.reminder_interval_hours ? reel.reminder_interval_hours * 3600 : intervalHours * 3600);
          let nextDate: string | null = null;
          if (intervalSec >= 3600) {
            nextDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
          } else {
            nextDate = null;
          }

          try {
            await Repository.recordReminderSent(reel.id, nextDate);
          } catch (err: any) {
            console.error(`[ReminderWorker] Failed to record reminder for reel ${reel.shortcode}:`, err.message || err);
            // Suppress repeated sending in memory for 5 minutes if DB recording fails
            if (this.failedReelSuppression.size >= 1000) {
              const firstKey = this.failedReelSuppression.keys().next().value;
              if (firstKey) this.failedReelSuppression.delete(firstKey);
            }
            this.failedReelSuppression.set(reel.id, Date.now() + 5 * 60 * 1000);

            // Attempt fallback backoff in DB to prevent immediate resends on next run
            try {
              await Repository.updateReminderSchedule(reel.id, new Date(Date.now() + 5 * 60 * 1000).toISOString());
            } catch (fallbackErr: any) {
              console.error(`[ReminderWorker] Fallback backoff failed for reel ${reel.shortcode}:`, fallbackErr.message || fallbackErr);
            }
          }
        } else {
          // On delivery failure, retain reminder and back off 5 minutes before retrying
          const retryDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          console.warn(`[ReminderWorker] Delivery for reel ${reel.shortcode} failed. Backing off until ${retryDate}.`);
          try {
            await Repository.updateReminderSchedule(reel.id, retryDate);
          } catch (err: any) {
            console.error(`[ReminderWorker] Failed to schedule retry for reel ${reel.shortcode}:`, err.message || err);
          }
        }
      }
    } finally {
      this.isDispatching = false;
    }
  }

  /**
   * Checks for reels whose 10-minute wait window for user reminder input has elapsed.
   * If the user didn't specify a time within 10 minutes, automatically sets a default 10-hour reminder
   * and notifies the user with the exact trigger time!
   */
  async checkAwaitingChoices() {
    const expiredReels = await Repository.getReelsAwaitingChoiceDue();
    if (expiredReels.length === 0) return;

    const config = loadConfig();
    const defaultHours = config.reminders.defaultIntervalHours || 10;

    for (const reel of expiredReels) {
      const { targetTime } = await Repository.activateDefaultReminder(reel.id, defaultHours);
      const targetStr = formatTargetTime(targetTime);

      const defaultNotice = formatDefaultReminderNotice(reel, defaultHours, targetStr);

      console.log(`[ReminderWorker] ⏰ 10-minute wait expired for reel ${reel.shortcode}. Set default ${defaultHours}h reminder (${targetStr}).`);

      if (reel.instagram_sender_id && this.metaBot.isConfigured) {
        await this.metaBot.sendDirectMessage(reel.instagram_sender_id, defaultNotice);
      }
    }
  }
}
