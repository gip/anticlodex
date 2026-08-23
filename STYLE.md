# AntiClodeX Product Style Guide

This guide documents the current AntiClodeX visual system so the same product style can be recreated in another application. The canonical source is the shared UI package, especially `packages/ui/src/styles.css`, `packages/ui/src/theme.tsx`, and `packages/ui/src/scheme.tsx`.

## Product Feel

AntiClodeX should feel like a compact engineering workspace, close to an editor or systems tool rather than a marketing site. The interface uses neutral surfaces, thin borders, small type, dense spacing, and restrained interaction states. It should prioritize scanability, hierarchy, and repeated daily use.

Most screens are quiet and utilitarian. Visual emphasis comes from typography, spacing, subtle background shifts, and exact borders. Avoid decorative cards, oversized controls, dramatic gradients, bokeh/orb decorations, and one-off color treatments. The landing page is the exception: it may use a more expressive mesh/glow background, but it still keeps text and controls structured inside a disciplined panel.

## Typography

Use the bundled Zed font family.

```css
--font: "Zed Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--font-mono: "Zed Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

Font face weights used by the product:

- `Zed Sans`: `400`, `500`, `600`, `700`
- `Zed Mono`: `400`, `500`, `700`, plus italic `400`

Type scale:

- Default body and UI copy: `13px-14px`
- Dense metadata, counts, chips, badges, and sidebar IDs: `10px-12px`
- Page titles: `18px-28px`, depending on density and page importance
- Card titles and section titles: `13px-18px`
- Landing hero title: `clamp(32px, 5vw, 48px)` on desktop, `clamp(30px, 12vw, 42px)` on small screens
- Markdown body: `14px` with `line-height: 1.6`
- Code and textarea markdown editing: `13px` with `line-height: 1.5`

Weights:

- `400` for normal body copy and muted labels
- `500` for buttons, compact nav items, row IDs, and secondary emphasis
- `600` for section titles, names, card titles, and modal titles
- `650/700` only for major page titles, hero titles, stats, and thread detail titles

Letter spacing is usually `0`. Use negative letter spacing only for large display titles, such as `-0.02em` to `-0.03em`. Use positive letter spacing for uppercase labels and badges, usually `0.03em-0.08em`.

## Color System

The product is token-driven. Recreate the look through CSS variables rather than hard-coded component colors.

### Default Light Theme

```css
--bg: #f5f5f4;
--bg-secondary: #fbfbfa;
--surface-soft: #efefee;
--surface-raised: #ffffff;
--fg: #1a1a1a;
--fg-muted: #6b6b6b;
--fg-subtle: #9a9a9a;
--border: #d8d8d6;
--border-strong: #c4c4c2;
--accent: #1a1a1a;
--accent-fg: #ffffff;
--focus-ring: rgba(23, 23, 23, 0.25);
--sidebar-bg: #efefee;
--window-bg: #e8e8e6;
--panel-bg: #fbfbfa;
--panel-bg-active: #ececea;
--titlebar-bg: #e8e8e6;
```

### Default Dark Theme

```css
--bg: #0d0d0d;
--bg-secondary: #131313;
--surface-soft: #1c1c1c;
--surface-raised: #181818;
--fg: #e6e6e6;
--fg-muted: #888888;
--fg-subtle: #555555;
--border: #262626;
--border-strong: #383838;
--accent: #e6e6e6;
--accent-fg: #0d0d0d;
--focus-ring: rgba(237, 237, 237, 0.35);
--sidebar-bg: #131313;
--window-bg: #0a0a0a;
--panel-bg: #161616;
--panel-bg-active: #232323;
--titlebar-bg: #0a0a0a;
```

### Zed Scheme

The Zed scheme keeps the same structure but shifts the palette warmer in light mode and lifted/editor-gray in dark mode.

Light:

```css
--bg: #f5f4f0;
--bg-secondary: #fbfaf7;
--surface-soft: #efeee9;
--surface-raised: #ffffff;
--fg: #1f1f1d;
--fg-muted: #6f6e6a;
--fg-subtle: #a3a39d;
--border: #dedcd5;
--border-strong: #c9c7bf;
--accent: #1f1f1d;
--accent-fg: #fbfaf7;
--sidebar-bg: #efeee9;
--window-bg: #e6e4dd;
--panel-bg: #fbfaf7;
--panel-bg-active: #e8e6df;
--titlebar-bg: #e6e4dd;
```

Dark:

```css
--bg: #1f1f21;
--bg-secondary: #232325;
--surface-soft: #2a2a2c;
--surface-raised: #26262a;
--fg: #e8e8e8;
--fg-muted: #8a8a8d;
--fg-subtle: #5e5e62;
--border: #2e2e30;
--border-strong: #3a3a3c;
--accent: #e8e8e8;
--accent-fg: #1c1c1e;
--sidebar-bg: #1d1d1f;
--window-bg: #181819;
--panel-bg: #232325;
--panel-bg-active: #2c2c2f;
--titlebar-bg: #1a1a1c;
```

### Semantic Colors

Keep semantic color use sparse.

- Danger button: `#a51212` background, `#7f0f0f` border, `#ffffff` text; hover background `#8a0f0f`
- Field error: `#e5484d`
- Open status light: text `#1a7f37`, background `rgba(26, 127, 55, 0.1)`
- Open status dark: text `#3fb950`, background `rgba(63, 185, 80, 0.15)`
- Online dot: `#4ade80` with `0 0 4px rgba(74, 222, 128, 0.5)`
- Offline dot: `--fg-subtle`

Topology badges use strong categorical fills:

- Host: `#2f71ff`, border `#1749cc`
- Process: `#3faf60`, border `#1e6e39`
- Container: `#b98920`, border `#8a5f00`
- Library: `#7f63d2`, border `#5e44a8`
- Other/system: `#7a7a7a`, border `#515151`

Document chips use low-opacity tinted backgrounds and borders:

- Document/feature: `rgba(31, 109, 255, 0.12)` background, `rgba(31, 109, 255, 0.4)` border
- Skill: `rgba(180, 115, 0, 0.14)` background, `rgba(180, 115, 0, 0.4)` border
- Prompt: `rgba(30, 112, 132, 0.14)` background, `rgba(30, 112, 132, 0.4)` border
- Spec: `rgba(36, 156, 83, 0.12)` background, `rgba(36, 156, 83, 0.4)` border
- External: `rgba(20, 100, 255, 0.08)` background, `rgba(20, 100, 255, 0.42)` border

## Layout

The global app shell fills the viewport.

```css
html,
body,
#root {
  height: 100%;
}

#root {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

html,
body {
  max-width: 100%;
  overflow-x: hidden;
}
```

Use a flex shell:

- Header at the top, `36px` on desktop app chrome and `40px` on web
- Main app area is `display: flex`, `min-height: 0`, background `--window-bg`
- Sidebar is fixed-width inside the shell
- Content area is flexible, `overflow-y: auto`, background `--panel-bg`
- Status bar at the bottom, `36px-40px`

### Header and Status Bar

Header:

- Height: `40px` web, `36px` desktop
- Padding: `0 16px` desktop/default, `0 12px` below `900px`, `0 10px` below `640px`
- Border: `1px solid var(--border)` at the bottom
- Background: `--titlebar-bg`
- Logo row gap: `4px-6px`
- Header logo text: `13px`, `500`, `-0.01em`
- Project label: `12px`, muted, single-line ellipsis, max `min(42vw, 420px)`

Status bar:

- Height: `40px`, or `36px` desktop
- Padding: `0 16px`
- Font size: `12px`; center metadata `11px`
- Border-top: `1px solid var(--border)`
- Context labels use mono at `11px`, ellipsized, max `50vw`

### Sidebar

The sidebar is compact and editor-like.

- Width: `240px`
- Background: `--sidebar-bg`
- Border-right: `1px solid var(--border)`
- Nav padding: `6px 0`
- Project row: `4px 10px 4px 8px`, `12px`, `500`
- Thread row: `3px 10px 3px 26px`, `12px`
- Counts and IDs use mono at `10px`
- Empty states use `11px-13px` muted text
- Hover state: background `--panel-bg-active`, foreground `--fg`

### Pages

Standard pages:

- Max width: `1024px`
- Width: `100%`
- Margin: `0 auto`
- Padding: `48px 24px`
- Mobile padding: `20px 14px 30px` below `900px`, `16px 10px 24px` below `640px`

Thread detail pages:

- Max width: `1320px`
- Desktop top padding: `32px`
- Mobile padding: `16px 12px 28px`

Page header:

- `display: flex`
- `align-items: center`
- Gap: `12px`, then `10px` on mobile
- Margin-bottom: `24px`, then `16px` on mobile
- Page title: `20px/600`, mobile `18px/1.3`

### Spacing Ladder

Use this spacing ladder consistently:

```text
2px, 4px, 6px, 8px, 10px, 12px, 14px, 16px, 18px, 20px, 22px, 24px, 28px, 32px, 36px, 48px
```

The most common values are `8px`, `10px`, `12px`, `14px`, `16px`, `18px`, `20px`, `24px`, `32px`, and `48px`.

Patterns:

- Tight inline control gaps: `4px-8px`
- Row and toolbar gaps: `8px-12px`
- Card internal padding: `14px-24px`
- Section gaps: `20px-32px`
- Page gutters: `24px` desktop, `10px-14px` mobile

## Components

### Buttons

Primary button:

```css
padding: 6px 14px;
font-size: 13px;
font-weight: 500;
border: 1px solid var(--border);
border-radius: 5px;
background: var(--accent);
color: var(--accent-fg);
transition: opacity 0.15s;
```

Header buttons are smaller: `4px 12px`, `12px`. Hero call-to-action buttons are larger: `12px 32px`, `16px`.

Secondary buttons are transparent with `--fg` text. On hover they use `background: var(--border)` and keep `opacity: 1`.

Disabled buttons use `opacity: 0.4` and `cursor: not-allowed`.

### Icon Buttons

Icon buttons should be square and quiet.

- Size: `28px` by `28px`
- Border: none
- Radius: `4px`, or `50%` for round variant
- Background: transparent
- Color: `--fg-muted`
- Hover: background `--panel-bg-active`, color `--fg`
- Mobile icon buttons may increase to `32px`

Use lucide-style line icons. Avoid text labels where a familiar icon is clear.

### Cards and Panels

Default cards:

- Border: `1px solid var(--border)`
- Radius: usually `8px`; larger feature cards use `12px-14px`
- Background: `--bg-secondary`, `--surface-soft`, or a light vertical gradient from `--bg-secondary` to `--surface-raised`
- Padding: `16px-24px`
- Hover: border color shifts to `--fg-muted`

Use shadows sparingly. The standard soft shadow is:

```css
--shadow-soft: 0 18px 42px rgba(23, 23, 23, 0.08);
```

In dark mode, use:

```css
--shadow-soft: 0 18px 42px rgba(0, 0, 0, 0.45);
```

Home cards may lift by `translateY(-2px)` and gain `--shadow-soft`. Most operational panels should not lift.

### Forms

Form fields are stacked.

- Field container: flex column, gap `6px`
- Label: `13px`, `500`, `--fg-muted`
- Input: `8px 12px`, `14px`, `6px` radius
- Border: `1px solid var(--border)`
- Background: `--bg`
- Text: `--fg`
- Focus: border changes to `--fg-muted`; no heavy glow
- Error border: `#e5484d`
- Error text: `12px`, `#e5484d`
- Textareas resize vertically

Select inputs use custom chevrons drawn with CSS gradients and reserve `30px` right padding.

### Modals and Dropdowns

Modal overlay:

- Fixed inset `0`
- Background `rgba(0, 0, 0, 0.5)`
- Centered with flex
- `z-index: 100`

Modal panel:

- Background `--bg-secondary`
- Border `1px solid var(--border)`
- Radius `12px`
- Padding `24px`
- Width `100%`, max `480px`
- Flex column gap `20px`

On mobile, modals use `padding: 12px` on the overlay, align to the top, and panels use `max-width: 100%`, `padding: 16px`, `gap: 16px`, and vertical full-width actions.

Dropdowns:

- Min width `220px`
- Background `--bg-secondary`
- Border `1px solid var(--border)`
- Radius `8px`
- Padding `4px 0`
- Shadow `0 4px 16px rgba(0,0,0,.12)` in light and `rgba(0,0,0,.4)` in dark
- Items use `8px 16px`, `14px`

### Lists, Rows, and Tables

Rows are compact and separated with thin borders.

- Thread/list row padding: `12px 16px`
- Row title: `14px`, `500`
- Row metadata: `12px-13px`, muted
- Hover background: `--bg` or `--panel-bg-active`
- Nested rows use a `2px` left border

Tables use separated borders:

- Wrapper border: `1px solid var(--border)`, radius `10px`, overflow auto
- Cells and headers use `1px` right/bottom borders
- Header text: `13px`, `600`, muted
- Cell padding: `8px`
- Sticky row/column headers for dense matrix views

### Chips, Tags, Badges, and Status

Pill tags:

- Display inline-flex
- Gap `4px-6px`
- Padding `3px 8px` or `3px 10px`
- Font size `10px-12px`
- Font weight `500-600`
- Border `1px solid var(--border)`
- Radius `999px`
- Color often `--fg-muted`

Project badges are `11px`, `600`, `3px 8px`, capitalized. Thread statuses are `12px`, `500`, `2px 8px`, radius `12px`.

### Markdown and Code

Rendered markdown:

- Body: `14px`, `line-height: 1.6`
- Heading margins: `20px 0 8px`
- `h1`: `22px`, `h2`: `18px`, `h3`: `16px`
- Paragraph margin-bottom: `10px`
- Lists: padding-left `24px`, item margin-bottom `4px`
- Links: underlined, `2px` underline offset; markdown links are italic in message bodies
- Blockquote: `3px` left border, `14px` left padding, muted text
- Horizontal rule: `16px 0`, top border only
- Images: max-width `100%`, radius `6px`

Inline code:

- Mono font
- Font size `0.9em` or `13px`
- Padding `1px-2px 5px-6px`
- Radius `4px`
- Background `rgba(128,128,128,.15)` or `--surface-soft`

Preformatted blocks:

- Padding `10px-12px`
- Radius `6px-8px`
- Background subtle gray or `--surface-soft`
- Border only in chat message bodies
- Horizontal overflow allowed

### Landing Page

The unauthenticated landing page is the most expressive surface.

- Full flex hero, centered, `padding: 40px 24px`
- Background combines radial gradients, a conic gradient, and a neutral linear gradient
- Main panel width `min(1100px, 100%)`
- Grid: `1.35fr 1fr`, collapsing to one column below `960px`
- Gap `28px`
- Padding `36px`, then `24px`, then `20px`
- Radius `18px`, then `14px` on small screens
- Border uses `--home-grid-line`
- Panel background uses translucent `--home-panel-bg` and `--home-panel-bg-alt`
- Backdrop blur: `blur(6px) saturate(1.35)`

Landing highlights are small stacked panels with `14px 16px` padding, `12px` radius, and hover `translateY(-1px)`.

## Interactions and Motion

Interactions are subtle and fast.

- Basic hover transitions: `0.1s-0.15s`
- Card and landing transitions: `0.2s ease`
- Hover typically changes one or two of: border color, background, foreground color, opacity
- Primary button hover uses `opacity: 0.85`
- Icon button hover uses background and color changes
- Cards generally do not animate except home/landing cards
- Collapsible thread content uses `0.16s ease-out`, fading in and moving from `translateY(-3px)`

Respect reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  transition: none;
  transform: none;
}
```

Focus should be visible but not loud. The explicit card focus style is:

```css
outline: 2px solid var(--focus-ring);
outline-offset: 2px;
```

## Responsive Behavior

Use these breakpoints:

- `960px`: landing layout collapses, home overview stacks, stats move to two columns, thread detail cards reduce padding
- `900px`: main mobile app shell behavior starts
- `640px`: tightest mobile typography and page padding

Mobile shell:

- Header padding becomes `0 12px`, then `0 10px`
- Sidebar becomes a fixed overlay:
  - `top: 48px`
  - `left: 0`
  - `bottom: 0`
  - `width: min(320px, 88vw)`
  - `max-width: 88vw`
  - `z-index: 110`
  - shadow `10px 0 24px rgba(0,0,0,.2)` in light and `.5` alpha in dark
- Backdrop uses `rgba(10,10,10,.45)` and starts below the header

Mobile page/content changes:

- Page padding shrinks to `20px 14px 30px`, then `16px 10px 24px`
- Page headers wrap and align to flex-start
- Page title drops to `18px`, then thread titles to `22px` and `20px`
- Action groups wrap or stack
- Modal actions become full-width vertical buttons
- Template option lists stack vertically
- User/system chat message max width becomes `100%`

Thread/topology mobile:

- Thread card padding drops to `14px`
- Thread topology canvas height drops from `640px` to `460px`, then `380px`, then `320px`
- Fullscreen topology minimum height is `300px`
- Matrix wrappers cap height at `min(58vh, 620px)`
- Matrix node columns shrink from `180px` to `140px`, then `130px`
- Matrix cells shrink from `160px` to `130px`, then `120px`

## Implementation Checklist

When applying this style to another product:

- Start with the same CSS variable set for light, dark, and Zed schemes.
- Load `Zed Sans` and `Zed Mono`, or use the documented fallbacks when unavailable.
- Build the app shell first: header, sidebar, scrollable panel content, and status bar.
- Keep operational UI dense: `12px-14px` text, `1px` borders, `4px-8px` radii, compact gaps.
- Prefer neutral backgrounds and muted metadata over saturated color.
- Use semantic color only for status, danger, topology categories, and document/source chips.
- Use shadows and transforms sparingly, mostly on the landing/home surfaces.
- Preserve the responsive breakpoints and mobile sidebar overlay behavior.
