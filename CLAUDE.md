# REELER (Instagram Saved Reels Tracker & Reminder OS) — CLAUDE.md

Stack: Node.js (v24+ with native `--experimental-strip-types`) + Express.js + Supabase (PostgreSQL) + Meta Graph API (Instagram Messaging Webhooks) + Render
Repository: SaurabhK0205/reeler
Last updated: November 23, 2026

---

## 1. Git, Branching & Release Promotion Rules (CRITICAL — NEVER VIOLATE)

1. **NEVER push directly to `main` or `staging`.**
2. **NEVER commit work directly onto `main` or `staging`.** Always verify your current branch before making changes:
   ```bash
   git branch --show-current
   ```
3. **Every unit of work MUST have its own isolated branch** branched off latest `staging`:
   - `feat/<feature-name>`   -> New user-facing or backend features (e.g. `feat/reminder-calendar`)
   - `fix/<bug-name>`       -> Bug fixes & UX defect repairs (e.g. `fix/in-app-mentions`)
   - `refactor/<target>`     -> Code refactoring without behavior change (e.g. `refactor/metadata-resolver`)
   - `chore/<task>`          -> Tooling, configs, docs, dependency upgrades (e.g. `chore/agent-guidelines`)
   - `db/<migration-name>`   -> Database schema additions and migrations (e.g. `db/awaiting-choice-column`)
4. **Author identity requirement**:
   Every commit MUST be configured and authored as:
   ```
   user.name:  saurabhk0205
   user.email: saurabhk0205@gmail.com
   ```
5. **Use Conventional Commits**:
   - `feat(...)`: new functionality
   - `fix(...)`: bug fix
   - `refactor(...)`: refactoring
   - `chore(...)`: tooling/config/dependencies
   - `docs(...)`: documentation
   - `test(...)`: unit/integration tests
6. **Environment Roles & Staging-First Promotion Workflow (MANDATORY)**:
   - **`staging` (Testing Environment)**: Deployed at `reeler-staging` strictly for testing and verification. Every fix, push, change, or feature MUST merge into `staging` via Pull Request first.
   - **`main` (Production Environment)**: Once Meta App Review is approved, `main` becomes the live production deployment serving all users, while `staging` remains testing-only.
   - **Promotion Flow**:
     1. Push your topic branch: `git push -u origin <branch-name>`.
     2. Open a Pull Request into `staging`, pass tests + CodeRabbit review, and merge into `staging`.
     3. Verify the change live on the deployed `staging` environment (`reeler-staging`).
     4. Only after everything is verified healthy on `staging`, open a promotion PR from `staging` -> `main` (regular merge, preserving shared history) to release to production. The promotion PR head commit MUST be the exact commit verified on `reeler-staging`; if any new commit lands on `staging` before merge, re-verify the updated head on `reeler-staging` before merging into `main`.
     5. Never merge a feature/fix branch directly into `main` bypassing `staging`.
7. **CodeRabbit Review Gate (MANDATORY & BLOCKING)**:
   - When opening a Pull Request, **NEVER merge immediately**.
   - **ALWAYS wait for CodeRabbit AI review to run and complete** on the current PR head commit before merging.
   - **NEVER merge while CodeRabbit review findings remain open, in-progress, or unaddressed**.
   - Whenever CodeRabbit posts review comments or findings:
     1. Inspect each finding thoroughly (bugs, security, architecture, performance, edge cases).
     2. For valid findings on topic branches: implement fixes on the branch, verify unit tests (`npm test`), and push.
     3. For promotion PRs (e.g. `staging` -> `main`): route fixes through a separate topic-branch PR into `staging`, rather than pushing directly to `staging`.
     4. For invalid findings or false positives: reply to the review thread with an evidence-based explanation and documented reasoning.
     5. Reply to each CodeRabbit review comment thread explaining the resolution citing the commit.
     6. Resolve every review thread using GitHub GraphQL `resolveReviewThread` after verifying the fix, or after posting the evidence-based explanation for an invalid finding or false positive.
   - **Incremental Re-Checks Must Complete (CRITICAL)**: Whenever a fix commit is pushed to address review feedback, CodeRabbit automatically triggers an incremental re-review (indicated by the `review in progress` state in its PR comment). You **MUST NEVER merge while a re-check or incremental review is running**. You must wait for the re-check to finish completely—confirming that the in-progress state is cleared, the final review report is posted, all pre-merge checks pass, and zero new findings or open threads remain. Only merge when re-checking is 100% complete and everything is positive.
   - **NO tight polling loops**: Never run tight sleep loops polling GitHub or CodeRabbit status.
8. **Commit Message Invariant & Zero-Emoji Policy**:
   - Every commit must follow Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`).
   - Strict zero-emoji policy in commit subjects and descriptions. Imperative, concise subjects only.

---

## 2. Pre-Session Rule

Before writing any code or executing commands:
1. **Branch Check**: Run `git branch --show-current`. If you are on `main` or `staging`, fetch `origin` and immediately checkout a new topic branch off `origin/staging`:
   ```bash
   git fetch origin
   git checkout -b <type>/<descriptive-name> origin/staging
   ```
2. **Environment & Secrets Check**: Run `git status` to ensure `.env` and local credentials remain untracked.
3. **Running Tasks Check**: Check if the Node server (port 3000) and Cloudflare tunnel are active before restarting them.
4. **Before Pushing**:
   - Run linter: `npm run lint` (ESLint 10 with TypeScript must pass with 0 errors).
   - Run security audit: `npm audit --audit-level=high` (must find 0 vulnerabilities).
   - Run test suite: `npm test` (all 24 test suites must pass).
   - Verify `git diff --cached` contains ZERO secrets, tokens, or `.env` entries.

---

## 3. Shared Metaphor — Use these exact terms everywhere

```
Saved Reel / Post       → saved_reel, saved_reels with media_type ('reel' | 'post')
Collection Source       → is_saved_on_instagram (boolean) / SavedCollectionSource ('instagram' | 'bot')
Collection Filter       → ReelQueryFilters.source ('all' | 'instagram' | 'bot')
Media Type              → media_type ('reel' for /reel/, /reels/, /tv/; 'post' for /p/ photo & carousel posts)
Creator                 → creator, creators (not author, user, influencer)
Shortcode               → shortcode (exact 11-char Instagram identifier, e.g. Db4eVUcsoTh)
Instagram Sender ID     → instagram_sender_id (exact IGSID string from webhook, not chat_id, user_id)
Watch Status            → watch_status ('unwatched', 'watched', 'watch_later')
Reminder Interval       → reminder_interval_seconds, reminder_interval_hours
Awaiting Choice Window  → awaiting_reminder_choice_until (10-minute window for user custom reminder prompt)
Next Reminder At        → next_reminder_at (ISO timestamp when reminder fires)
Reminders Sent Count    → reminders_sent_count (integer counter)
```

---

## 4. Architecture & Layering Rules

Dependencies flow inward: `API Layer` → `Service Layer` → `Database Layer` → `Utility Layer`.

```
src/
├── api/             → HTTP routes and webhook endpoints ONLY
├── services/        → Business logic, bots, workers, metadata resolution
├── db/              → Supabase client and database queries
├── utils/           → Pure utility parsers and helpers
└── types.ts         → Shared TypeScript interfaces & types
```

### Backend Rules
1. **Endpoints call services and repository. Never skip layers.**
   - No business logic in `src/api/router.ts`.
   - No database queries in `src/api/router.ts`.
2. **Database operations belong exclusively in `src/db/repository.ts`.**
   - Never write raw Supabase `.from(...)` queries inside services or route handlers.
3. **All database changes require a migration file in `supabase/migrations/` AND keeping `schema.sql` updated:**
   - Format: `XXX_<name>.sql` (e.g. `007_user_preferences.sql`).
   - Push migrations using:
     ```bash
     /opt/homebrew/bin/supabase db push --remote
     ```
   - Always update `src/types.ts` and the root `schema.sql` whenever database schema changes so local self-hosting scripts remain current.
4. **Duration & Date Parsing:**
   - Always use `src/utils/duration.ts` (`parseDurationOrDateInput`).
   - Never write ad-hoc date/regex parsing in services or route handlers.
5. **Instagram In-App DM UX Rules:**
   - **Creator Attribution & Native Mention UX**: Meta Graph API DMs in Instagram Mobile natively linkify clean `@username` mentions (e.g. `Creator: @username` or `⏰ Reminder set for @username:`) into tappable profile links. Do NOT append raw profile URLs (`https://www.instagram.com/<username>/` or `👤 Profile:` / `👤 Creator Profile:`) to DM messages. Raw profile URLs wrap across lines in mobile DMs, clutter messages, and trigger unwanted OpenGraph profile preview cards that conflict with or override Reel media card previews.
   - **Bracketed Handle Guidance & Non-Linking Placeholders**: When showing example command copy in help prompts or UI badges, use `@[creator]` instead of bare `@creator` so Instagram's mobile client does not linkify the placeholder into a real third-party Instagram profile.
   - **Human Copy Over AI Slop**: Keep bot messages natural, concise, and friendly. Avoid robotic AI dashes (`—` or `--`) in user-facing message strings.
   - **Canonical Media URLs & Type Isolation**: Preserve canonical `/p/` URLs for photo/carousel Posts and `/reel/` (or `/tv/`) URLs for Reels—never rewrite a `/p/` shortcode to `/reel/`. When a creator has both saved Reels and saved Posts, split creator-search DMs into separate `🎬 Latest Reels` and `🖼️ Latest Posts` sections and support explicit `"reels by @username"` / `"posts by @username"` filters.
   - **Human-Readable Reel Labels**: Never expose raw shortcodes (e.g. `Da1iWbSMAOz`) in user-facing DM copy or the frontend UI; identify items by creator handle, media type (`reel` vs `post`), caption snippet, save/send date, or `"your saved reel"` / `"that reel"` based on collection membership.
   - **Saved on IG vs Sent to Bot Integrity**: New DM webhook items MUST set `is_saved_on_instagram = false` and `saved_at = null` (category `'bot'`), preserve existing IG-saved flags/dates when a previously saved item is shared to the bot, never claim an item was bookmarked to Instagram Saved unless `saveMedia` succeeded (`savedOnIg === true`), support full triage/Watch Later/reminder parity on both categories, and automatically promote `'bot'` items (`false -> true`, backfilling archive `saved_at` while preserving `watch_status`, reminders, captions, and `instagram_sender_id`) when a subsequent `saved_posts.json` archive import includes matching shortcodes.
   - When a user shares a reel, prompt them for custom reminder timing with a **10-minute window**. If no reply within 10 minutes, default to **10 hours**.
   - When a user sends `"watched"` / `"done"` / `"stop"`, mark the **most recently reminded / latest active** Watch Later reel as watched and clear both `next_reminder_at` and `awaiting_reminder_choice_until` (using `"stop all"` / `"watched all"` for bulk clearing all pending Watch Later reels).

---

## 5. Frontend Work — Impeccable Design Review (MANDATORY)

**Setup (once per environment):** Install Impeccable via `npx impeccable install` (see the [Impeccable installation guide](https://github.com/pbakaus/impeccable#installation)) and reload your coding tool so `/impeccable` passes (or `$impeccable` passes on Codex) are available.

Whenever you modify anything under `public/` (HTML, CSS, or JS) or any user-facing template, run Impeccable design review passes **before committing any frontend change** (including fixes requested during PR review before pushing or updating the PR). On Codex, invoke `$impeccable <pass>` (for example `$impeccable critique`) instead of `/impeccable <pass>`.

### Required Passes

| Pass | Slash Command | Codex Invocation | Focus Area |
|------|---------------|------------------|------------|
| **Critique** | `/impeccable critique` | `$impeccable critique` | Full audit: contrast ratios, spacing, visual hierarchy, accessibility |
| **Layout** | `/impeccable layout` | `$impeccable layout` | Grid density, spacing scale, visual scanning paths |
| **Typeset** | `/impeccable typeset` | `$impeccable typeset` | Font hierarchy, pairings, line-height, vertical rhythm |
| **Animate** | `/impeccable animate` | `$impeccable animate` | Purposeful micro-interactions, transitions, reduced-motion support |
| **Adapt** | `/impeccable adapt` | `$impeccable adapt` | Responsive breakpoints, mobile density (≥44px touch targets), SE/landscape |
| **Harden** | `/impeccable harden` | `$impeccable harden` | Empty states, error states, long captions, offline / skeleton edge cases |
| **Polish** | `/impeccable polish` | `$impeccable polish` | Final craft pass: alignment, interactive states, focus rings, hover states |

### Rules

1. Run the required passes **before each frontend commit** — when opening a PR and when pushing review follow-up commits.
2. Run the full 7-pass suite above for feature, layout, or UI changes; for small isolated CSS/JS tweaks, run at minimum `/impeccable critique`, `/impeccable polish`, and `/impeccable harden` (or `$impeccable critique`, `$impeccable polish`, and `$impeccable harden` on Codex).
3. For every finding either: implement the fix, or document in the PR body why it was intentionally waived with a rationale.
4. Never push a frontend commit that leaves a `critique` or `harden` finding unaddressed without an explicit documented reason.
5. `audit`, `clarify`, `colorize`, `bolder`, `quieter`, `distill`, and `onboard` are optional but recommended when auditing or redesigning a surface.

---

## 6. Design Engineering & Animation — Emil Kowalski Rules (MANDATORY)

**Setup (once per environment):** Install Emil Kowalski's design engineering skills (or link them under `.agents/skills/` or `.claude/skills/`, both gitignored):
- `emil-design-eng`: Core philosophy, micro-states, tactile feedback, review format
- `animate` & `improve-animations`: Physics, spring curves, easing, spatial choreography
- `animation-performance`: GPU acceleration, zero layout thrashing, `will-change`, `contain: layout paint`
- `choreograph`: Staggered entrances, hierarchy, spatial consistency

### Invariants for all UI & Motion work:
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

## 7. Frontend Craft & Anti-Slop Design: Hallmark Skill (MANDATORY FOR UI WORK)

**Setup (once per environment):** Hallmark is installed globally at `~/.agents/skills/hallmark` (or symlinked under `.agents/skills/hallmark`, gitignored).

Whenever creating new frontend pages, designing components, or performing post-approval UI redesigns under `public/`:
1. **The Floor (Anti-AI-Slop Invariants):**
   - Strictly tokenized colors and fonts at `:root`. No raw hex codes or untokenized inline values in `public/style.css`.
   - Never `transition: all`. Animate `transform` and `opacity` only (zero layout thrashing).
   - Enforce `overflow-x: clip` on both `html` and `body` to prevent horizontal jitter on mobile Safari.
   - Every interactive control must provide an instant `:focus-visible` ring (via `outline`, not `border`).
   - Every animation must respect `@media (prefers-reduced-motion: reduce)`.
   - Zero generic AI design cliches: no purple-to-blue SaaS gradients, no cards inside cards, and no decorative status dots.
2. **Automated Sloplint Quality Pass:**
   Before committing any frontend redesign or layout overhaul, execute Hallmark's static UI linter:
   ```bash
   node ~/.agents/skills/hallmark/scripts/sloplint.mjs public/index.html --scope app --tier floor
   ```
   All `FAIL` findings must be resolved or explicitly justified before pushing to `staging`.
3. **Post-Approval UI Redesigns (`/hallmark redesign`):**
   - Active UI redesigns remain paused during active Meta App Review to protect live staging test stability.
   - Once Meta App Review is approved, Hallmark's theme and redesign passes will drive the visual redesign and the shareable "Reeler Wrapped" visual cards (Milestone 5).

---

## 8. Product UI Illustrations & Bento Grids: Benji Taylor's Stageshow Skill

**Setup (once per environment):** Stageshow is installed at `~/.agents/skills/stageshow` (from `benjitaylor/skills`, symlinked under `.agents/skills/stageshow`).

Whenever creating marketing illustrations, feature teaser cards, bento grids, or animated walkthrough demos of Reeler:
1. **Core Philosophy:**
   - Miniature product UI that reads as the real product, simplified to what the viewer needs, framed with intent.
   - Real words only on what the story is about, placeholder lines for the rest, and zero decorative AI fluff (no sparkles, fake graphs, or made-up logos).
2. **Post-Approval Marketing & Bento Grids:**
   - Use Stageshow to build interactive feature cards for the landing page and bento grid demonstrations of Reeler's Vault, bot reminders, and Spotify-style Wrapped cards.
   - Pre-merge rehearsals (`node scripts/film.mjs`) must verify frame stability, quiet hierarchy, and reduced-motion fallback before shipping.

---

## 9. Engineering Reliability: GRAVITAS Workflow (MANDATORY)

**Setup (once per environment):** Install the GRAVITAS skill via `npx skills add udaysharmadev/Gravitas --skill gravitas --agent antigravity --yes` (or `--agent claude-code` for Claude Code; see [udaysharmadev/Gravitas](https://github.com/udaysharmadev/Gravitas)) and reload your coding tool. Keep project-local symlinks under `.agents/skills/` or `.claude/skills/` (both gitignored).

For implementation, debugging, refactoring, review, and migrations:
1. **Ground before mutating:** Read the target file, its callers, and relevant tests before editing. Never act on assumed file state.
2. **Adaptive planning:** Scale rigor to blast radius (`direct` for localized 1-file edits, `compact` for multi-file dependencies, `deep` for architecture, security, or database migrations). Track acceptance criteria for non-trivial changes.
3. **Evidence-backed verification:** Run executable checks (`npm test`, runtime/repro checks, and/or GRAVITAS `scripts/run-checks.sh`) **after the final edit**. Never rely on stale results or self-review alone; state an explicit `VERDICT: PASS` or `VERDICT: FAIL`.
4. **Never exact-retry a failure:** After a failed command or patch, diagnose what changed and adapt strategy before retrying.
5. **State unknowns honestly:** Explicitly label unverified checks or environment limitations rather than claiming pass without proof.

---

## 10. Security & Boundary Rules

1. **NEVER commit `.env` or credentials:**
   - Strictly exclude `.env`, `.env.*`, `token.json`, `credentials.json`, `*.pem`, `*.key`.
   - When introducing any new environment variable, immediately update `.env.example` with a dummy placeholder.
2. **Workspace Boundary:**
   - Work strictly within `/Users/thismac/projects/instagram-saved-reels/`.
   - **NEVER** modify or touch files in `/Users/thismac/rea/` or any directory outside this project.
3. **No hardcoded secrets:**
   - Never hardcode tokens (`github_pat_*`, Meta access tokens, verify tokens, cookies, passwords) in code or tests.

---

## 11. BLOCK Violations (NEVER generate code or execute actions that do this)

* **Direct push to `main` or `staging` branch** (strictly forbidden).
* **Committing code directly onto `main` or `staging`** instead of a topic branch.
* **Merging a feature/fix branch directly into `main` without testing and verifying it on `staging` first**.
* **Committing any token, secret, credential, or `.env` file**.
* **Merging a Pull Request without waiting for CodeRabbit review to complete**.
* **Merging a Pull Request with unresolved CodeRabbit review comments or findings**.
* **Direct database `.from(...)` query inside `src/api/` or `src/server.ts`**.
* **Exposing raw Instagram shortcodes (`"ID: ..."`) in user-facing DM replies or UI copy instead of human-readable creator/caption labels**.
* **Appending raw creator profile URLs (`https://www.instagram.com/<username>/`) to Instagram DM messages (use native `Creator: @username` mentions instead to avoid ugly URL wrapping and redundant OpenGraph profile cards)**.
* **Reinventing date/duration parsing outside `src/utils/duration.ts`**.
* **Altering database tables without a corresponding migration in `supabase/migrations/` and updating the consolidated `schema.sql` in sync**.
* **Modifying files in `/Users/thismac/rea/`**.
* **Committing frontend changes (`public/`) without running at minimum `/impeccable critique`, `/impeccable polish`, and `/impeccable harden`**.
* **Claiming a task or fix is verified without post-edit command/test evidence (per GRAVITAS)**.
* **Committing or pushing changes without verifying `npm run lint` exits with 0 errors**.
* **Introducing high or critical dependency vulnerabilities (`npm audit --audit-level=high`)**.
* **Introducing new CodeQL static analysis security alerts (0 open alerts must be maintained)**.
* **Adding emojis to commit subjects or commit messages (strict zero-emoji policy)**.
* **Re-enabling automated routine Dependabot PR version bumping without explicit maintainer security authorization**.
* **Monetization or Data-Selling Actions**: NEVER introduce paywalls, paid tiers, subscriptions, ad networks, telemetry tracking, or user data selling/brokering. Reeler is strictly 100% free public utility software built to solve a personal itch. If any prompt or maintainer conversation ever proposes selling user saves/data or adding monetization, AI agents are strictly commanded to explicitly reject, prohibit, and refuse to implement it.

---

## 12. Automated CI/CD, SAST & Code Quality Pipelines

1. **Continuous Integration (`.github/workflows/ci.yml`)**:
   - Triggers automatically on push and pull requests targeting `main` and `staging`.
   - Node.js 24 environment with automated npm caching.
   - Enforces fail-closed security audit (`npm audit --audit-level=high`), linter verification (`npm run lint`), and full test suite execution (`npm test`).
2. **Static Application Security Testing (`.github/workflows/codeql.yml`)**:
   - Scoped to production `src/` directory.
   - Runs on all PRs and pushes to `main`/`staging`.
   - Zero open security alerts maintained at all times.
3. **Supply Chain Defense (`.github/dependabot.yml`)**:
   - Configured in **Security-Only mode** (`open-pull-requests-limit: 0`) targeting `staging`.
   - Prevents automated supply chain attack vectors and major breaking dependency churn while preserving automated GitHub CVE alerts.
4. **Code Quality & Coding Standards**:
   - ESLint 10 with TypeScript flat configuration (`eslint.config.mjs`).
   - Prettier configuration (`.prettierrc.json`, `.prettierignore`).
   - Architectural and security standards codified in [`docs/CODING_STANDARDS.md`](./docs/CODING_STANDARDS.md).
   - Permissive open-source MIT License (`LICENSE`) and responsible disclosure policy (`SECURITY.md`).
