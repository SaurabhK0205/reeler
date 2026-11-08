# REELER — Agent Instructions & Operating Rules

See [CLAUDE.md](./CLAUDE.md) for the complete, canonical rules and conventions governing this repository.

### Summary of Strict Invariants:
1. **Branching**: NEVER push or commit directly to `main`. Every unit of work must live on a dedicated branch (`feat/*`, `fix/*`, `refactor/*`, `chore/*`, `db/*`).
2. **Author Identity**: Commits must always be authored by `saurabhk0205 <saurabhk0205@gmail.com>`.
3. **Secrets**: Never commit `.env`, credentials, or access tokens.
4. **Architecture**: Endpoints call services; services call repository (`src/db/repository.ts`). No raw database calls in endpoints.
5. **Database**: All schema changes require a migration in `supabase/migrations/` and an update to `src/types.ts`.
6. **Instagram UX**: Use clean in-app `@username` mentions for creator profiles (no web URLs).
7. **Workspace Isolation**: Work strictly within `/Users/thismac/projects/instagram-saved-reels/`. Do not touch `/Users/thismac/rea/`.
