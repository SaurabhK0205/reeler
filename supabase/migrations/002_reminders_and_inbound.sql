-- ==============================================================================
-- Migration 002: Watch Later Reminders & Auto-Save
-- ==============================================================================

ALTER TABLE public.saved_reels
  ADD COLUMN IF NOT EXISTS reminder_interval_hours INTEGER DEFAULT 10,
  ADD COLUMN IF NOT EXISTS reminders_sent_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_reminder_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_saved_on_instagram BOOLEAN DEFAULT true;

-- Index for finding reels due for reminders
CREATE INDEX IF NOT EXISTS idx_reels_reminder_due 
ON public.saved_reels(next_reminder_at) 
WHERE watch_status = 'watch_later';
