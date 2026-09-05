/**
 * Pointer + keyboard input on the MapLibre map: click-to-draw lines and
 * stations (snapping to existing stations creates transfers), inspect
 * picking, time controls, and overlay toggles. Map pan/zoom stays native —
 * MapLibre only emits `click` when the pointer didn't drag.
 */
import type { Game } from "./game";
import {
  normalizeInputKey,
  savePreferences,
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

  // Rotating a platform is a held gesture, not a tapped one: the two keys set
  // a direction and a frame loop integrates it. A fixed step per press cannot
  // give a smooth turn, and leaning on the OS auto-repeat would make the rate
  // depend on the player's keyboard settings.
  const ROTATE_RAD_PER_SEC = Math.PI / 2;
  let rotateDirection = 0;
  let rotateFrame = 0;
  let rotateLastMs = 0;

  const setRotateDirection = (direction: number): void => {
    if (rotateDirection === direction) return;
    rotateDirection = direction;
    if (rotateFrame !== 0) cancelAnimationFrame(rotateFrame);
    rotateFrame = 0;
    if (direction === 0) return;
    rotateLastMs = performance.now();
    rotateFrame = requestAnimationFrame(stepRotation);
  };

  function stepRotation(nowMs: number): void {
    if (rotateDirection === 0) return;
    if (!game.blueprinting) {
      setRotateDirection(0);
      return;
    }
    // Clamped so a backgrounded tab does not return and spin the platform
    // through however many seconds it was away.
    const dt = Math.min((nowMs - rotateLastMs) / 1000, 0.1);
    rotateLastMs = nowMs;
    // A platform already in the ground does not turn, so while the cursor is
    // on one the offset must not creep either — otherwise the readout counts
    // up against a ghost that is visibly standing still.
    if (!renderer.hoverOrientationLocked) {
      game.adjustStationRotation(rotateDirection * ROTATE_RAD_PER_SEC * dt);
    }
    rotateFrame = requestAnimationFrame(stepRotation);
  }

  const actionFor = (rawKey: string): InputAction | null => {
    const key = normalizeInputKey(rawKey);
    return (Object.entries(preferences.keybinds).find(
      ([, boundKey]) =>
        boundKey !== "" && normalizeInputKey(boundKey) === key,
    )?.[0] ?? null) as InputAction | null;
  };

  map.on("mousemove", (e) => {
    if (game.mode === "place") {
      renderer.hoverLngLat = [e.lngLat.lng, e.lngLat.lat];
      renderer.hoverSnapped = false;
      renderer.hoveredStationId = null;
      map.getCanvas().style.cursor = "crosshair";
      return;
    }
    if (game.blueprinting) {
      const target = renderer.pickBuildTarget(
        getSnapshot(),
        game.draft,
        e.point,
        [e.lngLat.lng, e.lngLat.lat],
        game.buildTransitMode,
        false,
        game.stationRotationOffset,
      );
      renderer.hoverLngLat = renderer.toLngLat(target.pos);
      // The *base* angle, not the resolved one: the renderer re-adds the
      // rotation offset every frame, so the ghost keeps turning while a
      // rotate key is held and the mouse is not moving.
      renderer.hoverBaseOrientationRad = target.orientationBaseRad;
      renderer.hoverOrientationLocked = target.orientationLocked;
      // The first platform of a draft has no track to line up with yet, so it
      // follows the cursor until there is a second point to face.
      game.aimFirstDraftPoint(target.pos);
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

    if (game.blueprinting) {
      const target = renderer.pickBuildTarget(
        snap,
        game.draft,
        e.point,
        [e.lngLat.lng, e.lngLat.lat],
        game.buildTransitMode,
        true,
        game.stationRotationOffset,
      );
      if (!target.valid) {
        game.lastNotice =
          game.buildTransitMode === "bus"
            ? "Bus stops and route segments must connect through the visible road network."
            : "This segment cannot be built here.";
        return;
      }
      game.addDraftPoint({
        pos: target.pos,
        orientationRad: target.orientationRad,
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
    if (game.blueprinting) {
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
    // The settings dialog is modal, but focus inside it sits on plain
    // buttons, which none of the checks above catch — so every shortcut used
    // to keep firing at the game behind it. Pressing "b" while reading the
    // keybind list would silently switch to build mode.
    const dialog = document.getElementById("settings-dialog");
    if (dialog instanceof HTMLDialogElement && dialog.open) return;

    // Same reasoning for the tutorial overlay: it sits on top of the game
    // but isn't a modal dialog, so shortcuts would otherwise still land.
    if (!document.getElementById("tutorial-overlay")?.classList.contains("hidden")) return;

    // Chords belong to the browser. Without this, Ctrl/Cmd+D also toggles
    // the demand layer while bookmarking, and Ctrl+A, Ctrl+B and Ctrl+V all
    // fire game actions on top of their real ones.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Auto-repeat would run these at the OS repeat rate: holding Space
    // toggled pause about thirty times a second and landed wherever.
    if (e.repeat) return;

    const key = normalizeInputKey(e.key);
    const action = actionFor(e.key);

    // Digits pick a speed, but only when nothing has claimed them. This used
    // to run before the switch and return unconditionally, so an action
    // rebound to a digit was dead on arrival while the keybind UI happily
    // displayed it as bound.
    if (action === null && /^[1-6]$/.test(key)) {
      game.setSpeed(Number(key) - 1);
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
      case "rotateStationLeft":
        if (game.blueprinting) setRotateDirection(-1);
        break;
      case "rotateStationRight":
        if (game.blueprinting) setRotateDirection(1);
        break;
      case "finishLine":
        if (game.blueprinting) game.finishLine();
        break;
      case "cancel":
        // Escape steps back out one layer at a time: first disarm the map,
        // then close the panel.
        if (game.blueprinting) game.stopBlueprint();
        else if (game.mode === "build" || game.mode === "place")
          game.cancelDraft();
        else game.selection = null;
        break;
      case "undo":
        if (game.blueprinting) game.undoDraftPoint();
        break;
      case "toggleDemand":
        renderer.showDemand = !renderer.showDemand;
        break;
      case "toggleNetwork":
        renderer.showGhost = !renderer.showGhost;
        break;
      case "toggleView":
        // Persist, like the on-screen toggle does. Without this the keyboard
        // and the button disagreed: flip the view with `v`, reload, and it
        // was back where it started.
        renderer.set3dMode(!renderer.is3d);
        preferences.viewMode = renderer.is3d ? "3d" : "2d";
        savePreferences(preferences);
        break;
      case "speedUp":
        game.setSpeed(Math.min(5, game.speedIndex + 1));
        break;
      case "speedDown":
        game.setSpeed(Math.max(0, game.speedIndex - 1));
        break;
    }
  });

  window.addEventListener("keyup", (e) => {
    const action = actionFor(e.key);
    if (
      (action === "rotateStationLeft" && rotateDirection < 0) ||
      (action === "rotateStationRight" && rotateDirection > 0)
    ) {
      setRotateDirection(0);
    }
  });

  // A key held while the window loses focus never sends its keyup, so without
  // this the platform keeps turning behind an alt-tab.
  window.addEventListener("blur", () => setRotateDirection(0));
}
