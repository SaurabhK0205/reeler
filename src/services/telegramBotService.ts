import { loadConfig } from '../config.ts';
import { Repository } from '../db/repository.ts';
import { InstagramActionClient } from './instagramActionClient.ts';
import { parseDuration, formatTimeRemaining } from '../utils/duration.ts';
import type { SavedReel } from '../types.ts';

export class TelegramBotService {
  private botToken: string;
  private isPolling = false;
  private lastUpdateId = 0;
  private activeChatId: string | null = null;
  private customDefaultIntervalMs: number | null = null;
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
        await new Promise((r) => setTimeout(r, 3000));
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
      const welcome = `👋 <b>Welcome to your Saved Reels Watch Later Bot!</b>\n\nWhenever you see a Reel on Instagram, tap <b>Share ➔ Telegram ➔ @dinosaurabh_bot</b> (or paste the link here).\n\n⏱️ <b>Custom Reminders:</b>\nYou can set reminders for <b>seconds, minutes, hours, or days</b>!\n• Example: send link with <code>30s</code>, <code>5m</code>, <code>2h</code>, or <code>3 days</code>\n• Or use the quick-select buttons under each Reel.\n\n<b>Commands:</b>\n• /interval &lt;time&gt; - Set default reminder (e.g. <code>/interval 5m</code> or <code>/interval 12h</code>)\n• /pending - View Watch Later queue\n• /stats - View library statistics\n• /help - Help guide`;
      await this.sendMessage(chatId, welcome);
      return;
    }

    // Command: /interval <duration>
    if (text.startsWith('/interval')) {
      const parts = text.split(/\s+/).slice(1).join(' ');
      const parsed = parseDuration(parts);
      if (!parsed) {
        await this.sendMessage(
          chatId,
          `❓ <b>How to set default interval:</b>\nType <code>/interval 30s</code>, <code>/interval 15m</code>, <code>/interval 2h</code>, or <code>/interval 2 days</code>.`
        );
        return;
      }
      this.customDefaultIntervalMs = parsed.ms;
      await this.sendMessage(
        chatId,
        `⚙️ <b>Default reminder interval updated to: ${parsed.label}!</b>\nNew reels will remind you every ${parsed.label}.`
      );
      return;
    }

    // Command: /stats
    if (text.startsWith('/stats')) {
      const stats = await Repository.getStats();
      const statsMsg = `📊 <b>Your Saved Reels Library:</b>\n\n• <b>Total Reels:</b> ${stats.totalReels}\n• <b>Unique Creators:</b> ${stats.totalCreators}\n• <b>Saved This Week:</b> ${stats.savedThisWeek}\n• <b>⏰ Watch Later:</b> ${stats.watchLaterCount}\n• <b>✅ Watched:</b> ${stats.watchedCount}`;
      await this.sendMessage(chatId, statsMsg);
      return;
    }

    // Command: /creators (List top creators)
    if (text.startsWith('/creators')) {
      const creators = await Repository.getCreators();
      if (creators.length === 0) {
        await this.sendMessage(chatId, 'No saved creators found yet.');
        return;
      }
      const topList = creators.slice(0, 15).map((c, i) => `${i + 1}. <b>@${c.username}</b> (${c.saved_count || 0} reels)`).join('\n');
      const msg = `👥 <b>Top Saved Creators:</b>\n\n${topList}\n\n<i>Type any username like <code>@thefilmmemes</code> to get all their saved reels in sequence!</i>`;
      await this.sendMessage(chatId, msg);
      return;
    }

    // Creator Search: @username or /creator username or /user username
    const creatorCmdMatch = text.match(/^(?:\/creator|\/user)\s+@?([a-zA-Z0-9._]+)$/i);
    const directHandleMatch = text.match(/^@([a-zA-Z0-9._]+)$/);
    if (creatorCmdMatch || directHandleMatch) {
      const targetUsername = (creatorCmdMatch ? creatorCmdMatch[1] : directHandleMatch![1]).toLowerCase();
      await this.handleCreatorReelsRequest(chatId, targetUsername);
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
            [
              { text: '⏱️ 30s', callback_data: `set_30_${reel.id}` },
              { text: '⏱️ 5m', callback_data: `set_300_${reel.id}` },
              { text: '⏰ 1h', callback_data: `set_3600_${reel.id}` },
              { text: '⏰ 1d', callback_data: `set_86400_${reel.id}` },
            ],
          ],
        };
        await this.sendMessage(chatId, msg, keyboard);
      }
      return;
    }

    // Command: /help
    if (text.startsWith('/help')) {
      const helpMsg = `📖 <b>How to Use @dinosaurabh_bot:</b>\n\n1. In Instagram, open any Reel.\n2. Tap <b>Share ➔ Share via... ➔ Telegram ➔ dinosaurabh_bot</b>.\n3. Add custom time if you want: <code>https://instagram.com/reel/xyz 45s</code>\n4. You will get lock-screen reminders until you tap <b>"✅ Mark as Watched"</b>!`;
      await this.sendMessage(chatId, helpMsg);
      return;
    }

    // Check for Instagram Reel URL in message
    const reelMatch = text.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/i);
    if (reelMatch) {
      // Check if user also typed a custom duration in the same message (e.g. "https://... 30s" or "30 sec")
      const remainingText = text.replace(reelMatch[0], '').trim();
      const customDuration = parseDuration(remainingText);
      await this.handleReelShared(chatId, reelMatch[1], reelMatch[0], customDuration);
      return;
    }

    // Single-word lookup: user may have typed username without @ (e.g. "thefilmmemes")
    if (/^[a-zA-Z0-9._]{2,30}$/.test(text)) {
      const found = await this.handleCreatorReelsRequest(chatId, text, true);
      if (found) return;
    }

    // Default response
    await this.sendMessage(
      chatId,
      `💡 <b>Quick Tips:</b>\n• Send any Reel link to add it to Watch Later (with optional time like <code>30s</code> or <code>5m</code>)\n• Type <b>@username</b> (e.g. <code>@thefilmmemes</code>) to get all reels saved from that account!\n• Type <b>/creators</b> to see your top creators.`
    );
  }

  private async handleCreatorReelsRequest(chatId: string, username: string, silentIfNotFound = false): Promise<boolean> {
    const { creator, reels } = await Repository.getReelsByCreatorUsername(username);

    if (!creator || reels.length === 0) {
      if (!silentIfNotFound) {
        await this.sendMessage(
          chatId,
          `🔍 No saved reels found from <b>@${username}</b>.\nType /creators to see all your saved creators!`
        );
      }
      return false;
    }

    let msg = `🎬 <b>Saved Reels from @${creator.username}</b>\n`;
    msg += `<i>Total: ${reels.length} reel(s) · Ordered latest to oldest</i>\n\n`;

    const itemsToShow = reels.slice(0, 10);
    for (let i = 0; i < itemsToShow.length; i++) {
      const reel = itemsToShow[i];
      const rank = i + 1;
      const statusIcon = reel.watch_status === 'watched' ? '✅' : reel.watch_status === 'watch_later' ? '⏰' : '👁️';
      const snippet = reel.caption ? `"${reel.caption.slice(0, 55).replace(/\n/g, ' ')}..."` : '(No caption)';
      
      msg += `<b>${rank}.</b> ${statusIcon} <a href="${reel.reel_url}">Watch Reel</a>\n`;
      msg += `   ${snippet}\n\n`;
    }

    if (reels.length > 10) {
      msg += `<i>...and ${reels.length - 10} more in your dashboard!</i>\n`;
    }

    // Action buttons for top reels
    const keyboardRows = [];
    for (let i = 0; i < Math.min(3, reels.length); i++) {
      const r = reels[i];
      keyboardRows.push([
        { text: `Reel #${i + 1} 👉 Open`, url: r.reel_url },
        { text: r.watch_status === 'watched' ? '✅ Watched' : '👁️ Mark Watched', callback_data: `watch_${r.id}` },
      ]);
    }

    await this.sendMessage(chatId, msg, { inline_keyboard: keyboardRows });
    return true;
  }

  private async handleReelShared(
    chatId: string,
    shortcode: string,
    url: string,
    customDuration?: { ms: number; seconds: number; label: string } | null
  ) {
    const config = loadConfig();
    const defaultMs = this.customDefaultIntervalMs || config.reminders.defaultIntervalHours * 3600 * 1000;
    const durationMs = customDuration ? customDuration.ms : defaultMs;
    const durationSec = Math.round(durationMs / 1000);
    const durationLabel = customDuration ? customDuration.label : `${Math.round(durationMs / 3600000)} hours`;

    console.log(`[TelegramBot] 🎬 Reel received: ${shortcode} with reminder in ${durationLabel}`);

    // Upsert Creator
    const creator = await Repository.upsertCreator({
      instagram_user_id: `creator_${shortcode}`,
      username: 'instagram_creator',
      display_name: 'Instagram Creator',
    });

    const nextReminder = new Date(Date.now() + durationMs).toISOString();

    const saved = await Repository.upsertSavedReel({
      instagram_media_id: `shortcode_${shortcode}`,
      shortcode,
      reel_url: `https://www.instagram.com/reel/${shortcode}/`,
      creator_id: creator.id,
      taken_at: new Date().toISOString(),
      first_detected_at: new Date().toISOString(),
      save_order_rank: 1,
      watch_status: 'watch_later',
      reminder_interval_seconds: durationSec,
      next_reminder_at: nextReminder,
      is_saved_on_instagram: true,
    });

    const targetTimeStr = new Date(nextReminder).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const confirmationMsg = `🎬 <b>Added to Watch Later!</b>\n\n👉 <a href="${saved.reel_url}">Open Reel on Instagram</a>\n\n⏰ <b>Reminder set for:</b> ${durationLabel} (at ${targetTimeStr})\n<i>Tap below to change reminder or mark watched:</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '⏱️ 30s', callback_data: `set_30_${saved.id}` },
          { text: '⏱️ 1m', callback_data: `set_60_${saved.id}` },
          { text: '⏱️ 5m', callback_data: `set_300_${saved.id}` },
        ],
        [
          { text: '⏰ 1h', callback_data: `set_3600_${saved.id}` },
          { text: '⏰ 10h', callback_data: `set_36000_${saved.id}` },
          { text: '⏰ 1d', callback_data: `set_86400_${saved.id}` },
          { text: '⏰ 2d', callback_data: `set_172800_${saved.id}` },
        ],
        [{ text: '✅ Mark as Watched', callback_data: `watch_${saved.id}` }],
      ],
    };

    await this.sendMessage(chatId, confirmationMsg, keyboard);
  }

  private async handleCallbackQuery(query: any) {
    const data = query.data as string;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;

    if (!data || !chatId || !messageId) return;

    // 1. Mark as Watched
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

    // 2. Set custom reminder: set_<seconds>_<reelId>
    if (data.startsWith('set_')) {
      const match = data.match(/^set_(\d+)_(.+)$/);
      if (match) {
        const sec = parseInt(match[1], 10);
        const reelId = match[2];
        const nextDate = new Date(Date.now() + sec * 1000).toISOString();

        await Repository.updateReminderSchedule(reelId, nextDate, sec);
        await this.answerCallbackQuery(query.id, `⏰ Reminder set for ${formatTimeRemaining(sec * 1000)}!`);

        const timeStr = new Date(nextDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        await this.editMessageText(
          chatId,
          messageId,
          `⏰ <b>Reminder updated!</b>\nI will ping you in <b>${formatTimeRemaining(sec * 1000)}</b> (at ${timeStr}).\n\n<i>Reply to this or tap below anytime:</i>`,
          {
            inline_keyboard: [
              [
                { text: '⏱️ 30s', callback_data: `set_30_${reelId}` },
                { text: '⏱️ 5m', callback_data: `set_300_${reelId}` },
                { text: '⏰ 1h', callback_data: `set_3600_${reelId}` },
                { text: '⏰ 1d', callback_data: `set_86400_${reelId}` },
              ],
              [{ text: '✅ Mark as Watched', callback_data: `watch_${reelId}` }],
            ],
          }
        );
        return;
      }
    }
  }

  /**
   * Dispatches a reminder message for a due Reel with fast snooze buttons.
   */
  async sendReminder(reel: SavedReel) {
    const targetChatId = this.activeChatId || loadConfig().telegram.chatId;
    if (!targetChatId) {
      console.log('[TelegramBot] No active chat ID yet. User needs to send /start to @dinosaurabh_bot first.');
      return;
    }

    const creatorTag = reel.creator ? `@${reel.creator.username}` : 'Instagram Reel';
    const captionPreview = reel.caption ? `\n\n<i>"${reel.caption.slice(0, 80).replace(/\n/g, ' ')}..."</i>` : '';
    const text = `🔔 <b>Watch Later Reminder!</b>\n\n🎬 <b>${creatorTag}</b>${captionPreview}\n👉 <a href="${reel.reel_url}">Watch Reel on Instagram</a>\n\n<i>Tap below to mark watched or snooze:</i>`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Mark as Watched', callback_data: `watch_${reel.id}` }],
        [
          { text: '⏱️ Snooze 30s', callback_data: `set_30_${reel.id}` },
          { text: '⏱️ Snooze 5m', callback_data: `set_300_${reel.id}` },
          { text: '⏰ Snooze 1h', callback_data: `set_3600_${reel.id}` },
          { text: '⏰ Snooze 1d', callback_data: `set_86400_${reel.id}` },
        ],
      ],
    };

    console.log(`[TelegramBot] 🔔 Dispatching reminder for ${reel.shortcode} to Telegram chat ${targetChatId}...`);
    await this.sendMessage(targetChatId, text, keyboard);
  }
}
