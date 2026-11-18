import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../config.ts';

let supabaseClient: SupabaseClient | null = null;

/**
 * Hard per-request fetch timeout (30s, exceeding PostgREST/Postgres statement timeouts) so a dead
 * transport socket cannot hold archive execution slots or deletion barriers indefinitely while still
 * allowing dispatched writes to receive server-side commit/rollback confirmation.
 */
const SUPABASE_FETCH_TIMEOUT_MS = 30_000;

const boundedSupabaseFetch: typeof fetch = (input, init) => {
  const timeoutSignal = AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
};

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
    global: {
      fetch: boundedSupabaseFetch,
    },
  });

  return supabaseClient;
}

export function isSupabaseConfigured(): boolean {
  return loadConfig().supabase.isConfigured;
}

export function resetSupabaseClientForTests(): void {
  supabaseClient = null;
}
