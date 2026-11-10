-- ==============================================================================
-- Migration 009: Separate Instagram Saved Items vs DM Bot-Sent Items
-- ==============================================================================

-- Ensure existing NULL flags default cleanly to native Instagram Saved (true)
UPDATE public.saved_reels
SET is_saved_on_instagram = true
WHERE is_saved_on_instagram IS NULL;

ALTER TABLE public.saved_reels
  ALTER COLUMN is_saved_on_instagram SET DEFAULT true,
  ALTER COLUMN is_saved_on_instagram SET NOT NULL;

-- Reclassify historical items ingested exclusively via the DM bot
-- (DM synthetic media ID without any saved_posts.json archive bookmark timestamp)
UPDATE public.saved_reels
SET
  is_saved_on_instagram = false,
  updated_at = now()
WHERE is_saved_on_instagram IS DISTINCT FROM false
  AND saved_at IS NULL
  AND (
    instagram_media_id LIKE 'shortcode\_%' ESCAPE '\'
    OR instagram_media_id LIKE 'id\_%' ESCAPE '\'
  );

-- Composite indexes for collection-filtered timeline sorting and overview counts
CREATE INDEX IF NOT EXISTS idx_saved_reels_source_effective_desc
  ON public.saved_reels(is_saved_on_instagram, effective_saved_at DESC, save_order_rank ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_saved_reels_source_effective_asc
  ON public.saved_reels(is_saved_on_instagram, effective_saved_at ASC, save_order_rank DESC, id ASC);

CREATE INDEX IF NOT EXISTS idx_saved_reels_source_status_type
  ON public.saved_reels(is_saved_on_instagram, watch_status, media_type);
