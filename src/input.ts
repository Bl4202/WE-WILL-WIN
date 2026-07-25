/**
 * Pointer + keyboard input on the MapLibre map: click-to-draw lines and
 * stations (snapping to existing stations creates transfers), inspect
 * picking, time controls, and overlay toggles. Map pan/zoom stays native —
 * MapLibre only emits `click` when the pointer didn't drag.
 */
import type { Game } from "./game";
import type { MapRenderer } from "./render-map";
import type { SimSnapshot } from "./types";

export function bindInput(
  renderer: MapRenderer,
  game: Game,
  getSnapshot: () => SimSnapshot,
): void {
  const map = renderer.map;

  map.on("mousemove", (e) => {
    const snapped = renderer.pickStation(getSnapshot(), e.point);
    renderer.hoverLngLat = snapped
      ? renderer.toLngLat(snapped.pos)
      : [e.lngLat.lng, e.lngLat.lat];
    map.getCanvas().style.cursor =
      game.mode === "build" ? "crosshair" : snapped ? "pointer" : "";
  });

  map.on("click", (e) => {
    const snap = getSnapshot();
    const station = renderer.pickStation(snap, e.point);

    if (game.mode === "build") {
      game.addDraftPoint(
        station
          ? { pos: station.pos, existingStationId: station.id }
          : { pos: renderer.toWorld(e.lngLat.lat, e.lngLat.lng) },
      );
      return;
    }

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
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key) {
      case " ":
        e.preventDefault();
        game.togglePause();
        break;
      case "b":
      case "B":
        game.setMode("build");
        break;
      case "Enter":
        if (game.mode === "build") game.finishLine();
        break;
      case "Escape":
        if (game.mode === "build") game.cancelDraft();
        else game.selection = null;
        break;
      case "Backspace":
        if (game.mode === "build") game.undoDraftPoint();
        break;
      case "d":
      case "D":
        renderer.showDemand = !renderer.showDemand;
        break;
      case "g":
      case "G":
        renderer.showGhost = !renderer.showGhost;
        break;
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
        game.setSpeed(Number(e.key) - 1);
        break;
    }
  });
}
