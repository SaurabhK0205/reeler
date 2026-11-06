-- ==============================================================================
-- Instagram Saved Reels Tracker: Initial Schema (Supabase / PostgreSQL)
-- ==============================================================================

-- 1. Creators Table
CREATE TABLE IF NOT EXISTS public.creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_user_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  profile_picture_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_creators_username ON public.creators(username);

-- 2. Saved Reels Table
CREATE TABLE IF NOT EXISTS public.saved_reels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_media_id TEXT UNIQUE NOT NULL,
  shortcode TEXT UNIQUE NOT NULL,
  reel_url TEXT NOT NULL,
  creator_id UUID NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  caption TEXT,
  thumbnail_url TEXT,
  taken_at TIMESTAMPTZ NOT NULL,            -- Publication date of the Reel
  saved_at TIMESTAMPTZ,                     -- Exact save date (null for historical items)
  first_detected_at TIMESTAMPTZ NOT NULL,   -- First observed date
  save_order_rank BIGINT NOT NULL,          -- Relative save order (1 = newest)
  watch_status TEXT NOT NULL DEFAULT 'unwatched' CHECK (watch_status IN ('unwatched', 'watched', 'watch_later')),
  duration_seconds NUMERIC,
  is_unavailable BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 3. High-Performance Indexes for 10,000+ Items
CREATE INDEX IF NOT EXISTS idx_reels_creator_id ON public.saved_reels(creator_id);
CREATE INDEX IF NOT EXISTS idx_reels_first_detected_at ON public.saved_reels(first_detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_reels_saved_at ON public.saved_reels(saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_reels_order_rank ON public.saved_reels(save_order_rank ASC);
CREATE INDEX IF NOT EXISTS idx_reels_watch_status ON public.saved_reels(watch_status);
CREATE INDEX IF NOT EXISTS idx_reels_creator_watch ON public.saved_reels(creator_id, watch_status);

-- 4. PostgreSQL Full-Text Search GIN Index
CREATE INDEX IF NOT EXISTS idx_reels_caption_fts ON public.saved_reels 
USING GIN (to_tsvector('english', coalesce(caption, '')));

-- 5. Helper Function: Search Reels by Keyword across Caption and Creator
CREATE OR REPLACE FUNCTION public.search_reels(query_text TEXT)
RETURNS SETOF public.saved_reels AS $$
BEGIN
  RETURN QUERY
  SELECT r.*
  FROM public.saved_reels r
  JOIN public.creators c ON r.creator_id = c.id
  WHERE 
    to_tsvector('english', coalesce(r.caption, '')) @@ plainto_tsquery('english', query_text)
    OR c.username ILIKE '%' || query_text || '%'
    OR c.display_name ILIKE '%' || query_text || '%'
  ORDER BY r.save_order_rank ASC;
END;
$$ LANGUAGE plpgsql STABLE;

-- 6. Row Level Security (RLS)
ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_reels ENABLE ROW LEVEL SECURITY;

-- Allow read & write for service_role and anon/authenticated users (personal project setup)
CREATE POLICY "Allow public read on creators" ON public.creators FOR SELECT USING (true);
CREATE POLICY "Allow service_role all on creators" ON public.creators USING (true) WITH CHECK (true);

CREATE POLICY "Allow public read on saved_reels" ON public.saved_reels FOR SELECT USING (true);
CREATE POLICY "Allow service_role all on saved_reels" ON public.saved_reels USING (true) WITH CHECK (true);
