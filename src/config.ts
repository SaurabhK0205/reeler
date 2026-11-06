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
  const userAgent = process.env.USER_AGENT?.trim() || 
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
      isConfigured: Boolean(sessionId && userId && csrfToken),
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
