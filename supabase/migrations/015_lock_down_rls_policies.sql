-- ==============================================================================
-- Migration 015: Lock Down Over-Permissive Public RLS Policies on creators & saved_reels
-- ==============================================================================
-- Migration 001 created policies named "Allow service_role all on ..." without a
-- `TO service_role` clause, which in PostgreSQL applies to PUBLIC (including anon
-- and authenticated), alongside public SELECT policies. Because Reeler authenticates
-- users at the Express API boundary and connects to Supabase using service_role
-- (which bypasses RLS), direct anon/authenticated PostgREST access must be revoked.

ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_reels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read on creators" ON public.creators;
DROP POLICY IF EXISTS "Allow service_role all on creators" ON public.creators;
DROP POLICY IF EXISTS "Allow public read on saved_reels" ON public.saved_reels;
DROP POLICY IF EXISTS "Allow service_role all on saved_reels" ON public.saved_reels;

REVOKE ALL ON public.creators FROM anon, authenticated;
REVOKE ALL ON public.saved_reels FROM anon, authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'search_saved_reels'
  ) THEN
    REVOKE ALL ON FUNCTION public.search_saved_reels(TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.search_saved_reels(TEXT) TO service_role;
  END IF;
END $$;
