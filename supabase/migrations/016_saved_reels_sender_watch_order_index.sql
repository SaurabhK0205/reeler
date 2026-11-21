-- ==============================================================================
-- Migration 016: Composite index for sender-scoped Watch Later queries and cancel ordering
-- ==============================================================================

CREATE INDEX IF NOT EXISTS idx_saved_reels_sender_watch_updated
  ON public.saved_reels (instagram_sender_id, watch_status, updated_at DESC, created_at DESC);
