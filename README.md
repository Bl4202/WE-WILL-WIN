# WE-WILL-WIN

*This document uses ASD-STE100 Simplified Technical English.*

Metro is a public transit simulation game. It operates in a web browser.

The player is the head of the transit authority of a real city. The game makes
its world from open data. The data sources are street maps, transit schedules,
and census records.

## Documents

| Document | Contents |
|---|---|
| [Metro_Game_Overview.md](Metro_Game_Overview.md) | A description of the game in simple words. |
| [Transit_Authority_GDD.md](Transit_Authority_GDD.md) | The full game design document. |
| [style.md](style.md) | The visual style guide. |
| [Visual_Target_Roadmap.md](Visual_Target_Roadmap.md) | The visual target, read from a reference image. |
| [progress.md](progress.md) | A record of the completed work. |

## Procedure: how to start the game

1. Install the packages. Type `npm install`.
2. Start the development server. Type `npm run dev`.
3. Open the address that the server shows.

## Procedure: how to make a production build

1. Type `npm run build`.
2. Examine the build output for errors.
3. To look at the build, type `npm run preview`.

## Procedure: how to bake the world data again

The bake makes the world bundle for Houston. The bundle contains the demand
zones, the reference network, and the street graph.

1. Type `npm run bake`.
2. Wait for the six stages to be complete.
3. Read the bake report in `public/world/houston/v1/bake_report.json`.

To skip the network stages, add the `--skip-network` option. This makes a
demand-only bake, which is much more quick.

To test the GTFS validation stage only, type `npm run check:gtfs`.
