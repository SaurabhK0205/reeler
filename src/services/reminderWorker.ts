import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { InstagramActionClient } from './instagramActionClient.ts';
import type { InboundMessage } from './instagramActionClient.ts';
import { MetaInstagramBotService } from './metaInstagramBotService.ts';
import { formatTargetTime } from '../utils/duration.ts';
import { classifySavedMediaType, formatCanonicalInstagramUrl } from '../utils/mediaType.ts';
import {
  parseWatchedStopCommand,
  parseCancelCommand,
  formatHumanReelLabel,
  formatAddedToWatchLaterCreatorBlock,
  formatWatchedConfirmationMessage,
  formatWatchLaterReminderMessage,
  formatDefaultReminderNotice,
} from '../utils/reelMessages.ts';

export class ReminderWorker {
  private static readonly MAX_ITEM_ATTEMPTS = 3;
  private static readonly MAX_TRACKED_ITEM_IDS = 1000;
  private actionClient = new InstagramActionClient();
  private metaBot = new MetaInstagramBotService();
  private processedItemIds = new Set<string>();
  private failedItemAttempts = new Map<string, number>();
  private isRunning = false;
  private dmInterval: NodeJS.Timeout | null = null;
  private reminderInterval: NodeJS.Timeout | null = null;
  private adminThreadId: string | null = null;
  private adminUserId: string | null = null;
  private isDispatching = false;
  private isCheckingChoices = false;
  private isPollingInboundDMs = false;
  private pendingAdminConfirmationReplies: string[] = [];
  private failedReelSuppression = new Map<string, number>();
  private deliveredPersistenceCheckpoints = new Map<
    string,
    {
      reelId: string;
      nextDate: string | null;
      expectedNextReminderAt: string | null;
      deliveryTimestamp: number;
      attempts: number;
      nextRetryAt: number;
    }
  >();

  private setDeliveredPersistenceCheckpoint(
    key: string,
    checkpoint: {
      reelId: string;
      nextDate: string | null;
      expectedNextReminderAt: string | null;
      deliveryTimestamp?: number;
      attempts?: number;
      nextRetryAt?: number;
    }
  ) {
    if (this.deliveredPersistenceCheckpoints.size >= 1000) {
      const oldest = this.deliveredPersistenceCheckpoints.keys().next().value;
      if (oldest) this.deliveredPersistenceCheckpoints.delete(oldest);
    }
    this.deliveredPersistenceCheckpoints.set(key, {
      ...checkpoint,
      deliveryTimestamp: checkpoint.deliveryTimestamp ?? Date.now(),
      attempts: checkpoint.attempts ?? 0,
      nextRetryAt: checkpoint.nextRetryAt ?? Date.now(),
    });
  }

  private markItemProcessed(itemId: string) {
    if (!itemId) return;
    if (this.processedItemIds.has(itemId)) {
      this.processedItemIds.delete(itemId);
    } else if (this.processedItemIds.size >= ReminderWorker.MAX_TRACKED_ITEM_IDS) {
      const oldest = this.processedItemIds.values().next().value;
      if (oldest) this.processedItemIds.delete(oldest);
    }
    this.processedItemIds.add(itemId);
  }

  private setFailedItemAttempts(itemId: string, attempts: number) {
    if (!itemId) return;
    if (this.failedItemAttempts.has(itemId)) {
      this.failedItemAttempts.delete(itemId);
    } else if (this.failedItemAttempts.size >= ReminderWorker.MAX_TRACKED_ITEM_IDS) {
      const oldest = this.failedItemAttempts.keys().next().value;
      if (oldest) this.failedItemAttempts.delete(oldest);
    }
    this.failedItemAttempts.set(itemId, attempts);
  }

  /**
   * Starts the background DM polling and reminder dispatch loops.
   */
  start() {
    const config = loadConfig();
    const hasScraperAuth = config.instagram.isConfigured && Boolean(config.instagram.adminUsername);
    const hasMetaBotAuth = this.metaBot.isConfigured;

    if (!hasScraperAuth && !hasMetaBotAuth) {
      console.log('[ReminderWorker] Neither Instagram credentials nor Meta Bot credentials configured. Inbound DM and reminder worker idle.');
      return;
    }

    this.isRunning = true;

    // 1. Initial check & loop for inbound DMs (legacy scraper only)
    if (hasScraperAuth) {
      console.log(`[ReminderWorker] Starting DM listener for @${config.instagram.adminUsername}...`);
      this.pollInboundDMs();
      this.dmInterval = setInterval(() => {
        this.pollInboundDMs().catch((err) => console.error('[ReminderWorker] DM poll error:', err.message));
      }, config.reminders.dmPollingIntervalMs);
    } else {
      console.log('[ReminderWorker] Legacy DM scraper not configured. Relying on Meta Webhooks for inbound messages.');
    }

    // 2. Loop for dispatching due reminders and checking 10-minute awaiting choice windows
    console.log('[ReminderWorker] Starting reminder dispatcher and choice scheduler...');
    this.checkDueReminders().catch((err) => console.error('[ReminderWorker] Reminder dispatch error:', err.message));
    this.checkAwaitingChoices().catch((err) => console.error('[ReminderWorker] Choice check error:', err.message));
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
    if (this.isPollingInboundDMs) return;
    this.isPollingInboundDMs = true;
    try {
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

      // Flush pending confirmation replies from prior transient DM failures
      if (this.pendingAdminConfirmationReplies.length > 0 && this.adminUserId) {
        const remaining: string[] = [];
        for (const pendingReply of this.pendingAdminConfirmationReplies) {
          const res = await this.actionClient.sendDirectMessage(this.adminUserId, pendingReply);
          if (!res.success) remaining.push(pendingReply);
        }
        this.pendingAdminConfirmationReplies = remaining;
      }

      const messagesRes = await this.actionClient.getThreadMessages(this.adminThreadId);
      if (!messagesRes.success) return;

      const messages = messagesRes.data;
      const activeIds = new Set(messages.map((m) => m.itemId).filter(Boolean));
      for (const id of this.processedItemIds) {
        if (!activeIds.has(id)) {
          this.processedItemIds.delete(id);
        }
      }
      for (const id of this.failedItemAttempts.keys()) {
        if (!activeIds.has(id)) {
          this.failedItemAttempts.delete(id);
        }
      }

      // Process messages from admin only (newest items first)
      for (const msg of messages) {
        if (!msg.itemId || this.processedItemIds.has(msg.itemId)) continue;

        // Only handle incoming messages from the admin (ignore bot's own replies without storing them)
        if (!this.adminUserId || String(msg.userId) !== this.adminUserId) {
          continue;
        }

        try {
          await this.handleAdminMessage(msg);
          this.markItemProcessed(msg.itemId);
          this.failedItemAttempts.delete(msg.itemId);
        } catch (err: any) {
          const attempts = (this.failedItemAttempts.get(msg.itemId) ?? 0) + 1;
          if (attempts >= ReminderWorker.MAX_ITEM_ATTEMPTS) {
            console.error(
              `[ReminderWorker] Permanent failure processing admin DM item ${msg.itemId} after ${attempts} attempts; marking processed:`,
              err?.message || err
            );
            this.markItemProcessed(msg.itemId);
            this.failedItemAttempts.delete(msg.itemId);
          } else {
            console.error(
              `[ReminderWorker] Failed to process admin DM item ${msg.itemId} (attempt ${attempts}/${ReminderWorker.MAX_ITEM_ATTEMPTS}):`,
              err?.message || err
            );
            this.setFailedItemAttempts(msg.itemId, attempts);
          }
        }
      }
    } finally {
      this.isPollingInboundDMs = false;
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
      const existingItem = shortcode ? await Repository.getSavedItemByShortcode(shortcode, null) : null;
      const isTextFallbackReel = !mediaId && mediaType === 'reel' && !/\/p\//i.test(reelUrl || '');
      const resolvedMediaType =
        isTextFallbackReel && existingItem
          ? classifySavedMediaType({ mediaType: existingItem.media_type, reelUrl: existingItem.reel_url })
          : classifySavedMediaType({ mediaType, reelUrl });
      const canonicalUrl =
        isTextFallbackReel && existingItem
          ? formatCanonicalInstagramUrl(shortcode, resolvedMediaType, existingItem.reel_url)
          : formatCanonicalInstagramUrl(shortcode, resolvedMediaType, reelUrl);
      console.log(`[ReminderWorker] Detected shared ${resolvedMediaType} from admin: ${shortcode} (Media ID: ${mediaId})`);

      // 1. Save to native Instagram Saved collection
      let savedOnIg = false;
      if (mediaId) {
        const saveRes = await this.actionClient.saveMedia(mediaId);
        savedOnIg = saveRes.success && saveRes.data;
        if (savedOnIg) {
          console.log(`[ReminderWorker] Saved ${resolvedMediaType} ${mediaId} natively on Instagram!`);
        }
      }

      // 2. Upsert creator (avoid overwriting an unrelated handle like instagram_unknown)
      const creatorUsername = authorUsername || existingItem?.creator?.username || 'instagram_user';
      const sameCreatorHandle =
        !authorUsername ||
        !existingItem?.creator?.username ||
        authorUsername.toLowerCase() === existingItem.creator.username.toLowerCase();
      const creator = await Repository.upsertCreator({
        instagram_user_id:
          (sameCreatorHandle ? existingItem?.creator?.instagram_user_id : undefined) || creatorUsername,
        username: creatorUsername,
        display_name:
          (sameCreatorHandle ? existingItem?.creator?.display_name : undefined) || creatorUsername,
      });

      // 3. Upsert item into Supabase with watch_status = 'watch_later'
      const nextReminderDate = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
      const nowIso = new Date().toISOString();
      const isSavedOnInstagram = savedOnIg || (existingItem ? existingItem.is_saved_on_instagram !== false : false);
      const savedAt = existingItem
        ? (existingItem.saved_at ?? (savedOnIg && existingItem.is_saved_on_instagram === false ? nowIso : null))
        : (savedOnIg ? nowIso : null);
      await Repository.upsertSavedReel({
        instagram_media_id: existingItem?.instagram_media_id || mediaId || `id_${shortcode}`,
        shortcode,
        reel_url: canonicalUrl,
        media_type: resolvedMediaType,
        creator_id: creator.id,
        caption: caption || existingItem?.caption || null,
        thumbnail_url: thumbnailUrl || existingItem?.thumbnail_url || null,
        taken_at: existingItem?.taken_at || nowIso,
        saved_at: savedAt,
        first_detected_at: existingItem?.first_detected_at || nowIso,
        save_order_rank: existingItem?.save_order_rank ?? 1,
        watch_status: 'watch_later',
        reminder_interval_hours: intervalHours,
        next_reminder_at: nextReminderDate,
        is_saved_on_instagram: isSavedOnInstagram,
      });

      // 4. Send immediate confirmation DM to admin
      if (this.adminUserId) {
        const creatorLine = formatAddedToWatchLaterCreatorBlock(creator);
        const itemHeading = savedOnIg
          ? (resolvedMediaType === 'post'
            ? '🖼️ Post saved to Watch Later & bookmarked to your Instagram Saved!'
            : '🎬 Saved to Watch Later & bookmarked to your Instagram Saved!')
          : (resolvedMediaType === 'post'
            ? '🖼️ Post added to your Watch Later!'
            : '🎬 Added to your Watch Later!');
        const confirmText = `${itemHeading}${creatorLine}\n\nI will remind you about this in ${intervalHours} hours ⏰\n(Reply "done" when you've watched it)`;
        await this.actionClient.sendDirectMessage(this.adminUserId, confirmText);
      }
      return;
    }

    // Case 2: Text command (e.g. "done", "watched", "stop all", "cancel", "cancel reminder")
    if (msg.text) {
      const cancelCmd = parseCancelCommand(msg.text);
      if (cancelCmd) {
        if (this.adminUserId) {
          if (cancelCmd.invalidCreatorTarget) {
            const example = cancelCmd.isCancelAddition ? 'clear @creator' : 'cancel reminder for @creator';
            const rawTarget = cancelCmd.invalidCreatorTarget;
            const shownTarget = rawTarget.length > 100 ? `${rawTarget.slice(0, 100)}...` : rawTarget;
            const reply = `ℹ️ Could not find a valid creator handle in "${shownTarget}". Reply e.g. "${example}".`;
            const sendResult = await this.actionClient.sendDirectMessage(this.adminUserId, reply);
            if (!sendResult.success) {
              console.error('[ReminderWorker] Failed to send admin error reply:', sendResult.error);
              this.pendingAdminConfirmationReplies.push(reply);
            }
            return;
          }

          if (cancelCmd.isCancelAddition) {
            if (cancelCmd.targetCreator) {
              const result = await Repository.clearWatchLaterForCreator(this.adminUserId, cancelCmd.targetCreator, {
                includeUnattributedFallback: true,
              });
              const reply = result.clearedReels.length > 0
                ? `❌ Cleared ${result.clearedReels.length} item(s) by @${cancelCmd.targetCreator} from your Watch Later.`
                : `ℹ️ No Watch Later items found from @${cancelCmd.targetCreator}.`;
              const sendResult = await this.actionClient.sendDirectMessage(this.adminUserId, reply);
              if (!sendResult.success) {
                console.error('[ReminderWorker] Failed to send admin clear reply:', sendResult.error);
                this.pendingAdminConfirmationReplies.push(reply);
              }
            } else {
              const cancelled = await Repository.cancelRecentAdditionForSender(this.adminUserId, {
                includeUnattributedFallback: true,
              });
              const reply = cancelled
                ? `❌ Cancelled! Removed ${formatHumanReelLabel(cancelled.cancelledReel, 40)} from your Watch Later.`
                : `ℹ️ No recent item found in your Watch Later to cancel.`;
              const sendResult = await this.actionClient.sendDirectMessage(this.adminUserId, reply);
              if (!sendResult.success) {
                console.error('[ReminderWorker] Failed to send admin cancel reply:', sendResult.error);
                this.pendingAdminConfirmationReplies.push(reply);
              }
            }
          } else if (cancelCmd.isCancelReminder) {
            const result = await Repository.cancelReminderForSender(this.adminUserId, {
              targetCreator: cancelCmd.targetCreator,
              includeUnattributedFallback: true,
            });
            const reply = result
              ? `⏰ Reminder cancelled for ${formatHumanReelLabel(result.updatedReel, 40)}. It will remain saved in your Watch Later list without alerts.`
              : `ℹ️ No active reminder found to cancel.`;
            const sendResult = await this.actionClient.sendDirectMessage(this.adminUserId, reply);
            if (!sendResult.success) {
              console.error('[ReminderWorker] Failed to send admin cancel reminder reply:', sendResult.error);
              this.pendingAdminConfirmationReplies.push(reply);
            }
          }
        }
        return;
      }

      const { isCommand, markAll } = parseWatchedStopCommand(msg.text);
      if (isCommand) {
        const { updatedReels, remainingCount, remainingReels } = await Repository.markWatchedForInstagramSender(
          this.adminUserId || '',
          { markAll, includeUnattributedFallback: true }
        );
        if (this.adminUserId) {
          const reply = formatWatchedConfirmationMessage(updatedReels, remainingCount, markAll, remainingReels);
          const sendResult = await this.actionClient.sendDirectMessage(this.adminUserId, reply);
          if (!sendResult.success) {
            console.error('[ReminderWorker] Failed to send admin watched reply:', sendResult.error);
            this.pendingAdminConfirmationReplies.push(reply);
          }
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
      const now = Date.now();
      // Clean up expired entries in the suppression map
      for (const [key, expireTime] of this.failedReelSuppression.entries()) {
        if (now >= expireTime) {
          this.failedReelSuppression.delete(key);
        }
      }

      // Prune stale checkpoints older than 24 hours from original delivery
      for (const [key, checkpoint] of this.deliveredPersistenceCheckpoints.entries()) {
        if (now > checkpoint.deliveryTimestamp + 24 * 3600 * 1000) {
          this.deliveredPersistenceCheckpoints.delete(key);
        }
      }

      // 1. Retry persistence for delivered reminders first without re-sending DMs (bounded to 10 per tick with backoff)
      let checkpointRecoveries = 0;
      for (const [key, checkpoint] of Array.from(this.deliveredPersistenceCheckpoints.entries())) {
        if (checkpointRecoveries >= 10) break;
        if (now < checkpoint.nextRetryAt) continue;
        checkpointRecoveries++;
        try {
          const fresh = await Repository.getSavedItemById(checkpoint.reelId);
          const matchesExpectation = checkpoint.expectedNextReminderAt === null
            ? fresh?.next_reminder_at === null
            : fresh?.next_reminder_at === checkpoint.expectedNextReminderAt;
          if (!fresh || !matchesExpectation) {
            this.deliveredPersistenceCheckpoints.delete(key);
            continue;
          }
          await Repository.recordReminderSent(checkpoint.reelId, checkpoint.nextDate, {
            expectedNextReminderAt: checkpoint.expectedNextReminderAt,
          });
          this.deliveredPersistenceCheckpoints.delete(key);
        } catch {
          checkpoint.attempts = (checkpoint.attempts || 0) + 1;
          checkpoint.nextRetryAt = now + Math.min(3600000, 60000 * Math.pow(2, checkpoint.attempts));
        }
      }

      const allDueReels = await Repository.getReelsDueForReminder();
      if (allDueReels.length === 0) return;

      // Filter out temporarily suppressed reminders and delivered checkpoints so we never re-send DMs
      const eligibleReels = allDueReels.filter((r) => {
        const suppressionKey = `${r.id}:${r.next_reminder_at || ''}`;
        return !this.failedReelSuppression.has(suppressionKey) && !this.deliveredPersistenceCheckpoints.has(suppressionKey);
      });
      if (eligibleReels.length === 0) return;

      // Limit batch size per dispatch tick to avoid unbounded execution latency
      const BATCH_LIMIT = 10;
      const dueReels = eligibleReels.slice(0, BATCH_LIMIT);

      const config = loadConfig();
      const intervalHours = config.reminders.defaultIntervalHours;

      console.log(`[ReminderWorker] Found ${allDueReels.length} Reel(s) due for reminder (dispatching batch of ${dueReels.length}).`);

      for (const reel of dueReels) {
        // Recheck schedule immediately before sending to ensure reminder was not cancelled in the interim.
        let freshReel: SavedReel | null = null;
        try {
          freshReel = await Repository.getSavedItemById(reel.id);
        } catch (err: any) {
          console.error(`[ReminderWorker] Failed to reload due reel ${reel.shortcode}:`, err.message || err);
          this.failedReelSuppression.set(`${reel.id}:${reel.next_reminder_at || ''}`, Date.now() + 5 * 60 * 1000);
          continue;
        }
        if (
          !freshReel ||
          freshReel.watch_status !== 'watch_later' ||
          !freshReel.next_reminder_at ||
          new Date(freshReel.next_reminder_at).getTime() > Date.now() ||
          String(freshReel.instagram_sender_id || '') !== String(reel.instagram_sender_id || '')
        ) {
          console.log(`[ReminderWorker] Skipping reel ${reel.shortcode} because its reminder is no longer due or owner changed.`);
          continue;
        }

        const recipientSenderId = freshReel.instagram_sender_id;
        const hasRecipient = Boolean(recipientSenderId || (this.adminUserId && config.instagram.isConfigured));
        if (!hasRecipient) {
          console.warn(`[ReminderWorker] Skipping reel ${reel.shortcode} because no valid recipient exists.`);
          this.failedReelSuppression.set(`${freshReel.id}:${freshReel.next_reminder_at || ''}`, Date.now() + 5 * 60 * 1000);
          continue;
        }

        const reminderText = formatWatchLaterReminderMessage(freshReel);

        let delivered = false;

        try {
          if (recipientSenderId && this.metaBot.isConfigured) {
            console.log(`[ReminderWorker] Dispatching Instagram DM reminder to ${recipientSenderId}...`);
            delivered = await this.metaBot.sendDirectMessage(recipientSenderId, reminderText);
          } else if (!recipientSenderId && this.adminUserId && config.instagram.isConfigured) {
            // Supported delivery fallback for legacy or unattributed sender reels
            console.log(`[ReminderWorker] Dispatching fallback reminder to admin (${this.adminUserId})...`);
            const sendResult = await this.actionClient.sendDirectMessage(this.adminUserId, reminderText);
            delivered = sendResult.success && sendResult.data === true;
          } else {
            console.warn(`[ReminderWorker] No active delivery channel or recipient found for reel ${reel.shortcode}.`);
          }
        } catch (err: any) {
          console.error(`[ReminderWorker] Delivery error for reel ${reel.shortcode}:`, err.message || err);
          delivered = false;
        }

        if (delivered) {
          // Calculate next reminder date only after confirmed delivery:
          // Short intervals (< 1 hour) are one-time reminders (next_reminder_at = null)
          // Longer intervals (>= 1 hour) repeat with a gentle 24-hour cadence
          const intervalSec = freshReel.reminder_interval_seconds ?? (freshReel.reminder_interval_hours ? freshReel.reminder_interval_hours * 3600 : intervalHours * 3600);
          let nextDate: string | null = null;
          if (intervalSec >= 3600) {
            nextDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
          } else {
            nextDate = null;
          }

          try {
            await Repository.recordReminderSent(freshReel.id, nextDate, {
              expectedNextReminderAt: freshReel.next_reminder_at,
            });
          } catch (err: any) {
            console.error(`[ReminderWorker] Failed to record reminder for reel ${freshReel.shortcode}:`, err.message || err);
            // Suppress repeated sending in memory for 5 minutes if DB recording fails
            // Key suppression by reel ID and the failed due timestamp so a newly scheduled reminder remains eligible
            const suppressionKey = `${freshReel.id}:${freshReel.next_reminder_at || ''}`;
            if (this.failedReelSuppression.size >= 1000) {
              const firstKey = this.failedReelSuppression.keys().next().value;
              if (firstKey) this.failedReelSuppression.delete(firstKey);
            }
            this.failedReelSuppression.set(suppressionKey, Date.now() + 5 * 60 * 1000);

            // Record checkpoint so future ticks retry DB write without re-sending the DM
            this.setDeliveredPersistenceCheckpoint(suppressionKey, {
              reelId: freshReel.id,
              nextDate,
              expectedNextReminderAt: freshReel.next_reminder_at,
            });

            // Attempt fallback persistence: preserve the normal nextDate with the expected-schedule guard
            // so recovery cannot overwrite a cancellation, without scheduling another delivery 5 minutes later
            try {
              const fallbackUpdated = await Repository.updateReminderSchedule(
                freshReel.id,
                nextDate,
                undefined,
                { expectedNextReminderAt: freshReel.next_reminder_at }
              );
              // Advance checkpoint expectation only when guarded fallback write was applied
              const existingCheckpoint = this.deliveredPersistenceCheckpoints.get(suppressionKey);
              if (fallbackUpdated && existingCheckpoint) {
                existingCheckpoint.expectedNextReminderAt = nextDate;
              }
            } catch (fallbackErr: any) {
              console.error(`[ReminderWorker] Fallback schedule update failed for reel ${freshReel.shortcode}:`, fallbackErr.message || fallbackErr);
            }
          }
        } else {
          // On delivery failure, retain reminder and back off 5 minutes before retrying
          const retryDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          console.warn(`[ReminderWorker] Delivery for reel ${freshReel.shortcode} failed. Backing off until ${retryDate}.`);
          try {
            await Repository.updateReminderSchedule(freshReel.id, retryDate, undefined, {
              expectedNextReminderAt: freshReel.next_reminder_at,
            });
          } catch (err: any) {
            console.error(`[ReminderWorker] Failed to schedule retry for reel ${freshReel.shortcode}:`, err.message || err);
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
    if (this.isCheckingChoices) {
      console.log('[ReminderWorker] Choice check already in progress, skipping tick.');
      return;
    }
    this.isCheckingChoices = true;

    try {
      const expiredReels = await Repository.getReelsAwaitingChoiceDue();
      if (expiredReels.length === 0) return;

      const config = loadConfig();
      const defaultHours = config.reminders.defaultIntervalHours || 10;

      for (const reel of expiredReels) {
        if (!reel.awaiting_reminder_choice_until) {
          continue;
        }
        const { reel: activatedReel, targetTime } = await Repository.activateDefaultReminder(
          reel.id,
          reel.awaiting_reminder_choice_until,
          defaultHours
        );
        if (!activatedReel) {
          // CAS race lost or deadline refreshed: another tick or worker handled this reel, or sender re-shared it
          continue;
        }

        const senderTz = activatedReel.instagram_sender_id
          ? await Repository.getSenderTimezone(activatedReel.instagram_sender_id)
          : undefined;
        const targetStr = formatTargetTime(targetTime, new Date(), senderTz);

        const defaultNotice = formatDefaultReminderNotice(activatedReel, defaultHours, targetStr);

        console.log(`[ReminderWorker] ⏰ 10-minute wait expired for reel ${activatedReel.shortcode}. Set default ${defaultHours}h reminder (${targetStr}).`);

        if (activatedReel.instagram_sender_id && this.metaBot.isConfigured) {
          await this.metaBot.sendDirectMessage(activatedReel.instagram_sender_id, defaultNotice);
        }
      }
    } finally {
      this.isCheckingChoices = false;
    }
  }
}
