import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { InstagramActionClient } from './instagramActionClient.ts';
import type { InboundMessage } from './instagramActionClient.ts';

export class ReminderWorker {
  private actionClient = new InstagramActionClient();
  private processedItemIds = new Set<string>();
  private isRunning = false;
  private dmInterval: NodeJS.Timeout | null = null;
  private reminderInterval: NodeJS.Timeout | null = null;
  private adminThreadId: string | null = null;
  private adminUserId: string | null = null;

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

    // 2. Loop for dispatching due reminders
    this.checkDueReminders();
    this.reminderInterval = setInterval(() => {
      this.checkDueReminders().catch((err) => console.error('[ReminderWorker] Reminder dispatch error:', err.message));
    }, config.reminders.reminderCheckIntervalMs);
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
      if (lower === 'done' || lower === 'watched') {
        // Mark the most recent watch_later reel as watched
        const dueReels = await Repository.getReelsDueForReminder();
        if (dueReels.length > 0) {
          await Repository.updateWatchStatus(dueReels[0].id, 'watched');
          if (this.adminUserId) {
            await this.actionClient.sendDirectMessage(this.adminUserId, `✅ Marked "${dueReels[0].shortcode}" as watched! Reminders stopped.`);
          }
        } else {
          if (this.adminUserId) {
            await this.actionClient.sendDirectMessage(this.adminUserId, `👍 All set! No pending watch-later reminders right now.`);
          }
        }
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
      if (!this.adminUserId) {
        if (!config.instagram.adminUsername) break;
        const threadRes = await this.actionClient.findAdminThread(config.instagram.adminUsername);
        if (threadRes.success && threadRes.data) {
          this.adminUserId = threadRes.data.adminUserId;
        } else {
          break;
        }
      }

      const creatorTag = reel.creator ? `@${reel.creator.username}` : 'Instagram Reel';
      const captionPreview = reel.caption ? `"${reel.caption.slice(0, 70).replace(/\n/g, ' ')}..."\n` : '';
      const reminderText = `🔔 Watch Later Reminder:\n${creatorTag}: ${captionPreview}👉 ${reel.reel_url}\n\n(Reply "done" to mark as watched)`;

      console.log(`[ReminderWorker] Sending reminder for ${reel.shortcode} to admin...`);
      const sendRes = await this.actionClient.sendDirectMessage(this.adminUserId, reminderText);

      if (sendRes.success) {
        // Schedule next reminder in intervalHours
        const nextDate = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
        await Repository.recordReminderSent(reel.id, nextDate);
      }
    }
  }
}
