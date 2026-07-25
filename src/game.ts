/**
 * Game manager: owns the Simulation, the fixed-timestep loop, time controls,
 * and UI-side state (mode, line draft, selection). Mirrors the eventual
 * store/kernel split (GDD §1.1): the sim only advances via tick(), commands
 * are applied between ticks, and everything else reads snapshots.
 */
import { BASE_TIME_SCALE, SIM_DT, SPEED_MULTIPLIERS } from "./constants";
import { Simulation, type LinePoint } from "./simulation";
import type { SimSnapshot, Zone } from "./types";

export type UiMode = "inspect" | "build";

export interface Selection {
  kind: "station" | "line";
  id: number;
}

/** Safety cap so a background tab doesn't spiral on refocus. */
const MAX_TICKS_PER_FRAME = 400;

export class Game {
  readonly sim: Simulation;

  constructor(zones: Zone[]) {
    this.sim = new Simulation(zones);
  }

  speedIndex = 2; // 1× — real time
  mode: UiMode = "inspect";
  /** Stations of the line currently being drawn (build mode). */
  draft: LinePoint[] = [];
  selection: Selection | null = null;

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
    const dtReal = Math.min((nowMs - this.lastFrameMs) / 1000, 0.25);
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

  // ── Build mode / commands ───────────────────────────────────────────

  setMode(mode: UiMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode !== "build") this.draft = [];
    if (mode !== "inspect") this.selection = null;
  }

  addDraftPoint(point: LinePoint): void {
    // Disallow the same station twice in a row.
    const last = this.draft[this.draft.length - 1];
    if (
      last?.existingStationId !== undefined &&
      last.existingStationId === point.existingStationId
    ) {
      return;
    }
    this.draft.push(point);
  }

  undoDraftPoint(): void {
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
    const line = this.sim.commitLine(points);
    this.draft = [];
    this.mode = "inspect";
    return line !== null;
  }

  cancelDraft(): void {
    this.draft = [];
    this.mode = "inspect";
  }
}
