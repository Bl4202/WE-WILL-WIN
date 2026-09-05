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
import { wrapAngle } from "./geo";
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
  /**
   * Extra platform rotation the player is holding in, radians. It sits on top
   * of the angle the draft suggests, so drawing a straight line still lays
   * straight platforms without touching the rotate keys. Cleared once a
   * station is placed.
   */
  stationRotationOffset = 0;
  /**
   * Whether the first drafted platform is still following the cursor.
   *
   * It has no track to line up with until a second point exists, so it aims
   * at wherever the line is heading. But a player who turned it by hand
   * before clicking meant that angle — auto-aiming would silently throw the
   * choice away on the very next mouse move.
   */
  private firstPointAutoAim = true;
  activeFacilityType: FacilityType | null = null;
  lastNotice: string | null = null;

  /**
   * How far this frame falls between the last sim tick and the next, 0–1.
   * The sim is locked to 4 Hz, so the renderer lerps vehicles across it to
   * keep motion smooth at 1× (where a tick is a quarter-second of real time).
   */
  tickAlpha = 0;

  /** Bumped on every draft mutation, so getDraftEstimate can memoize. */
  private draftRevision = 0;
  private draftEstimateKey = "";
  private draftEstimate: ConstructionEstimate | null = null;

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
      this.draftRevision++;
      this.blueprinting = false;
      this.stationRotationOffset = 0;
      this.firstPointAutoAim = true;
    }
    if (mode === "build" || mode === "place") this.selection = null;
    if (mode !== "place") this.activeFacilityType = null;
  }

  /** Arm the map so clicks place stations. */
  startBlueprint(): void {
    this.setMode("build");
    this.blueprinting = true;
    this.stationRotationOffset = 0;
    this.firstPointAutoAim = true;
    this.lastNotice = null;
  }

  /** Turn the platform under the cursor. Driven by a held key, so it takes
   *  an angle per frame rather than a fixed step. */
  adjustStationRotation(deltaRad: number): void {
    this.stationRotationOffset = wrapAngle(
      this.stationRotationOffset + deltaRad,
    );
  }

  /**
   * Aim the only placed station at the cursor.
   *
   * The first point of a draft has no track to align to yet, so while it is
   * still the only point it follows the cursor — a platform left square to
   * the line it starts is the one thing the player cannot correct later.
   * Skipped once the platform has been turned by hand: that angle was chosen.
   *
   * `draftRevision` must not move here. The estimate is memoized on it and
   * bumping it every mouse move would reprice the whole draft each frame; it
   * is safe because a one-point draft has no segment to price.
   */
  aimFirstDraftPoint(towards: Vec2): void {
    if (!this.firstPointAutoAim) return;
    if (this.draft.length !== 1) return;
    const first = this.draft[0];
    if (first.existingStationId !== undefined) return;
    if (Math.hypot(towards.x - first.pos.x, towards.y - first.pos.y) < 1) return;
    first.orientationRad = wrapAngle(
      Math.atan2(towards.y - first.pos.y, towards.x - first.pos.x),
    );
  }

  /** Disarm the map and drop the draft, leaving the panel open to edit. */
  stopBlueprint(): void {
    this.blueprinting = false;
    this.draft = [];
    this.draftRevision++;
    this.stationRotationOffset = 0;
    this.firstPointAutoAim = true;
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
    // Read before the offset is cleared below: a first platform the player
    // turned by hand keeps that angle instead of resuming auto-aim.
    const turnedByHand = this.stationRotationOffset !== 0;
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
    if (this.draft.length === 1 && turnedByHand) this.firstPointAutoAim = false;
    // The offset was dialled in for this platform, not for the whole line.
    this.stationRotationOffset = 0;
    this.draftRevision++;
  }

  undoDraftPoint(): void {
    this.lastNotice = null;
    this.draft.pop();
    // Stepping back to an empty draft starts over, hand-set angle included.
    if (this.draft.length === 0) this.firstPointAutoAim = true;
    this.stationRotationOffset = 0;
    this.draftRevision++;
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
    this.draftRevision++;
    this.blueprinting = false;
    this.stationRotationOffset = 0;
    this.firstPointAutoAim = true;
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
    this.draftRevision++;
    this.blueprinting = false;
    this.stationRotationOffset = 0;
    this.firstPointAutoAim = true;
    this.mode = "inspect";
    this.activeFacilityType = null;
    this.lastNotice = null;
  }

  /**
   * Priced construction estimate for the line currently being drawn.
   *
   * Memoized because the UI asks for this every frame to fill five labels,
   * while `estimateLineConstruction` rebuilds the whole segment breakdown and
   * deep-clones every point of every segment path — for a road-snapped bus
   * draft that is hundreds of allocations per frame. The draft only changes
   * when the player clicks, so the estimate does too.
   */
  getDraftEstimate(): ConstructionEstimate {
    const key =
      this.draft.length +
      "|" +
      this.buildTransitMode +
      "|" +
      this.buildAlignment +
      "|" +
      this.buildLevelM +
      "|" +
      this.draftRevision;
    if (key !== this.draftEstimateKey || !this.draftEstimate) {
      this.draftEstimateKey = key;
      this.draftEstimate = this.sim.estimateLine(
        this.draft,
        this.buildTransitMode,
        this.buildAlignment,
      );
    }
    return this.draftEstimate;
  }
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  return `$${Math.round(value / 1_000_000)}M`;
}
