# REELER — Agent Instructions & Operating Rules

See [CLAUDE.md](./CLAUDE.md) for the complete, canonical rules and conventions governing this repository.

### Frontend Work — Impeccable Design Review (MANDATORY)

**Setup (once per environment):** Install Impeccable via `npx impeccable install` (see the [Impeccable installation guide](https://github.com/pbakaus/impeccable#installation)) and reload your coding tool so `/impeccable` passes are available.

Whenever you touch `public/` (HTML, CSS, JS) or any user-facing template, run Impeccable design review passes **before each frontend commit** (including PR review follow-ups before pushing/updating a PR):

| Pass | Command | Focus |
|------|---------|-------|
| Critique | `/impeccable critique` | Full audit: contrast, spacing, hierarchy, accessibility |
| Layout | `/impeccable layout` | Grid density, spacing scale, visual scan paths |
| Typeset | `/impeccable typeset` | Font hierarchy, pairings, vertical rhythm |
| Animate | `/impeccable animate` | Purposeful micro-interactions and transitions |
| Adapt | `/impeccable adapt` | Responsive breakpoints, mobile density (≥44px touch targets), SE/landscape |
| Harden | `/impeccable harden` | Empty states, errors, long captions, edge cases |
| Polish | `/impeccable polish` | Final craft pass: spacing, alignment, interactive states |

Run the full 7-pass suite for feature/UI changes, and at minimum `critique` + `polish` + `harden` for small isolated tweaks. Address every finding or document why it was intentionally waived in the PR body. (Optional: `audit`, `clarify`, `colorize`, `bolder`, `quieter`, `distill`, `onboard`.)

---

### Engineering Reliability — GRAVITAS Workflow (MANDATORY)

**Setup (once per environment):** Install the GRAVITAS skill via `npx skills add udaysharmadev/Gravitas --skill gravitas --agent antigravity --yes` (see [udaysharmadev/Gravitas](https://github.com/udaysharmadev/Gravitas)) and reload your coding tool. In this repository, keep local skill symlinks under `.agents/skills/` (gitignored).

Follow GRAVITAS invariants for implementation, debugging, refactoring, review, and migrations:
1. **Ground before mutating:** Read target files, their callers, and relevant tests before editing. Never act on assumed file state.
2. **Adaptive planning:** Scale planning to risk (`direct` for localized 1-file edits, `compact` for multi-file dependencies, `deep` for architecture/security/schema work). Record scope and acceptance criteria for non-trivial changes.
3. **Evidence-backed completion:** Run targeted and regression checks (`npm test`, typecheck, and/or GRAVITAS `scripts/run-checks.sh`) **after the final relevant edit** and base completion claims only on observed output (`VERDICT: PASS` / `VERDICT: FAIL`).
4. **Never exact-retry a failure:** Change diagnosis, context, or strategy before retrying a failed command or edit.
5. **State unknowns honestly:** Explicitly report anything not verified or runnable in the current environment instead of assuming it passes.

---

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
