-- ==============================================================================
-- Migration 013: Scope saved_reels shortcode uniqueness per sender for multi-user
-- ==============================================================================
-- Replaces the global UNIQUE(shortcode) constraint with two partial unique indexes:
--   1. One row per (instagram_sender_id, shortcode) for bot/DM senders so multiple
--      users can independently save and schedule reminders for the same reel/post.
--   2. One unattributed row per shortcode where instagram_sender_id IS NULL for
--      admin/native Instagram archive imports.

ALTER TABLE public.saved_reels
  DROP CONSTRAINT IF EXISTS saved_reels_shortcode_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_reels_sender_shortcode_unique
  ON public.saved_reels (instagram_sender_id, shortcode)
  WHERE instagram_sender_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_reels_unattributed_shortcode_unique
  ON public.saved_reels (shortcode)
  WHERE instagram_sender_id IS NULL;
