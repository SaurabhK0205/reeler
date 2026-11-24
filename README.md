# Reeler

> "You scroll through 1,000 reels a day. Make sure you don't miss an important one."

Inspired by Michael De Santa's line in GTA V (*"You forget a thousand things every day, make sure this is one of 'em"*), Reeler exists because Instagram's Saved tab turns into a graveyard fast. You cannot search captions, you cannot filter by creator, and nothing reminds you to come back to a reel you actually meant to watch.

Reeler pairs an Instagram DM bot (`@er_reel_er`) with a private web vault ([reeler-staging.onrender.com](https://reeler-staging.onrender.com)). Share a Reel or Post to the bot, tell it when to remind you, and browse everything you have saved in one searchable place without giving up your Instagram password.

### Meta App Review Status
Reeler is currently undergoing official Meta App Review for Instagram Messaging API permissions. As soon as public scopes are approved, live access opens for everyone.

In the meantime, feel free to explore the repository, run the server locally, or open an issue with suggestions and feedback.

Note on early access: Meta currently delivers bot responses for select Instagram accounts outside the tester list. If `@er_reel_er` responds to your DM, you have early access; otherwise, full access unlocks once review finishes.

---

## How It Works

### 1. Instagram DM Bot (`@er_reel_er`)
Built on Meta's official Messenger API for Instagram (`graph.facebook.com/v21.0/me/messages`). Every user's data is isolated per Instagram Scoped User ID (`instagram_sender_id`).

| DM Command | What It Does |
|---|---|
| Share a Reel or Post | Adds the item to your Watch Later queue and prompts for a reminder time (10-minute reply window; defaults to 10 hours if no reply). Supports both Reel video (`ig_reel`) and Feed Post (`ig_post`) share attachments as well as direct link URLs. |
| Re-sharing an existing item (Path A) | Resharing an item already in Watch Later preserves your existing reminder schedule, displays the currently scheduled time (or notes if none is active), and primes active context so replying with a new duration updates it without resetting. |
| `remind @[creator] in 2h`, `update reminder for @[creator] to 5pm`, `snooze @[creator] 1h` (Path B) | Directly sets, reschedules, or snoozes the reminder for an active Watch Later item from that specific creator. |
| `30m`, `2h`, `tomorrow at 5pm` | Sets, reschedules, or snoozes your reminder on the latest item. Supports natural duration phrases, relative times, and exact dates. |
| `watched` or `done` | Marks your latest reminded item as watched and cancels active reminders for it. |
| `queue`, `reminders`, `upcoming` | Lists active future upcoming reminders only (ordered by soonest alert time). Excludes past-due or unreminded items to keep your queue focused. |
| `update @[creator] [time]`, `update [time]` | Reschedules or sets a reminder on an item by creator handle or latest active item (e.g. `update @warnerbrosindia tomorrow 10 am`, `update 2h`). Automatically attributes unattributed feed posts if matched. |
| `stop all` or `clear all` | Marks all active Watch Later items as watched and stops all scheduled alarms. |
| `cancel` or `undo` | Removes a recently added item from your Watch Later if you sent it by mistake. |
| `cancel reminder` | Stops reminder alerts on your latest item while keeping it safely saved in Watch Later. |
| `clear @[creator]` / `watched @[creator]` | Clears or marks items as watched for a specific creator. |
| `@[creator]`, `reels by @[creator]`, `posts by @[creator]` | Searches your saved items by creator handle, with separate sections for Reels and Posts. |
| `tz` / `tz <city or zone>` | Checks your current timezone or sets it to your local time (e.g. `tz IST`, `tz London`, `tz New York`, `tz Tokyo`, `tz +5:30`). All reminders and dates are calculated in your configured timezone. |
| `vault` | Sends your personal, zero-login direct access link to the web vault. |
| `code` | Generates a 6-digit one-time login code (valid for 10 minutes) to unlock your private vault on desktop or laptop browsers. |
| `delete my data` | Permanently deletes all of your saved items, reminders, and preference records from the database. |
| `help` | Displays the complete command reference and usage guide. |

#### Human Conversational UX & Safe Mentions
- **Tappable Profiles**: Bot confirmations format creator handles as native `@username` mentions, allowing users to tap straight to creator profiles inside Instagram without messy raw URLs.
- **Bracketed Placeholders (`@[creator]`)**: Guidance copy and command templates use `@[creator]` syntax so Instagram mobile clients do not linkify placeholder examples into real third-party accounts.
- **24-Hour Policy Window Awareness**: When a reminder is scheduled beyond 24 hours (e.g. 3 days, 1 week), the bot appends a transparent advisory reminding the user that Meta limits automated DMs to 24 hours from the last user message, and suggests checking `queue` or `vault` if the window closes before the alert.
- **Natural Copy**: Responses use concise, human phrasing without robotic AI formatting or em-dashes (<950 characters single-bubble limit).

---

### 2. Private Web Vault
- **Zero-login access**: Instant access via the `?key=...` link or 6-digit `code` sent by `@er_reel_er` in DM. Includes a **Switch Vault** button to sign out or switch accounts.
- **Full-text search**: Fast search across captions, shortcodes, and creator handles (backed by PostgreSQL GIN `to_tsvector` indexing).
- **Multi-dimensional filters**: Filter by media type (`All`, `Reels`, `Posts`), source (`All`, `Saved on IG`, `Sent to Bot`), save date (`Today`, `Yesterday`, `7d`, `30d`, `3m`, `6m`, `Year`), watch status (`Unwatched`, `Watch Later`, `Watched`), and creator chips.
- **Dual catalog views**: Seamlessly toggle between a visual poster grid and a dense, sortable list view.
- **Adaptive cinema feed**: Fullscreen player that measures and respects aspect ratios, fitting vertical Reels (`9:16`) alongside square, portrait, and landscape Posts (`1:1`, `4:5`, `3:4`, `16:9`).
- **Archive import**: Additive import for Instagram's official `saved_posts.json` export from Accounts Center, allowing historical bookmarks to live alongside bot-tracked items without duplicates.

---

## Stack

- **Runtime & API:** Node.js `>=24` (native `--experimental-strip-types`), TypeScript, Express 4
- **Frontend:** Vanilla HTML5, CSS3, and JavaScript (`public/`) with zero build step, bundler, or framework overhead
- **Database:** PostgreSQL / Supabase with in-memory fallback for offline testing
- **Messaging:** Meta Messenger API for Instagram with HMAC-SHA256 (`X-Hub-Signature-256`) webhook verification
- **Hosting:** Render (Docker) with optional HTTPS metadata relay (`METADATA_PROXY_URL`) for OpenGraph lookups

---

## Running Locally

### 1. Install dependencies
```bash
git clone https://github.com/SaurabhK0205/reeler.git
cd reeler
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env
```

If you leave `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` empty, the server automatically starts with an in-memory database store so you can test the UI, import archives, and browse immediately:

```bash
npm start
```

Open `http://localhost:3000`. Once Supabase is configured in `.env`, you can run `npm run seed` before `npm start` to populate sample items.

### 3. Available scripts
- `npm start`: Run the server (`src/server.ts`)
- `npm run dev`: Run the server in watch mode (`--watch`)
- `npm test`: Run all 7 regression test suites (24 tests covering archive import, Meta bot webhooks, adaptive player, vault auth, compliance pages, duration/timezone, and security/idempotency)
- `npm run import`: Import an Instagram `saved_posts.json` export from the CLI
- `npm run recover-posts`: Repair legacy `/reel/` URLs that are actually `/p/` posts
- `npm run seed`: Populate sample data into a configured Supabase database

---

## Database Setup

Reeler connects to database storage through the Supabase client (`@supabase/supabase-js`) using `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. You can host your database on [Supabase Cloud](https://supabase.com), on a self-hosted Supabase instance (Docker / PostgREST), or locally via the Supabase CLI (`npx supabase init` once, then `npx supabase start`).

### One-Shot Database Setup (`schema.sql`)
A complete, self-contained SQL script is maintained in [`schema.sql`](schema.sql). It provisions the entire database schema (tables, 24 performance indexes, full-text search, and RLS policies):

- **Supabase Cloud / Self-Hosted Dashboard**: Paste and run [`schema.sql`](schema.sql) in the Supabase SQL Editor.
- **Local CLI**: Run `psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -f schema.sql` (connecting to local Supabase at port 54322) or use the Supabase CLI (`npx supabase db reset`). Note: `db reset` recreates the local database and discards existing data, so use it only for disposable local testing.

> **Repository Invariant**: Whenever a new migration is created or any change is made to the database schema, `schema.sql` MUST be updated in sync so local and self-hosted environments always match the latest schema.

### Incremental Migrations
Alternatively, apply the migrations in [`supabase/migrations/`](supabase/migrations/) sequentially (`001_initial_schema.sql` through `016_saved_reels_sender_watch_order_index.sql`).

### Configure `.env`
Copy your Project API URL and `service_role` key into `.env`:
```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

---

## Meta Webhook & Deployment

Set the following environment variables in your deployment environment (e.g. Render using [`render.yaml`](render.yaml)):

- `META_PAGE_ACCESS_TOKEN`: Page access token for the Facebook Page linked to your Instagram Professional account
- `META_APP_SECRET`: Meta App Secret used to verify `X-Hub-Signature-256` on incoming webhooks
- `META_WEBHOOK_VERIFY_TOKEN`: Custom verification token configured in Meta Webhooks dashboard
- `APP_URL`: Public base URL used for vault links (falls back to `RENDER_EXTERNAL_URL`)
- `METADATA_PROXY_URL` / `METADATA_PROXY_TOKEN` *(optional)*: HTTPS relay (such as a Cloudflare Worker) for fetching public OpenGraph metadata when cloud IPs encounter Instagram login walls

Endpoints exposed by the server:
- `GET` / `POST /api/instagram/webhook` (alias: `/webhook`): Meta webhook verification and DM event handler
- `GET /api/health`: Service health, database mode, and Meta bot readiness check
- `GET /privacy`, `GET /terms`, `GET /data-deletion`: Compliance pages required for Meta App Review

---

## Automated Code Review & Quality Gates

Reeler enforces a multi-tier automated quality gate to guarantee senior engineering standards, protect database parity, and eliminate AI slop:

### 1. Pre-Push Local Suite
Run `npm test` before committing. All 24 test suites / 64 tests must pass cleanly.

### 2. Gemini Principal Code Reviewer (`.github/workflows/ai-code-review.yml`)
- Zero-dependency Node.js script (`scripts/gemini-pr-review.mjs`) executing on every PR event (`opened`, `reopened`, `ready_for_review`, `synchronize`).
- **Dynamic Model Discovery**: Queries Google AI Studio's Model API (`https://generativelanguage.googleapis.com/v1beta/models`) to automatically detect active models (`gemini-flash-lite-latest`, `gemini-2.0-flash`, `gemini-2.5-flash`), with 15-second request timeouts and fallback resilience.
- **Strict Invariant Audits**:
  - `Anti-AI-slop`: Enforces direct, natural copy (<950 characters single-bubble limit) and rejects em-dashes or decorative punctuation.
  - `Concurrency & CAS`: Verifies atomic Compare-And-Swap locks on all state transitions (reminders, choices).
  - `Store Parity`: Asserts that `InMemoryStore` logic in tests is behaviorally identical to Supabase PostgREST queries in production.
  - `Schema Parity`: Verifies that any database change in `supabase/migrations/` is synchronized in root `schema.sql`.

### 3. NVIDIA Nemotron 3 Ultra 550B Deep Reasoning Auditor (`.github/workflows/ai-code-review.yml`)
- High-capacity reasoning auditor (`scripts/nemotron-pr-review.mjs`) running on NVIDIA's OpenAI-compatible NIM endpoint (`https://integrate.api.nvidia.com/v1`).
- Leverages the **550-billion-parameter MoE architecture** (with 55B active parameters per token, Mamba-2 state space, and NVFP4 quantization) and native chain-of-thought reasoning tokens to detect:
  - Deep concurrency race conditions and non-atomic state updates.
  - Subtly breaking API signature changes and unintended default parameter behaviors.
  - Inconsistencies between test stores and live production database queries.
  - Meta 24-hour window compliance and fail-closed state machines.

### 4. Qodo PR-Agent (`.github/workflows/pr-agent.yml` & `.pr_agent.toml`)
- Open-source PR review and conversational review bot (`qodo-ai/pr-agent@main`).
- Automatically analyzes code changes on pull request creation and responds to interactive PR commands in comments:
  - `/review`: Request an on-demand code review.
  - `/ask <question>`: Ask a question about the changes in the PR.
- Configured with custom token budgets and decoupled concurrency so comment commands never cancel active PR workflows.

### 5. CodeRabbit (`.coderabbit.yaml`)
- Configured with custom path rules and tone instructions enforcing atomic CAS locks, Supabase query parity, and single-bubble copy constraints.
- **Why CodeRabbit shows `SKIPPED` in GitHub Actions**:
  - **10-Star Policy Threshold**: Under CodeRabbit's current open-source plan, repositories with fewer than 10 stars do not receive unmetered automatic background reviews on every push.
  - **Target Branch Filtering**: Auto-reviews default to the repository's primary branch (`main`). On PRs targeting `staging`, CodeRabbit marks its check run as `SKIPPED`.
  - **Manual Triggering**: To run CodeRabbit on any PR, comment `@coderabbitai review` directly on the pull request (allows up to 1 review per hour on the free tier).

### Secret Setup
To power the automated review pipeline:
1. Navigate to **Settings** > **Secrets and variables** > **Actions** in GitHub.
2. Under the **Secrets** tab (not Variables), configure:
   - `GEMINI_API_KEY`: Google AI Studio API key (from [aistudio.google.com](https://aistudio.google.com)).
   - `NVIDIA_API_KEY`: NVIDIA NIM API key (from [build.nvidia.com](https://build.nvidia.com)).
*(If either key is absent, the corresponding workflow step gracefully skips without failing CI).*

---

## Save-Date Integrity

Instagram's native saved feed orders bookmarks from newest to oldest, but `saved_posts.json` exports contain timestamps only when recorded by Meta. Rather than generating fake timestamps:
- Each item preserves its relative `save_order_rank`.
- Historical items without an explicit save timestamp record `first_detected_at` with `saved_at = NULL`.
- Chronological sorting uses the generated `effective_saved_at` column (`COALESCE(saved_at, first_detected_at)`). Re-importing newer exports backfills missing timestamps without overwriting reminders or watch status.
