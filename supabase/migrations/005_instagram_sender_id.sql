-- ==============================================================================
-- Migration 005: Instagram Sender ID for Direct Message Reminders
-- ==============================================================================

ALTER TABLE public.saved_reels
  ADD COLUMN IF NOT EXISTS instagram_sender_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reels_instagram_sender_id 
ON public.saved_reels(instagram_sender_id);
