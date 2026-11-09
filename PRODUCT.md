# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user is a focused curator and power Instagram user with an extensive personal archive of saved Reels (7,000+ videos from thousands of creators). They need a dependable, distraction-free environment to rediscover, search, categorize, and watch high-value content that would otherwise be buried in Instagram's limited native saved UI.

## Product Purpose

Reeler (Saved Reels Tracker) transforms a chaotic, unsearchable Instagram bookmark list into an organized, cinematic personal film vault. Success means the user can instantly find any saved reel by creator or topic, preview and watch it with zero friction, track their watch status, and receive scheduled reminders through Instagram DMs.

## Positioning

Unlike native Instagram saved folders (which are paginated, unsearchable, and mixed with ads) or generic bookmarking tools, Reeler is purpose-built for video reels: it maintains deep bidirectional sync with the user's real Instagram data export, supports automated reminder pacing via Meta Graph API DMs, and provides an offline-capable, local-first search engine with zero algorithmic noise.

## Operating Context

- **Desktop & Mobile Web**: Used on desktop/laptop browsers (`localhost:3000` / Cloudflare tunnel) as a media workstation for reviewing, searching, and managing the reel archive.
- **Instagram Direct Messages**: Automated companion bot delivers reels, creator queries, and scheduled reminders directly inside native Instagram chat on iOS/Android.
- **Data Volume**: Built to handle 7,100+ saved reels and 4,700+ creators smoothly with instant client-side responsiveness.

## Capabilities and Constraints

- **Single-page web client**: Vanilla HTML5, modern CSS3, native ES modules (`public/index.html`, `public/style.css`, `public/app.js`).
- **Backend**: Express on Node.js with native experimental strip-types and Supabase PostgreSQL.
- **Constraints**: No heavy frontend build pipelines or runtime frameworks (React/Vue/Webpack); must remain lean, lightning fast, and load instantly from static files.
- **Aspect Ratio**: Catalog poster cards use uniform `9:13.5` vertical theater framing while the interactive player adapts seamlessly across `9:16` Reels and `3:4`, `4:5`, `1:1`, `5:4`, and `16:9` saved Instagram posts without web chrome.

## Brand Commitments

- **Aesthetic**: Cinematic personal film vault meets gallery dark mode (Mobbin / Raycast / Letterboxd). Deep obsidian canvas, razor-sharp 1px hairline borders, vibrant micro-accent badges, and high-contrast typography.
- **Anti-Slop Mandate**: Zero AI-generated visual clichés (no blurry pastel glow cards, no low-contrast illegible text, no generic cookie-cutter templates). Plain, confident copy and deliberate craft.

## Evidence on Hand

- Live Supabase archive exceeds 7,100 saved items and 4,900 creators parsed from official Instagram `saved_posts.json` exports and webhook events.
- Working Meta Graph API webhook and bidirectional DM notification system.
- Full automated unit test suite (18/18 passing across archive import, DM bot, adaptive player geometry, and stream/search hardening).

## Product Principles

1. **Content First, Chrome Recedes**: The media, creator identity, and video content are the stars; the UI chrome stays crisp, dark, and unobtrusive.
2. **Speed & Density**: High-density browsing without visual clutter. Scanning 100 reels should feel instantaneous and fluid.
3. **Tactile Feedback**: Hover micro-interactions (subtle card lift, play affordance, smooth zoom) provide immediate, tactile feedback without distracting motion.
4. **Accessible Contrast**: Strict WCAG AA contrast (minimum 4.5:1) for all text and interactive badges against the obsidian background.
