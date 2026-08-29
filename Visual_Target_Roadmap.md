# Visual Target Roadmap

A reference screenshot (provided 2026-08-22) sets the visual/UX bar for where this game is
headed. This is a **feature checklist extracted from that image**, not a phase plan —
most of these land well past Phase 1 (current), several overlap with Phase 3/4 items
already in `Transit_Authority_GDD.md` (noted inline where relevant). Treat this as the
"what does done look like" reference to check future work against.

The reference is a 3D, night-mode transit map (a real-world NYC-Brooklyn example: Flatbush
Av / Tillary St / Jay St / Fulton Mall) with a station inspector panel, live departures, an
economy readout, and a full control chrome. Broken into groups below, at the finest detail
level I can read off the image.

---

## 1. Map rendering — 3D city + day/night

- [ ] **3D building extrusion** — city blocks rendered as extruded 3D blocks (height from
      building-footprint data), not flat 2D fill. This is the single biggest visual jump
      from the current renderer. Buildings are a flat dark gray, undifferentiated by type —
      no per-building color/material variation visible.
- [ ] **2D/3D toggle** — a button (bottom-right in the reference, labeled "2D") that
      switches camera between the current flat top-down view and a tilted 3D perspective.
      Its presence confirms the screenshot itself is the *3D* mode.
- [ ] **Day/night lighting cycle** — the basemap's lighting (sky, building shading, ambient
      tone) shifts with the in-sim clock, not just a fixed dark theme. The reference is
      captured at 23:17 sim-time and reads as genuine nighttime — dark navy sky, no visible
      sun/moon glow, buildings read as silhouettes rather than lit surfaces.
- [ ] **Water / green-space fill** — a large navy-blue area (upper portion of frame, reads
      as a bay or river) and smaller teal polygons nearer the map center. *Uncertain: the
      smaller teal shapes could be water (ponds/basin) or parks — the color alone doesn't
      disambiguate at this resolution. Worth deciding as a deliberate two-tone convention
      (water vs. green space) rather than guessing at implementation time.*
- [ ] **Road network rendered under the 3D buildings** — visible thin gray/tan lines
      forming a full street grid, plus at least one highway interchange with curved
      cloverleaf-style ramps (upper-middle of frame). This implies the basemap carries full
      road detail, not just arterials — consistent with the OSM street graph already baked
      in Phase 1, just not rendered as flat 2D lines the way it is today.
- [ ] **Tilted/perspective camera controls** — pitch + rotate, not just pan/zoom (current
      renderer explicitly disables rotation — this will need revisiting).
- [ ] **Rounded-corner UI chrome** — every panel, button, and chip in this reference uses
      soft rounded corners. *Flag: this is the opposite direction from the current
      implemented UI, which was deliberately moved to hard square edges per an earlier
      request. Reconcile which direction wins before restyling toward this reference —
      don't silently round every corner back off without a decision.*

## 2. Line, station & vehicle rendering

- [ ] **Lines rendered with real thickness/tube appearance**, not flat 2px paths — reads
      almost as a raised ribbon following the street grid, with a subtle drop-shadow/glow
      beneath it suggesting the line sits slightly elevated above the ground plane rather
      than painted flat onto it.
- [ ] **Parallel-track offset on shared corridors** — where two or more lines run the same
      trunk alignment, render them as visually distinct parallel strands rather than one
      overlapping line (visible in the reference along the main corridor, where red/green/
      orange run side by side for a long stretch).
- [ ] **Line colors read as real-world-accurate** for this NYC example — red badges for
      1/2/3-family lines, green for 4/5/6-family, orange for B/D/F/M-family — matching the
      actual MTA color convention. *Not directly portable to Houston (no equivalent
      real-world palette to match), but worth deciding whether player-drawn lines should
      default to a similarly saturated, high-contrast palette rather than the current
      pastel/desaturated set.*
- [ ] **Station markers**: small white circle + name label + a row of colored line-badge
      pills showing every line serving that stop (e.g. "5 2" badges next to "Flatbush Av").
      Badges are small filled circles with a bold white digit/letter, matching the same
      style used inside the side panel.
- [ ] **Selected-station highlight state** — the currently-inspected station ("Flatbush Av")
      reads visually distinct from other stations on the map: brighter/larger label text
      and a more prominent marker versus the dimmer, smaller labels on stations not
      currently selected (Tillary St, Jay St, Fulton Mall are all visible but clearly
      de-emphasized by comparison).
- [ ] **Station "platform" overlay square** — a semi-transparent light-blue rectangular
      plane at station locations, distinct from the simple dot used elsewhere.
      **Correction from the first pass of this doc:** this should apply to **every**
      station, not just visually "busier" ones — the earlier draft's "rises from busier
      stations" framing was a misread. Treat this square as the default visual
      representation of a station's physical footprint, present everywhere.
      **This is the visual hook for an eventual station-design editing feature** — the
      square is presumably a stand-in/placeholder for whatever the player will eventually
      be able to configure (platform length/width, entrance placement, elevated vs.
      underground form, etc.). Don't build it as a cosmetic-only overlay; design it from
      the start as the thing a future station editor edits.
- [ ] **Trains rendered as a consist of linked white squares** — confirmed visible in the
      bottom-right area of the reference, on the track there: a train is **not** a single
      dot/circle (unlike our current game's large colored circles) but a short row of
      individual white square segments joined end-to-end along the line, each square
      reading as one car. This is the target train design going forward.
  - **Car count = visible train length.** The segmented-squares approach visually encodes
    how many cars a train is running with, which implies rolling-stock/consist-length
    needs to become a real, inspectable property rather than the single flat
    `TRAIN_CAPACITY` constant the sim currently uses (`src/constants.ts`) — a 2-car train
    and an 8-car train should look different, not just carry different numbers.
  - Squares are white (matching the white station-dot color), **not** colored to match
    the line the way our current vehicle markers are — color/identity is carried by the
    line itself and the line's badges, not repeated on the train.
  - Orientation/rotation of each square should presumably follow the line's local
    heading (cars lie flat along the track direction), rather than a rotation-invariant
    circle — worth confirming against a closer crop, since square markers (unlike
    circles) actually need a heading to render correctly.

## 3. Station Details panel (click a station → slide-out)

This is the biggest net-new *feature*, not just a visual — it's a real data panel. Full
layout, top to bottom:

- [ ] **Header row**: back arrow (‹) at far left, "Station Details" title centered, close
      (×) button at far right.
- [ ] **Name field row**: an editable text input pre-filled with the station's name
      ("Flatbush Av"), plus a separate small square button with a circular-arrows/refresh
      icon immediately to its right — reads as "regenerate/randomize this station's name,"
      implying stations have an auto-name-generation feature in addition to manual rename.
- [ ] **Line badge row**: directly under the name field, one circular badge per line
      serving this station (red "2", green "5") — same badge style used on the map itself.
- [ ] **"Ridership" section**, header in bold:
  - One row per line: small colored line badge on the left, a horizontal bar (bar *length*
    scales with the value — green "5" bar is visibly longer than red "2" bar, matching
    12,171 vs 9,108), and the number right-aligned.
  - A final **"Total"** row: no badge, no bar, just label left / summed value right
    (21,279 = 12,171 + 9,108 exactly — confirms Total is a plain sum, not a deduplicated
    unique-rider count).
- [ ] **"Departures" section**, header in bold, grouped by line:
  - Sub-header per line: colored circular badge + "{N} Train" label (e.g. "2 Train").
  - Under each: one row per direction/terminus this line serves from here, showing the
    **destination name** on the left and, right-aligned, two numbers separated by a comma
    then "min" (e.g. "Prospect Pk — 1, 6 min", "125 St — 2, 6 min"). *Uncertain what the
    first number means* — candidates: a platform/track number, a queue position ("1st
    train, then a 2nd"), or a train ID. Don't guess when implementing; decide the intended
    semantics deliberately, since the current game has no concept of platform/track number
    at all.
  - The 2 Train section shows two directions (Prospect Pk, 125 St); the 5 Train section
    also shows two (121 St, Eastern Pkwy) — i.e. every line at a station lists both of its
    directions, not just "next train regardless of direction."
- [ ] **"Current Usage" section**, header in bold, single line of body text below it:
  - Populated state would presumably show a live passenger count; the captured state shows
    the **empty state**: "No passengers at station" in a dimmer/muted text color.
- [ ] **"Nearby Stations" section**, header in bold, up to 3 rows visible:
  - Each row: a location-pin icon on the left; station name in bold on the first line;
    directly below it, smaller muted text combining **distance in meters** and **walk time**
    with a middle-dot separator ("268m • 4 min walk"); and on the right side of the row,
    that station's own line badges (Tillary St: F + 6; Jay St: 1 + F + 6; Fulton Mall: 3
    alone).
  - These are explicitly *not* on the selected station's own lines — this is a walk-transfer
    suggestion list, separate from same-line connections.
  - Rows appear sorted by distance ascending (268m, 441m, 500m).
- [ ] **Panel chrome**: the whole panel sits over a translucent dark scrim/backdrop, rounded
      corners throughout, positioned flush to the left edge of the screen, roughly a third
      of the viewport width.

## 4. Top-right icon row

- [ ] Map style / layers toggle icon (folded-map glyph)
- [ ] Sound on/off icon (speaker with sound-wave arcs — implies the game has ambient audio
      or SFX that can be muted)
- [ ] Dark/light **theme** toggle icon (crescent moon) — distinct from the day/night *sim*
      lighting cycle in §1; this one is a UI chrome theme switch, not a simulation state.
- [ ] Hamburger menu (three horizontal lines → settings/overflow menu, contents unknown
      from this image)
- [ ] All four sit in a single translucent rounded pill/row, top-right corner, consistent
      icon sizing and spacing.

## 5. Bottom time & economy bar

Reading left to right as laid out in the image:

- [ ] Play/pause button (▶), leftmost.
- [ ] **Day counter** ("Day 48") and **live clock** ("23:17:02", to the second) — the
      current game already has an equivalent (day + HH:MM), just coarser (minutes, not
      seconds) and differently positioned.
- [ ] **Moon icon** immediately after the clock, tied to time-of-day (pairs with the
      day/night lighting cycle in §1 — this is the glanceable "it's currently night"
      indicator, separate from the theme-toggle moon icon in §4).
- [ ] **Multi-step fast-forward controls** — two/three step icons after the moon (already
      exists in the current game as the speed buttons; here it's a restyle, not new
      function).
- [ ] **Money/budget chip**, visually separated from the time cluster: a small icon (reads
      as a card/chip or bank-note glyph) followed by the balance ("$1,055,959,939") and a
      **live positive delta** in green ("+$4.85M") — this is a real running capital account
      shown continuously, not a one-time cost estimate. Already a named future item: GDD
      Phase 3 "Capital account v1" and Phase 4 "Operating account." Not implementable until
      that economy model exists.
- [ ] **Total active vehicle count** chip: a small train/vehicle icon + a bare number
      ("123") — reads as "123 trains currently in service network-wide." Cheap to add now:
      it's just `vehicles.length` surfaced in a chrome slot, no new simulation needed.
- [ ] Each cluster (time, money, vehicle-count) is its own separate rounded pill rather than
      one continuous bar — worth preserving that visual separation rather than merging them
      into one strip.

## 6. Bottom-left tool icons

Four square icon buttons in a row, bottom-left corner:

- [ ] **Wrench icon** — build/tools mode (line drawing mode already exists conceptually as
      the current game's Build mode).
- [ ] **Branch/fork icon** (two lines splitting from a point, with dots at the ends) —
      reads as a route- or line-planning view; exact function unconfirmed from the icon
      alone.
- [ ] **Stacked-bars/list icon** — likely a lines/stations list overview panel (a
      network-wide summary, as distinct from the single-station Details panel in §3).
- [ ] **Share/export icon** (curved arrow) — export or share the current network. New
      feature, no backing today; note it implies some kind of shareable network state
      (a save format, a link, or an image export — undetermined which from the icon).

## 7. Right-side floating map controls

Vertical stack, bottom-right corner, each a separate rounded-square button:

- [ ] **Compass / reset-bearing button** (top of the stack) — only meaningful once map
      rotation is enabled (see §1); resets the camera to north-up.
- [ ] **"2D" toggle button** (see §1, listed here too since it's physically in this
      cluster, directly below the compass).
- [ ] **Zoom + button**, then **zoom − button** below it — native map zoom controls,
      currently the game relies on scroll-to-zoom only with no on-screen buttons.

---

## Sequencing note

Most of §1 (3D rendering, day/night) and the economy readout in §5 are **not** buildable
until later GDD phases land underneath them — 3D rendering wants real geometry/LOD work
(Phase 5 "Large-metro LOD, 3D station inspector" is the named slot for this), and the
money readout needs the capital-account economy from Phase 3/4. The **Station Details
panel (§3)** and the **chrome restyle items (§4, §6, §7)** are the parts of this image
that could realistically be pulled forward and prototyped against the *current* Phase 1
game without waiting on the simulation kernel to grow up — they're mostly new UI wrapping
data (ridership, departures, nearby stations) that's cheap-to-free to compute on top of
what `simulation.ts` already tracks.

Two open decisions flagged inline above, worth resolving before implementation rather than
guessing in the moment: **(a)** rounded vs. square UI chrome — this reference is fully
rounded, the currently-implemented UI is deliberately square-edged; **(b)** what the two
comma-separated numbers in each Departures row actually mean, since the current simulation
has no concept of platform/track number to hang the first one on.
