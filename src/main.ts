/**
 * Bootstrap: load the baked Houston world bundle, then wire the game
 * manager, MapLibre+deck.gl renderer, UI, and input together. Sim state
 * flows one way — kernel → snapshot → render/UI — and player actions flow
 * back as commands (GDD §1.1 in miniature).
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { Game } from "./game";
import { bindInput } from "./input";
import { createHoustonFacilities } from "./mobility";
import { loadPreferences } from "./preferences";
import { MapRenderer } from "./render-map";
import { hasSeenTutorial, Tutorial } from "./tutorial";
import { Ui } from "./ui";
import { loadWorld, zonesFromDemand } from "./world";

async function boot(): Promise<void> {
  const loading = document.getElementById("loading")!;
  try {
    const world = await loadWorld();
    const zones = zonesFromDemand(world.demand, world.projection);
    const preferences = loadPreferences();

    const game = new Game(zones, createHoustonFacilities(world.projection));
    const renderer = new MapRenderer(document.getElementById("map")!, world, {
      initial3d: preferences.viewMode === "3d",
      theme: preferences.theme,
    });
    const ui = new Ui(game, renderer, preferences);
    bindInput(renderer, game, () => game.sim.snapshot(), preferences);

    const tutorial = new Tutorial();
    document.getElementById("tutorial-replay")!.addEventListener("click", () => {
      (document.getElementById("settings-dialog") as HTMLDialogElement).close();
      tutorial.start();
    });

    renderer.map.once("load", () => {
      loading.classList.add("done");
      if (!hasSeenTutorial()) tutorial.start();
    });

    const renderFrame = (snap: ReturnType<typeof game.sim.snapshot>) => {
      renderer.update(snap, game);
      ui.update(snap);
    };
    game.start(renderFrame);

    const testWindow = window as Window & {
      render_game_to_text?: () => string;
      advanceTime?: (ms: number) => void;
    };
    testWindow.render_game_to_text = () => {
      const snap = game.sim.snapshot();
      return JSON.stringify({
        coordinateSystem:
          "Map screen origin is top-left; longitude increases right/east and latitude increases up/north.",
        mode: game.mode,
        view: renderer.is3d ? "3d" : "2d",
        theme: preferences.theme,
        speedIndex: game.speedIndex,
        day: snap.day,
        simTimeSec: Math.round(snap.simTimeSec),
        finances: {
          capital: Math.round(snap.economy.capitalBalance),
          operating: Math.round(snap.economy.operatingBalance),
          cashflowToday: Math.round(snap.economy.netCashflowToday),
          projectedDailyCashflow: Math.round(
            snap.economy.projectedDailyCashflow,
          ),
          fareRevenueToday: Math.round(snap.economy.fareRevenueToday),
          operatingCostToday: Math.round(snap.economy.operatingCostToday),
        },
        kpis: {
          ...snap.kpis,
          waiting: [...snap.stations.values()].reduce(
            (total, station) => total + station.waiting.length,
            0,
          ),
          activePassengers: snap.passengers.size,
        },
        traffic: { ...snap.traffic },
        environment: { ...snap.environment },
        mapGeometry: renderer.geometryStats,
        build: {
          service: game.buildTransitMode,
          nextAlignment: game.buildAlignment,
          nextLevelM: game.buildLevelM,
          direction: game.buildDirection,
          draftPoints: game.draft.length,
          estimatedCost: game.getDraftEstimate().totalCost,
          estimatedDemolitions:
            game.getDraftEstimate().demolishedBuildings,
          estimatedNoiseDb: Math.round(
            game.getDraftEstimate().averageNoiseDb,
          ),
          facility: game.activeFacilityType,
        },
        network: {
          stations: [...snap.stations.values()].map((station) => ({
            id: station.id,
            name: station.name,
            lines: station.lineIds,
            alignment: station.primaryAlignment,
            levelM: station.levelM,
            waiting: station.waiting.length,
          })),
          lines: [...snap.lines.values()].map((line) => ({
            id: line.id,
            name: line.name,
            mode: line.mode,
            alignment: line.alignment,
            direction: line.direction,
            headwaySec: line.headwaySec,
            fleet: line.vehicleIds.length,
            segments: line.segmentDetails.map((segment) => ({
              alignment: segment.alignment,
              levelM: segment.levelM,
              lengthM: Math.round(segment.lengthM),
              pathPoints: segment.path.length,
              noiseDb: Math.round(segment.noiseDb),
              demolishedBuildings: segment.demolishedBuildings,
            })),
            stations: line.stationIds.length,
            lengthM: Math.round(line.length),
          })),
          vehicles: snap.vehicles.map((vehicle) => ({
            id: vehicle.id,
            name: vehicle.name,
            lineId: vehicle.lineId,
            model: vehicle.modelId,
            capacity: vehicle.capacity,
            onboard: vehicle.onboard.length,
            condition: Math.round(vehicle.conditionPct),
          })),
          facilities: snap.facilities.map((facility) => ({
            id: facility.id,
            code: facility.code,
            type: facility.type,
            connected: facility.connected,
            builtIn: facility.builtIn,
          })),
        },
        selection: game.selection,
      });
    };
    testWindow.advanceTime = (ms: number) => game.advanceTime(ms);
  } catch (err) {
    loading.textContent =
      `Failed to load the world bundle — run "npm run bake" first, then reload. (${err})`;
    throw err;
  }
}

void boot();
