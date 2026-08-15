/**
 * Phase-0 simulation kernel: deterministic, fixed-timestep (4 Hz sim tick,
 * GDD §4.3), advanced only through tick(). A miniature of the eventual Rust
 * kernel's contract: it owns all sim state, consumes commands between ticks,
 * and the UI/render layer only reads snapshots.
 *
 * Tick order (reduced from §4.3): SCHEDULE/MOVE → DWELL (alight/board) →
 * DEMAND SPAWN → KPI. No economy, physics, or reliability yet — Phase 0
 * deliberately excludes them.
 */
import {
  DAILY_TRIPS,
  DAY_SEC,
  DEFAULT_HEADWAY_SEC,
  DEST_DETERRENCE_M,
  DWELL_SEC,
  LOCAL_DEMAND_FRACTION,
  SAME_STATION_M,
  SIM_DT,
  TRAIN_CAPACITY,
  WALK_RADIUS,
  WALK_SPEED,
} from "./constants";
import { nextSpeed, runTimeSec } from "./kinematics";
import {
  TransitPlanner,
  type PlannedTrip,
  type StationAccess,
} from "./pathfinding";
import { Rng } from "./rng";
import type {
  Kpis,
  Line,
  Passenger,
  SimSnapshot,
  Station,
  Vec2,
  Vehicle,
  Zone,
} from "./types";

/** A point of a committed line: either a brand-new station or an existing one. */
export interface LinePoint {
  pos: Vec2;
  existingStationId?: number;
}

/** Relative trip-emission weight per hour of day (AM peak, midday, PM peak). */
const HOURLY_WEIGHT = [
  0.2, 0.1, 0.1, 0.1, 0.3, 1.0, 3.0, 6.5, 6.0, 3.0, 2.0, 2.2, // 00–11
  2.5, 2.2, 2.0, 2.5, 4.5, 6.5, 5.5, 3.0, 2.0, 1.5, 1.0, 0.5, // 12–23
] as const;
const HOURLY_SUM = HOURLY_WEIGHT.reduce((a, b) => a + b, 0);

const LINE_COLORS = [
  "#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa",
  "#fb8c00", "#00acc1", "#d81b60", "#7cb342", "#5e35b1",
];

export class Simulation {
  readonly zones: Zone[];
  readonly stations = new Map<number, Station>();
  readonly lines = new Map<number, Line>();
  readonly vehicles: Vehicle[] = [];
  readonly passengers = new Map<number, Passenger>();

  private simTimeSec = 5 * 3600; // day 1, 05:00 — just before the AM peak
  private readonly rng = new Rng(0xc0ffee);
  private readonly planner = new TransitPlanner();
  private spawnAccumulator = 0;
  /** Passenger ids in walk-access, sorted by arrival time (earliest last). */
  private walking: number[] = [];
  private networkVersion = 0;

  /** Prefix sums over zone pop/jobs for O(log n) origin sampling. */
  private readonly cumPop: number[];
  private readonly cumJobs: number[];

  /** TEMP (see LOCAL_DEMAND_FRACTION, constants.ts): zone indices (into
   *  `this.zones`) within WALK_RADIUS of any built station — mirrors
   *  cumPop/cumJobs but restricted to this near-network subset. Rebuilt
   *  alongside planCache on every network change. Delete together with
   *  LOCAL_DEMAND_FRACTION. */
  private nearNetworkZoneIdx: number[] = [];
  private cumPopNear: number[] = [];
  private cumJobsNear: number[] = [];

  /**
   * O/D plan cache keyed "originZone|destZone" — zone pairs repeat heavily,
   * so most spawns skip Dijkstra entirely. Cleared on any network change.
   * Cached legs are shared between passengers (they are read-only after
   * planning).
   */
  private planCache = new Map<
    string,
    { plan: PlannedTrip; walkSec: number } | null
  >();

  private nextStationId = 1;
  private nextLineId = 1;
  private nextVehicleId = 1;
  private nextPassengerId = 1;

  private kpis: Kpis = {
    boardingsToday: 0,
    boardingsYesterday: 0,
    completedTrips: 0,
    unservedTrips: 0,
  };

  constructor(zones: Zone[]) {
    this.zones = zones;
    this.cumPop = new Array(zones.length);
    this.cumJobs = new Array(zones.length);
    let p = 0;
    let j = 0;
    for (let i = 0; i < zones.length; i++) {
      p += zones[i].pop;
      j += zones[i].jobs;
      this.cumPop[i] = p;
      this.cumJobs[i] = j;
    }
  }

  /** Sample a zone index from a prefix-sum array by binary search. */
  private sampleZone(cum: number[]): number {
    const total = cum[cum.length - 1];
    if (total <= 0) return -1;
    const r = this.rng.next() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] > r) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // ── Commands (applied between ticks by the game manager) ────────────

  /** Commit a drawn line. Returns the new line, or null if invalid. */
  commitLine(points: LinePoint[]): Line | null {
    if (points.length < 2) return null;

    const stationIds: number[] = [];
    // Stations minted by this very call, so a line that loops back onto its
    // own starting point reuses that station instead of stacking a second one
    // on the same spot (the draft's points are not Stations yet, so they
    // arrive here as repeated coordinates rather than repeated ids).
    const minted: { pos: Vec2; id: number }[] = [];
    for (const p of points) {
      if (p.existingStationId !== undefined) {
        stationIds.push(p.existingStationId);
        continue;
      }
      const twin = minted.find(
        (m) => Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < SAME_STATION_M,
      );
      if (twin) {
        stationIds.push(twin.id);
        continue;
      }
      const id = this.nextStationId++;
      this.stations.set(id, {
        id,
        name: `Station ${id}`,
        pos: { ...p.pos },
        lineIds: [],
        waiting: [],
      });
      minted.push({ pos: { ...p.pos }, id });
      stationIds.push(id);
    }

    const stationDist: number[] = [0];
    for (let i = 1; i < stationIds.length; i++) {
      const a = this.stations.get(stationIds[i - 1])!.pos;
      const b = this.stations.get(stationIds[i])!.pos;
      stationDist.push(stationDist[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }

    const id = this.nextLineId++;
    const line: Line = {
      id,
      name: `Line ${id}`,
      color: LINE_COLORS[(id - 1) % LINE_COLORS.length],
      stationIds,
      stationDist,
      length: stationDist[stationDist.length - 1],
      headwaySec: DEFAULT_HEADWAY_SEC,
    };
    this.lines.set(id, line);
    for (const sid of stationIds) {
      const st = this.stations.get(sid)!;
      if (!st.lineIds.includes(id)) st.lineIds.push(id);
    }

    this.spawnFleet(line);
    this.planner.rebuild(this.lines, this.stations);
    this.planCache.clear();
    this.rebuildNearNetworkZones(); // TEMP — see LOCAL_DEMAND_FRACTION
    this.networkVersion++;
    return line;
  }

  /** Size the fleet from the round-trip time and headway, spread evenly. */
  private spawnFleet(line: Line): void {
    let runSec = 0;
    for (let i = 1; i < line.stationDist.length; i++) {
      runSec += runTimeSec(line.stationDist[i] - line.stationDist[i - 1]);
    }
    const oneWaySec = runSec + line.stationIds.length * DWELL_SEC;
    const count = Math.max(
      1,
      Math.min(16, Math.round((2 * oneWaySec) / line.headwaySec)),
    );
    const last = line.stationIds.length - 1;
    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0 : i / count;
      // Unfold the round trip: first half outbound, second half inbound.
      const along = frac < 0.5 ? frac * 2 : (1 - frac) * 2;
      const dist = along * line.length;
      const dir: 1 | -1 = frac < 0.5 ? 1 : -1;
      // Station at or behind `dist`, so the train sits in hop idx → idx+1.
      let idx = 0;
      while (idx < last && line.stationDist[idx + 1] <= dist) idx++;
      // `atStationIdx` is the stop *behind* the train, which depends on which
      // way it faces: an outbound train just left idx and is heading for
      // idx+1, an inbound one just left idx+1 and is heading back to idx.
      // Clamping keeps the stop it is heading for on the line, so a train
      // seeded at either end starts by running toward the terminus rather
      // than pointing off the end of the line.
      const atStationIdx =
        dir === 1 ? Math.min(idx, last - 1) : Math.min(idx + 1, last);
      this.vehicles.push({
        id: this.nextVehicleId++,
        lineId: line.id,
        dist,
        prevDist: dist,
        speed: 0, // pulls away from a stand like any other departure
        dir,
        state: "running",
        dwellRemaining: 0,
        atStationIdx,
        onboard: [],
      });
    }
  }

  // ── Tick ────────────────────────────────────────────────────────────

  tick(): void {
    const prevDay = Math.floor(this.simTimeSec / DAY_SEC);
    this.simTimeSec += SIM_DT;
    if (Math.floor(this.simTimeSec / DAY_SEC) !== prevDay) {
      this.kpis.boardingsYesterday = this.kpis.boardingsToday;
      this.kpis.boardingsToday = 0;
      this.kpis.completedTrips = 0;
      this.kpis.unservedTrips = 0;
    }

    this.moveVehicles();
    this.finishWalks();
    this.spawnDemand();
  }

  private moveVehicles(): void {
    for (const v of this.vehicles) {
      const line = this.lines.get(v.lineId)!;
      // Where this tick started, so the renderer can interpolate across it
      // (the sim ticks at 4 Hz; the screen refreshes far faster).
      v.prevDist = v.dist;
      if (v.state === "dwelling") {
        v.dwellRemaining -= SIM_DT;
        if (v.dwellRemaining <= 0) v.state = "running";
        continue;
      }

      const nextIdx = v.atStationIdx + v.dir;
      if (nextIdx < 0 || nextIdx >= line.stationIds.length) {
        // Facing off the end of the line — turn around. Reversing (rather
        // than just clamping) matters: with no stop ahead there is nothing
        // to advance toward, so a train left pointing outward would sit
        // here forever instead of resuming service.
        v.dir = v.dir === 1 ? -1 : 1;
        v.speed = 0;
        v.dist = Math.max(0, Math.min(line.length, v.dist));
        continue;
      }

      // Accelerate to the midpoint, then brake into the platform (see
      // kinematics.ts). `dir` flips only at terminals, so the next station is
      // always ahead, and the hop it belongs to sets the train's top speed.
      const marker = line.stationDist[nextIdx];
      const hopLen = Math.abs(marker - line.stationDist[v.atStationIdx]);
      v.speed = nextSpeed(v.speed, (marker - v.dist) * v.dir, hopLen);
      v.dist += v.dir * v.speed * SIM_DT;

      const arrived = v.dir === 1 ? v.dist >= marker : v.dist <= marker;
      if (arrived) {
        v.dist = marker;
        v.speed = 0;
        v.atStationIdx = nextIdx;
        v.state = "dwelling";
        v.dwellRemaining = DWELL_SEC;
        this.handleStationStop(v, line);
      }
    }
  }

  /** Alight, flip at terminals, then board — capacity-constrained. */
  private handleStationStop(v: Vehicle, line: Line): void {
    const stationId = line.stationIds[v.atStationIdx];
    const station = this.stations.get(stationId)!;

    // 1 · Alight.
    const staying: number[] = [];
    for (const pid of v.onboard) {
      const p = this.passengers.get(pid)!;
      const leg = p.legs[p.legIndex];
      if (leg.alightStationId === stationId) {
        p.legIndex++;
        if (p.legIndex >= p.legs.length) {
          this.passengers.delete(pid);
          this.kpis.completedTrips++;
        } else {
          p.phase = "waiting";
          station.waiting.push(pid);
        }
      } else {
        staying.push(pid);
      }
    }
    v.onboard = staying;

    // 2 · Reverse at terminals before boarding, so passengers board the
    //     direction the vehicle will actually depart in.
    if (v.atStationIdx === 0) v.dir = 1;
    else if (v.atStationIdx === line.stationIds.length - 1) v.dir = -1;

    // 3 · Board, up to crush capacity; the rest are left behind to wait.
    const stillWaiting: number[] = [];
    for (const pid of station.waiting) {
      const p = this.passengers.get(pid)!;
      const leg = p.legs[p.legIndex];
      const wants =
        leg.lineId === line.id &&
        leg.boardStationId === stationId &&
        leg.dir === v.dir;
      if (wants && v.onboard.length < TRAIN_CAPACITY) {
        p.phase = "riding";
        v.onboard.push(pid);
        this.kpis.boardingsToday++;
      } else {
        stillWaiting.push(pid);
      }
    }
    station.waiting = stillWaiting;
  }

  /** Move passengers who finished their access walk into station queues. */
  private finishWalks(): void {
    while (this.walking.length > 0) {
      const pid = this.walking[this.walking.length - 1];
      const p = this.passengers.get(pid)!;
      if (p.arrivesAtStationAt > this.simTimeSec) break;
      this.walking.pop();
      p.phase = "waiting";
      this.stations.get(p.legs[0].boardStationId)!.waiting.push(pid);
    }
  }

  private spawnDemand(): void {
    if (this.lines.size === 0) return; // nothing to ride yet
    const hour = Math.floor((this.simTimeSec % DAY_SEC) / 3600);
    const ratePerSec =
      (DAILY_TRIPS * (HOURLY_WEIGHT[hour] / HOURLY_SUM)) / 3600;
    this.spawnAccumulator += ratePerSec * SIM_DT;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      this.spawnTrip(hour);
    }
  }

  // Gravity-flavoured destination weight: mass × distance deterrence (§4.1.3
  // in spirit — the real doubly-constrained model arrives in Phase 2).
  private gravityWeight(origin: Zone, z: Zone, amBound: boolean): number {
    if (z.id === origin.id) return 0;
    const d = Math.hypot(
      z.center.x - origin.center.x,
      z.center.y - origin.center.y,
    );
    return (amBound ? z.jobs : z.pop) * Math.exp(-d / DEST_DETERRENCE_M);
  }

  /** One person-trip: home→work in the AM half, work→home in the PM half. */
  private spawnTrip(hour: number): void {
    const amBound = hour < 12;

    // TEMP demand-bootstrap hack (LOCAL_DEMAND_FRACTION, constants.ts) —
    // delete this branch when Phase 2's calibrated model lands.
    const useLocalPool =
      this.nearNetworkZoneIdx.length > 1 &&
      this.rng.next() < LOCAL_DEMAND_FRACTION;

    let origin: Zone;
    if (useLocalPool) {
      const li = this.sampleZone(amBound ? this.cumPopNear : this.cumJobsNear);
      if (li < 0) return;
      origin = this.zones[this.nearNetworkZoneIdx[li]];
    } else {
      const oi = this.sampleZone(amBound ? this.cumPop : this.cumJobs);
      if (oi < 0) return;
      origin = this.zones[oi];
    }

    let dest: Zone;
    if (useLocalPool) {
      const weights = this.nearNetworkZoneIdx.map((zi) =>
        this.gravityWeight(origin, this.zones[zi], amBound),
      );
      const li = this.rng.weightedIndex(weights);
      if (li < 0) return;
      dest = this.zones[this.nearNetworkZoneIdx[li]];
    } else {
      const weights = this.zones.map((z) =>
        this.gravityWeight(origin, z, amBound),
      );
      const di = this.rng.weightedIndex(weights);
      if (di < 0) return;
      dest = this.zones[di];
    }

    const cacheKey = `${origin.id}|${dest.id}`;
    let cached = this.planCache.get(cacheKey);
    if (cached === undefined) {
      const originAccess = this.stationsNear(origin.center);
      const destAccess = this.stationsNear(dest.center);
      const plan = this.planner.plan(originAccess, destAccess, this.lines);
      cached = plan
        ? {
            plan,
            walkSec:
              originAccess.find((a) => a.stationId === plan.boardStationId)
                ?.walkSec ?? 0,
          }
        : null;
      this.planCache.set(cacheKey, cached);
    }
    if (!cached) {
      this.kpis.unservedTrips++;
      return;
    }

    const id = this.nextPassengerId++;
    const p: Passenger = {
      id,
      phase: "walking-to-station",
      spawnedAt: this.simTimeSec,
      arrivesAtStationAt: this.simTimeSec + cached.walkSec,
      legs: cached.plan.legs,
      legIndex: 0,
    };
    this.passengers.set(id, p);
    // Insert keeping the array sorted by arrival time, earliest last.
    let i = this.walking.length;
    while (
      i > 0 &&
      this.passengers.get(this.walking[i - 1])!.arrivesAtStationAt <
        p.arrivesAtStationAt
    ) {
      i--;
    }
    this.walking.splice(i, 0, id);
  }

  /** TEMP (see LOCAL_DEMAND_FRACTION): recompute the near-network zone pool
   *  and its prefix sums. Call whenever stations change. */
  private rebuildNearNetworkZones(): void {
    this.nearNetworkZoneIdx = [];
    for (let i = 0; i < this.zones.length; i++) {
      if (this.stationsNear(this.zones[i].center).length > 0) {
        this.nearNetworkZoneIdx.push(i);
      }
    }
    this.cumPopNear = new Array(this.nearNetworkZoneIdx.length);
    this.cumJobsNear = new Array(this.nearNetworkZoneIdx.length);
    let p = 0;
    let j = 0;
    for (let k = 0; k < this.nearNetworkZoneIdx.length; k++) {
      const z = this.zones[this.nearNetworkZoneIdx[k]];
      p += z.pop;
      j += z.jobs;
      this.cumPopNear[k] = p;
      this.cumJobsNear[k] = j;
    }
  }

  private stationsNear(pos: Vec2): StationAccess[] {
    const out: StationAccess[] = [];
    for (const s of this.stations.values()) {
      const d = Math.hypot(s.pos.x - pos.x, s.pos.y - pos.y);
      if (d <= WALK_RADIUS) {
        out.push({ stationId: s.id, walkSec: d / WALK_SPEED });
      }
    }
    out.sort((a, b) => a.walkSec - b.walkSec);
    return out.slice(0, 3);
  }

  // ── Read-only view for render/UI ────────────────────────────────────

  snapshot(): SimSnapshot {
    return {
      simTimeSec: this.simTimeSec,
      day: Math.floor(this.simTimeSec / DAY_SEC) + 1,
      networkVersion: this.networkVersion,
      zones: this.zones,
      stations: this.stations,
      lines: this.lines,
      vehicles: this.vehicles,
      passengers: this.passengers,
      kpis: this.kpis,
    };
  }
}
