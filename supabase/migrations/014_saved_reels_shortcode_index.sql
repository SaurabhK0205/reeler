-- ==============================================================================
-- Migration 014: Restore non-partial shortcode index for shortcode-only lookups
-- ==============================================================================
-- Migration 013 replaced global UNIQUE(shortcode) with sender-scoped partial
-- unique indexes. This non-partial B-tree index preserves fast lookups for
-- shortcode-only queries (e.g. batch duplicate scans and unscoped metadata reuse).

CREATE INDEX IF NOT EXISTS idx_saved_reels_shortcode
  ON public.saved_reels (shortcode);
