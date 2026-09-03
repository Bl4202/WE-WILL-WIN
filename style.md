# Metro — Visual Style Guide

*This document uses ASD-STE100 Simplified Technical English. The code blocks
are source code, and they keep their original text.*

> This is a companion to `Transit_Authority_GDD.md`. This document is the one
> source of truth for the visual design. It covers the colour, the type, the
> space, the elevation, and the components. For an item that this document does
> not cover, obey §5 of the GDD, which covers the interface. That section is
> map-first, with little chrome. It holds much data, but it is never noisy.

---

## 1. Design philosophy and core principles

Metro is a serious transit simulation with the appearance of a transit diagram.
The player looks at the map for 95% of the time. Each interface element must
give data to that view or stay out of it. Two principles control all the rules
below.

### 1.1 The map is the canvas

The map is not a panel in the application. **The map *is* the application.** The
interface is a set of overlays above a map canvas that fills the full screen.

- **There is no chrome frame.** There is no fixed header bar that takes
  permanent vertical space. There is no sidebar that moves the map away from
  the centre. The map canvas is always `100vw × 100vh` below the other
  elements.
- **The overlays float. They do not dock.** The panels are cards at absolute
  positions, with a margin from the edge of the screen. The usual margin is
  `12–16px`. A panel does not change the size of the canvas. If you collapse a
  panel or hide it, the map does not change its size. The panels are the
  toolbars, the search field, the inspector panels, and the legends.
- **Use glass, not paint.** Each overlay is translucent and has a blur behind
  it. Thus the player sees the colour and the movement of the map *through*
  the interface. This keeps the player oriented while a panel has the focus.
  See §2.3.
- **The panels are contextual, not permanent.** A detail panel for a station or
  a line appears only after the player selects an object. It goes away when the
  player deselects the object. The permanent chrome is the time controls, the
  KPI strip, and the mode rail. Keep that chrome thin and small. It is a strip,
  not a bar.
- **Let the pointer through where this is correct.** An overlay that only shows
  data must not stop the map below it. An example is the inspector panel. An
  overlay with controls in it can stop the map.

### 1.2 The transit diagram appearance

The map must look like a transit map of the highest quality, but live. Examples
are Citymapper, Mapbox Transit, and the Chicago "L" diagrams. See the reference
screenshots. The map must be strong in colour, easy to read, and calm when it
holds much data.

- **Legibility is first.** A line stroke is thick enough to follow with the
  eye. It is `4–6px` at the default zoom. A station marker is white, with a
  high contrast against the dark basemap. Labels do not touch each other. A
  pass to prevent a collision controls this.
- **The colour has a purpose.** Each line gets one strong, separate colour from
  the palette in §2.4. Colour is the primary method that shows the difference
  between two lines. Never use the stroke style alone to carry data that the
  colour can carry.
- **Use badges with a high contrast.** The line badges, the mode icons, and the
  status pills have solid fills and white or almost-white text. Never use grey
  text on a grey background. The player reads these elements quickly. Thus each
  one must be legible at a glance, not after a careful examination.
- **Keep the controls compact.** A control has an icon first. The controls are
  dense, and a tooltip gives the words. A toolbar button is a square of
  `36–40px`. It is not a rectangle with a label.
- **Keep the screen clean.** The detail of the basemap must be weak. Make its
  labels dark and its street grid quiet. Thus the transit network, which is the
  *work* of the player, is always the brightest element on the screen. Use the
  gradients, the shadows, and the icons very little. They show the elevation.
  They are not decoration.

---

## 2. The colour system and the design tokens

### 2.1 The base theme

**The dark mode is the default and the primary design.** It agrees with the
dark Mapbox basemap of the game, and it makes the strong line colours clear.
The light mode is a full alternative theme, not an addition at the end. Each
token below has a light-mode equivalent.

A `data-theme` attribute on `:root` controls the theme. The value `"dark"` is
the default, and the value `"light"` is optional. If there is no stored
preference, `prefers-color-scheme` gives the first value.

```css
:root {
  color-scheme: dark;
}
:root[data-theme="light"] {
  color-scheme: light;
}
```

### 2.2 The core CSS variables

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

### 2.3 The surface colours — the glass panels

Each panel uses the same recipe. This includes the toolbar, the sidebar, the
drawer, the inspector card, and the dropdown.

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

The `saturate(1.4)` value on the blur is deliberate. It stops the colours of
the map when they become grey below the glass. Thus the pink accent, the
magenta accent, and the line colours stay strong through a panel.

**If the browser does not support the blur:** put the `backdrop-filter` in a
`@supports` block. A browser without support gets `--surface-panel-solid` at
approximately 96% opacity. It does not get the translucent value.

### 2.4 The colour system for the transit lines

The visual style of a line carries two separate types of data. The **colour**
gives the identity of the line. The **stroke pattern** gives the category of
the mode, which lets the player group the lines quickly. See the mode catalogue
in GDD §3.3. Never use the stroke pattern alone. Always add a legend or a
badge.

**The core palette.** The game assigns these colours to the lines in order. The
order is important, because these colours give:

- The maximum separation between two adjacent colours.
- A good contrast on a dark background.
- Good legibility for a person with a colour vision deficiency (CVD).

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

**The default colour and stroke for each mode.** The player makes a new line of
a given mode. The line then takes a colour from the part of the palette that
the mode reserves. It also takes a default stroke pattern. The player can
change the colour, but the pattern stays with the mode. The pattern is the
backup signal for a person with a colour vision deficiency.

| Mode | Seed colours (palette #) | Stroke weight | Stroke pattern | Notes |
|---|---|---|---|---|
| **Metro** (heavy rail) | 1, 2, 3, 5 | `6px` | solid | The thickest stroke. It is also first in the z-order. |
| **Express** (regional or limited) | 6, 8 | `5px` | solid, with chevron ticks each `40px` | The chevrons show the direction and the speed. |
| **Light Rail** | 7, 13 | `5px` | solid | The same weight as Express, but with no ticks. |
| **Regional Rail** | 14, 10 | `5px` | long dash (`14px on / 6px off`) | This shows that the line leaves the dense centre. |
| **Bus / BRT** | 12, 15 | `3px` | short dash (`6px on / 5px off`) | Thinner. It is below the rail in the visual order. |
| **Ferry** | 13 (teal), 7 (cyan) | `4px` | dotted (`2px dot / 6px gap`). A light wave animation on the `stroke-dasharray` is optional. | This is the only mode with a water pattern. |

The selection state changes the colour, never the pattern. A line that the
player selects or points at gets a glow like `--shadow-2`, which is
`filter: drop-shadow(0 0 6px <line-color>)`. Its width also increases by `2px`.
When the player selects a different object, the other lines decrease to `40%`
opacity. Their colour does not change.

### 2.5 The station markers

These agree with the reference transit map.

| Marker | Meaning | Style |
|---|---|---|
| **Open white circle**, `8px` diameter | A local stop | `fill: #f4f6f8`, `stroke: var(--color-canvas)` `2px` |
| **White diamond**, `11px` | A transfer station, with 2 or more lines | `fill: #ffffff`, `stroke: #0d1116` `2px`, a square that turns 45° |
| **Filled colour ring**, `13px` | The end of a line, or a large hub | Fill is the line colour, `stroke: #ffffff` `2.5px`, halo `shadow-1` |
| **Selected station** | Any marker above, after selection | `stroke: var(--accent-blue)`, `3px`, and an outer glow like `--shadow-focus-ring` |

### 2.6 The borders and the shadows — the elevation levels

There are four elevation levels. Use them consistently. Thus the player can see
immediately which element is above another element.

| Level | Token | Use | Border | Shadow |
|---|---|---|---|---|
| 0 | — | The map canvas | none | none |
| 1 | `--shadow-1` | Chips, badges, list rows | `--border-subtle` | flat, very light |
| 2 | `--shadow-2` | Toolbars, the KPI strip, the mode rail | `--border-default` | soft, close |
| 3 | `--shadow-3` | Panels, drawers, inspector cards | `--border-default` | soft, medium. **This is the default panel elevation.** |
| 4 | `--shadow-4` | Modals, dropdown menus, command palettes, elements that the player drags | `--border-strong` | strong, large |

A border is always `1px`. It is always a translucent white or a translucent
black. It is never a strong colour. Thus it looks like the edge of the glass,
not like decoration. There is one exception: `--border-focus`. Use it only for
the keyboard focus and for an active drag.

---

## 3. The type and the space

### 3.1 The font

- **The primary interface font is [Inter](https://rsms.me/inter/).** It is
  clean and geometric. It has good hinting at small sizes and a large language
  coverage. It also has tabular figures. Thus it is correct for an interface
  with many numbers, such as the KPIs, the headways, the distances, and the
  clock.
- **The fallback stack is:** `"Inter", "Segoe UI", system-ui, -apple-system,
  sans-serif`. This keeps the native rendering of the operating system as a
  fallback. It agrees with the stack of the current prototype.
- **For the numbers,** always set `font-variant-numeric: tabular-nums;`. Thus
  the digits do not move when a value changes in real time. This applies to the
  clock, the KPI counters, the headway, the length, and the coordinates.
- **Do not** add a second display font or a serif font. One family does all the
  work with its weights and its sizes.

```css
--font-ui: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
--font-mono: "IBM Plex Mono", "Cascadia Code", monospace; /* debug/dev overlays only */
```

### 3.2 The type levels

| Role | Size | Weight | Line-height | Letter-spacing | Colour token |
|---|---|---|---|---|---|
| Panel title (equal to h3) | `14px` | 600 | 1.3 | 0 | `--text-primary`, or an accent for emphasis |
| Section label (capitals) | `11px` | 600 | 1.2 | `0.06em` | `--text-tertiary` |
| Station or line list item | `13px` | 500 | 1.4 | 0 | `--text-primary` |
| Line badge text | `12px` | 700 | 1 | `0.01em` | `--text-on-accent` |
| Button label | `13px` | 600 | 1 | 0 | it changes with the context |
| Body text | `13px` | 400 | 1.5 | 0 | `--text-secondary` |
| Small label (tooltips, chip captions, times) | `11px` | 500 | 1.3 | `0.02em` | `--text-tertiary` |
| KPI headline number | `16–20px` | 700 | 1.1 | 0 | `--accent-primary` or `--accent-blue` |
| Keyboard shortcut chip | `10px` | 600 | 1 | 0 | `--text-tertiary` on `--surface-sunken` |

### 3.3 The space grid — 4px and 8px

Each padding, gap, margin, and offset is a multiple of `4px`. Use the `8px`
step for the large layout. Use the `4px` step for the space in a component.

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

**Rules:**

- The outer padding of a panel is `--space-4` (`16px`). A tight variant, such
  as a toolbar, uses `--space-2` (`8px`).
- The gap between two list rows is `--space-1` to `--space-2`.
- The margin between a panel and the edge of the screen is `--space-3`
  (`12px`). This agrees with the current `#focus-panel`.
- The gap between an icon and its label in a button is `--space-2` (`8px`).
- The gap between two sections in a panel is `--space-4` to `--space-5`.

### 3.4 The z-index levels

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

## 4. The components

### 4.1 The sidebar and the drawers

- **Structure:** a header with glass (`--surface-raised`, `--shadow-2`, and it
  stays in position), then a body that scrolls (`--surface-panel`), then an
  optional footer with the actions.
- **Collapse:** a drawer collapses to an icon rail of `48px`. It does not hide
  fully. Thus the navigation is always one click away. The collapse animates
  the `width` for `200ms ease-out`.
- **Tabs:** the header holds horizontal tabs with an icon and a label. The
  active tab has a bottom border of `2px` in `--accent-primary`, and a light
  background of `--accent-primary-muted`. Never use the colour alone. Add the
  border for a high-contrast mode and for a person with a colour vision
  deficiency.
- **The content that scrolls:** use `overflow-y: auto` and a thin scrollbar of
  `6px`. The thumb is `--border-strong` and the track is transparent. Momentum
  scroll is on. The content padding is `--space-4` and the row gap is
  `--space-1`.
- **A drawer that the player can resize** gets a drag handle of `8px` at its
  edge. The cursor is `col-resize`. The handle becomes brighter with
  `--accent-blue-muted` when the pointer is above it.

### 4.2 The header and the search field

- **The search input:** the shape is a pill (`border-radius: 999px`), and the
  `height` is `40px`. The background is `--surface-sunken` and the border is
  `--border-subtle`. The search icon is at the left, inset by `--space-3`. The
  placeholder text is `--text-tertiary`.
- **The keyboard shortcut chip:** it is at the right, in the pill. Examples are
  `⌘K` and `Ctrl K`. It is a small chip of `--surface-raised`, with a `10px`
  label that looks like a monospace font, and a `4px` corner radius. It touches
  the right padding of the input.
- **The dropdown for the search:** it appears below the pill with a gap of
  `--space-1`. It has a `--surface-raised` background, `--shadow-4`, and
  `--z-dropdown`. The results are in groups by type: Stations, Lines, Zones.
  The group labels are `11px` capitals in `--text-tertiary`. The active row has
  `--surface-hover` and an accent bar of `2px` at its left in
  `--accent-primary`.
- **The focus state:** at the focus, the border of the pill changes to
  `--border-focus` and gets `--shadow-focus-ring`. The change takes `150ms
  ease`.

### 4.3 The toolbars and the map controls

These agree with the control group at the top left of the reference screenshot.
That group has icons for the full screen, the save, and the undo, and a radio
list for the basemap style.

- **The container:** a compact `.panel` (§2.3), with `border-radius: 10px` and
  a padding of `--space-2`.
- **A row of icon buttons:** the buttons are squares of `32px`. There is no
  border between two adjacent buttons in a group. A gap of `--space-1`
  separates them. A group with no gap can use a divider of `1px` in
  `--border-subtle`.
- **The active state:** the active control gets an `--accent-primary-muted`
  fill and an `--accent-primary` icon. This agrees with the filled dot in the
  reference, but the colour is now the primary pink. Use `--accent-blue` for
  data and for the selection state. Use `--accent-primary` for the *active
  input mode* of the player.
- **A radio list**, for example the basemap style: change the radio input to a
  ring of `14px`. The checked state fills with `--accent-primary`. The label is
  `13px` in `--text-primary`. The row height is `28px` and the vertical gap is
  `4px`.
- **A checkbox row**, for example a layer control such as "Waypoints": the box
  is `14px` with a `4px` radius. The checked state is an `--accent-primary`
  fill with a white check glyph.
- **The tooltips:** each control with an icon and no label has a tooltip. The
  delay before it appears is `150ms`. It has a `--surface-raised` background,
  `--shadow-2`, `11px` text, an arrow that points at the control, and
  `--z-tooltip`.
- **The zoom and compass controls:** these are at the bottom right or the top
  right. They are a group of icon buttons in one round container. They are
  squares of `32px`, as above.

### 4.4 The badges and the line indicators

- **A line badge (pill):** `border-radius: 999px` and `padding: 2px 10px`. The
  background is the full line colour and the text is `--text-on-accent`, at
  `12px` and weight 700. Use it in lists, in tooltips, and in the header of the
  inspector panel.
- **A line badge (square):** for a line with a number, the size is `24×24px`
  with `border-radius: 6px`. The background is the line colour, the number is
  bold and white, and it is at the centre. This agrees with a real route
  bullet.
- **A station pill:** the background is `--surface-raised`, the border is
  `1px` in `--border-default`, `border-radius: 999px`, and `padding: 4px 10px`.
  It contains a small dot of `6px` for each line at the station, and then the
  station name, at `13px`.
- **A transfer indicator:** small circles of `10px` above each other, with an
  overlap of `-4px`. Each circle has the colour of its line and a white stroke
  of `1.5px` to separate it. Use this where a station has 2 or more lines in a
  list.
- **A drag handle:** the `⠿` grip icon, or a grid of 6 dots, at `16px`. The
  default colour is `--text-tertiary`, and it becomes `--text-secondary` when
  the pointer is above it. The cursor is `grab`, and it is `grabbing` during
  the drag. The row that the player drags gets `--shadow-3`, a scale of `1.02`,
  and `--z-dropdown`. The gap at the target opens in `150ms`.
- **A status pill or a KPI pill:** a small rounded rectangle. The background is
  a semantic colour at `16%` opacity: `--color-success`, `--color-warning`, or
  `--color-danger`. The text is at full opacity, and there is a dot at its
  left.

### 4.5 The interactive states

The states must be consistent and quick. They must never be slow. This is a
real-time simulation, and the interface must have the same quality.

| State | Treatment |
|---|---|
| **Pointer above** | `background: var(--surface-hover)`. The icon or the text can become brighter by one step (`--text-secondary` → `--text-primary`). The change takes `150ms ease-out`. |
| **Pressed** | `background: var(--surface-active)`, and a scale of `0.97` on a button. The change takes `100ms ease-out`. This is faster than the pointer state, thus the button feels immediate. |
| **Selected** | An `--accent-primary-muted` background, and `--accent-primary` for the text, the icon, and the border. This stays until the player deselects the element. It is not only for the time of the press. |
| **Keyboard focus** | `outline: none; box-shadow: var(--shadow-focus-ring);`. Use this **only** on `:focus-visible`, never on a mouse click. Thus the map-first interface has no focus rings during normal play. The change takes `200ms ease`. |
| **Disabled** | `opacity: 0.45`, `cursor: not-allowed`, `color: var(--text-disabled)`. Stop all the pointer and press changes. Use `pointer-events: none` where this is safe. |
| **Loading** | The content decreases to `60%` opacity. A spinner of `14px` appears after a delay of `300ms`. Its stroke is `--accent-primary` on a `--border-subtle` track. The delay prevents a flicker on a fast load. |

**The standard time for a change:** each small interaction takes **`150–250ms`**.
This includes the pointer state, the focus, a toggle, and a colour change. Use
`ease-out` when an element appears or becomes larger. Use `ease-in` when an
element goes away or becomes smaller. A panel or a drawer uses the longer times
(`200–250ms`). A button or a badge uses the shorter time (`150ms`).

Never animate the `width` or the `height` of an element that changes
frequently. This includes the KPI counters and the live vehicle glyphs. Change
those elements with text or with a transform only, at the rate of the
simulation tick, and with no CSS transition. A CSS transition fights the 4 Hz
rate of the simulation. See GDD §4.3.

```css
:root {
  --transition-fast: 150ms ease-out;
  --transition-base: 200ms ease-out;
  --transition-slow: 250ms ease-out;
}
```

---

## 5. The Tailwind token map

If your team uses Tailwind, put the CSS variables above into `tailwind.config`.
Thus the utility classes stay in agreement with the design tokens, and no
person writes a hex value directly.

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

## 6. Notes for the change from the current prototype

The Phase 0 prototype (`src/style.css`) already has the correct instincts. It
has a dark base, translucent panels, tabular numbers for the clock and the
KPIs, and a small KPI strip. This document continues that work. It does not
replace its intention.

- Divide `--panel` into `--surface-panel`, which is translucent, and
  `--surface-panel-solid`, which is the fallback. Add the `backdrop-filter`
  blur. The prototype does not have that blur.
- Keep `--accent: #4fc3f7` as `--accent-blue`. This is the secondary accent for
  data. Add a new `--accent-primary` (`#ff3d8a`, pink or magenta) for the
  primary actions and for the active mode. This agrees with the target design.
- Keep `--amber: #ffb74d` as `--color-warning`.
- Replace the `LINE_COLORS` array in `src/simulation.ts` with the 16 colours of
  `--line-color-*` in §2.4. Then add the default colour and the stroke pattern
  for each mode. Thus a future mode, such as a bus or a ferry, is different in
  more than its colour. See GDD §3.3.
- The position and the size of `#focus-panel` already agree with §3.3. They are
  `top/right: 12px` and a width of `260px`. Keep them. Apply the new `.panel`
  glass style and the new type tokens only.
