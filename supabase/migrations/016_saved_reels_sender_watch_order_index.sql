-- ==============================================================================
-- Migration 016: Composite index for sender-scoped Watch Later queries and cancel ordering
-- ==============================================================================

-- Supabase migration runner executes migration scripts inside an implicit transaction block (BEGIN ... COMMIT).
-- PostgreSQL disallows CREATE INDEX CONCURRENTLY inside a transaction block (SQLSTATE 25001).
-- We use standard CREATE INDEX IF NOT EXISTS to guarantee transaction-safe migration execution.
CREATE INDEX IF NOT EXISTS idx_saved_reels_sender_watch_updated
  ON public.saved_reels (instagram_sender_id, watch_status, updated_at DESC, created_at DESC);
