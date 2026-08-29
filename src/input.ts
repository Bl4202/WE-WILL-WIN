/**
 * Pointer + keyboard input on the MapLibre map: click-to-draw lines and
 * stations (snapping to existing stations creates transfers), inspect
 * picking, time controls, and overlay toggles. Map pan/zoom stays native —
 * MapLibre only emits `click` when the pointer didn't drag.
 */
import type { Game } from "./game";
import {
  normalizeInputKey,
  type InputAction,
  type Preferences,
} from "./preferences";
import type { MapRenderer } from "./render-map";
import type { SimSnapshot } from "./types";

export function bindInput(
  renderer: MapRenderer,
  game: Game,
  getSnapshot: () => SimSnapshot,
  preferences: Preferences,
): void {
  const map = renderer.map;

  map.on("mousemove", (e) => {
    if (game.mode === "place") {
      renderer.hoverLngLat = [e.lngLat.lng, e.lngLat.lat];
      renderer.hoverSnapped = false;
      renderer.hoveredStationId = null;
      map.getCanvas().style.cursor = "crosshair";
      return;
    }
    if (game.mode === "build") {
      const target = renderer.pickBuildTarget(getSnapshot(), game.draft, e.point, [
        e.lngLat.lng,
        e.lngLat.lat,
      ], game.buildTransitMode);
      renderer.hoverLngLat = renderer.toLngLat(target.pos);
      renderer.hoverSnapped = target.snapped && target.valid;
      // Only a committed station carries a waiting queue; a draft point has
      // no id yet, so there is nothing to report for it.
      renderer.hoveredStationId = target.existingStationId ?? null;
      map.getCanvas().style.cursor = target.valid ? "crosshair" : "not-allowed";
      return;
    }
    const snap = getSnapshot();
    const facility = renderer.pickFacility(snap, e.point);
    const station = facility ? null : renderer.pickStation(snap, e.point);
    renderer.hoverLngLat = facility
      ? renderer.toLngLat(facility.pos)
      : station
        ? renderer.toLngLat(station.pos)
        : [e.lngLat.lng, e.lngLat.lat];
    renderer.hoverSnapped = false;
    renderer.hoveredStationId = station?.id ?? null;
    map.getCanvas().style.cursor = station || facility ? "pointer" : "";
  });

  // Leaving the canvas fires no mousemove, so the last hover would stick.
  map.on("mouseout", () => {
    renderer.hoveredStationId = null;
    renderer.hoverSnapped = false;
  });

  map.on("click", (e) => {
    const snap = getSnapshot();

    if (game.mode === "place") {
      game.placeFacility(renderer.toWorld(e.lngLat.lat, e.lngLat.lng));
      return;
    }

    if (game.mode === "build") {
      const target = renderer.pickBuildTarget(snap, game.draft, e.point, [
        e.lngLat.lng,
        e.lngLat.lat,
      ], game.buildTransitMode, true);
      if (!target.valid) {
        game.lastNotice =
          game.buildTransitMode === "bus"
            ? "Bus stops and route segments must connect through the visible road network."
            : "This segment cannot be built here.";
        return;
      }
      game.addDraftPoint({
        pos: target.pos,
        existingStationId: target.existingStationId,
        pathFromPrevious: target.pathFromPrevious,
        demolitionSitesFromPrevious: target.demolitionSitesFromPrevious,
        demolitionFeatureIdsFromPrevious:
          target.demolitionFeatureIdsFromPrevious,
      });
      return;
    }

    const facility = renderer.pickFacility(snap, e.point);
    if (facility) {
      game.selection = { kind: "facility", id: facility.id };
      return;
    }
    const station = renderer.pickStation(snap, e.point);
    if (station) {
      game.selection = { kind: "station", id: station.id };
      return;
    }
    const lineId = renderer.pickLine(snap, e.point);
    game.selection = lineId !== null ? { kind: "line", id: lineId } : null;
  });

  map.on("dblclick", (e) => {
    if (game.mode === "build") {
      e.preventDefault();
      game.finishLine();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement &&
        e.target.closest("[data-keybind-action].recording"))
    ) {
      return;
    }
    const key = normalizeInputKey(e.key);
    const action = (Object.entries(preferences.keybinds).find(
      ([, boundKey]) => normalizeInputKey(boundKey) === key,
    )?.[0] ?? null) as InputAction | null;

    if (/^[1-6]$/.test(e.key)) {
      game.setSpeed(Number(e.key) - 1);
      return;
    }

    switch (action) {
      case "pause":
        e.preventDefault();
        game.togglePause();
        break;
      case "build":
        game.setMode("build");
        break;
      case "cycleAlignment":
        if (game.mode === "build" && game.buildTransitMode === "metro") {
          const next =
            game.buildAlignment === "surface"
              ? "elevated"
              : game.buildAlignment === "elevated"
                ? "underground"
                : "surface";
          game.setBuildAlignment(
            next,
          );
        }
        break;
      case "finishLine":
        if (game.mode === "build") game.finishLine();
        break;
      case "cancel":
        if (game.mode === "build" || game.mode === "place") game.cancelDraft();
        else game.selection = null;
        break;
      case "undo":
        if (game.mode === "build") game.undoDraftPoint();
        break;
      case "toggleDemand":
        renderer.showDemand = !renderer.showDemand;
        break;
      case "toggleNetwork":
        renderer.showGhost = !renderer.showGhost;
        break;
      case "toggleView":
        renderer.set3dMode(!renderer.is3d);
        break;
      case "speedUp":
        game.setSpeed(Math.min(5, game.speedIndex + 1));
        break;
      case "speedDown":
        game.setSpeed(Math.max(0, game.speedIndex - 1));
        break;
    }
  });
}
