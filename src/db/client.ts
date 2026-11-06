import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../config.ts';

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  const config = loadConfig();
  if (!config.supabase.isConfigured || !config.supabase.url || !config.supabase.key) {
    throw new Error(
      'Supabase is not configured. Please add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your .env file.'
    );
  }

  supabaseClient = createClient(config.supabase.url, config.supabase.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseClient;
}

export function isSupabaseConfigured(): boolean {
  return loadConfig().supabase.isConfigured;
}
