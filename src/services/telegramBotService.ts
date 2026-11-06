import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { InstagramActionClient } from './instagramActionClient.ts';
import type { SavedReel } from '../types.ts';

export class TelegramBotService {
  private botToken: string;
  private isPolling = false;
  private lastUpdateId = 0;
  private activeChatId: string | null = null;
  private actionClient = new InstagramActionClient();

  constructor() {
    const config = loadConfig();
    this.botToken = config.telegram.botToken || '';
    this.activeChatId = config.telegram.chatId || null;
  }

  get isConfigured(): boolean {
    return Boolean(this.botToken);
  }

  get chatId(): string | null {
    return this.activeChatId;
  }

  start() {
    if (!this.isConfigured) {
      console.log('[TelegramBot] No TELEGRAM_BOT_TOKEN set. Telegram bot service idle.');
      return;
    }

    this.isPolling = true;
    console.log('[TelegramBot] 🤖 Starting Telegram Bot polling for @dinosaurabh_bot...');
    this.pollLoop().catch((err) => console.error('[TelegramBot] Fatal poll error:', err));
  }

  stop() {
    this.isPolling = false;
    console.log('[TelegramBot] Stopped.');
  }

  private async apiCall(method: string, body: Record<string, unknown> = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { ok: boolean; result?: any; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram API ${method} failed: ${json.description || 'unknown'}`);
    }
    return json.result;
  }

  async sendMessage(chatId: string | number, text: string, replyMarkup?: Record<string, unknown>) {
    return this.apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_markup: replyMarkup,
    });
  }

  async editMessageText(chatId: string | number, messageId: number, text: string, replyMarkup?: Record<string, unknown>) {
    return this.apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.apiCall('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  private async pollLoop() {
    while (this.isPolling) {
      try {
        const updates = await this.apiCall('getUpdates', {
          offset: this.lastUpdateId + 1,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });

        if (Array.isArray(updates) && updates.length > 0) {
          for (const update of updates) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            await this.handleUpdate(update);
          }
        }
      } catch (err: any) {
        if (!this.isPolling) break;
        console.error('[TelegramBot] Polling warning:', err.message);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  private async handleUpdate(update: any) {
    // 1. Handle Button Clicks (Callback Query)
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    // 2. Handle Incoming Messages
    const message = update.message;
    if (!message || !message.text) return;

    const chatId = String(message.chat.id);
    this.activeChatId = chatId;
    const text = message.text.trim();

    // Command: /start
    if (text.startsWith('/start')) {
      const welcome = `👋 <b>Welcome to your Saved Reels Watch Later Bot!</b>\n\nWhenever you see a Reel on Instagram, tap <b>Share ➔ Telegram ➔ @dinosaurabh_bot</b>.\n\nI will instantly store it in your Supabase database and ping you with periodic reminders until you mark it watched!\n\n<b>Commands:</b>\n• /stats - View your library stats\n• /pending - View your Watch Later queue\n• /help - Help & instructions`;
      await this.sendMessage(chatId, welcome);
      return;
    }

    // Command: /stats
    if (text.startsWith('/stats')) {
      const stats = await Repository.getStats();
      const statsMsg = `📊 <b>Your Saved Reels Library:</b>\n\n• <b>Total Reels:</b> ${stats.totalReels}\n• <b>Unique Creators:</b> ${stats.totalCreators}\n• <b>Saved This Week:</b> ${stats.savedThisWeek}\n• <b>⏰ Watch Later:</b> ${stats.watchLaterCount}\n• <b>✅ Watched:</b> ${stats.watchedCount}`;
      await this.sendMessage(chatId, statsMsg);
      return;
    }

    // Command: /pending
    if (text.startsWith('/pending')) {
      const res = await Repository.getReels({ watchStatus: 'watch_later', limit: 5 });
      if (res.reels.length === 0) {
        await this.sendMessage(chatId, '🎉 <b>All caught up!</b> No pending reels in Watch Later right now.');
        return;
      }

      await this.sendMessage(chatId, `⏰ <b>Your Watch Later Queue (${res.total} total):</b>`);
      for (const reel of res.reels) {
        const creator = reel.creator ? `@${reel.creator.username}` : 'Instagram Reel';
        const msg = `🎬 <b>${creator}</b>\n👉 ${reel.reel_url}`;
        const keyboard = {
          inline_keyboard: [
            [{ text: '✅ Mark as Watched', callback_data: `watch_${reel.id}` }],
          ],
        };
        await this.sendMessage(chatId, msg, keyboard);
      }
      return;
    }

    // Command: /help
    if (text.startsWith('/help')) {
      const helpMsg = `📖 <b>How to Use @dinosaurabh_bot:</b>\n\n1. In Instagram, open any Reel.\n2. Tap <b>Share ➔ Share via... ➔ Telegram ➔ dinosaurabh_bot</b>.\n3. The bot saves it to your Supabase Watch Later list.\n4. You will get lock-screen reminders every 10 hours until you tap <b>"✅ Mark as Watched"</b>!`;
      await this.sendMessage(chatId, helpMsg);
      return;
    }

    // Check for Instagram Reel URL in message
    const reelMatch = text.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/i);
    if (reelMatch) {
      await this.handleReelShared(chatId, reelMatch[1], reelMatch[0]);
      return;
    }

    // Default response for unmatched text
    await this.sendMessage(
      chatId,
      `💡 Send me any Instagram Reel link (or tap Share from the Instagram app) and I'll add it to your Watch Later queue!`
    );
  }

  private async handleReelShared(chatId: string, shortcode: string, url: string) {
    const config = loadConfig();
    const interval = config.reminders.defaultIntervalHours;

    console.log(`[TelegramBot] 🎬 Reel received from user: ${shortcode}`);

    // Upsert Creator placeholder or known creator
    const creator = await Repository.upsertCreator({
      instagram_user_id: `creator_${shortcode}`,
      username: 'instagram_creator',
      display_name: 'Instagram Creator',
    });

    const nextReminder = new Date(Date.now() + interval * 60 * 60 * 1000).toISOString();

    const saved = await Repository.upsertSavedReel({
      instagram_media_id: `shortcode_${shortcode}`,
      shortcode,
      reel_url: `https://www.instagram.com/reel/${shortcode}/`,
      creator_id: creator.id,
      taken_at: new Date().toISOString(),
      first_detected_at: new Date().toISOString(),
      save_order_rank: 1,
      watch_status: 'watch_later',
      reminder_interval_hours: interval,
      next_reminder_at: nextReminder,
      is_saved_on_instagram: true,
    });

    const confirmationMsg = `🎬 <b>Added to Watch Later!</b>\n\n👉 <a href="${saved.reel_url}">Open Reel on Instagram</a>\n\n⏰ I will remind you in <b>${interval} hours</b> if unwatched.`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Mark as Watched', callback_data: `watch_${saved.id}` }],
        [
          { text: '💤 Snooze 5h', callback_data: `snooze_5_${saved.id}` },
          { text: '💤 Snooze 24h', callback_data: `snooze_24_${saved.id}` },
        ],
      ],
    };

    await this.sendMessage(chatId, confirmationMsg, keyboard);
  }

  private async handleCallbackQuery(query: any) {
    const data = query.data as string;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;

    if (!data || !chatId || !messageId) return;

    if (data.startsWith('watch_')) {
      const reelId = data.replace('watch_', '');
      await Repository.updateWatchStatus(reelId, 'watched');
      await this.answerCallbackQuery(query.id, '✅ Marked as Watched!');
      await this.editMessageText(
        chatId,
        messageId,
        `🎉 <b>Marked as Watched!</b>\n\nGreat job! Reminders have been stopped for this reel.`
      );
      return;
    }

    if (data.startsWith('snooze_5_')) {
      const reelId = data.replace('snooze_5_', '');
      const nextDate = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
      await Repository.recordReminderSent(reelId, nextDate);
      await this.answerCallbackQuery(query.id, '💤 Snoozed for 5 hours');
      await this.editMessageText(
        chatId,
        messageId,
        `💤 <b>Snoozed!</b> I will remind you again in <b>5 hours</b>.`
      );
      return;
    }

    if (data.startsWith('snooze_24_')) {
      const reelId = data.replace('snooze_24_', '');
      const nextDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await Repository.recordReminderSent(reelId, nextDate);
      await this.answerCallbackQuery(query.id, '💤 Snoozed for 24 hours');
      await this.editMessageText(
        chatId,
        messageId,
        `💤 <b>Snoozed!</b> I will remind you again tomorrow.`
      );
      return;
    }
  }

  /**
   * Dispatches a reminder message for a due Reel.
   */
  async sendReminder(reel: SavedReel) {
    const targetChatId = this.activeChatId || loadConfig().telegram.chatId;
    if (!targetChatId) {
      console.log('[TelegramBot] No active chat ID yet. User needs to send /start to @dinosaurabh_bot first.');
      return;
    }

    const creatorTag = reel.creator ? `@${reel.creator.username}` : 'Instagram Reel';
    const captionPreview = reel.caption ? `\n\n<i>"${reel.caption.slice(0, 80).replace(/\n/g, ' ')}..."</i>` : '';
    const text = `🔔 <b>Watch Later Reminder!</b>\n\n🎬 <b>${creatorTag}</b>${captionPreview}\n👉 <a href="${reel.reel_url}">Watch Reel on Instagram</a>`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Mark as Watched', callback_data: `watch_${reel.id}` }],
        [
          { text: '💤 Snooze 5h', callback_data: `snooze_5_${reel.id}` },
          { text: '💤 Snooze 24h', callback_data: `snooze_24_${reel.id}` },
        ],
      ],
    };

    console.log(`[TelegramBot] Dispatching reminder for ${reel.shortcode} to Telegram chat ${targetChatId}...`);
    await this.sendMessage(targetChatId, text, keyboard);
  }
}
