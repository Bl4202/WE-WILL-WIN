# Metro — Visual Style Guide

> Companion to `Transit_Authority_GDD.md`. This document is the single source of truth for visual design: color, type, spacing, elevation, and component styling. Anything not covered here should follow the spirit of §5 (UI/UX) in the GDD — map-first, low-chrome, data-dense but never noisy.

---

## 1. Design Philosophy and Core Principles

Metro is a **serious transit simulation wearing a transit-diagram's clothes**. The player spends 95% of their time looking at the map; every UI element exists to either feed that view or get out of its way. Two principles govern everything below.

### 1.1 Map-First Canvas Architecture

The map is not a panel inside the app — **the map *is* the app**. All UI is a set of floating overlays that sit on top of a full-bleed, edge-to-edge map canvas.

- **No chrome frame.** There is no fixed header bar that claims permanent vertical space, no sidebar that pushes the map viewport off-center. The map canvas always spans `100vw × 100vh` beneath everything else.
- **Overlays float, they don't dock.** Panels (toolbars, search, focus/inspector panels, legends) are absolutely-positioned cards with margin from the viewport edge (typically `12–16px`), not elements that reflow the canvas. Collapsing or hiding a panel never resizes the map.
- **Glass, not paint.** Every overlay uses translucency + backdrop-blur so the map's color and motion stay visible *through* the UI. This keeps the player spatially oriented even while a panel has focus. See §2.3.
- **Contextual, not persistent.** Detail panels (station/line inspector) only appear when something is selected, and disappear cleanly when it isn't. The chrome that *is* always-on (time controls, KPI glance strip, mode rail) is kept minimal and thin — a strip, not a bar.
- **Click-through where sensible.** Read-only informational overlays (e.g. the focus/inspector panel) should not block map interaction underneath them unless they contain interactive controls.

### 1.2 Transit Diagram Aesthetic

The player-facing map should read like a **world-class transit map** (Citymapper / Mapbox Transit / Chicago "L" diagrams — see reference screenshots) rendered live: vibrant, legible at a glance, and calm under density.

- **Ultra-clear legibility first.** Line strokes are thick enough to trace at a glance (`4–6px` at default zoom), station markers are high-contrast white against the dark basemap, and labels never overlap without a deliberate collision-avoidance pass.
- **Vibrant, purposeful color coding.** Every line gets one saturated, distinct hue from the categorical palette (§2.4). Color is the primary way the player distinguishes lines — never rely on line style alone to carry meaning that color could carry.
- **High-contrast badges over subtle ones.** Line badges, mode icons, and status pills use solid fills and white/near-white text — never low-contrast gray-on-gray. If it's a data element the player scans quickly, it must pass at a glance, not on close reading.
- **Compact utility.** Controls are icon-first, dense, and tooltip-labeled rather than verbosely spelled out. A toolbar button is `36–40px` square, not a labeled rectangle.
- **Low visual clutter.** Basemap detail recedes (dimmed labels, muted street grid) so the transit network — the player's *work* — is always the brightest, highest-contrast thing on screen. Decorative chrome (gradients, drop shadows, iconography) is used sparingly and only to establish elevation, never for ornament.

---

## 2. Color System and Design Tokens

### 2.1 Base Theme

**Dark mode is the default and primary-designed experience** — it matches the Mapbox dark basemap the game is built around and makes saturated line colors pop. Light mode is a fully supported alternate theme, not an afterthought; every token below has a light-mode counterpart.

Theme is controlled by a `data-theme` attribute on `:root` (`"dark"` default, `"light"` opt-in), with `prefers-color-scheme` as the initial default when no explicit preference is stored.

```css
:root {
  color-scheme: dark;
}
:root[data-theme="light"] {
  color-scheme: light;
}
```

### 2.2 Core CSS Variables

```css
:root {
  /* ── Canvas & Surfaces (dark, default) ───────────────────── */
  --color-canvas: #0b0e12;                 /* map fallback bg, behind Mapbox tiles */
  --surface-panel: rgba(20, 23, 28, 0.82);  /* floating panel fill */
  --surface-panel-solid: #14181d;           /* opaque fallback (no backdrop-filter support) */
  --surface-raised: rgba(30, 34, 41, 0.92); /* dropdowns, popovers, menus */
  --surface-sunken: rgba(10, 12, 15, 0.55); /* input fields, wells, code chips */
  --surface-hover: rgba(255, 255, 255, 0.06);
  --surface-active: rgba(255, 255, 255, 0.10);

  /* ── Text ─────────────────────────────────────────────────── */
  --text-primary: #eef1f5;
  --text-secondary: #a8b0ba;
  --text-tertiary: #6b7480;
  --text-on-accent: #ffffff;
  --text-disabled: #4a515a;

  /* ── Borders ──────────────────────────────────────────────── */
  --border-subtle: rgba(255, 255, 255, 0.08);
  --border-default: rgba(255, 255, 255, 0.14);
  --border-strong: rgba(255, 255, 255, 0.22);
  --border-focus: var(--accent-primary);

  /* ── Blur ─────────────────────────────────────────────────── */
  --blur-panel: 16px;
  --blur-modal: 28px;

  /* ── Primary Accent: signature pink/magenta ──────────────── */
  --accent-primary: #ff3d8a;
  --accent-primary-hover: #ff5c9d;
  --accent-primary-active: #e02176;
  --accent-primary-muted: rgba(255, 61, 138, 0.16);   /* tinted backgrounds */
  --accent-primary-border: rgba(255, 61, 138, 0.45);

  /* ── Secondary Accent: supporting blue ───────────────────── */
  --accent-blue: #4fc3f7;
  --accent-blue-hover: #6fd0fa;
  --accent-blue-active: #2ea8de;
  --accent-blue-muted: rgba(79, 195, 247, 0.16);

  /* ── Semantic ─────────────────────────────────────────────── */
  --color-success: #43c07a;
  --color-warning: #ffb74d;
  --color-danger: #ef5350;
  --color-info: var(--accent-blue);

  /* ── Shadows / Elevation (see §2.6) ──────────────────────── */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.30);
  --shadow-2: 0 4px 12px rgba(0, 0, 0, 0.35);
  --shadow-3: 0 8px 24px rgba(0, 0, 0, 0.40);
  --shadow-4: 0 16px 48px rgba(0, 0, 0, 0.50);
  --shadow-focus-ring: 0 0 0 3px var(--accent-primary-muted);

  font-family: "Inter", "Segoe UI", system-ui, sans-serif;
}

/* ── Light mode overrides ────────────────────────────────────── */
:root[data-theme="light"] {
  --color-canvas: #eef1f4;
  --surface-panel: rgba(255, 255, 255, 0.80);
  --surface-panel-solid: #ffffff;
  --surface-raised: rgba(255, 255, 255, 0.96);
  --surface-sunken: rgba(15, 23, 42, 0.04);
  --surface-hover: rgba(15, 23, 42, 0.05);
  --surface-active: rgba(15, 23, 42, 0.09);

  --text-primary: #1a1f26;
  --text-secondary: #4b5563;
  --text-tertiary: #8a919b;
  --text-on-accent: #ffffff;
  --text-disabled: #b6bcc4;

  --border-subtle: rgba(15, 23, 42, 0.07);
  --border-default: rgba(15, 23, 42, 0.12);
  --border-strong: rgba(15, 23, 42, 0.20);

  --shadow-1: 0 1px 2px rgba(15, 23, 42, 0.06);
  --shadow-2: 0 4px 12px rgba(15, 23, 42, 0.10);
  --shadow-3: 0 8px 24px rgba(15, 23, 42, 0.14);
  --shadow-4: 0 16px 48px rgba(15, 23, 42, 0.18);
}
```

### 2.3 Surface & Overlay Colors — Frosted Glass Panels

Every floating panel (toolbar, sidebar, drawer, focus/inspector card, dropdown) uses the same recipe:

```css
.panel {
  background: var(--surface-panel);
  backdrop-filter: blur(var(--blur-panel)) saturate(1.4);
  -webkit-backdrop-filter: blur(var(--blur-panel)) saturate(1.4);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  box-shadow: var(--shadow-3);
}

/* Elements requiring guaranteed opacity (perf, or stacked over dense map data) */
.panel--solid {
  background: var(--surface-panel-solid);
  backdrop-filter: none;
}
```

`saturate(1.4)` on the blur is deliberate — it keeps the map's colors from washing out to gray under the glass, which is what makes the pink/magenta and line-color accents still feel vibrant even through a panel.

**Fallback:** wrap `backdrop-filter` usage behind a `@supports` check; browsers without support get `--surface-panel-solid` at ~96% opacity instead of the translucent value.

### 2.4 Transit Line Color System

Two independent layers of meaning ride on a line's visual style: **color** (which specific line) and **stroke pattern** (which mode category, for the player's fast visual grouping — see the mode catalogue in GDD §3.3). Never rely on stroke pattern alone; always pair with a legend/badge.

**Core categorical palette** (assigned to lines in rotation, order matters — chosen for maximum adjacent-hue separation, dark-bg contrast, and CVD (color-vision-deficiency) legibility):

| # | Name | Hex | Swatch |
|---|------|-----|--------|
| 1 | Signal Red | `#e5384f` | 🟥 |
| 2 | Transit Blue | `#2f80ed` | 🟦 |
| 3 | Emerald | `#2fb85c` | 🟩 |
| 4 | Sunflower | `#f4c430` | 🟨 |
| 5 | Violet | `#9b51e0` | 🟪 |
| 6 | Tangerine | `#f2884b` | 🟧 |
| 7 | Cyan | `#00b8d9` | 🟦 |
| 8 | Magenta Rose | `#e0447a` | 🟪 |
| 9 | Lime | `#8bc34a` | 🟩 |
| 10 | Indigo | `#5e5ce6` | 🟪 |
| 11 | Amber | `#ffb300` | 🟨 |
| 12 | Rose Pink | `#f48fb1` | 🟪 |
| 13 | Teal | `#26a69a` | 🟦 |
| 14 | Sienna | `#a1887f` | 🟫 |
| 15 | Sky | `#64b5f6` | 🟦 |
| 16 | Chartreuse | `#c0d93e` | 🟩 |

```css
:root {
  --line-color-1: #e5384f;
  --line-color-2: #2f80ed;
  --line-color-3: #2fb85c;
  --line-color-4: #f4c430;
  --line-color-5: #9b51e0;
  --line-color-6: #f2884b;
  --line-color-7: #00b8d9;
  --line-color-8: #e0447a;
  --line-color-9: #8bc34a;
  --line-color-10: #5e5ce6;
  --line-color-11: #ffb300;
  --line-color-12: #f48fb1;
  --line-color-13: #26a69a;
  --line-color-14: #a1887f;
  --line-color-15: #64b5f6;
  --line-color-16: #c0d93e;
}
```

**Mode-category defaults & stroke treatment.** When a new line of a given mode is created, it seeds from that mode's reserved slice of the palette above and adopts a default stroke pattern. The player may recolor freely; the pattern stays mode-locked (it's the accessible, colorblind-safe backup signal).

| Mode | Seed colors (palette #) | Stroke weight | Stroke pattern | Notes |
|---|---|---|---|---|
| **Metro** (heavy rail) | 1, 2, 3, 5 | `6px` | solid | Thickest stroke — trunk-line priority in z-order too |
| **Express** (regional/limited) | 6, 8 | `5px` | solid + chevron ticks every `40px` | Chevrons imply direction/speed |
| **Light Rail** | 7, 13 | `5px` | solid | Same weight as Express, no ticks |
| **Regional Rail** | 14, 10 | `5px` | long dash (`14px on / 6px off`) | Reads as "leaves the dense core" |
| **Bus / BRT** | 12, 15 | `3px` | short dash (`6px on / 5px off`) | Thinner — secondary to rail in visual hierarchy |
| **Ferry** | 13 (teal), 7 (cyan) | `4px` | dotted (`2px dot / 6px gap`), drawn with a slight wave `stroke-dasharray` animation optional | Only mode allowed a "water" motif |

Route selection state overrides color, never pattern: a selected/hovered line gets a `--shadow-2`-style glow (`filter: drop-shadow(0 0 6px <line-color>)`) plus a `+2px` width bump; deselected lines when *something else* is selected drop to `40%` opacity rather than changing hue.

### 2.5 Station Markers

Matches the reference transit-map style directly:

| Marker | Meaning | Style |
|---|---|---|
| **Open white circle**, `8px` diameter | Regular waypoint / local stop | `fill: #f4f6f8`, `stroke: var(--color-canvas)` `2px` |
| **White diamond**, `11px` | Interchange / transfer station (2+ lines) | `fill: #ffffff`, `stroke: #0d1116` `2px`, rotated 45° square |
| **Filled colored ring**, `13px` | Line terminus / major hub | Fill = line color, `stroke: #ffffff` `2.5px`, halo `shadow-1` |
| **Selected station** | Any of the above, selected | `stroke: var(--accent-blue)`, `3px`, plus `--shadow-focus-ring`-style outer glow |

### 2.6 Borders and Shadows — Elevation Layers

Four elevation tiers, used consistently so the player can read "what's on top of what" instantly:

| Level | Token | Use | Border | Shadow |
|---|---|---|---|---|
| 0 | — | Map canvas itself | none | none |
| 1 | `--shadow-1` | Inline chips, badges, list rows | `--border-subtle` | flat, barely-there |
| 2 | `--shadow-2` | Toolbars, glance strip, mode rail | `--border-default` | soft, close |
| 3 | `--shadow-3` | Floating panels, drawers, focus/inspector cards | `--border-default` | soft, medium spread — **default panel elevation** |
| 4 | `--shadow-4` | Modals, dropdown menus, command palettes, dragged elements | `--border-strong` | pronounced, large spread |

Borders are always `1px`, always a translucent white/black (never a saturated color) so they read as "edge of glass," not decoration. The one exception is `--border-focus`, used solely for keyboard-focus and active-drag outlines.

---

## 3. Typography and Spatial System

### 3.1 Font Selection

- **Primary UI typeface: [Inter](https://rsms.me/inter/).** Clean, geometric-humanist, excellent hinting at small sizes, huge language coverage, and built-in tabular figures — ideal for a UI dense with numbers (KPIs, headways, distances, clocks).
- **Fallback stack:** `"Inter", "Segoe UI", system-ui, -apple-system, sans-serif` (keeps native OS rendering as a graceful degrade, matching the current prototype's stack).
- **Numeric/tabular contexts** (clock, KPI counters, headway/length readouts, coordinates): always set `font-variant-numeric: tabular-nums;` so digits don't jitter as values tick over in real time.
- **Do not** introduce a second display/serif face. One family, weight and size do all the hierarchy work.

```css
--font-ui: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
--font-mono: "IBM Plex Mono", "Cascadia Code", monospace; /* debug/dev overlays only */
```

### 3.2 Type Hierarchy

| Role | Size | Weight | Line-height | Letter-spacing | Color token |
|---|---|---|---|---|---|
| Panel title (h3-equivalent) | `14px` | 600 | 1.3 | 0 | `--text-primary` (or accent for emphasis titles) |
| Section label (all-caps eyebrow) | `11px` | 600 | 1.2 | `0.06em` | `--text-tertiary` |
| Station / line list item | `13px` | 500 | 1.4 | 0 | `--text-primary` |
| Line badge text | `12px` | 700 | 1 | `0.01em` | `--text-on-accent` |
| Button label | `13px` | 600 | 1 | 0 | context-dependent |
| Body / description text | `13px` | 400 | 1.5 | 0 | `--text-secondary` |
| Micro-label (tooltips, chip captions, timestamps) | `11px` | 500 | 1.3 | `0.02em` | `--text-tertiary` |
| KPI headline number | `16–20px` | 700 | 1.1 | 0 | `--accent-primary` or `--accent-blue` |
| Keyboard-shortcut chip | `10px` | 600 | 1 | 0 | `--text-tertiary` on `--surface-sunken` |

### 3.3 Spatial Grid — 4px / 8px Scale

All padding, gaps, margins, and offsets are multiples of `4px`. Prefer the `8px` step for macro layout, `4px` for micro/internal component spacing.

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
--space-16: 64px;
```

**Conventions:**
- Panel outer padding: `--space-4` (`16px`), tight variants (toolbars) use `--space-2` (`8px`).
- Gap between list rows: `--space-1` to `--space-2`.
- Panel-to-viewport-edge margin: `--space-3` (`12px`), matching the current `#focus-panel` implementation.
- Icon-to-label gap in buttons: `--space-2` (`8px`).
- Section-to-section gap inside a panel: `--space-4`–`--space-5`.

### 3.4 Z-Index Scale

```css
--z-canvas: 0;             /* map tiles / base render layer */
--z-line-vectors: 10;      /* transit line polylines drawn on canvas */
--z-station-markers: 20;   /* station dots/diamonds, always above lines */
--z-line-labels: 25;       /* line/station text labels on the map */
--z-vehicles: 30;          /* moving train/bus glyphs, above everything drawn on-canvas */
--z-chrome: 90;            /* glance strip, mode rail, bottom bar */
--z-floating-panel: 100;   /* toolbars, focus/inspector panels, drawers */
--z-panel-header: 105;     /* sticky headers within a scrollable panel */
--z-dropdown: 200;         /* select menus, autocomplete lists, context menus */
--z-tooltip: 210;          /* hover tooltips — always above dropdowns that spawned them */
--z-modal-backdrop: 290;
--z-modal: 300;            /* dialogs, command palette */
--z-toast: 400;            /* transient notifications — always on top */
```

---

## 4. UI Component Specifications

### 4.1 Floating Sidebar and Drawers

- **Structure:** glassmorphic header (`--surface-raised`, `--shadow-2`, sticky) + scrollable body (`--surface-panel`) + optional footer action row.
- **Collapse behavior:** drawers collapse to an icon rail (`48px` wide) rather than fully hiding, so navigation is always one click away. Collapse/expand animates `width` over `200ms ease-out`.
- **Navigation tabs:** horizontal icon+label tabs in the header, active tab indicated by a `2px` bottom border in `--accent-primary` plus a subtle `--accent-primary-muted` background wash — never color-only (add the border for contrast-mode/CVD safety).
- **Scrollable content:** `overflow-y: auto`, custom thin scrollbar (`6px`, `--border-strong` thumb, transparent track), momentum scrolling enabled. Content padding `--space-4`, row gap `--space-1`.
- **Resizable drawers** (if applicable) get an `8px` drag handle at the edge, cursor `col-resize`, highlight on hover with `--accent-blue-muted`.

### 4.2 Top Header and Search Bar

- **Search input:** pill-shaped (`border-radius: 999px`), `height: 40px`, `--surface-sunken` background, `--border-subtle` border, left-aligned search icon at `--space-3` inset, placeholder text in `--text-tertiary`.
- **Keyboard shortcut chip:** right-aligned inside the pill (e.g. `⌘K` / `Ctrl K`), rendered as a small `--surface-raised` chip, `10px` monospace-ish label, `4px` corner radius, sits flush against the input's right padding.
- **Quick search dropdown:** appears below the pill with `--space-1` gap, `--surface-raised` background, `--shadow-4`, `--z-dropdown`. Results grouped by type (Stations / Lines / Zones) with `11px` uppercase group labels (`--text-tertiary`). Active/hovered row gets `--surface-hover` and a `2px` left accent bar in `--accent-primary`.
- **Focus state:** on focus, the pill border transitions to `--border-focus` and gains `--shadow-focus-ring` over `150ms ease`.

### 4.3 Toolbars and Map Controls

Directly modeled on the reference screenshot's top-left control cluster (fullscreen / save / undo icons + basemap-style radio list):

- **Container:** compact `.panel` (§2.3), `border-radius: 10px`, padding `--space-2`.
- **Icon button group (row):** square buttons, `32px`, no visible border between adjacent buttons in a group — separated only by `--space-1` gap or a `1px` `--border-subtle` divider for tightly-packed groups.
- **Active state:** active/toggled control gets `--accent-primary-muted` fill + `--accent-primary` icon color (matches the filled amber/blue dot seen in reference — but standardized to the primary pink accent for anything that represents "current tool/mode"). Reserve `--accent-blue` for informational/selection state, `--accent-primary` for the player's *active input mode*.
- **Radio-style option list** (e.g. basemap style picker): standard radio input restyled to a `14px` ring, checked state fills with `--accent-primary`, label text `13px` `--text-primary`, row height `28px`, `4px` vertical gap.
- **Checkbox rows** (e.g. layer toggles like "Waypoints"): `14px` box, `4px` radius, checked state = `--accent-primary` fill with a white check glyph.
- **Tooltips:** every icon-only control has a tooltip, `150ms` delay before show, `--surface-raised` background, `--shadow-2`, `11px` text, arrow pointing to trigger, `--z-tooltip`.
- **Map zoom/compass controls:** bottom-right or top-right stacked icon buttons, same `32px` square spec, grouped in a single rounded container.

### 4.4 Transit Badges and Line Indicators

- **Line badge (pill):** `border-radius: 999px`, `padding: 2px 10px`, background = line color at full saturation, text = `--text-on-accent`, `12px` weight 700. Used inline in lists, tooltips, and the inspector panel header.
- **Line badge (square/route-number style):** for numbered lines, `24×24px`, `border-radius: 6px`, background = line color, centered bold number, white text — mirrors real-world route bullets.
- **Station pill:** `--surface-raised` background, `1px` `--border-default`, `border-radius: 999px`, `padding: 4px 10px`, contains a small colored dot (`6px`) per serving line + station name, `13px` text.
- **Connection/transfer indicator:** stacked overlapping small circles (`10px`, `-4px` overlap) in each connecting line's color, white `1.5px` stroke to separate them — used wherever a station serves 2+ lines in list contexts.
- **Draggable reorder handle:** `⠿` grip icon (or 6-dot grid), `16px`, `--text-tertiary` default, `--text-secondary` on hover, `cursor: grab` (`grabbing` while active). Dragged row gets `--shadow-3`, slight `1.02` scale, and drops to `--z-dropdown` while in motion; drop-target gap animates open over `150ms`.
- **Status/KPI pill:** small rounded rect, semantic color background at `16%` opacity (`--color-success`/`--color-warning`/`--color-danger` muted variants), full-opacity text and left dot indicator.

### 4.5 Interactive States

Consistent, snappy, never sluggish — this is a real-time sim, the UI should feel like it too.

| State | Treatment |
|---|---|
| **Hover** | `background: var(--surface-hover)`; icons/text may lighten one step (`--text-secondary` → `--text-primary`). Transition `150ms ease-out`. |
| **Active (pressed)** | `background: var(--surface-active)`, scale `0.97` on buttons, transition `100ms ease-out` (faster than hover — should feel immediate). |
| **Selected / toggled on** | `--accent-primary-muted` background + `--accent-primary` text/icon/border. Persists until deselected, not just while pressed. |
| **Focus-visible** | `outline: none; box-shadow: var(--shadow-focus-ring);` — **only** on `:focus-visible`, never on mouse click, to keep the map-first UI free of focus rings during normal pointer play. `200ms ease` transition. |
| **Disabled** | `opacity: 0.45`, `cursor: not-allowed`, `color: var(--text-disabled)`, all hover/active transitions suppressed (`pointer-events: none` where safe). |
| **Loading** | Content dims to `60%` opacity, a `14px` spinner (`--accent-primary` stroke on `--border-subtle` track) fades in after a `300ms` delay (avoids flicker on fast loads). |

**Transition timing standard:** all micro-interactions (hover, focus, toggle, color shifts) use **`150–250ms`**, `ease-out` for entrances/expansions, `ease-in` for exits/collapses. Panel open/close and drawer collapse sit at the higher end (`200–250ms`); button/badge state changes sit at the lower end (`150ms`). Never animate `width`/`height` directly on high-frequency elements (KPI counters, live vehicle glyphs) — those update via text/transform only, at simulation tick rate, with no CSS transition (they'd fight the sim's own 4 Hz cadence — see GDD §4.3).

```css
:root {
  --transition-fast: 150ms ease-out;
  --transition-base: 200ms ease-out;
  --transition-slow: 250ms ease-out;
}
```

---

## 5. Tailwind Token Mapping

For teams using Tailwind, map the CSS variables above into `tailwind.config` so utility classes stay in sync with the design tokens (avoids hardcoded hex drift):

```js
// tailwind.config.js
module.exports = {
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        panel: "var(--surface-panel)",
        "panel-solid": "var(--surface-panel-solid)",
        raised: "var(--surface-raised)",
        sunken: "var(--surface-sunken)",
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
          disabled: "var(--text-disabled)",
        },
        border: {
          subtle: "var(--border-subtle)",
          DEFAULT: "var(--border-default)",
          strong: "var(--border-strong)",
          focus: "var(--border-focus)",
        },
        accent: {
          primary: "var(--accent-primary)",
          "primary-hover": "var(--accent-primary-hover)",
          "primary-active": "var(--accent-primary-active)",
          blue: "var(--accent-blue)",
          "blue-hover": "var(--accent-blue-hover)",
        },
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        danger: "var(--color-danger)",
        line: {
          1: "var(--line-color-1)", 2: "var(--line-color-2)",
          3: "var(--line-color-3)", 4: "var(--line-color-4)",
          5: "var(--line-color-5)", 6: "var(--line-color-6)",
          7: "var(--line-color-7)", 8: "var(--line-color-8)",
          9: "var(--line-color-9)", 10: "var(--line-color-10)",
          11: "var(--line-color-11)", 12: "var(--line-color-12)",
          13: "var(--line-color-13)", 14: "var(--line-color-14)",
          15: "var(--line-color-15)", 16: "var(--line-color-16)",
        },
      },
      spacing: {
        1: "var(--space-1)", 2: "var(--space-2)", 3: "var(--space-3)",
        4: "var(--space-4)", 5: "var(--space-5)", 6: "var(--space-6)",
        8: "var(--space-8)", 10: "var(--space-10)", 12: "var(--space-12)",
        16: "var(--space-16)",
      },
      backdropBlur: {
        panel: "var(--blur-panel)",
        modal: "var(--blur-modal)",
      },
      boxShadow: {
        1: "var(--shadow-1)", 2: "var(--shadow-2)",
        3: "var(--shadow-3)", 4: "var(--shadow-4)",
        "focus-ring": "var(--shadow-focus-ring)",
      },
      zIndex: {
        canvas: "var(--z-canvas)",
        "line-vectors": "var(--z-line-vectors)",
        "station-markers": "var(--z-station-markers)",
        "line-labels": "var(--z-line-labels)",
        vehicles: "var(--z-vehicles)",
        chrome: "var(--z-chrome)",
        panel: "var(--z-floating-panel)",
        dropdown: "var(--z-dropdown)",
        tooltip: "var(--z-tooltip)",
        modal: "var(--z-modal)",
        toast: "var(--z-toast)",
      },
      fontFamily: {
        ui: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "Cascadia Code", "monospace"],
      },
      transitionDuration: {
        fast: "150ms",
        base: "200ms",
        slow: "250ms",
      },
    },
  },
};
```

---

## 6. Migration Notes (from current prototype)

The Phase-0 prototype (`src/style.css`) already establishes the right instincts — dark base, translucent panels, tabular numerics for the clock/KPIs, a minimal glance strip. This spec extends it rather than replacing its intent:

- `--panel` → split into `--surface-panel` (translucent) and `--surface-panel-solid` (fallback); add `backdrop-filter` blur, which the prototype currently omits.
- `--accent: #4fc3f7` → retained as `--accent-blue` (secondary/informational accent); a new `--accent-primary` (`#ff3d8a`, pink/magenta) is introduced for primary actions and active-mode indication, per the target visual direction.
- `--amber: #ffb74d` → retained as `--color-warning`.
- The ad-hoc `LINE_COLORS` array in `src/simulation.ts` should be replaced with the 16-color `--line-color-*` palette in §2.4, extended with the mode-default/stroke-pattern mapping so future modes (bus, ferry, etc. per GDD §3.3) are visually distinguishable beyond hue alone.
- `#focus-panel`'s existing position/sizing (`top/right: 12px`, `260px` wide) matches the §3.3 spacing convention already — keep it, just apply the new `.panel` glass treatment and type tokens.
