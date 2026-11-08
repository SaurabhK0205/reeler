# Design System: Reeler Cinematic Film Vault

<!-- impeccable:design-schema 1 -->

## Design Philosophy

Reeler merges **Cinematic Personal Film Vault** aesthetics (inspired by Letterboxd / Runway) with **Gallery Dark Mode** precision (inspired by Mobbin / Raycast). The interface recedes into an obsidian theater canvas so the reels, creators, and film media take center stage with razor-sharp contrast, 1px hairlines, and zero AI-slop decorative fluff.

## Color Palette

### Surfaces & Backgrounds
- Canvas Background: `#08090d` (pure inky obsidian)
- Panel / Section Surface: `#0e1017` (neutral dark floor)
- Card / Elevated Surface: `#141720` (first elevated layer)
- Card Hover / Highlight Surface: `#1c202c` (tactile feedback layer)
- Hairline Border: `rgba(255, 255, 255, 0.08)` (subtle 1px structural line)
- Hairline Border Strong: `rgba(255, 255, 255, 0.16)` (active / focused 1px line)

### Typography & Ink
- Text Primary: `#ffffff` (100% white, 17.5:1 contrast against canvas)
- Text Secondary: `#e2e8f0` (slate-200, 13.2:1 contrast)
- Text Muted: `#94a3b8` (slate-400, 6.2:1 contrast — strictly exceeds WCAG AA 4.5:1 floor)
- Selection Background: `rgba(56, 189, 248, 0.25)`

### Semantic Accents (Reserved & Functional)
- Crimson (Film Reel / Watch Later): `#ff4757`
- Cyan (Creator Focus / Primary Action): `#38bdf8`
- Emerald (Watched / Healthy Sync): `#10b981`
- Amber (Scheduled Reminders / Alerts): `#fbbf24`

## Typography

- **Stack**: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif`
- **Numbers**: `font-variant-numeric: tabular-nums` for all stats, counts, and ranks.
- **Rhythm**:
  - Vault Title: 24px / 1.15, Weight 700, letter-spacing `-0.03em`
  - Stat Values: 28px / 1.1, Weight 650, tabular numerals
  - Section Kickers: 11px, Weight 600, uppercase, letter-spacing `0.06em`
  - Card Captions: 13px / 1.42, Weight 400
  - Badges & Pills: 11px–12px, Weight 550

## Iconography & Affordances

- **Zero Unicode Emoji for UI Controls**: Every button, input, badge, and toggle uses drawn, geometric SVG icons with uniform 1.5px/2px stroke.
- **Micro-interactions**:
  - Cards lift `2px` on hover with hairline border brightening to `rgba(255, 255, 255, 0.18)`.
  - Poster preview reveals a centered frosted glass play trigger (`backdrop-filter: blur(8px)`).
  - One-click Watch Later bookmark toggle directly accessible on every card.

## Media & Poster Frame System

- **Reels with Thumbnails**: Vertical poster ratio with subtle top/bottom scrim gradients ensuring creator handles and rank badges remain legible.
- **Reels without Thumbnails**: Elegant typographic film card featuring creator monogram, authentic reel shortcode identifier, and logline caption snippet over an obsidian mesh ground — no repetitive stock photos.
- **Cinema Theater Modal**: Full-screen dark theater overlay with embedded Instagram player, full caption reader, metadata badges, and keyboard shortcuts (`Esc` to close).
