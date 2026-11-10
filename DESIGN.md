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
- Overlay & HUD Scrims (`--surface-scrim`, `--surface-scrim-strong`, `--surface-scrim-pill`, `--surface-badge-dark`, `--surface-fallback`, `--surface-avatar-hud`, `--surface-hud-btn`, `--surface-hud-top`, `--surface-bottom-scrim`) and Elevation Shadows (`--shadow-popover`, `--shadow-stage`, `--shadow-caption`, `--shadow-dock`, `--shadow-toast`): tokenized dark obsidian steps (`0.82–0.96` alpha) and depth tokens keeping text contrast `>= 7:1` over imagery with zero raw literals outside `:root`

### Typography & Ink
- Text Primary (`--ink-primary`): `#ffffff` (18:1+ contrast on dark canvas)
- Text Secondary (`--ink-secondary`): `#e2e8f0` (14:1 contrast)
- Text Muted (`--ink-muted`): `#94a3b8` (~7.0:1 contrast — exceeds WCAG AA 4.5:1)
- Focus Outline (`--hairline-focus`): `#7b86f2`
- Selection Background: `rgba(94, 106, 210, 0.35)`

### Semantic Accents (Reserved & Functional)
- Brand / Focus Indigo (`--accent-linear` / `--accent-linear-text`): `#5e6ad2` / `#95a0ff`
- Watched Emerald (`--status-watched-text` / `--status-watched-bg` / `--status-watched-border`): `#34d399` / `rgba(39, 166, 68, 0.15)` / `rgba(39, 166, 68, 0.45)`
- Watch Later Amber (`--status-later` / `--status-later-text`): `#f59e0b` / `#fbbf24` (applied when Watch Later count > 0)
- Error Crimson (`--accent-error` / `--accent-error-text`): `#ff4757` / `#ff7b87`

## Typography

- **Stack**: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif` (`--font-sans`), `ui-monospace` (`--font-mono`) for rank tags and `<kbd>` keycaps.
- **Numbers**: `font-variant-numeric: tabular-nums` across KPI stats, counts, creator totals, and rank tags.
- **Rhythm**:
  - Vault Brand `<h1>` (`--text-h1`): `20px` / `1.1`, Weight `700`, letter-spacing `0.05em` (`18px` on `<= 480px` preserving a `>= 1.25:1` step above `14px` body copy, and `16px` ultra-compact nav cap on `<= 360px` to preserve single-row navbar fit)
  - Body Base (`--text-base`): `14px` / `1.5`
  - Section Headings `<h2>` (`--text-h2`): `14px` / `1.2`, Weight `600`
  - Stat Values (`--text-stat`): `22px` / `1.1`, Weight `700`, tabular numerals (`14px` centered on `<= 600px` compact mobile filter buttons) with cold-load skeleton pulse bars (`is-initial-loading`), unified 4-column interactive quick-filter buttons (`All Items`/`All` with live `reels · posts` sub-split on desktop, `Added This Week`/`Week`, `Watch Later`/`Later`, `Watched` — visible on all viewports) clearly distinguished above a passive borderless `Active Creators:` row, a dedicated **Collection Category Switcher** (`.collection-source-bar` with `#source-tabs`: `All` / `Saved on IG` / `Sent to Bot`, persisted via `?source=`, tabular `.source-tab-count` counters, contextual sync note, and `<= 480px` compact stacked `44px` tabs labeled `All` / `IG Saved` / `Bot Sent`), a dedicated `Content Type` segmented toggle (`All` / `Reels` / `Posts`, persisted via `?type=`), removable per-filter summary chips (`#active-filter-chips`), and non-overlapping inline `Retry` recovery on error
  - Card & Feed Captions (`--text-sm`): `13px` / `1.45`, measure capped at `62ch`, `overflow-wrap: anywhere` (up to 2 lines in List View via `.table-caption-clamp`), with Meta Latin-1 UTF-8 mojibake normalized and unrenderable C1 / Unicode Private Use Area / BMP-truncated emoji compatibility clusters stripped on ingest and render
  - Creator Handles (`.handle-text`): Ellipsis-safe block truncation inside dedicated `@handle` creator filter buttons on Grid cards and List rows (`.card-creator-filter-btn` / `.table-creator-filter-btn`, `24px` desktop / `38px` mobile touch) so clicking a catalog handle filters the local vault directly without extra micro-icons, while outbound Instagram links live in List View `Actions` (`↗`) and Fullscreen Feed `@handle` / `Open`
  - Metadata / Pills / Dates (`--text-xs`): `12px`, Weight `500`–`600`. Bot-sent items (`is_saved_on_instagram === false`) display `Sent <date>` plus an indigo-tinted `.card-source-pill.is-bot` (`Bot` in cards/List `176px` `Saved / Sent` column) and `.feed-source-pill.is-bot` (`Sent to Bot` in Fullscreen Feed), whereas archive/native Instagram items display `Saved <date>` and published-sort views display `Pub <date>` (still preserving the `Bot` badge when applicable).

## Iconography, Touch Targets & Motion

- **Drawn Geometric SVG Icons**: Uniform `2px` stroke Lucide-style SVGs for all navigation, media, status, close, and dismiss actions; zero Unicode UI emojis or symbol characters.
- **WCAG 2.5.8 Target Size & Touch Safeguards**: All interactive buttons, links, creator filter buttons, page-jump inputs/buttons, inline retries, toast Retry/Undo/dismiss buttons, and creator pills enforce `>= 24x24px` target area (`>= 38x38px` across nav buttons, Collection Category tabs, filter chips, catalog creator filter buttons, feed creator links, clear buttons, status pills, caption toggles, toast actions, list actions, view toggles, KPI quick-filter buttons, and SE rail actions on coarse touch / mobile viewports, with `>= 44px` stacked Collection tabs at `<= 480px`), while mobile/coarse inputs and selects use `16px` font size to prevent iOS Safari focus auto-zoom, classic scrollbars scope strictly to `@media (pointer: fine)` to avoid mobile viewport gutters, and toast notifications stretch cleanly with `12px` edge insets below `600px`.
- **Reduced Motion**: `@media (prefers-reduced-motion: reduce)` preserves opacity and state transitions (including `.source-tab-btn`) while disabling transforms, smooth scroll, skeleton pulses, and spinners.

## Media & Adaptive Cinema Modal

- **Reels & Posts with Thumbnails**: Responsive multi-column poster grid (`2` columns down to `320px`) using vertical poster ratio (`9:13.5`) with top/bottom dark scrims separating rank + explicit `Reel` / `Post` type badges (`.media-type-reel` / `.media-type-post`) and bookmark controls cleanly from thumbnail photography without nested interactive buttons; desktop hover/focus reveals the centered glass play trigger while coarse/mobile viewports display a clean corner `Watch`/`Open` cue pill to avoid duplicating Instagram's baked-in thumbnail triangle.
- **Reels without Thumbnails**: Monochrome monogram poster displaying creator initial badge, `@creator` handle (or display name, caption/date preview, or `Instagram Creator` placeholder fallback without generating profile links or exposing opaque database IDs), classified format label (`Saved Reel` / `Saved Post` / `Carousel` for IG-saved items; `Bot Reel` / `Bot Post` / `Carousel` for DM-sent items), generous vertical inset padding (`44px`/`46px` desktop, `46px`/`50px` mobile) clearing top bookmark controls and the corner play cue (`poster-cue-monogram`); structural grid cards and list rows render loading skeletons immediately on cold fetches (`Grid` and `List`).
- **1-Click Triage, Bounded Creators & Navigation**: Grid cards, List rows, and Fullscreen Feed share unambiguous dual triage ownership — Bookmark/Later (`[🔖]` + amber `.card-later-badge` / `.table-later-badge`) owns `Watch Later`, while `.status-pill-toggle` (`Mark Watched` / `Watched`, `aria-pressed`) owns `Watched` — backed by idempotency guards, `:disabled` busy feedback, descriptive overwrite tooltips, an `Undo` toast when switching directly between `Watched` and `Watch Later`, and inline toast `Retry` recovery. Initial creator filtering loads a bounded `?limit=6` payload (`~2 KB`) paired with coalesced cache + server search (`?q=...&limit=15`), out-of-range page URLs clamp smoothly to the last available page, and pagination supports `[`/`]` shortcuts alongside direct `novalidate` page jumping (`Enter` or contextual `Go` button to jump, `Esc` to cancel) via `#page-jump-input`. Top Creators collapses cleanly under a mobile toggle below `600px`.
- **Adaptive Vertical Snap Feed**: Measures each post's true aspect ratio (`9:16`, `3:4`, `4:5`, `1:1`, `5:4`, `16:9`) via server metadata + two-width iframe `MEASURE` probing (`POST X OF Y` for non-clip photo/carousel posts vs `REEL X OF Y` for reels): floating scrimmed overlay + side rail for vertical `9:16` reels, bottom-docked metadata for wide/square formats, horizontal side-dock layout on short landscape windows (`vh < 560 && vw >= 560`) with `0px` horizontal overflow, `overflow: clip` boundary masking to prevent focus-scroll white footer bleed, expandable captions, embed Retry fallback, and zero Instagram white header/footer bleed.
- **Keyboard, Live Announcements & Guide Support**: Search (`/` or `⌘K` / `Ctrl+K`), Guide (`?`) with non-trapping `aria-modal="false"` disclosure behavior (`Esc` or moving focus outside closes), Pagination (`[` / `]`), Feed navigation (`↑`/`k`, `↓`/`j`, `Esc`), Feed quick triage (`w` Watched, `l` Later, `c` Copy with `#sr-status-announcer` live updates), synchronous background `inert` locking, offscreen slide `inert` isolation, explicit `.feed-focus-player-btn` keyboard focus bridge (`iframe.tabIndex = -1` by default so regular `Tab` traversal never stalls or traps `Esc`), and frame-0 focus on `#feed-close-btn`.
