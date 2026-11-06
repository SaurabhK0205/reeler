-- ==============================================================================
-- Migration 003: Seconds-precision reminders
-- ==============================================================================

ALTER TABLE public.saved_reels
  ADD COLUMN IF NOT EXISTS reminder_interval_seconds INTEGER DEFAULT 36000;
