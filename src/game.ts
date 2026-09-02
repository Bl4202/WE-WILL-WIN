/**
 * Game manager: owns the Simulation, the fixed-timestep loop, time controls,
 * and UI-side state (mode, line draft, selection). Mirrors the eventual
 * store/kernel split (GDD §1.1): the sim only advances via tick(), commands
 * are applied between ticks, and everything else reads snapshots.
 */
import {
  BASE_TIME_SCALE,
  SAME_STATION_M,
  SIM_DT,
  SPEED_MULTIPLIERS,
} from "./constants";
import { facilityBuildCost } from "./mobility";
import { Simulation, type LinePoint } from "./simulation";
import type {
  ConstructionEstimate,
  FacilityType,
  MobilityFacility,
  RailAlignment,
  RollingStockModelId,
  ServiceDirection,
  SimSnapshot,
  TransitMode,
  Vec2,
  Zone,
} from "./types";

export type UiMode = "inspect" | "build" | "fleet" | "place";

export interface Selection {
  kind: "station" | "line" | "facility";
  id: number;
}

/** Safety cap so a background tab doesn't spiral on refocus. */
const MAX_TICKS_PER_FRAME = 400;

export class Game {
  readonly sim: Simulation;

  constructor(zones: Zone[], facilities: MobilityFacility[] = []) {
    this.sim = new Simulation(zones, facilities);
  }

  speedIndex = 2; // 1× — real time
  mode: UiMode = "inspect";
  /** Stations of the line currently being drawn (build mode). */
  draft: LinePoint[] = [];
  /**
   * Whether map clicks are drawing a line.
   *
   * Separate from being in build mode, because the construction settings are
   * worth opening and changing on their own. Arming on entry meant every visit
   * to the panel dropped a station wherever the next click happened to land.
   */
  blueprinting = false;
  selection: Selection | null = null;
  buildTransitMode: TransitMode = "metro";
  buildAlignment: RailAlignment = "surface";
  /** Metres relative to street level for the next segment. */
  buildLevelM = 0;
  buildDirection: ServiceDirection = "bidirectional";
  activeFacilityType: FacilityType | null = null;
  lastNotice: string | null = null;

  /**
   * How far this frame falls between the last sim tick and the next, 0–1.
   * The sim is locked to 4 Hz, so the renderer lerps vehicles across it to
   * keep motion smooth at 1× (where a tick is a quarter-second of real time).
   */
  tickAlpha = 0;

  private accumulator = 0;
  private lastFrameMs = 0;
  private frameCallback: (snap: SimSnapshot) => void = () => {};

  start(onFrame: (snap: SimSnapshot) => void): void {
    this.frameCallback = onFrame;
    this.lastFrameMs = performance.now();
    requestAnimationFrame(this.loop);
  }

  private loop = (nowMs: number): void => {
    // The QA harness drives time through advanceTime() instead of the frame
    // clock, so the loop must not also advance it. Dev-only: sniffing a bare
    // global in production means any extension or third-party script that
    // happens to define `__vt_pending` silently freezes the simulation —
    // rAF keeps rendering, the sim never ticks, and nothing reports why.
    const controlledByTestHarness =
      import.meta.env.DEV && "__vt_pending" in window;
    const dtReal = controlledByTestHarness
      ? 0
      : Math.min((nowMs - this.lastFrameMs) / 1000, 0.25);
    this.lastFrameMs = nowMs;

    const simSecPerReal =
      BASE_TIME_SCALE * SPEED_MULTIPLIERS[this.speedIndex];
    this.accumulator += dtReal * simSecPerReal;

    let ticks = Math.floor(this.accumulator / SIM_DT);
    if (ticks > MAX_TICKS_PER_FRAME) {
      ticks = MAX_TICKS_PER_FRAME;
      this.accumulator = 0; // drop the backlog rather than freeze
    } else {
      this.accumulator -= ticks * SIM_DT;
    }
    for (let i = 0; i < ticks; i++) this.sim.tick();
    this.tickAlpha = this.accumulator / SIM_DT;

    this.frameCallback(this.sim.snapshot());
    requestAnimationFrame(this.loop);
  };

  // ── Time controls ───────────────────────────────────────────────────

  setSpeed(index: number): void {
    if (index >= 0 && index < SPEED_MULTIPLIERS.length) {
      this.speedIndex = index;
    }
  }

  togglePause(): void {
    this.speedIndex = this.speedIndex === 0 ? 2 : 0;
  }

  /** Deterministic wall-time advance used by browser-game smoke tests. */
  advanceTime(ms: number): void {
    const simSeconds =
      (Math.max(0, ms) / 1000) *
      BASE_TIME_SCALE *
      SPEED_MULTIPLIERS[this.speedIndex];
    const ticks = Math.min(
      MAX_TICKS_PER_FRAME,
      Math.floor(simSeconds / SIM_DT),
    );
    for (let i = 0; i < ticks; i++) this.sim.tick();
    this.accumulator = 0;
    this.tickAlpha = 0;
    this.frameCallback(this.sim.snapshot());
  }

  // ── Build mode / commands ───────────────────────────────────────────

  setMode(mode: UiMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "build") this.lastNotice = null;
    if (mode !== "build") {
      this.draft = [];
      this.blueprinting = false;
    }
    if (mode === "build" || mode === "place") this.selection = null;
    if (mode !== "place") this.activeFacilityType = null;
  }

  /** Arm the map so clicks place stations. */
  startBlueprint(): void {
    this.setMode("build");
    this.blueprinting = true;
    this.lastNotice = null;
  }

  /** Disarm the map and drop the draft, leaving the panel open to edit. */
  stopBlueprint(): void {
    this.blueprinting = false;
    this.draft = [];
    this.lastNotice = null;
  }

  setBuildTransitMode(mode: TransitMode): void {
    this.lastNotice = null;
    this.buildTransitMode = mode;
    if (mode !== "metro") {
      this.buildAlignment = "surface";
      this.buildLevelM = 0;
    }
    this.setMode("build");
  }

  setBuildAlignment(alignment: RailAlignment): void {
    this.lastNotice = null;
    this.buildAlignment =
      this.buildTransitMode === "metro" ? alignment : "surface";
    this.buildLevelM =
      this.buildAlignment === "underground"
        ? this.buildLevelM < 0
          ? this.buildLevelM
          : -16
        : this.buildAlignment === "elevated"
          ? 12
          : 0;
    this.setMode("build");
  }

  setBuildDepth(depthM: number): void {
    this.buildLevelM = -Math.max(8, Math.min(40, Math.round(depthM)));
    this.buildAlignment = "underground";
    this.setMode("build");
  }

  setBuildDirection(direction: ServiceDirection): void {
    this.buildDirection = direction;
    this.lastNotice = null;
    this.setMode("build");
  }

  beginFacilityPlacement(type: FacilityType): void {
    this.setMode("place");
    this.activeFacilityType = type;
    this.lastNotice = null;
  }

  placeFacility(pos: Vec2): boolean {
    if (!this.activeFacilityType) return false;
    const type = this.activeFacilityType;
    const cost = facilityBuildCost(type);
    if (cost > this.sim.economy.capitalBalance) {
      this.lastNotice = "This facility is over the available capital budget.";
      return false;
    }
    const facility = this.sim.buildFacility(type, pos);
    if (!facility) {
      this.lastNotice =
        type === "airport"
          ? "Airports need at least 8 km of separation."
          : "Choose a site farther from another mobility hub.";
      return false;
    }
    this.lastNotice = `${facility.name} funded for ${formatMoney(cost)}.`;
    this.setMode("inspect");
    this.selection = { kind: "facility", id: facility.id };
    return true;
  }

  addDraftPoint(point: LinePoint): void {
    this.lastNotice = null;
    // Disallow the same stop twice in a row — by position, so it also covers
    // snapping back onto the draft point just placed (which has no station id
    // yet) and would otherwise make a zero-length hop.
    const last = this.draft[this.draft.length - 1];
    if (
      last &&
      Math.hypot(last.pos.x - point.pos.x, last.pos.y - point.pos.y) <
        SAME_STATION_M
    ) {
      return;
    }
    this.draft.push({
      ...point,
      alignmentFromPrevious:
        this.draft.length > 0
          ? this.buildTransitMode === "metro"
            ? this.buildAlignment
            : "surface"
          : undefined,
      levelMFromPrevious:
        this.draft.length > 0
          ? this.buildTransitMode === "metro"
            ? this.buildLevelM
            : 0
          : undefined,
    });
  }

  undoDraftPoint(): void {
    this.lastNotice = null;
    this.draft.pop();
  }

  /** Commit the draft as a new line. Returns true on success. */
  finishLine(): boolean {
    // Collapse near-duplicate consecutive points (a double-click to finish
    // also lands two clicks at the same spot).
    const points: LinePoint[] = [];
    for (const p of this.draft) {
      const last = points[points.length - 1];
      if (
        last &&
        last.existingStationId === undefined &&
        p.existingStationId === undefined &&
        Math.hypot(last.pos.x - p.pos.x, last.pos.y - p.pos.y) < 150
      ) {
        continue;
      }
      points.push(p);
    }
    if (points.length < 2) return false;
    const estimate = this.sim.estimateLine(
      points,
      this.buildTransitMode,
      this.buildAlignment,
    );
    if (estimate.totalCost > this.sim.economy.capitalBalance) {
      this.lastNotice = "This route is over the available capital budget.";
      return false;
    }
    const line = this.sim.commitLine(
      points,
      this.buildTransitMode,
      this.buildAlignment,
      this.buildDirection,
    );
    if (!line) {
      this.lastNotice = "The route could not be built at this location.";
      return false;
    }
    this.lastNotice = `${line.name} infrastructure opened for ${formatMoney(line.constructionCost)}. Buy and assign rolling stock to begin service.`;
    this.draft = [];
    this.blueprinting = false;
    this.mode = "inspect";
    this.selection = { kind: "line", id: line.id };
    return true;
  }

  purchaseVehicle(modelId: RollingStockModelId): boolean {
    const vehicle = this.sim.purchaseVehicle(modelId);
    if (!vehicle) {
      this.lastNotice = "That vehicle is over the available capital budget.";
      return false;
    }
    this.lastNotice = `${vehicle.name} purchased into the unassigned pool.`;
    return true;
  }

  assignVehicle(vehicleId: number, lineId: number): boolean {
    const line = this.sim.lines.get(lineId);
    const vehicle = this.sim.vehicles.find((item) => item.id === vehicleId);
    if (!line || !vehicle || !this.sim.assignVehicle(vehicleId, lineId)) {
      this.lastNotice = "That vehicle is not compatible with this line.";
      return false;
    }
    this.selection = { kind: "line", id: lineId };
    this.lastNotice = `${vehicle.name} assigned to ${line.name}.`;
    return true;
  }

  unassignVehicle(vehicleId: number): boolean {
    const vehicle = this.sim.vehicles.find((item) => item.id === vehicleId);
    if (!vehicle || !this.sim.unassignVehicle(vehicleId)) return false;
    this.lastNotice = `${vehicle.name} returned to the unassigned pool.`;
    return true;
  }

  cancelDraft(): void {
    this.draft = [];
    this.blueprinting = false;
    this.mode = "inspect";
    this.activeFacilityType = null;
    this.lastNotice = null;
  }

  getDraftEstimate(): ConstructionEstimate {
    return this.sim.estimateLine(
      this.draft,
      this.buildTransitMode,
      this.buildAlignment,
    );
  }
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  return `$${Math.round(value / 1_000_000)}M`;
}
