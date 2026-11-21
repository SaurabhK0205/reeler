-- ==============================================================================
-- Migration 016: Composite index for sender-scoped Watch Later queries and cancel ordering
-- ==============================================================================

-- Deployment runners (including Supabase GitHub integration) execute migration scripts inside
-- an implicit transaction block (BEGIN ... COMMIT). To guarantee successful, atomic execution
-- across all deployment runners without failing, this index is created using standard
-- CREATE INDEX IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_saved_reels_sender_watch_updated
  ON public.saved_reels (instagram_sender_id, watch_status, updated_at DESC, created_at DESC);
