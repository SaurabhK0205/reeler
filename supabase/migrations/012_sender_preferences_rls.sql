-- ==============================================================================
-- Migration 012: Enable Row Level Security on sender_preferences
-- ==============================================================================

ALTER TABLE public.sender_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sender_preferences FROM anon, authenticated;
