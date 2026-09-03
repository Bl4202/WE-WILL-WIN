# Progress

*This document uses ASD-STE100 Simplified Technical English.*

This document records the requests from the player and the work that is
complete.

## Requests

### First request

Make a 3D mode that the player can switch on and off. The 3D mode must use
real-world data. The buildings must look like their real counterparts. Also,
make the interface clean and smooth, and add animations.

### Added request

Make the transit simulation better. Add these items:

- A price for each construction.
- An alignment for each segment, on the surface or in a tunnel.
- The correct positions of the Houston airports.
- Airports and other transport that the player can build.
- Connections to areas outside the city.
- Road congestion, and a display of the traffic.
- Roads and highways.
- Better performance.

### Added request (2026-08-22)

Change the interface. Put a bottom operations bar at the centre of it. Add
these items:

- The day and the time.
- Controls for the simulation speed.
- The money, the cashflow with its sign, and the number of active passengers.
- A rule that the player must buy the rolling stock and then assign it.
- Engineering data for each line and each track.
- Stations and trains on the map, with a label for each route.
- A choice of one-way service or two-way service.
- Track on the surface, on an elevated structure, or in a tunnel. The tunnel
  depth is variable. Each choice has a different cost, a different quantity of
  demolition, and a different quantity of noise.
- A deeper simulation of the operations.
- A better 3D city.
- A full light theme, settings for the 2D view and the 3D view, and keybinds
  that the player can change.

### Added feedback (2026-08-22)

Make these corrections:

- Obey the supplied interface image more closely.
- Remove the blue tint and the teal tint.
- Show every visible road and highway as 3D geometry.
- Keep the bus services on the roads.
- Charge for the real building footprints that a segment crosses.
- Put each vehicle that the player buys into a pool. The player must then
  assign the vehicle to a line.

### Added feedback (2026-08-29)

Correct the road rendering:

- Return to the road appearance of the earlier version.
- Stop the road names when they show through the buildings.
- Make the tall buildings in downtown Houston more opaque.
- Keep the roads, but let the buildings hide them.
- Give each road the same height, and make that height less.
- Correct the zoom at which the 3D buildings and the thick roads change.
- Put the street names and the other icons above the roads.
- Correct the road width when the player zooms out.
- Decrease the number of highway shields.
- Correct the scale of the roads. A road must become smaller with its distance
  from the camera.

### Added request (2026-08-31)

- Switch off the congestion data by default.
- Let the player change the construction settings without an entry into the
  blueprint mode. The build menu must open as before. A separate button must
  then start the blueprint.

### Added request (2026-09-02)

- Write all the game documents again in ASD-STE100 Simplified Technical
  English.
- Keep the project banner in `README.md`.
- Update the progress documents to the latest game features.

## Completed work

### Work before 2026-08-29

- The operations changes of 2026-08-22 are complete. The player buys the
  rolling stock and assigns it. A line is not active until its fleet has
  money. Each model has its own capacity, speed, noise, energy, reliability,
  and maintenance. The service is one-way or two-way. The game calculates the
  headway, the energy use, the emissions, the subsidy, and the daily cashflow
  with its sign.
- Each segment has its own engineering. The choices are the surface, an
  elevated structure, or a tunnel at a variable depth. Each choice has a speed
  limit, a depth premium, demolition sites, a demolition cost, and a noise
  reduction. Each station now holds data for its platform, its entrance, its
  depth, and its daily boardings.
- The interface no longer starts at the sidebar. The map is now first. There
  is a bottom operations bar, a construction panel, a fleet panel, and detail
  views for the stations and the lines. The game keeps the light or dark
  preference and the 2D or 3D preference. The player can change the keybinds.
- The chrome now obeys the supplied reference. It has compact black panels,
  circular tools above a thin bottom strip, and small square controls at the
  top. The light mode is neutral. There is no permanent brand card and no
  permanent dashboard card.
- The visible tiles now show 3D street geometry. There are road decks, raised
  highway structures, edge passes, shadow passes, and traffic stripes. The 2D
  mode removes these extrusions and shows a flat planning camera.
  **A later change replaced these road decks. See "Road rendering
  (2026-08-31)" below.**
- There is a road graph that the game can route on. A bus stop attaches to a
  street. The geometry between two stops follows the road vertices. It no
  longer crosses the blocks in a straight line.
- The game no longer uses synthetic clearance counts. It intersects the real
  OSM building footprints. A surface segment or an elevated segment pays for
  each footprint that it crosses. A tunnel does not demolish the surface.
- The purchase of a vehicle is separate from its deployment. A purchase goes
  into a pool. The player then assigns a compatible vehicle to a line. The
  player can also return an assigned vehicle to the pool.
- The 3D OpenStreetMap buildings are available, and the player can switch them
  on and off. The interface has new animations.
- There is a capital account and an operating account. The game estimates the
  construction cost and then subtracts the exact cost.
- There are three services: Metro, Bus, and Regional Rail. Each service has a
  different cost, speed, dwell time, capacity, operation, and exposure to
  traffic.
- A metro line can change between the surface and a tunnel at each segment.
  The game prices and draws the mixed route correctly.
- These facilities are at their real coordinates: IAH, HOU, EFD, Port Houston,
  Houston Amtrak, and the Downtown Transit Center.
- The player can build bus hubs, rail terminals, harbours, and airports. An
  airport is very expensive. Each facility changes the connections to the
  areas outside the city.
- The simulation calculates these metrics: the congestion, the transit share,
  the number of car trips, and the number of connected gateways.
- The renderer highlights the real OSM highway traffic. It also draws light
  car glyphs at intervals.
- The scan of all the zones for a destination is replaced. The game now uses
  importance sampling with a bound.
- These tests are correct: the production build, the HTTP shell smoke test,
  and the simulation assertions for the mixed alignment and the economy.
- There is a short `render_game_to_text` hook for the state, and a
  deterministic `advanceTime` hook. Browser QA uses these hooks.
- Playwright examined the first 2D view, the 3D building view, and a
  completed tunnel line. There were no console errors. A tunnel segment now
  has a clear cool-blue colour.
- Playwright examined these items:
  - A mixed construction, on the surface and in a tunnel.
  - The bus service and the regional rail service.
  - An airport that costs $2.5B.
  - The activation of a gateway.
  - The fares and the operating costs.
  - The flow of the demand.

  The normal loop now gives the time control to the automation. Thus the
  screenshots and the exported state stay in step.
- The state that the browser can read contains every visible KPI. Thus the
  automated evidence agrees with the HUD.
- Playwright examined these screens in the reference style:
  - The construction screen.
  - The route detail screen.
  - The fleet pool screen.
  - The settings screen.
  - The dark 3D screen and the light 3D screen.
  - The flat 2D screen.

  There were no console errors.
- Playwright examined these items:
  - A bus segment on a road with 94 street vertices.
  - A downtown surface line that pays for 10 real building demolitions.
  - The full sequence from the purchase into the pool to the assignment.

  The operating headway was 284 seconds.

### Chrome and defects (2026-08-31)

- The chrome now obeys the visual system of `style.md`. The ground is pure
  black, the rules are hairline white, the surfaces are flat, and the edges
  are square. The mode panels, the bottom bar, and the settings dialog keep
  their behaviour.
- The tokens are now `#000` and `#fff`. The amber, red, positive, and negative
  tokens are declared again. Before this, the cashflow state and the
  over-budget state used the colours of the first version.
- The four KPI accent colours are restored, by id. Thus the markup did not
  change.
- The corner radius is 0. Six controls stay circular by decision. The box
  shadows are removed, and the blur is 2 px again.
- The Google Fonts import is removed, because it blocked the render. The
  system font stack returns, with tabular figures for the numeric columns.
  The minimum type size is now 10 px.
- **Defect:** the loop looked for a `"__vt_pending"` global in production. Thus
  any extension with that name stopped the simulation permanently. This check
  is now for development only.
- **Defect:** `unassignVehicle` put the passengers on a platform that still
  held legs for their old line. They never got off and never completed. This
  was a leak, and it also made the active-passenger KPI too high. The game now
  plans their route again, or counts them unserved.
- **Defect:** `spawnTrip` returned with no action when all 48 destination
  samples gave the origin zone. Thus a trip disappeared. It did not increase
  `unservedTrips` or `carTripsToday`, and the transit share was too high.
- **Defect:** `updateDemolishedBuildingFilter` made a key each frame, before
  its early return. It is now gated on `networkVersion`, with a Set for the
  duplicates.
- **Performance:** `nearestRoadSnap` projected each vertex of each road on each
  mouse movement. A pre-rejection in metres now removes most of them. Measured
  across 8 mouse movements with approximately 11k roads: the self time
  decreased from 44 ms to 14 ms. The price of a bus draft did not change.

### Road rendering (2026-08-31)

- The road structures moved from the deck.gl overlay into the MapLibre style.
  They were deck.gl geometry above the finished map frame. Thus they covered
  each street name, each shield, each POI icon, and the building extrusions.
- Interleaved rendering is the documented correction, but it does not operate
  in this stack. deck.gl 9.3 below MapLibre 5 draws no pixels at all.
- The roads are now native line layers. They take their correct position in
  the style: above the basemap roadway, below the labels, and below the
  extrusions. Thus the buildings hide them, and the invisible depth mask is
  gone.
- A ramp reads the `ramp` flag of the tiles. It draws at 8 m, not at the 19 m
  of the mainline. Before this, an interchange became one large slab.
- The renderer no longer draws a tunnel. Before this, a tunnel made a slab
  across the surface.
- Each road class has a minimum zoom. There are 34k features at z11 against 2k
  at z17.
- The width expression is metre-exact. MapLibre uses 512 px tiles, thus the
  usual 256 px constant made each carriageway half its correct width.
- The viewport key quantises to a fraction of its own span. Thus an extraction
  of 75–300 ms operates again on real camera movement, not on almost each pan.
- `roadNodeKey` uses integer quantisation on the same 1e-6 grid. It no longer
  uses `toFixed`.
- The road labels of the basemap get a `symbol-spacing` that changes with the
  zoom. The labels are now above the roads, thus their density is visible.
- The building extrusions are fully opaque, with a colour ramp of five steps.
  The layer anchors resolve for each style. Before this, they assumed the
  first symbol layer, which put the buildings below the roads in the dark
  theme.
- A demolition scar belongs to the selected line only. Before this, the scars
  collected across the full network into permanent red areas.

### Interface (2026-08-31)

- The congestion overlay is off by default. The player can switch it on in the
  map layers.
- The build menu no longer arms the map. An entry into the build mode opens
  the panel only. The player can then read and change the construction type,
  the direction, the engineering, and the tunnel depth.
- A new button, "Start blueprint", arms the map. It becomes "Stop blueprint"
  while the map is armed. To stop the blueprint removes the draft but keeps
  the panel open.
- A change to a construction setting no longer arms the map.
- The Escape key now goes back one level at a time. The first press disarms
  the map. The second press closes the panel.

### Simulation kernel tests (2026-09-02)

- There is a test harness for the kernel: `npm run check:sim`. It operates the
  real kernel against the real Houston bundle, in Node. It needs no browser
  and no test framework, because `src/simulation.ts` has no DOM references.
- The harness tests properties, not stored values. A property test survives a
  change to the tuning. It examines a digest against itself, a conservation
  law, and a limit.
- The harness has 8 checks in 5 groups: the determinism, the conservation of
  the trips, the fleet dispatch, the memory limits, and the performance.
- **Defect:** more trains gave no more service. Each vehicle started from the
  same position, and `nextSpeed` is a pure function of the position. Thus two
  vehicles of one model followed identical paths. Four trains operated as two.
  A new vehicle now starts in the largest gap of the cycle. Measured: four
  trains start at four gaps of 71 km on a cycle of 284 km. They stay apart,
  between 57 km and 82 km, after 120k ticks.
- **Defect:** to unassign a vehicle stopped each waiting passenger
  permanently. `rerouteStranded` helped only the passengers in the vehicle.
  The queues on the platforms still named a line with a headway of zero, and
  `planner.rebuild` then removed that line. Measured: 1,062 passengers were
  frozen on a network with one line, fourteen simulation hours later.
  `rescueUnservableWaiters` now plans the platform queues and the walkers
  again. It counts a passenger unserved only when the network cannot serve
  them.
- **Defect:** the plan cache had no limit. Only a network change emptied it,
  across a key space of 1,560². Measured: more than 23,000 entries after 200k
  ticks, and still increasing. It is now an LRU cache with the limit
  `PLAN_CACHE_LIMIT`, which is 20,000.
- `check-sim.mts` imports from `src/`, which Vite compiles with the bundler
  resolution. Thus it needs its own configuration, `tsconfig.sim.json`. Type
  it with `npm run typecheck:sim`. It is not in `typecheck:scripts`.

### Documentation (2026-09-02)

- The six documents are written again in ASD-STE100 Simplified Technical
  English. They are `README.md`, `progress.md`, `Metro_Game_Overview.md`,
  `Visual_Target_Roadmap.md`, `style.md`, and `Transit_Authority_GDD.md`.
- The code blocks, the diagrams, the tables, and the cross-references do not
  change. A check compares each code block against the earlier version.
- No sentence is longer than the 25 words that the standard permits.

## QA result

- The production build is correct. The only message is the usual Vite advisory
  about the large bundle.
- `npm run check:sim` gives 8 correct checks of 8. The groups are the
  determinism, the conservation of the trips, the fleet dispatch, the bounded
  growth, and the performance.
- `npm run check:gtfs` finds each of its 17 test defects. The control test on
  the unchanged feed gives no message.
- A person examined the Playwright screenshots of these items:
  - The 2D map.
  - The neutral dark 3D city and the neutral light 3D city.
  - The compact panels in the reference style.
  - The settings screen and the keybinds screen.
  - The bus service on a road.
  - The demolition markers.
  - The fleet assignment sequence.
- The saved browser state agreed with the HUD. Each test scenario was complete
  and there were no console errors.

## Open work

- **The roads do not become smaller with their distance from the camera.** A
  MapLibre line has its width in screen pixels, and MapLibre has no width in
  map units. Thus one road keeps one width across the full frame. At the
  maximum pitch of 65°, the ground below the top of the screen is 2.5 times
  finer than at the centre. The ground at the bottom is 1.6 times coarser.
  Thus a carriageway is four times too wide at the horizon. The correction is
  to draw the roads as ground polygons in `fill` layers.
- The basemap uses the hosted OpenFreeMap tiles. Our own PMTiles are the last
  open item of Phase 1.

## Future suggestions

- The bus router uses the visible tiles only. If a route across the full city
  becomes necessary, change the router to a streamed graph of the full city.
  The player will then not have to move the map.
- The cars are map glyphs, and they are optimized for that use. If close
  street-level play becomes necessary, add vehicle meshes with a level of
  detail.
