import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { InstagramActionClient } from './instagramActionClient.ts';
import type { InboundMessage } from './instagramActionClient.ts';
import { MetaInstagramBotService } from './metaInstagramBotService.ts';
import { formatTargetTime } from '../utils/duration.ts';

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

    // Case 1: Reel was shared!
    if (msg.reel) {
      const { mediaId, shortcode, authorUsername, caption, thumbnailUrl } = msg.reel;
      console.log(`[ReminderWorker] 🎬 Detected shared Reel from admin: ${shortcode} (Media ID: ${mediaId})`);

      // 1. Save to native Instagram Saved collection
      let savedOnIg = false;
      if (mediaId) {
        const saveRes = await this.actionClient.saveMedia(mediaId);
        savedOnIg = saveRes.success && saveRes.data;
        if (savedOnIg) {
          console.log(`[ReminderWorker] ✅ Saved Reel ${mediaId} natively on Instagram!`);
        }
      }

      // 2. Upsert creator
      const creatorUsername = authorUsername || 'instagram_user';
      const creator = await Repository.upsertCreator({
        instagram_user_id: creatorUsername,
        username: creatorUsername,
        display_name: creatorUsername,
      });

      // 3. Upsert reel into Supabase with watch_status = 'watch_later'
      const nextReminderDate = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
      await Repository.upsertSavedReel({
        instagram_media_id: mediaId || `id_${shortcode}`,
        shortcode,
        reel_url: `https://www.instagram.com/reel/${shortcode}/`,
        creator_id: creator.id,
        caption: caption || null,
        thumbnail_url: thumbnailUrl || null,
        taken_at: new Date().toISOString(),
        saved_at: new Date().toISOString(),
        first_detected_at: new Date().toISOString(),
        save_order_rank: 1,
        watch_status: 'watch_later',
        reminder_interval_hours: intervalHours,
        next_reminder_at: nextReminderDate,
        is_saved_on_instagram: savedOnIg,
      });

      // 4. Send immediate confirmation DM to admin
      if (this.adminUserId) {
        const confirmText = `🎬 Saved to Watch Later & bookmarked to your Instagram Saved!\n\nI will remind you about this in ${intervalHours} hours ⏰\n(Reply "done" when you've watched it)`;
        await this.actionClient.sendDirectMessage(this.adminUserId, confirmText);
      }
      return;
    }

    // Case 2: Text command (e.g. "done", "watched", "remind in 5h")
    if (msg.text) {
      const lower = msg.text.toLowerCase().trim();
      const isWatched = /\b(watched|watch|done|seen|finish|finished|stop|cancel|halt)\b/i.test(lower);
      if (isWatched) {
        const updated = await Repository.markWatchedForInstagramSender(this.adminUserId || '');
        if (updated.length > 0 && this.adminUserId) {
          await this.actionClient.sendDirectMessage(this.adminUserId, `✅ Marked "${updated[0].shortcode}" as watched! Reminders stopped.`);
        } else if (this.adminUserId) {
          await this.actionClient.sendDirectMessage(this.adminUserId, `👍 All set! No pending watch-later reminders right now.`);
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
      const dueReels = await Repository.getReelsDueForReminder();
      if (dueReels.length === 0) return;

      const config = loadConfig();
      const intervalHours = config.reminders.defaultIntervalHours;

      console.log(`[ReminderWorker] 🔔 Found ${dueReels.length} Reel(s) due for reminder.`);

      for (const reel of dueReels) {
        const creatorTag =
          reel.creator && reel.creator.username && reel.creator.username !== 'instagram_creator'
            ? `@${reel.creator.username}`
            : (reel.creator?.display_name && reel.creator.display_name !== 'instagram_creator' ? reel.creator.display_name : 'Instagram Reel');
        const rawCaption = reel.caption ? reel.caption.slice(0, 70).replace(/\n/g, ' ') : '';
        const captionPreview = rawCaption ? `"${rawCaption}..."\n` : '';
        const reminderText = `🔔 Watch Later Reminder!\n\n🎬 ${creatorTag}\n${captionPreview}👉 ${reel.reel_url}\n\nReply "watched" when done, or reply e.g. "5m" or "snooze 1h" to delay!`;

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

      const creatorTag =
        reel.creator && reel.creator.username && reel.creator.username !== 'instagram_creator'
          ? `@${reel.creator.username}`
          : (reel.creator?.display_name && reel.creator.display_name !== 'instagram_creator' ? reel.creator.display_name : 'your reel');
      const defaultNotice = `⏰ No reminder time received for ${creatorTag} — I've scheduled your reminder for ${defaultHours} hours from now (${targetStr}).\n\nReply e.g. "2h" or "tomorrow 5pm" anytime to change it, or "watched" when done!`;

      console.log(`[ReminderWorker] ⏰ 10-minute wait expired for reel ${reel.shortcode}. Set default ${defaultHours}h reminder (${targetStr}).`);

      if (reel.instagram_sender_id && this.metaBot.isConfigured) {
        await this.metaBot.sendDirectMessage(reel.instagram_sender_id, defaultNotice);
      }
    }
  }
}
