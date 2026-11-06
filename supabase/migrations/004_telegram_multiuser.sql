-- ==============================================================================
-- Migration 004: Multi-User Telegram Support
-- ==============================================================================

ALTER TABLE public.saved_reels
  ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reels_telegram_chat_id 
ON public.saved_reels(telegram_chat_id);
