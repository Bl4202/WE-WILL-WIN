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

## Completed work

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

## QA result

- The production build is correct. The only message is the usual Vite advisory
  about the large bundle.
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

## Future suggestions

- The bus router uses the visible tiles only. If a route across the full city
  becomes necessary, change the router to a streamed graph of the full city.
  The player will then not have to move the map.
- The cars are map glyphs, and they are optimized for that use. If close
  street-level play becomes necessary, add vehicle meshes with a level of
  detail.
