-- ==============================================================================
-- Migration 007: Explicit Saved Media Type Isolation ('reel' vs 'post')
-- ==============================================================================

ALTER TABLE public.saved_reels
  ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'reel'
  CHECK (media_type IN ('reel', 'post'));

-- Backfill existing rows from canonical reel_url path (/p/ -> 'post', /reel/ or /reels/ or /tv/ -> 'reel')
UPDATE public.saved_reels
SET media_type = CASE
  WHEN reel_url ~* 'instagram\.com/([a-zA-Z0-9._]+/)?p/' THEN 'post'
  ELSE 'reel'
END
WHERE media_type IS DISTINCT FROM CASE
  WHEN reel_url ~* 'instagram\.com/([a-zA-Z0-9._]+/)?p/' THEN 'post'
  ELSE 'reel'
END;

CREATE INDEX IF NOT EXISTS idx_saved_reels_media_type
  ON public.saved_reels(media_type);

CREATE INDEX IF NOT EXISTS idx_saved_reels_creator_media_type
  ON public.saved_reels(creator_id, media_type);
