# REELER — Agent Instructions & Operating Rules

See [CLAUDE.md](./CLAUDE.md) for the complete, canonical rules and conventions governing this repository.

### Frontend Work — Impeccable Design Review (MANDATORY)

**Setup (once per environment):** Install Impeccable via `npx impeccable install` (see the [Impeccable installation guide](https://github.com/pbakaus/impeccable#installation)) and reload your coding tool so `/impeccable` passes (or `$impeccable` passes on Codex) are available.

Whenever you touch `public/` (HTML, CSS, JS) or any user-facing template, run Impeccable design review passes **before each frontend commit** (including PR review follow-ups before pushing/updating a PR). On Codex, invoke the matching `$impeccable <pass>` prompt (for example `$impeccable critique`) instead of `/impeccable <pass>`:

| Pass | Slash Command | Codex Invocation | Focus |
|------|---------------|------------------|-------|
| Critique | `/impeccable critique` | `$impeccable critique` | Full audit: contrast, spacing, hierarchy, accessibility |
| Layout | `/impeccable layout` | `$impeccable layout` | Grid density, spacing scale, visual scan paths |
| Typeset | `/impeccable typeset` | `$impeccable typeset` | Font hierarchy, pairings, vertical rhythm |
| Animate | `/impeccable animate` | `$impeccable animate` | Purposeful micro-interactions and transitions |
| Adapt | `/impeccable adapt` | `$impeccable adapt` | Responsive breakpoints, mobile density (≥44px touch targets), SE/landscape |
| Harden | `/impeccable harden` | `$impeccable harden` | Empty states, errors, long captions, edge cases |
| Polish | `/impeccable polish` | `$impeccable polish` | Final craft pass: spacing, alignment, interactive states |

Run the full 7-pass suite for feature/UI changes, and at minimum `critique` + `polish` + `harden` for small isolated tweaks. Address every finding or document why it was intentionally waived in the PR body. (Optional: `audit`, `clarify`, `colorize`, `bolder`, `quieter`, `distill`, `onboard`.)

---

### Design Engineering & Animation — Emil Kowalski Rules (MANDATORY)

**Setup (once per environment):** Install Emil Kowalski's design engineering skills (or link them under `.agents/skills/` or `.claude/skills/`, both gitignored):
- `emil-design-eng`: Core philosophy, micro-states, tactile feedback, review format
- `animate` & `improve-animations`: Physics, spring curves, easing, spatial choreography
- `animation-performance`: GPU acceleration, zero layout thrashing, `will-change`, `contain: layout paint`
- `choreograph`: Staggered entrances, hierarchy, spatial consistency

**Invariants for all UI & Motion work:**
1. **The Decision Framework:**
   - 100+ times/day actions (keyboard shortcuts, rapid feed paging): NEVER animate. Must feel instantaneous.
   - Occasional actions (modals, drawers, dialogs): Spatial entrance (scale from 0.95-0.97 + opacity, never scale(0)).
   - Always use `ease-out` (starts fast, feels responsive) on entering, and fast `ease-in` on exit.
2. **Tactile Feedback Requirement:**
   - Every interactive control (buttons, cards, chips, toggles) MUST have an `:active` state (typically `scale(0.92)` to `scale(0.97)` over ~0.08s) so users feel the interface heard and acknowledged their touch/click.
3. **Performance & Containment:**
   - Animate `transform` and `opacity` only. Never animate layout properties (`width`, `height`, `margin`, `padding`, `top`, `left`).
   - When dynamic container resizing is required (e.g. adaptive video viewports), apply `contain: layout paint` to prevent document-wide reflows.
4. **Mandatory Review Format:**
   - When reviewing or proposing UI animation/craft changes, ALWAYS output a markdown table with `| Before | After | Why |` columns. Never use informal bullet lists.
5. **Reduced Motion:**
   - Respect `@media (prefers-reduced-motion: reduce)` by disabling transitions/animations or removing dynamic scale/movement (e.g. `transition: none` or resetting animating scales to 1), while strictly preserving static positioning transforms (such as `translate(-50%, -50%)` dialog centering) so layout never breaks.

---

### Engineering Reliability — GRAVITAS Workflow (MANDATORY)

**Setup (once per environment):** Install the GRAVITAS skill via `npx skills add udaysharmadev/Gravitas --skill gravitas --agent antigravity --yes` (or `--agent claude-code` for Claude Code; see [udaysharmadev/Gravitas](https://github.com/udaysharmadev/Gravitas)) and reload your coding tool. In this repository, keep local skill symlinks under `.agents/skills/` or `.claude/skills/` (both gitignored).

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
6. **Instagram UX**: Include clickable creator profile links (`https://www.instagram.com/<username>/` paired with `@<username>`) when a valid Instagram handle exists (placing Reel URLs before profile URLs in reminders to preserve video card previews), never leak raw shortcodes in user-facing DMs or UI, and treat `"watched"` as single-latest-reel unless `"stop all"` / `"watched all"` is requested.
7. **Workspace Isolation**: Work strictly within `/Users/thismac/projects/instagram-saved-reels/`. Do not touch `/Users/thismac/rea/`.
8. **CodeRabbit Review Gate (MANDATORY & BLOCKING)**:
   - **NEVER merge a Pull Request immediately.**
   - **ALWAYS wait for CodeRabbit AI review to run and complete** on the current head commit of every opened PR before merging.
   - **NEVER merge while CodeRabbit findings remain open, in-progress, or unaddressed.**
   - Whenever CodeRabbit comments or points out any issues (bugs, regressions, security, edge cases, architecture, or code improvements):
     1. Inspect each finding thoroughly.
     2. For valid findings: implement fixes on the topic branch, verify tests (`npm test`), and push.
     3. For invalid findings or false positives: provide an evidence-based explanation and documented reasoning in the review reply.
     4. Reply to each CodeRabbit review comment thread explaining the resolution citing the commit.
     5. Resolve every review thread using GitHub GraphQL `resolveReviewThread` after verifying the fix, or after posting the evidence-based explanation for an invalid finding or false positive.
   - Recheck review status after every push. Only merge after CodeRabbit completes its review on the final head commit and all findings are confirmed resolved and verified.
   - **No tight polling loops**: Never run tight sleep loops polling GitHub or CodeRabbit status.
