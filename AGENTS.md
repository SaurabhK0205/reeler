# REELER — Agent Instructions & Operating Rules

See [CLAUDE.md](./CLAUDE.md) for the complete, canonical rules and conventions governing this repository.

### Summary of Strict Invariants:
1. **Branching**: NEVER push or commit directly to `main` or `staging`. Every unit of work must live on a dedicated branch (`feat/*`, `fix/*`, `refactor/*`, `chore/*`, `db/*`).
2. **Author Identity**: Commits must always be authored by `saurabhk0205 <saurabhk0205@gmail.com>`.
3. **Secrets**: Never commit `.env`, credentials, or access tokens.
4. **Architecture**: Endpoints call services; services call repository (`src/db/repository.ts`). No raw database calls in endpoints.
5. **Database**: All schema changes require a migration in `supabase/migrations/` and an update to `src/types.ts`.
6. **Instagram UX**: Use clean in-app `@username` mentions for creator profiles (no web URLs).
7. **Workspace Isolation**: Work strictly within `/Users/thismac/projects/instagram-saved-reels/`. Do not touch `/Users/thismac/rea/`.
8. **CodeRabbit Review Gate (MANDATORY & BLOCKING)**:
   - **NEVER merge a Pull Request immediately.**
   - **ALWAYS wait for CodeRabbit AI review to run and complete** on the current head commit of every opened PR before merging.
   - **NEVER merge while CodeRabbit findings remain open or unaddressed.**
   - Whenever CodeRabbit comments or points out any issues (bugs, regressions, security, edge cases, architecture, or code improvements):
     1. Inspect each finding thoroughly.
     2. For valid findings: implement fixes on the topic branch (or a dedicated topic branch if the PR is a promotion branch), verify tests (`npm test`), and push.
     3. For invalid findings or false positives: provide an evidence-based explanation and documented reasoning in the review reply.
     4. Reply to each CodeRabbit review comment thread explaining the resolution.
   - Recheck review status after every push. Only merge after CodeRabbit completes its review on the final head commit and all findings are confirmed resolved and verified.
   - **No tight polling loops**: Never run tight sleep loops polling GitHub or CodeRabbit status.
