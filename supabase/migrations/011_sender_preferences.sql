-- ==============================================================================
-- Migration 011: Multi-User Sender Preferences & Timezone
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.sender_preferences (
  sender_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_sender_preferences_sender_id
ON public.sender_preferences(sender_id);

ALTER TABLE public.sender_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sender_preferences FROM anon, authenticated;
