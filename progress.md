Original prompt: CAn you make it so you can toggle a 3d mode that takes real world data to make the buildings look actuarate to real life couterparts, please also refreash the ui so it looks clean and smooth, add animations etc

Added request: Improve the metro simulation with priced construction, per-segment overground/tunnel alignments, accurate Houston airports, buildable airports and other transport, outside connections, congestion, traffic visuals, roads/highways, and optimization.

Added request (2026-08-22): Rework the interface around a polished bottom operations bar; add day/time, simulation-speed controls, money, signed cashflow, and active passenger totals; require players to buy and assign rolling stock; expose per-line and per-track engineering details; model stations and trains on the map with route labels; add one-way/two-way service; support surface, elevated, and variable-depth tunneling with demolition, cost, and noise tradeoffs; deepen operating simulation; improve the 3D city; add a full light theme, 2D/3D settings, and editable keybinds.

Added feedback (2026-08-22): Match the supplied UI much more literally, remove the blue/teal tint, make every visible road/highway read as 3D geometry, constrain bus services to roads, charge actual intersected building footprints as demolitions, and purchase vehicles into an unassigned pool before assigning them to a line.

## Completed

- Added the 2026-08-22 operations overhaul foundation: purchasable/assignable rolling stock, inactive lines until fleet is funded, per-model capacity/speed/noise/energy/reliability/maintenance, one-way or two-way service, calculated headways, energy use, emissions, subsidy, and signed projected daily cashflow.
- Added per-segment surface/elevated/variable-depth engineering with speed limits, depth premiums, demolition sites/costs, and noise reduction; stations now carry platform, entrance, depth, and daily boarding data.
- Replaced the sidebar-first shell with a map-first bottom operations bar, contextual construction and fleet panels, detailed station/line views, persistent light/dark and 2D/3D preferences, and editable keybinds.
- Reworked the chrome into the supplied reference language: compact neutral-black contextual panels, circular tools above a thin bottom strip, small square top controls, neutral light mode, and no persistent brand/dashboard card.
- Added visible-tile 3D street geometry with extruded road decks, raised highway structures, edge/shadow passes, and traffic stripes; 2D mode removes those extrusions and returns to a flat planning camera.
- Added a routable visible-road graph. Bus stops snap to streets and stop-to-stop geometry follows connected road vertices instead of drawing straight across blocks.
- Replaced synthetic clearance counts with real visible OSM building-footprint intersection checks. Surface/elevated segments charge each intersected footprint while tunnels avoid surface demolition.
- Split fleet procurement from deployment: purchases enter an unassigned pool, compatible vehicles are explicitly assigned to a line, and assigned stock can be returned to the pool.
- Added toggleable real-world 3D OpenStreetMap buildings and a refreshed animated UI.
- Added capital and operating accounts, construction estimates, and exact cost deductions.
- Added Metro, Bus, and Regional Rail services with distinct cost, speed, dwell, capacity, operations, and traffic exposure.
- Added per-segment surface/tunnel metro alignment and mixed-route pricing/rendering.
- Seeded IAH, HOU, EFD, Port Houston, Houston Amtrak, and Downtown Transit Center at real-world coordinates.
- Added buildable bus hubs, rail terminals, harbors, and expensive airports with outside-connection effects.
- Added congestion, transit share, car-trip, and connected-gateway simulation metrics.
- Added real OSM highway traffic highlighting and lightweight repeated car glyphs in the tile renderer.
- Replaced the full-zone destination scan with bounded importance sampling.
- Production build, HTTP shell smoke test, and mixed-alignment/economy simulation assertions pass.
- Added concise `render_game_to_text` state and deterministic `advanceTime` hooks for browser QA.
- Playwright verified the initial 2D view, 3D building view, and a fully committed tunnel line without console errors; tunnel segments now use a clearer cool-blue treatment.
- Playwright verified mixed surface/tunnel construction, bus and regional-rail services, an additional $2.5B airport, gateway activation, fares/operating costs, and demand flow. The normal loop now yields time control to the automation harness so screenshots and exported state remain synchronized.
- The browser-readable state includes every visible KPI so automated evidence matches the HUD.
- Playwright verified the reference-style construction, route-detail, fleet-pool, settings, dark 3D, light 3D, and flat 2D screens without console errors.
- Playwright verified a road-routed bus segment with 94 street-graph vertices, a downtown surface line charging 10 actual building demolitions, and the full buy-to-pool then assign workflow producing a 284-second operating headway.

## QA result

- Production build passes; the only notice is Vite's existing large-bundle advisory.
- Playwright screenshots were visually inspected for the 2D map, neutral dark/light 3D city, compact reference-style panels, settings/keybinds, road-routed bus service, demolition markers, and fleet assignment flow.
- Saved browser state matched the HUD and every tested scenario completed without console errors.

## Future suggestions

- Extend the visible-tile bus router into a streamed citywide graph if cross-city routing without panning becomes a priority.
- Add LOD-specific vehicle meshes if close street-level camera gameplay becomes a priority; current cars are optimized map glyphs.
