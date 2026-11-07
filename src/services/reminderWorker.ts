import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { InstagramActionClient } from './instagramActionClient.ts';
import type { InboundMessage } from './instagramActionClient.ts';
import { TelegramBotService } from './telegramBotService.ts';
import { MetaInstagramBotService } from './metaInstagramBotService.ts';

export class ReminderWorker {
  private actionClient = new InstagramActionClient();
  private telegramBot: TelegramBotService;
  private metaBot = new MetaInstagramBotService();
  private processedItemIds = new Set<string>();
  private isRunning = false;
  private dmInterval: NodeJS.Timeout | null = null;
  private reminderInterval: NodeJS.Timeout | null = null;
  private adminThreadId: string | null = null;
  private adminUserId: string | null = null;

  constructor(telegramBot?: TelegramBotService) {
    this.telegramBot = telegramBot || new TelegramBotService();
  }

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

    // 2. Loop for dispatching due reminders (every 3 seconds for high-precision seconds/minutes reminders)
    this.checkDueReminders();
    this.reminderInterval = setInterval(() => {
      this.checkDueReminders().catch((err) => console.error('[ReminderWorker] Reminder dispatch error:', err.message));
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
    const dueReels = await Repository.getReelsDueForReminder();
    if (dueReels.length === 0) return;

    const config = loadConfig();
    const intervalHours = config.reminders.defaultIntervalHours;

    console.log(`[ReminderWorker] 🔔 Found ${dueReels.length} Reel(s) due for reminder.`);

    for (const reel of dueReels) {
      // 1. Send via Telegram (Push notification with action buttons!)
      if (this.telegramBot.isConfigured && reel.telegram_chat_id) {
        await this.telegramBot.sendReminder(reel);
      }

      // 2. Send via Official Meta Instagram DM if user saved via Instagram!
      if (reel.instagram_sender_id && this.metaBot.isConfigured) {
        const creatorTag = reel.creator ? `@${reel.creator.username}` : 'Instagram Reel';
        const rawCaption = reel.caption ? reel.caption.slice(0, 70).replace(/\n/g, ' ') : '';
        const captionPreview = rawCaption ? `"${rawCaption}..."\n` : '';
        const reminderText = `🔔 Watch Later Reminder!\n\n🎬 ${creatorTag}\n${captionPreview}👉 ${reel.reel_url}\n\nReply "watched" when done, or reply e.g. "5m" or "snooze 1h" to delay!`;
        console.log(`[ReminderWorker] 🔔 Dispatching Instagram DM reminder to ${reel.instagram_sender_id}...`);
        await this.metaBot.sendDirectMessage(reel.instagram_sender_id, reminderText);
      }

      // Calculate next reminder date:
      // A short interval (< 1 hour, like 5s, 30s, 10m) is a one-time reminder: DO NOT repeat automatically!
      // Setting next_reminder_at to null prevents spamming every 5 seconds.
      // If the user wants another reminder, they can reply e.g. "5m" or "1h" to snooze it.
      const intervalSec = reel.reminder_interval_seconds ?? (reel.reminder_interval_hours ? reel.reminder_interval_hours * 3600 : intervalHours * 3600);
      let nextDate: string | null = null;
      if (intervalSec >= 3600) {
        // For long intervals (>= 1 hour), send a gentle daily reminder (24h later) rather than tight loops
        nextDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      } else {
        // One-time reminder delivered! Stop until explicitly snoozed by the user.
        nextDate = null;
      }

      await Repository.recordReminderSent(reel.id, nextDate);
    }
  }
}
