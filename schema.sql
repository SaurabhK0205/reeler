-- ==============================================================================
-- REELER: Complete Consolidated Database Schema (PostgreSQL / Supabase)
-- ==============================================================================
-- This file contains the complete, canonical schema script for self-hosting or
-- initializing a local or production database in a single execution.
--
-- RULE: Whenever a new migration is created or any change is made to the
-- database schema, this schema.sql file MUST be kept updated in sync.
-- ==============================================================================

-- 0. Required Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. Creators Table
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_user_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  profile_picture_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_creators_username
  ON public.creators(username);

-- ==============================================================================
-- 2. Saved Reels & Posts Table
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.saved_reels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_media_id TEXT UNIQUE NOT NULL,
  shortcode TEXT NOT NULL,
  reel_url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'reel' CHECK (media_type IN ('reel', 'post')),
  creator_id UUID NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  caption TEXT,
  thumbnail_url TEXT,
  taken_at TIMESTAMPTZ NOT NULL,            -- Publication date of the Reel/Post
  saved_at TIMESTAMPTZ,                     -- Exact save date (null for historical items)
  first_detected_at TIMESTAMPTZ NOT NULL,   -- First observed date
  effective_saved_at TIMESTAMPTZ GENERATED ALWAYS AS (COALESCE(saved_at, first_detected_at)) STORED,
  save_order_rank BIGINT NOT NULL,          -- Relative save order (1 = newest)
  watch_status TEXT NOT NULL DEFAULT 'unwatched' CHECK (watch_status IN ('unwatched', 'watched', 'watch_later')),
  duration_seconds NUMERIC,
  is_unavailable BOOLEAN DEFAULT false,
  reminder_interval_hours INTEGER DEFAULT 10,
  reminder_interval_seconds INTEGER DEFAULT 36000,
  reminders_sent_count INTEGER DEFAULT 0,
  last_reminded_at TIMESTAMPTZ,
  next_reminder_at TIMESTAMPTZ,
  awaiting_reminder_choice_until TIMESTAMPTZ DEFAULT NULL,
  is_saved_on_instagram BOOLEAN NOT NULL DEFAULT true,
  telegram_chat_id TEXT,
  instagram_sender_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Shortcode Uniqueness:
-- Multi-user partial unique index for per-sender shortcodes, plus unattributed index for admin/archive imports.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_reels_sender_shortcode_unique
  ON public.saved_reels (instagram_sender_id, shortcode)
  WHERE instagram_sender_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_reels_unattributed_shortcode_unique
  ON public.saved_reels (shortcode)
  WHERE instagram_sender_id IS NULL;

-- Fast B-tree index for shortcode-only lookups (batch scans, metadata reuse)
CREATE INDEX IF NOT EXISTS idx_saved_reels_shortcode
  ON public.saved_reels (shortcode);

-- Creator & Foreign Key Indexes
CREATE INDEX IF NOT EXISTS idx_reels_creator_id
  ON public.saved_reels(creator_id);

CREATE INDEX IF NOT EXISTS idx_reels_creator_watch
  ON public.saved_reels(creator_id, watch_status);

CREATE INDEX IF NOT EXISTS idx_saved_reels_creator_media_type
  ON public.saved_reels(creator_id, media_type);

-- Timeline & Sorting Indexes
CREATE INDEX IF NOT EXISTS idx_reels_first_detected_at
  ON public.saved_reels(first_detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_reels_saved_at
  ON public.saved_reels(saved_at DESC);

CREATE INDEX IF NOT EXISTS idx_reels_order_rank
  ON public.saved_reels(save_order_rank ASC);

CREATE INDEX IF NOT EXISTS idx_saved_reels_effective_saved_at_desc
  ON public.saved_reels(effective_saved_at DESC, save_order_rank ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_saved_reels_effective_saved_at_asc
  ON public.saved_reels(effective_saved_at ASC, save_order_rank DESC, id ASC);

-- Filter & Source Indexes
CREATE INDEX IF NOT EXISTS idx_reels_watch_status
  ON public.saved_reels(watch_status);

CREATE INDEX IF NOT EXISTS idx_saved_reels_media_type
  ON public.saved_reels(media_type);

CREATE INDEX IF NOT EXISTS idx_saved_reels_source_effective_desc
  ON public.saved_reels(is_saved_on_instagram, effective_saved_at DESC, save_order_rank ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_saved_reels_source_effective_asc
  ON public.saved_reels(is_saved_on_instagram, effective_saved_at ASC, save_order_rank DESC, id ASC);

CREATE INDEX IF NOT EXISTS idx_saved_reels_source_status_type
  ON public.saved_reels(is_saved_on_instagram, watch_status, media_type);

-- Reminders & Scheduling Indexes
CREATE INDEX IF NOT EXISTS idx_reels_reminder_due
  ON public.saved_reels(next_reminder_at)
  WHERE watch_status = 'watch_later';

CREATE INDEX IF NOT EXISTS idx_saved_reels_awaiting_choice
  ON public.saved_reels(awaiting_reminder_choice_until)
  WHERE awaiting_reminder_choice_until IS NOT NULL;

-- Multi-User & Channel Indexes
CREATE INDEX IF NOT EXISTS idx_reels_instagram_sender_id
  ON public.saved_reels(instagram_sender_id);

CREATE INDEX IF NOT EXISTS idx_saved_reels_sender_id_id
  ON public.saved_reels(instagram_sender_id, id);

CREATE INDEX IF NOT EXISTS idx_saved_reels_sender_watch_updated
  ON public.saved_reels(instagram_sender_id, watch_status, updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reels_telegram_chat_id
  ON public.saved_reels(telegram_chat_id);

-- PostgreSQL Full-Text Search GIN Index
CREATE INDEX IF NOT EXISTS idx_reels_caption_fts
  ON public.saved_reels
  USING GIN (to_tsvector('english', coalesce(caption, '')));

-- ==============================================================================
-- 3. Sender Preferences Table (Multi-User Timezones & Settings)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.sender_preferences (
  sender_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_sender_preferences_sender_id
  ON public.sender_preferences(sender_id);

-- ==============================================================================
-- 4. Helper Function: Search Reels by Keyword across Caption and Creator
-- ==============================================================================
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

-- ==============================================================================
-- 5. Row Level Security (RLS) & Access Permissions
-- ==============================================================================
-- Reeler authenticates requests at the Express API layer and accesses the database
-- via Supabase service_role key (which bypasses RLS). Direct anonymous and
-- authenticated client-side PostgREST access is strictly revoked.

ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_reels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sender_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.creators FROM anon, authenticated;
REVOKE ALL ON public.saved_reels FROM anon, authenticated;
REVOKE ALL ON public.sender_preferences FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.search_reels(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_reels(TEXT) TO service_role;
