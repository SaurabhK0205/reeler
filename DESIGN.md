# Design System: Reeler Cinematic Film Vault

<!-- impeccable:design-schema 1 -->

## Design Philosophy

Reeler merges **Linear Obsidian Film Vault** clarity with a distraction-free **Adaptive Cinema Feed**. The chrome recedes into a pure `#010102` canvas with hairline `1px` borders, disciplined semantic accents reserved strictly for status/focus/errors, and zero decorative slop so saved Instagram reels (`9:16`, `3:4`, `4:5`, `1:1`, `5:4`, `16:9`) hold the frame.

## Color Palette

### Surfaces & Backgrounds
- Canvas Background (`--canvas`): `#010102`
- Navigation Bar Surface (`--surface-nav`): `#08090b`
- Panel / Toolbar Surface (`--surface-panel`): `#0d0e12`
- Card / Elevated Surface (`--surface-card`): `#121419`
- Card Hover Surface (`--surface-card-hover`): `#181b22`
- Active Control Surface (`--surface-active`): `#1f232d`
- Hairline Border (`--hairline`): `rgba(255, 255, 255, 0.08)`
- Hairline Border Strong (`--hairline-strong`): `rgba(255, 255, 255, 0.16)`
- Media Pure Black (`--surface-media`): `#000000`
- Monogram Card Surfaces (`--surface-monogram-start` / `--surface-monogram-end` / `--surface-monogram-badge`): `#0a0b0f` / `#101217` / `#181a22`

### Typography & Ink
- Text Primary (`--ink-primary`): `#ffffff` (18:1+ contrast on dark canvas)
- Text Secondary (`--ink-secondary`): `#e2e8f0` (14:1 contrast)
- Text Muted (`--ink-muted`): `#94a3b8` (~7.0:1 contrast — exceeds WCAG AA 4.5:1)
- Focus Outline (`--hairline-focus`): `#7b86f2`
- Selection Background: `rgba(94, 106, 210, 0.35)`

### Semantic Accents (Reserved & Functional)
- Brand / Focus Indigo (`--accent-linear` / `--accent-linear-text`): `#5e6ad2` / `#95a0ff`
- Watched Emerald (`--status-watched` / `--status-watched-text`): `#27a644` / `#34d399`
- Watch Later Amber (`--status-later` / `--status-later-text`): `#f59e0b` / `#fbbf24` (applied when Watch Later count > 0)
- Error Crimson (`--accent-error` / `--accent-error-text`): `#ff4757` / `#ff7b87`

## Typography

- **Stack**: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif` (`--font-sans`), `ui-monospace` (`--font-mono`) for rank tags, shortcode IDs, and `<kbd>` keycaps.
- **Numbers**: `font-variant-numeric: tabular-nums` across KPI stats, counts, creator totals, and rank tags.
- **Rhythm**:
  - Vault Brand `<h1>` (`--text-h1`): `20px` / `1.1`, Weight `700`, letter-spacing `0.05em` (`16px` on `<= 480px`, `14px` on `<= 360px`)
  - Body Base (`--text-base`): `14px` / `1.5`
  - Section Headings `<h2>` (`--text-h2`): `14px` / `1.2`, Weight `600`
  - Stat Values (`--text-stat`): `22px` / `1.1`, Weight `700`, tabular numerals (`16px` on `<= 600px` compact mobile KPIs), with `.metric-sub` (`watched` count) aligned in the Watch Later header row
  - Card & Feed Captions (`--text-sm`): `13px` / `1.45`, measure capped at `62ch`, `overflow-wrap: anywhere` (up to 2 lines in List View via `.table-caption-clamp`)
  - Creator Handles (`.handle-text`): Ellipsis-safe block truncation inside flex links with an external-link glyph on catalog cards disambiguating outbound Instagram links
  - Metadata / Pills / Dates (`--text-xs`): `12px`, Weight `500`–`600`

## Iconography, Touch Targets & Motion

- **Drawn Geometric SVG Icons**: Uniform `2px` stroke Lucide-style SVGs for all navigation, media, status, close, and dismiss actions; zero Unicode UI emojis or symbol characters.
- **WCAG 2.5.8 Target Size & Touch Safeguards**: All interactive buttons, links, page-jump inputs, inline retries, and creator pills enforce `>= 24x24px` target area (`>= 34px–44px` on coarse touch / mobile viewports), while mobile/coarse inputs and selects bump to `16px` to prevent iOS Safari focus auto-zoom.
- **Reduced Motion**: `@media (prefers-reduced-motion: reduce)` preserves opacity and state transitions while disabling transforms, smooth scroll, skeleton pulses, and spinners.

## Media & Adaptive Cinema Modal

- **Reels with Thumbnails**: Vertical poster ratio (`9:13.5`) with top/bottom dark scrims separating rank badges and bookmark controls cleanly from thumbnail photography without nested interactive buttons; coarse/narrow viewports display a bottom-right corner play indicator (`34x34px`).
- **Reels without Thumbnails**: Monochrome monogram poster displaying creator initial badge, monospace shortcode identifier, and subtle `Saved Post` label (without duplicating card `@handle` or caption text); structural `.vault-skeleton-card` placeholders cover cold fetches.
- **1-Click Triage & Navigation**: Catalog cards and List rows pair a direct 1-click Watched toggle pill (`.status-pill-toggle`) with the Bookmark (`Watch Later`) button, while pagination supports direct page jumping via `#page-jump-input`.
- **Adaptive Vertical Snap Feed**: Measures each post's true aspect ratio (`9:16`, `3:4`, `4:5`, `1:1`, `5:4`, `16:9`) via server metadata + two-width iframe `MEASURE` probing: floating scrimmed overlay + side rail for vertical `9:16` reels, bottom-docked metadata for wide/square formats, horizontal side-dock layout on short landscape windows (`vh < 560 && vw >= 560`) with expandable 4-line captions and embed Retry fallback, and zero Instagram white header/footer bleed.
- **Keyboard, Live Announcements & Guide Support**: Search (`/` or `⌘K` / `Ctrl+K`), Guide (`?`) with popover Tab containment, Feed navigation (`↑`/`k`, `↓`/`j`, `Esc`), Feed quick triage (`w` Watched, `l` Later, `c` Copy with `#sr-status-announcer` live updates), synchronous background `inert` locking, and frame-0 focus on `#feed-close-btn`.
