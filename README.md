# Reeler

> "You scroll through 1,000 reels a day. Make sure you don't miss an important one."

Inspired by Michael De Santa's line in GTA V (*"You forget a thousand things every day, make sure this is one of 'em"*), Reeler exists because Instagram's Saved tab turns into a graveyard fast. You cannot search captions, you cannot filter by creator, and nothing reminds you to come back to a reel you actually meant to watch.

Reeler pairs an Instagram DM bot (`@er_reel_er`) with a private web vault ([reeler-staging.onrender.com](https://reeler-staging.onrender.com)). Share a Reel or Post to the bot, tell it when to remind you, and browse everything you have saved in one searchable place without giving up your Instagram password.

---

## How It Works

### 1. Instagram DM Bot (`@er_reel_er`)
Built on Meta's official Messenger API for Instagram (`graph.facebook.com/v21.0/me/messages`). Every user's data is isolated per Instagram Scoped User ID (`instagram_sender_id`).

| DM Command | What It Does |
|---|---|
| Share a Reel or Post | Adds the item to your Watch Later queue and asks when to remind you (defaults to 10 hours if you do not reply within 10 minutes). |
| `30m`, `2h`, `tomorrow at 5pm` | Sets or reschedules the reminder on your most recent item. |
| `watched` | Marks your latest reminded item as watched and stops reminders for it. |
| `stop all` / `clear all` | Marks all pending Watch Later items as watched and stops their reminders. |
| `@username`, `reels by @name`, `posts by @name` | Searches your saved items from that creator. |
| `tz` / `tz <city or zone>` | Checks or updates your local timezone (for example `tz IST`, `tz London`, `tz New York`). |
| `vault` | Sends your private direct link to the web vault. |
| `code` | Generates a one-time 6-digit login code (valid for 10 minutes) to unlock your vault on a laptop or desktop browser. |
| `delete my data` | Permanently deletes all of your saved items, reminders, and preferences from the database. |

### 2. Private Web Vault
- Zero-login access via the `?key=...` link or 6-digit `code` sent by `@er_reel_er` in DM, plus a **Switch Vault** button in the header to clear the cached key cleanly.
- Full-text search across captions and creator handles (PostgreSQL GIN `to_tsvector` index).
- Filters for media type (`All`, `Reels`, `Posts`), source (`Saved on IG` vs `Sent to Bot`), save date (`Today`, `Yesterday`, `7d`, `30d`, `3m`, `6m`, `Year`), watch status (`Unwatched`, `Watch Later`, `Watched`), and creator.
- Grid view, dense list view, and an adaptive fullscreen player that fits vertical Reels (`9:16`) alongside square and landscape Posts (`1:1`, `4:5`, `3:4`, `16:9`).
- Additive archive import for Instagram's official `saved_posts.json` export from Accounts Center, so existing Instagram bookmarks can live alongside bot-tracked items without duplicates.

---

## Stack

- **Runtime & API:** Node.js `>=24` (native `--experimental-strip-types`), TypeScript, Express 4
- **Frontend:** Vanilla HTML, CSS, and JavaScript (`public/`) with no build step or framework runtime
- **Database:** Supabase (PostgreSQL) with an in-memory fallback when Supabase credentials are omitted
- **Messaging:** Meta Messenger API for Instagram with HMAC-SHA256 (`X-Hub-Signature-256`) webhook verification
- **Hosting:** Render (Docker) with an optional HTTPS metadata relay (`METADATA_PROXY_URL`) for OpenGraph lookups on cloud IPs

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

If you leave `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` empty, the server falls back to an in-memory store so you can test the UI immediately:

```bash
npm run seed
npm start
```

Open `http://localhost:3000`.

### 3. Available scripts
- `npm start` — Run the server (`src/server.ts`)
- `npm run dev` — Run with `--watch`
- `npm test` — Run all 6 regression test suites (archive import, Meta bot & metadata resolver, adaptive player, vault auth, compliance pages, duration/timezone)
- `npm run import` — Import an Instagram `saved_posts.json` export from the CLI
- `npm run recover-posts` — Repair legacy `/reel/` URLs that are actually `/p/` posts
- `npm run seed` — Populate sample data for local development

---

## Database Setup (Supabase)

1. Create a project at [supabase.com](https://supabase.com).
2. Apply all SQL migrations in [`supabase/migrations/`](supabase/migrations/) in order (`001_initial_schema.sql` through `014_saved_reels_shortcode_index.sql`).
3. Copy your Project URL and `service_role` key into `.env`:
   ```env
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
   ```

---

## Meta Webhook & Deployment

Set the following environment variables in your host (for example Render using [`render.yaml`](render.yaml)):

- `META_PAGE_ACCESS_TOKEN` — Page access token for the Facebook Page linked to your Instagram Professional account
- `META_APP_SECRET` — Meta App Secret used to verify `X-Hub-Signature-256` on every incoming webhook
- `META_WEBHOOK_VERIFY_TOKEN` — Custom verify token configured in Meta Webhooks
- `APP_URL` — Public base URL used for vault links (falls back to `RENDER_EXTERNAL_URL`)
- `METADATA_PROXY_URL` / `METADATA_PROXY_TOKEN` *(optional)* — HTTPS relay (such as a Cloudflare Worker) for fetching public OpenGraph metadata when cloud datacenter IPs hit Instagram's login wall

Endpoints exposed by the server:
- `GET` / `POST /api/instagram/webhook` (alias: `/webhook`) — Meta webhook verification and DM event handler
- `GET /api/health` — Service health, database mode, and Meta bot readiness check
- `GET /privacy`, `GET /terms`, `GET /data-deletion` — Compliance pages required for Meta App Review

---

## Save-Date Integrity

Instagram's saved feed orders bookmarks from newest to oldest, while official `saved_posts.json` exports include timestamps only on entries where Meta recorded them. Rather than inventing fake dates:
- Each item keeps its relative `save_order_rank`.
- Historical items without an explicit save timestamp leave `saved_at` as `NULL` and record `first_detected_at`.
- Chronological sorting uses a generated `effective_saved_at` column (`COALESCE(saved_at, first_detected_at)`), and re-importing a newer `saved_posts.json` backfills missing `saved_at` values when present.
