# REELER (Instagram Saved Reels Tracker & Reminder OS) — CLAUDE.md

Stack: Node.js (v22+ with native `--experimental-strip-types`) + Express.js + Supabase (PostgreSQL) + Meta Graph API (Instagram Messaging Webhooks) + Cloudflare Tunnel
Repository: SaurabhK0205/reeler
Last updated: November 8, 2026

---

## 1. Git & Branching Rules (CRITICAL — NEVER VIOLATE)

1. **NEVER push directly to the `main` branch.**
2. **NEVER commit work directly onto `main`.** Always verify your current branch before making changes:
   ```bash
   git branch --show-current
   ```
3. **Every unit of work MUST have its own isolated branch** branched off latest `main`:
   - `feat/<feature-name>`   → New user-facing or backend features (e.g. `feat/reminder-calendar`)
   - `fix/<bug-name>`       → Bug fixes & UX defect repairs (e.g. `fix/in-app-mentions`)
   - `refactor/<target>`     → Code refactoring without behavior change (e.g. `refactor/metadata-resolver`)
   - `chore/<task>`          → Tooling, configs, docs, dependency upgrades (e.g. `chore/agent-guidelines`)
   - `db/<migration-name>`   → Database schema additions and migrations (e.g. `db/awaiting-choice-column`)
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
6. **PR / Merge Workflow**:
   - Push your topic branch: `git push -u origin <branch-name>`
   - Open a Pull Request into `staging` (and sync to `main` via PR with zero divergence).
7. **CodeRabbit Review Gate (MANDATORY & BLOCKING)**:
   - When opening a Pull Request, **NEVER merge immediately**.
   - **ALWAYS wait for CodeRabbit AI review to run and complete** on the current PR head commit before merging.
   - **NEVER merge while CodeRabbit review findings remain open or unaddressed**.
   - Whenever CodeRabbit posts review comments or findings:
     1. Inspect each finding thoroughly (bugs, security, architecture, performance, edge cases).
     2. For valid findings on topic branches: implement fixes on the branch, verify unit tests (`npm test`), and push.
     3. For promotion PRs (e.g. `staging` -> `main`): route fixes through a separate topic-branch PR into `staging`, rather than pushing directly to `staging`.
     4. For invalid findings or false positives: reply to the review thread with an evidence-based explanation and documented reasoning.
     5. Reply to each CodeRabbit review comment thread explaining the resolution.
   - Recheck review status after every push. Only merge after CodeRabbit completes its review on the final head commit and all findings are confirmed resolved and verified.
   - **NO tight polling loops**: Never run tight sleep loops polling GitHub or CodeRabbit status.

---

## 2. Pre-Session Rule

Before writing any code or executing commands:
1. **Branch Check**: Run `git branch --show-current`. If you are on `main`, immediately checkout a new topic branch:
   ```bash
   git checkout -b <type>/<descriptive-name>
   ```
2. **Environment & Secrets Check**: Run `git status` to ensure `.env` and local credentials remain untracked.
3. **Running Tasks Check**: Check if the Node server (port 3000) and Cloudflare tunnel are active before restarting them.
4. **Before Pushing**:
   - Run syntax check: `node --check` or test-run with native TypeScript:
     ```bash
     node --experimental-strip-types --env-file-if-exists=.env src/server.ts
     ```
   - Verify `git diff --cached` contains ZERO secrets, tokens, or `.env` entries.

---

## 3. Shared Metaphor — Use these exact terms everywhere

```
Saved Reel              → saved_reel, saved_reels (not post, media, bookmark, video)
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
3. **All database changes require a migration file in `supabase/migrations/`:**
   - Format: `XXX_<name>.sql` (e.g. `007_user_preferences.sql`).
   - Push migrations using:
     ```bash
     /opt/homebrew/bin/supabase db push --remote
     ```
   - Always update `src/types.ts` whenever database schema changes.
4. **Duration & Date Parsing:**
   - Always use `src/utils/duration.ts` (`parseDurationOrDateInput`).
   - Never write ad-hoc date/regex parsing in services or route handlers.
5. **Instagram In-App DM UX Rules:**
   - **Creator Profile Links**: Meta Graph API DMs do NOT automatically linkify plain `@username` mentions on Instagram Web or reliably across mobile clients. Whenever a valid Instagram handle exists (never for placeholder fallbacks like `Instagram Creator` or spaced display names), include a clean clickable profile URL (`https://www.instagram.com/<username>/`) paired with `@<username>` in Watch Later save confirmations, custom/default schedule replies, reminder DMs, and creator-search replies (short `"watched"` / `"stop"` confirmation DMs intentionally omit profile link cards to keep the reply compact).
   - **Link Preview Priority**: In reminder DMs that contain a Reel URL, always place the Reel URL **before** the creator profile URL so Instagram unfurls the Reel video thumbnail card rather than overriding it with a profile card.
   - **Human-Readable Reel Labels**: Never expose raw shortcodes (e.g. `Da1iWbSMAOz`) in user-facing DM copy or the frontend UI; identify reels by creator handle, caption snippet, save date, or plain `"your saved reel"`.
   - When a user shares a reel, prompt them for custom reminder timing with a **10-minute window**. If no reply within 10 minutes, default to **10 hours**.
   - When a user sends `"watched"` / `"done"` / `"stop"`, mark the **most recently reminded / latest active** Watch Later reel as watched and clear both `next_reminder_at` and `awaiting_reminder_choice_until` (using `"stop all"` / `"watched all"` for bulk clearing all pending Watch Later reels).

---

## 5. Frontend Work — Impeccable Design Review (MANDATORY)

**Setup (once per environment):** Install Impeccable via `npx impeccable install` (see the [Impeccable installation guide](https://github.com/pbakaus/impeccable#installation)) and reload your coding tool so `/impeccable` passes are available.

Whenever you modify anything under `public/` (HTML, CSS, or JS) or any user-facing template, run Impeccable design review passes **before committing any frontend change** (including fixes requested during PR review before pushing or updating the PR).

### Required Passes

| Pass | Slash Command | Focus Area |
|------|--------------|------------|
| **Critique** | `/impeccable critique` | Full audit: contrast ratios, spacing, visual hierarchy, accessibility |
| **Layout** | `/impeccable layout` | Grid density, spacing scale, visual scanning paths |
| **Typeset** | `/impeccable typeset` | Font hierarchy, pairings, line-height, vertical rhythm |
| **Animate** | `/impeccable animate` | Purposeful micro-interactions, transitions, reduced-motion support |
| **Adapt** | `/impeccable adapt` | Responsive breakpoints, mobile density (≥44px touch targets), SE/landscape |
| **Harden** | `/impeccable harden` | Empty states, error states, long captions, offline / skeleton edge cases |
| **Polish** | `/impeccable polish` | Final craft pass: alignment, interactive states, focus rings, hover states |

### Rules

1. Run the required passes **before each frontend commit** — when opening a PR and when pushing review follow-up commits.
2. Run the full 7-pass suite above for feature, layout, or UI changes; for small isolated CSS/JS tweaks, run at minimum `/impeccable critique`, `/impeccable polish`, and `/impeccable harden`.
3. For every finding either: implement the fix, or document in the PR body why it was intentionally waived with a rationale.
4. Never push a frontend commit that leaves a `critique` or `harden` finding unaddressed without an explicit documented reason.
5. `audit`, `clarify`, `colorize`, `bolder`, `quieter`, `distill`, and `onboard` are optional but recommended when auditing or redesigning a surface.

---

## 6. Engineering Reliability — GRAVITAS Workflow (MANDATORY)

**Setup (once per environment):** Install the GRAVITAS skill via `npx skills add udaysharmadev/Gravitas --skill gravitas --agent antigravity --yes` (see [udaysharmadev/Gravitas](https://github.com/udaysharmadev/Gravitas)) and reload your coding tool. Keep project-local symlinks under `.agents/skills/` (gitignored).

For implementation, debugging, refactoring, review, and migrations:
1. **Ground before mutating:** Read the target file, its callers, and relevant tests before editing. Never act on assumed file state.
2. **Adaptive planning:** Scale rigor to blast radius (`direct` for localized 1-file edits, `compact` for multi-file dependencies, `deep` for architecture, security, or database migrations). Track acceptance criteria for non-trivial changes.
3. **Evidence-backed verification:** Run executable checks (`npm test`, runtime/repro checks, and/or GRAVITAS `scripts/run-checks.sh`) **after the final edit**. Never rely on stale results or self-review alone; state an explicit `VERDICT: PASS` or `VERDICT: FAIL`.
4. **Never exact-retry a failure:** After a failed command or patch, diagnose what changed and adapt strategy before retrying.
5. **State unknowns honestly:** Explicitly label unverified checks or environment limitations rather than claiming pass without proof.

---

## 7. Security & Boundary Rules

1. **NEVER commit `.env` or credentials:**
   - Strictly exclude `.env`, `.env.*`, `token.json`, `credentials.json`, `*.pem`, `*.key`.
   - When introducing any new environment variable, immediately update `.env.example` with a dummy placeholder.
2. **Workspace Boundary:**
   - Work strictly within `/Users/thismac/projects/instagram-saved-reels/`.
   - **NEVER** modify or touch files in `/Users/thismac/rea/` or any directory outside this project.
3. **No hardcoded secrets:**
   - Never hardcode tokens (`github_pat_*`, Meta access tokens, verify tokens, cookies, passwords) in code or tests.

---

## 8. BLOCK Violations (NEVER generate code or execute actions that do this)

* **Direct push to `main` branch** (strictly forbidden).
* **Committing code directly onto `main`** instead of a topic branch.
* **Committing any token, secret, credential, or `.env` file**.
* **Merging a Pull Request without waiting for CodeRabbit review to complete**.
* **Merging a Pull Request with unresolved CodeRabbit review comments or findings**.
* **Direct database `.from(...)` query inside `src/api/` or `src/server.ts`**.
* **Exposing raw Instagram shortcodes (`"ID: ..."`) in user-facing DM replies or UI copy instead of human-readable creator/caption labels**.
* **Placing creator profile URLs before Reel URLs in reminder DMs (breaks Reel video preview unfurling)**.
* **Reinventing date/duration parsing outside `src/utils/duration.ts`**.
* **Altering database tables without a corresponding migration in `supabase/migrations/`**.
* **Modifying files in `/Users/thismac/rea/`**.
* **Committing frontend changes (`public/`) without running at minimum `/impeccable critique`, `/impeccable polish`, and `/impeccable harden`**.
* **Claiming a task or fix is verified without post-edit command/test evidence (per GRAVITAS)**.
