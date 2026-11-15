-- ==============================================================================
-- Migration 010: Composite index for sender-scoped id pagination
-- ==============================================================================

CREATE INDEX IF NOT EXISTS idx_saved_reels_sender_id_id
  ON public.saved_reels(instagram_sender_id, id);
