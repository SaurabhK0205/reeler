# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Core Principle

"You scroll through 1,000 reels a day. Make sure you don't miss an important one."

Inspired by Michael De Santa's line in GTA V ("You forget a thousand things every day, make sure this is one of 'em").

## Users

Instagram users who save or share Reels and Posts they intend to watch later, only to lose them inside Instagram's unsearchable Saved tab. Reeler serves both individual curators importing large historical archives (`saved_posts.json`) and everyday users forwarding individual Reels to `@er_reel_er` for reminders.

## Product Purpose

Reeler pairs an Instagram DM reminder bot (`@er_reel_er`) with a searchable, per-user web vault (`https://reeler-staging.onrender.com`). Users can forward any Reel or Post to the bot, pick when they want to be reminded, search saved items by creator or caption, manage watch status, and delete all of their data on demand.

## Positioning

Native Instagram Saved folders do not support caption search, creator filtering, or watch reminders. Reeler stays focused on Instagram Reels and Posts: users keep their existing Instagram workflow (Share -> DM `@er_reel_er` or export `saved_posts.json`), get scheduled DM reminders through Meta's official API, and browse a private, per-sender web vault with no Instagram password required.

## Operating Context

- **Desktop & Mobile Web**: Hosted on Render (`https://reeler-staging.onrender.com`) and usable on desktop or mobile browsers via private vault links (`?key=...`) or 6-digit login codes (`code`).
- **Instagram Direct Messages**: `@er_reel_er` handles incoming Reel and Post shares (`ig_post` and `ig_reel` share attachments), natural-language reminder scheduling, reshare schedule preservation with update prompts (Path A), creator-targeted reminder updates and snoozing (`remind @[creator] in 2h`, `update reminder for @[creator] to 5pm`, `snooze @[creator] 1h` - Path B), watch later queue listings (`queue`, `reminders`), 24-hour policy window awareness notices, cancel/undo commands, creator-scoped management (`clear @[creator]`, `watched @[creator]`), timezone preferences, creator lookups, vault login codes, and permanent `delete my data` requests via Meta Graph API webhooks with zero AI-slop copy.
- **Data Isolation & Scale**: Built on Supabase PostgreSQL with per-sender scoping (`(instagram_sender_id, shortcode)`), GIN full-text search, and bounded creator directories capable of handling thousands of saved items and creators cleanly. A consolidated `schema.sql` script is maintained at repository root for one-shot local and self-hosted database provisioning.

## Capabilities and Constraints

- **Single-page web client**: Vanilla HTML5, CSS3, and native JS (`public/index.html`, `public/style.css`, `public/app.js`, `public/playerGeometry.js`).
- **Backend**: Express on Node.js 24 (`--experimental-strip-types`) with Supabase PostgreSQL and an in-memory fallback for local testing.
- **Constraints**: No frontend build pipeline or runtime framework (React/Vue/Webpack); static assets stay lean and load directly from Express.
- **Aspect Ratio**: Catalog poster cards use uniform `9:13.5` framing while the fullscreen player adapts to `9:16` Reels and `3:4`, `4:5`, `1:1`, `5:4`, and `16:9` Instagram Posts.

## Brand Commitments

- **Visual Direction**: Dark gallery vault inspired by Mobbin, Raycast, and Letterboxd — obsidian background, 1px hairline borders, restrained status accents, and high-contrast typography.
- **Plain Copy**: Direct, grounded language with zero hype, zero emoji clutter in code or docs, and honest status feedback.

## Evidence on Hand

- Live Render deployment (`https://reeler-staging.onrender.com`) backed by Supabase PostgreSQL migrations `001` through `016`, complete consolidated `schema.sql`, and Meta Messenger API webhooks for `@er_reel_er`.
- 7 automated regression test suites (`npm test`) covering archive imports, Meta webhook bot flows, metadata resolution fallbacks, adaptive player geometry, vault auth/OTP, compliance pages, timezone/duration parsing, and security/idempotency.

## Product Principles

1. **Content First, Chrome Recedes**: Media, creator attribution, and captions stay front and center; navigation and controls stay quiet.
2. **Fast Filtering at Scale**: Search, creator pills, source tabs, and pagination stay responsive across thousands of saved items.
3. **Clear Tactile Feedback**: Interactive controls use subtle GPU-composited press states and honor `prefers-reduced-motion`.
4. **Accessible Contrast**: Maintain WCAG AA contrast (at least 4.5:1) for text and interactive badges against dark surfaces.
