-- ==============================================================================
-- Migration 008: Effective Saved Timestamp for Chronological Save-Date Sorting
-- ==============================================================================

ALTER TABLE public.saved_reels
  ADD COLUMN IF NOT EXISTS effective_saved_at TIMESTAMPTZ
  GENERATED ALWAYS AS (COALESCE(saved_at, first_detected_at)) STORED;

CREATE INDEX IF NOT EXISTS idx_saved_reels_effective_saved_at_desc
  ON public.saved_reels(effective_saved_at DESC, save_order_rank ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_saved_reels_effective_saved_at_asc
  ON public.saved_reels(effective_saved_at ASC, save_order_rank DESC, id ASC);
