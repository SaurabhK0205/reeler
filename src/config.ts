export interface AppConfig {
  supabase: {
    url?: string;
    key?: string;
    isConfigured: boolean;
  };
  instagram: {
    sessionId?: string;
    userId?: string;
    csrfToken?: string;
    userAgent: string;
    isConfigured: boolean;
    adminUsername?: string;
  };
  telegram: {
    botToken?: string;
    chatId?: string;
    isConfigured: boolean;
  };
  reminders: {
    defaultIntervalHours: number;
    dmPollingIntervalMs: number;
    reminderCheckIntervalMs: number;
  };
  server: {
    port: number;
  };
}

export function loadConfig(): AppConfig {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();

  const sessionId = process.env.INSTAGRAM_SESSION_ID?.trim();
  const userId = process.env.INSTAGRAM_USER_ID?.trim();
  const csrfToken = process.env.INSTAGRAM_CSRF_TOKEN?.trim();
  const adminUsername = process.env.ADMIN_USERNAME?.trim()?.replace(/^@/, '');
  const userAgent = process.env.USER_AGENT?.trim() || 
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  const defaultIntervalHours = Number(process.env.DEFAULT_REMINDER_HOURS) || 10;
  const dmPollingIntervalMs = (Number(process.env.DM_POLLING_SECONDS) || 15) * 1000;
  const reminderCheckIntervalMs = (Number(process.env.REMINDER_CHECK_SECONDS) || 60) * 1000;
  const port = Number(process.env.PORT) || 3000;

  return {
    supabase: {
      url: supabaseUrl,
      key: supabaseKey,
      isConfigured: Boolean(supabaseUrl && supabaseKey),
    },
    instagram: {
      sessionId,
      userId,
      csrfToken,
      userAgent,
      adminUsername,
      isConfigured: Boolean(sessionId && userId && csrfToken),
    },
    telegram: {
      botToken,
      chatId,
      isConfigured: Boolean(botToken),
    },
    reminders: {
      defaultIntervalHours,
      dmPollingIntervalMs,
      reminderCheckIntervalMs,
    },
    server: {
      port,
    },
  };
}

export function redactSecret(secret?: string): string {
  if (!secret) return '(not set)';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
