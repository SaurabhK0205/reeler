-- Migration: Add awaiting_reminder_choice_until for 10-minute wait window
ALTER TABLE saved_reels
ADD COLUMN IF NOT EXISTS awaiting_reminder_choice_until TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_saved_reels_awaiting_choice
ON saved_reels(awaiting_reminder_choice_until)
WHERE awaiting_reminder_choice_until IS NOT NULL;
