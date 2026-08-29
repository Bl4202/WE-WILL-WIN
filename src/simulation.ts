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
  LOCAL_DEMAND_FRACTION,
  SAME_STATION_M,
  SIM_DT,
  WALK_RADIUS,
  WALK_SPEED,
} from "./constants";
import { nextSpeed, runTimeSec } from "./kinematics";
import {
  BASE_FARE,
  DAILY_OPERATING_SUBSIDY,
  FACILITY_SPECS,
  STARTING_CAPITAL,
  STARTING_OPERATING_BALANCE,
  estimateLineConstruction,
  facilityBuildCost,
  getRollingStockSpec,
  getTransitModeSpec,
  normalizeAlignment,
} from "./mobility";
import {
  TransitPlanner,
  type PlannedTrip,
  type StationAccess,
} from "./pathfinding";
import { Rng } from "./rng";
import type {
  ConstructionEstimate,
  EconomyState,
  EnvironmentState,
  FacilityType,
  Kpis,
  Line,
  MobilityFacility,
  Passenger,
  RailAlignment,
  RollingStockModelId,
  ServiceDirection,
  SimSnapshot,
  Station,
  TrafficState,
  TransitMode,
  Vec2,
  Vehicle,
  Zone,
} from "./types";

/** A point of a committed line: either a brand-new station or an existing one. */
export interface LinePoint {
  pos: Vec2;
  existingStationId?: number;
  /** Exact centreline from the previous stop. Used by road-routed bus lines. */
  pathFromPrevious?: Vec2[];
  /** Real building footprints crossed by the segment from the previous stop. */
  demolitionSitesFromPrevious?: Vec2[];
  demolitionFeatureIdsFromPrevious?: Array<string | number>;
  /** Alignment of the segment from the previous point to this point. */
  alignmentFromPrevious?: RailAlignment;
  /** Metres relative to street level for the segment from the previous point. */
  levelMFromPrevious?: number;
}

/** Relative trip-emission weight per hour of day (AM peak, midday, PM peak). */
const HOURLY_WEIGHT = [
  0.2, 0.1, 0.1, 0.1, 0.3, 1.0, 3.0, 6.5, 6.0, 3.0, 2.0, 2.2, // 00–11
  2.5, 2.2, 2.0, 2.5, 4.5, 6.5, 5.5, 3.0, 2.0, 1.5, 1.0, 0.5, // 12–23
] as const;
const HOURLY_SUM = HOURLY_WEIGHT.reduce((a, b) => a + b, 0);
const PEAK_HOURLY_WEIGHT = Math.max(...HOURLY_WEIGHT);
const DESTINATION_CANDIDATES = 48;

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
  readonly facilities: MobilityFacility[];
  readonly economy: EconomyState = {
    capitalBalance: STARTING_CAPITAL,
    operatingBalance: STARTING_OPERATING_BALANCE,
    constructionSpent: 0,
    fleetSpent: 0,
    fareRevenueToday: 0,
    subsidyToday: 0,
    operatingCostToday: 0,
    energyCostToday: 0,
    maintenanceCostToday: 0,
    netCashflowToday: 0,
    projectedDailyCashflow: DAILY_OPERATING_SUBSIDY,
  };
  readonly environment: EnvironmentState = {
    networkNoiseIndex: 0,
    residentsExposedToNoise: 0,
    demolishedBuildings: 0,
    electricityKwhToday: 0,
    dieselLitersToday: 0,
    emissionsKgToday: 0,
  };
  readonly traffic: TrafficState = {
    congestionIndex: 48,
    carTripsToday: 0,
    avoidedCarTripsToday: 0,
    transitShare: 0,
    connectedGateways: 0,
    totalGateways: 0,
  };

  private simTimeSec = 5 * 3600; // day 1, 05:00 — just before the AM peak
  private readonly rng = new Rng(0xc0ffee);
  private readonly planner = new TransitPlanner();
  private spawnAccumulator = 0;
  /** Passenger ids in walk-access, sorted by arrival time (earliest last). */
  private walking: number[] = [];
  private networkVersion = 0;
  private mobilityVersion = 0;
  private trafficAccumulator = 0;
  private economyDayStartedAt = this.simTimeSec;

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
  private nextFacilityId: number;

  private kpis: Kpis = {
    boardingsToday: 0,
    boardingsYesterday: 0,
    completedTrips: 0,
    unservedTrips: 0,
  };

  constructor(zones: Zone[], facilities: MobilityFacility[] = []) {
    this.zones = zones;
    this.facilities = facilities.map((facility) => ({
      ...facility,
      pos: { ...facility.pos },
    }));
    this.nextFacilityId =
      this.facilities.reduce((max, facility) => Math.max(max, facility.id), 0) +
      1;
    this.traffic.totalGateways = this.facilities.filter(
      (facility) => facility.connectsOutside,
    ).length;
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
    this.recalculateTraffic();
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

  estimateLine(
    points: LinePoint[],
    mode: TransitMode,
    alignment: RailAlignment,
  ): ConstructionEstimate {
    return estimateLineConstruction(
      points,
      mode,
      normalizeAlignment(mode, alignment),
    );
  }

  /** Commit a drawn service. Returns null if invalid or over budget. */
  commitLine(
    points: LinePoint[],
    mode: TransitMode = "metro",
    alignment: RailAlignment = "surface",
    direction: ServiceDirection = "bidirectional",
  ): Line | null {
    if (points.length < 2) return null;
    if (
      points.some(
        (point) =>
          point.existingStationId !== undefined &&
          !this.stations.has(point.existingStationId),
      )
    ) {
      return null;
    }

    const resolvedFallbackAlignment = normalizeAlignment(mode, alignment);
    const segmentAlignments = points.slice(1).map((point) =>
      normalizeAlignment(
        mode,
        point.alignmentFromPrevious ?? resolvedFallbackAlignment,
      ),
    );
    const resolvedAlignment = segmentAlignments.every(
      (segment) => segment === "underground",
    )
      ? "underground"
      : segmentAlignments.every((segment) => segment === "surface")
        ? "surface"
        : "mixed";
    const estimate = this.estimateLine(points, mode, resolvedFallbackAlignment);
    if (
      estimate.lengthM < SAME_STATION_M ||
      estimate.totalCost > this.economy.capitalBalance
    ) {
      return null;
    }

    const stationIds: number[] = [];
    // Stations minted by this very call, so a line that loops back onto its
    // own starting point reuses that station instead of stacking a second one
    // on the same spot (the draft's points are not Stations yet, so they
    // arrive here as repeated coordinates rather than repeated ids).
    const minted: { pos: Vec2; id: number }[] = [];
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const p = points[pointIndex];
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
      const adjacentDetails = [
        estimate.segmentDetails[pointIndex - 1],
        estimate.segmentDetails[pointIndex],
      ].filter((detail) => detail !== undefined);
      const primaryAlignment: RailAlignment = adjacentDetails.some(
        (detail) => detail.alignment === "underground",
      )
        ? "underground"
        : adjacentDetails.some((detail) => detail.alignment === "elevated")
          ? "elevated"
          : "surface";
      const matchingLevels = adjacentDetails
        .filter((detail) => detail.alignment === primaryAlignment)
        .map((detail) => detail.levelM);
      const levelM =
        matchingLevels.length > 0
          ? matchingLevels.reduce((sum, value) => sum + value, 0) /
            matchingLevels.length
          : 0;
      this.stations.set(id, {
        id,
        name: this.stationNameFor(p.pos, id),
        pos: { ...p.pos },
        primaryAlignment,
        levelM,
        platformLengthM:
          mode === "regional-rail" ? 240 : mode === "metro" ? 180 : 28,
        platformCount: direction === "bidirectional" ? 2 : 1,
        entrances:
          primaryAlignment === "underground" ? 3 : primaryAlignment === "elevated" ? 2 : 1,
        boardingsToday: 0,
        lineIds: [],
        waiting: [],
      });
      minted.push({ pos: { ...p.pos }, id });
      stationIds.push(id);
    }

    const stationDist: number[] = [0];
    for (let i = 1; i < stationIds.length; i++) {
      stationDist.push(
        stationDist[i - 1] + estimate.segmentDetails[i - 1].lengthM,
      );
    }

    const id = this.nextLineId++;
    const modeSpec = getTransitModeSpec(mode, resolvedAlignment);
    const line: Line = {
      id,
      name: `${modeSpec.shortLabel} ${id}`,
      color: LINE_COLORS[(id - 1) % LINE_COLORS.length],
      mode,
      alignment: resolvedAlignment,
      direction,
      segmentAlignments,
      segmentDetails: estimate.segmentDetails,
      constructionCost: estimate.totalCost,
      stationIds,
      stationDist,
      length: stationDist[stationDist.length - 1],
      targetHeadwaySec: DEFAULT_HEADWAY_SEC,
      headwaySec: 0,
      vehicleIds: [],
      stats: {
        boardingsToday: 0,
        revenueToday: 0,
        energyCostToday: 0,
        maintenanceCostToday: 0,
        energyUsedToday: 0,
      },
    };
    this.lines.set(id, line);
    this.economy.capitalBalance -= estimate.totalCost;
    this.economy.constructionSpent += estimate.totalCost;
    for (const sid of stationIds) {
      const st = this.stations.get(sid)!;
      if (!st.lineIds.includes(id)) st.lineIds.push(id);
    }

    this.planner.rebuild(this.lines, this.stations);
    this.planCache.clear();
    this.rebuildNearNetworkZones(); // TEMP — see LOCAL_DEMAND_FRACTION
    this.recomputeFacilityConnections();
    this.recalculateEnvironment();
    this.networkVersion++;
    return line;
  }

  buildFacility(type: FacilityType, pos: Vec2): MobilityFacility | null {
    const spec = FACILITY_SPECS[type];
    const cost = facilityBuildCost(type);
    if (cost > this.economy.capitalBalance) return null;

    if (
      this.facilities.some(
        (facility) =>
          Math.hypot(facility.pos.x - pos.x, facility.pos.y - pos.y) <
          (type === "airport" && facility.type === "airport" ? 8_000 : 1_000),
      )
    ) {
      return null;
    }

    const number =
      this.facilities.filter(
        (facility) => facility.type === type && !facility.builtIn,
      ).length + 1;
    const facility: MobilityFacility = {
      id: this.nextFacilityId++,
      type,
      name: `New ${spec.label} ${number}`,
      pos: { ...pos },
      builtIn: false,
      connectsOutside: spec.connectsOutside,
      connected: false,
      constructionCost: cost,
      catchmentM: spec.catchmentM,
      trafficRelief: spec.trafficRelief,
      dailyCapacity: spec.dailyCapacity,
    };
    this.facilities.push(facility);
    this.economy.capitalBalance -= cost;
    this.economy.constructionSpent += cost;
    this.traffic.totalGateways = this.facilities.filter(
      (item) => item.connectsOutside,
    ).length;
    this.recomputeFacilityConnections();
    this.mobilityVersion++;
    return facility;
  }

  /** Buy one physical vehicle into the unassigned fleet pool. */
  purchaseVehicle(modelId: RollingStockModelId): Vehicle | null {
    const stock = getRollingStockSpec(modelId);
    if (stock.purchaseCost > this.economy.capitalBalance) {
      return null;
    }
    const vehicleId = this.nextVehicleId++;
    const vehicle: Vehicle = {
      id: vehicleId,
      lineId: null,
      modelId,
      name: `${stock.name} ${vehicleId}`,
      capacity: stock.capacity,
      purchaseCost: stock.purchaseCost,
      energyType: stock.energyType,
      energyPerKm: stock.energyPerKm,
      noiseDb: stock.noiseDb,
      reliabilityPct: stock.reliabilityPct,
      conditionPct: 100,
      distanceTodayM: 0,
      lifetimeDistanceM: 0,
      energyUsedToday: 0,
      dist: 0,
      prevDist: 0,
      speed: 0,
      dir: 1,
      state: "dwelling",
      dwellRemaining: 0,
      atStationIdx: 0,
      onboard: [],
    };
    this.vehicles.push(vehicle);
    this.economy.capitalBalance -= stock.purchaseCost;
    this.economy.fleetSpent += stock.purchaseCost;
    this.networkVersion++;
    return vehicle;
  }

  assignVehicle(vehicleId: number, lineId: number): boolean {
    const vehicle = this.vehicles.find((item) => item.id === vehicleId);
    const line = this.lines.get(lineId);
    if (
      !vehicle ||
      !line ||
      vehicle.lineId !== null ||
      getRollingStockSpec(vehicle.modelId).mode !== line.mode
    ) {
      return false;
    }
    const fleetIndex = line.vehicleIds.length;
    const startsInbound =
      line.direction === "bidirectional" && fleetIndex % 2 === 1;
    vehicle.lineId = line.id;
    vehicle.dist = startsInbound ? line.length : 0;
    vehicle.prevDist = vehicle.dist;
    vehicle.speed = 0;
    vehicle.dir = startsInbound ? -1 : 1;
    vehicle.state = "dwelling";
    vehicle.atStationIdx = startsInbound ? line.stationIds.length - 1 : 0;
    vehicle.dwellRemaining = getTransitModeSpec(
      line.mode,
      line.alignment,
    ).dwellSec;
    line.vehicleIds.push(vehicle.id);
    this.updateLineHeadway(line);
    this.planner.rebuild(this.lines, this.stations);
    this.planCache.clear();
    this.recalculateEnvironment();
    this.networkVersion++;
    return true;
  }

  unassignVehicle(vehicleId: number): boolean {
    const vehicle = this.vehicles.find((item) => item.id === vehicleId);
    if (!vehicle || vehicle.lineId === null) return false;
    const line = this.lines.get(vehicle.lineId);
    if (!line) return false;
    const station = this.stations.get(line.stationIds[vehicle.atStationIdx]);
    const strandedIds = vehicle.onboard.slice();
    vehicle.onboard = [];
    line.vehicleIds = line.vehicleIds.filter((id) => id !== vehicle.id);
    vehicle.lineId = null;
    vehicle.dist = 0;
    vehicle.prevDist = 0;
    vehicle.speed = 0;
    vehicle.state = "dwelling";
    vehicle.dwellRemaining = 0;
    vehicle.atStationIdx = 0;
    this.updateLineHeadway(line);
    this.planner.rebuild(this.lines, this.stations);
    this.planCache.clear();
    // Rebuild the planner BEFORE re-routing the people this vehicle was
    // carrying, so they are re-planned against the network as it now is —
    // without their old line if that was its last vehicle.
    this.rerouteStranded(strandedIds, station);
    this.recalculateEnvironment();
    this.networkVersion++;
    return true;
  }

  /**
   * Re-plan passengers put off a vehicle mid-journey.
   *
   * Dropping them at a platform still holding legs on the line they were
   * just removed from leaves them waiting for a train that may never come:
   * they never alight, never complete, and never leave `this.passengers` —
   * an unbounded leak that also permanently inflates the active-passenger
   * count. Their final destination is the last leg's alighting station, so
   * the remainder of the journey is re-planned from where they now stand.
   * Anyone the network can no longer serve is dropped and counted unserved,
   * which is what the KPI means.
   */
  private rerouteStranded(
    passengerIds: number[],
    station: Station | undefined,
  ): void {
    for (const passengerId of passengerIds) {
      const passenger = this.passengers.get(passengerId);
      if (!passenger) continue;
      const finalLeg = passenger.legs[passenger.legs.length - 1];
      const destinationId = finalLeg?.alightStationId;

      if (station && destinationId !== undefined) {
        if (destinationId === station.id) {
          this.passengers.delete(passengerId);
          this.kpis.completedTrips++;
          continue;
        }
        const replanned = this.planner.plan(
          [{ stationId: station.id, walkSec: 0 }],
          [{ stationId: destinationId, walkSec: 0 }],
          this.lines,
        );
        if (replanned) {
          passenger.legs = replanned.legs;
          passenger.legIndex = 0;
          passenger.phase = "waiting";
          station.waiting.push(passengerId);
          continue;
        }
      }
      this.passengers.delete(passengerId);
      this.kpis.unservedTrips++;
    }
  }

  private updateLineHeadway(line: Line): void {
    if (line.vehicleIds.length === 0) {
      line.headwaySec = 0;
      return;
    }
    const fleet = line.vehicleIds
      .map((id) => this.vehicles.find((vehicle) => vehicle.id === id))
      .filter((vehicle): vehicle is Vehicle => vehicle !== undefined);
    const averageTopSpeedMps =
      fleet.reduce(
        (sum, vehicle) =>
          sum + getRollingStockSpec(vehicle.modelId).maxSpeedKph / 3.6,
        0,
      ) / Math.max(1, fleet.length);
    const mode = getTransitModeSpec(line.mode, line.alignment);
    let oneWaySec = line.stationIds.length * mode.dwellSec;
    for (let i = 1; i < line.stationDist.length; i++) {
      const limit = (line.segmentDetails[i - 1]?.speedLimitKph ?? 90) / 3.6;
      oneWaySec +=
        runTimeSec(
          line.stationDist[i] - line.stationDist[i - 1],
          Math.min(averageTopSpeedMps, limit),
        ) / mode.speedFactor;
    }
    const cycleSec =
      line.direction === "bidirectional"
        ? oneWaySec * 2
        : oneWaySec * 1.55;
    line.headwaySec = Math.max(
      90,
      Math.round(cycleSec / Math.max(1, fleet.length)),
    );
  }

  private stationNameFor(pos: Vec2, id: number): string {
    const anchors = [
      { name: "Central", x: 0, y: 0 },
      { name: "Midtown", x: 0, y: -2_400 },
      { name: "Museum District", x: 500, y: -4_400 },
      { name: "Montrose", x: -3_200, y: -1_000 },
      { name: "The Heights", x: -2_000, y: 5_000 },
      { name: "EaDo", x: 2_800, y: -600 },
      { name: "East End", x: 5_500, y: -1_600 },
      { name: "Uptown", x: -10_000, y: -1_800 },
      { name: "Medical Center", x: 1_000, y: -7_000 },
    ];
    let nearest = anchors[0];
    let nearestDistance = Infinity;
    for (const anchor of anchors) {
      const distance = Math.hypot(pos.x - anchor.x, pos.y - anchor.y);
      if (distance < nearestDistance) {
        nearest = anchor;
        nearestDistance = distance;
      }
    }
    const duplicate = [...this.stations.values()].filter((station) =>
      station.name.startsWith(nearest.name),
    ).length;
    return nearestDistance < 7_500
      ? `${nearest.name}${duplicate > 0 ? ` ${duplicate + 1}` : ""}`
      : `Houston ${String(id).padStart(2, "0")}`;
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
      this.economy.fareRevenueToday = 0;
      this.economy.subsidyToday = 0;
      this.economy.operatingCostToday = 0;
      this.economy.energyCostToday = 0;
      this.economy.maintenanceCostToday = 0;
      this.economy.netCashflowToday = 0;
      this.economy.projectedDailyCashflow = 0;
      this.economyDayStartedAt = this.simTimeSec;
      this.environment.electricityKwhToday = 0;
      this.environment.dieselLitersToday = 0;
      this.environment.emissionsKgToday = 0;
      for (const station of this.stations.values()) {
        station.boardingsToday = 0;
      }
      for (const line of this.lines.values()) {
        line.stats.boardingsToday = 0;
        line.stats.revenueToday = 0;
        line.stats.energyCostToday = 0;
        line.stats.maintenanceCostToday = 0;
        line.stats.energyUsedToday = 0;
      }
      for (const vehicle of this.vehicles) {
        vehicle.distanceTodayM = 0;
        vehicle.energyUsedToday = 0;
      }
      this.traffic.carTripsToday = 0;
      this.traffic.avoidedCarTripsToday = 0;
    }

    this.moveVehicles();
    this.finishWalks();
    this.spawnDemand();
    this.accrueOperatingCosts();
    this.trafficAccumulator += SIM_DT;
    if (this.trafficAccumulator >= 30) {
      this.trafficAccumulator -= 30;
      this.recalculateTraffic();
    }
  }

  private moveVehicles(): void {
    for (const v of this.vehicles) {
      if (v.lineId === null) continue;
      const line = this.lines.get(v.lineId);
      if (!line) continue;
      const modeSpec = getTransitModeSpec(line.mode, line.alignment);
      const stock = getRollingStockSpec(v.modelId);
      // Where this tick started, so the renderer can interpolate across it
      // (the sim ticks at 4 Hz; the screen refreshes far faster).
      v.prevDist = v.dist;
      if (v.state === "dwelling") {
        v.dwellRemaining -= SIM_DT;
        if (v.dwellRemaining <= 0) {
          if (
            line.direction === "one-way" &&
            v.atStationIdx === line.stationIds.length - 1
          ) {
            // A one-way service deadheads back to its origin off-map. The
            // movement is not rendered, but its energy and maintenance are.
            this.consumeVehicleEnergy(v, line, line.length * 0.55);
            v.dist = 0;
            v.prevDist = 0;
            v.atStationIdx = 0;
            v.dir = 1;
            v.dwellRemaining = modeSpec.dwellSec;
            this.handleStationStop(v, line);
          } else {
            v.state = "running";
          }
        }
        continue;
      }

      const nextIdx = v.atStationIdx + v.dir;
      if (nextIdx < 0 || nextIdx >= line.stationIds.length) {
        // Facing off the end of the line — turn around. Reversing (rather
        // than just clamping) matters: with no stop ahead there is nothing
        // to advance toward, so a train left pointing outward would sit
        // here forever instead of resuming service.
        v.dir = line.direction === "one-way" ? 1 : v.dir === 1 ? -1 : 1;
        v.speed = 0;
        v.dist = Math.max(0, Math.min(line.length, v.dist));
        continue;
      }

      // Accelerate to the midpoint, then brake into the platform (see
      // kinematics.ts). `dir` flips only at terminals, so the next station is
      // always ahead, and the hop it belongs to sets the train's top speed.
      const marker = line.stationDist[nextIdx];
      const hopLen = Math.abs(marker - line.stationDist[v.atStationIdx]);
      const segmentIndex = Math.min(v.atStationIdx, nextIdx);
      const trackLimitMps =
        (line.segmentDetails[segmentIndex]?.speedLimitKph ?? 90) / 3.6;
      v.speed = nextSpeed(
        v.speed,
        (marker - v.dist) * v.dir,
        hopLen,
        Math.min(stock.maxSpeedKph / 3.6, trackLimitMps),
      );
      const trafficFactor = Math.max(
        0.42,
        1 -
          modeSpec.congestionExposure *
            (this.traffic.congestionIndex / 135),
      );
      const before = v.dist;
      v.dist +=
        v.dir * v.speed * modeSpec.speedFactor * trafficFactor * SIM_DT;
      this.consumeVehicleEnergy(v, line, Math.abs(v.dist - before));

      const arrived = v.dir === 1 ? v.dist >= marker : v.dist <= marker;
      if (arrived) {
        v.dist = marker;
        v.speed = 0;
        v.atStationIdx = nextIdx;
        v.state = "dwelling";
        v.dwellRemaining = modeSpec.dwellSec;
        const failureChance =
          ((100 - v.reliabilityPct) + (100 - v.conditionPct) * 0.15) /
          25_000;
        if (this.rng.next() < failureChance) {
          v.dwellRemaining += 90 + this.rng.next() * 210;
        }
        this.handleStationStop(v, line);
      }
    }
  }

  private consumeVehicleEnergy(
    vehicle: Vehicle,
    line: Line,
    distanceM: number,
  ): void {
    if (distanceM <= 0) return;
    const stock = getRollingStockSpec(vehicle.modelId);
    const units = (distanceM / 1_000) * stock.energyPerKm;
    const cost = units * stock.energyCostPerUnit;
    vehicle.distanceTodayM += distanceM;
    vehicle.lifetimeDistanceM += distanceM;
    vehicle.energyUsedToday += units;
    vehicle.conditionPct = Math.max(
      45,
      vehicle.conditionPct - (distanceM / 1_000) * 0.00014,
    );
    line.stats.energyUsedToday += units;
    line.stats.energyCostToday += cost;
    this.economy.energyCostToday += cost;
    this.economy.operatingCostToday += cost;
    this.economy.operatingBalance -= cost;
    if (stock.energyType === "electricity") {
      this.environment.electricityKwhToday += units;
      this.environment.emissionsKgToday += units * 0.36;
    } else {
      this.environment.dieselLitersToday += units;
      this.environment.emissionsKgToday += units * 2.68;
    }
  }

  /** Alight, flip at terminals, then board — capacity-constrained. */
  private handleStationStop(v: Vehicle, line: Line): void {
    const stationId = line.stationIds[v.atStationIdx];
    const station = this.stations.get(stationId)!;
    const capacity = v.capacity;

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
    else if (
      v.atStationIdx === line.stationIds.length - 1 &&
      line.direction === "bidirectional"
    ) {
      v.dir = -1;
    }

    // 3 · Board, up to crush capacity; the rest are left behind to wait.
    const stillWaiting: number[] = [];
    for (const pid of station.waiting) {
      const p = this.passengers.get(pid)!;
      const leg = p.legs[p.legIndex];
      const wants =
        leg.lineId === line.id &&
        leg.boardStationId === stationId &&
        leg.dir === v.dir;
      if (wants && v.onboard.length < capacity) {
        p.phase = "riding";
        v.onboard.push(pid);
        this.kpis.boardingsToday++;
        station.boardingsToday++;
        line.stats.boardingsToday++;
        line.stats.revenueToday += BASE_FARE;
        this.economy.fareRevenueToday += BASE_FARE;
        this.economy.operatingBalance += BASE_FARE;
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
    const hour = Math.floor((this.simTimeSec % DAY_SEC) / 3600);
    const ratePerSec =
      (DAILY_TRIPS * (HOURLY_WEIGHT[hour] / HOURLY_SUM)) / 3600;
    this.spawnAccumulator += ratePerSec * SIM_DT;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      this.spawnTrip(hour);
    }
  }

  /**
   * Importance-sample a bounded destination set from the population/job
   * prefix sums, then apply distance deterrence inside that set. This keeps
   * each trip O(DESTINATION_CANDIDATES) instead of scanning every tract.
   */
  private sampleDestination(
    origin: Zone,
    amBound: boolean,
    useLocalPool: boolean,
  ): Zone | null {
    const cumulative = useLocalPool
      ? amBound
        ? this.cumJobsNear
        : this.cumPopNear
      : amBound
        ? this.cumJobs
        : this.cumPop;
    const candidates: Zone[] = [];
    const weights: number[] = [];
    for (let i = 0; i < DESTINATION_CANDIDATES; i++) {
      const sampled = this.sampleZone(cumulative);
      if (sampled < 0) continue;
      const zone = useLocalPool
        ? this.zones[this.nearNetworkZoneIdx[sampled]]
        : this.zones[sampled];
      if (zone.id === origin.id) continue;
      const distance = Math.hypot(
        zone.center.x - origin.center.x,
        zone.center.y - origin.center.y,
      );
      candidates.push(zone);
      // Population/jobs already shaped the importance sample.
      weights.push(Math.exp(-distance / DEST_DETERRENCE_M));
    }
    const picked = this.rng.weightedIndex(weights);
    return picked < 0 ? null : candidates[picked];
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

    const dest = this.sampleDestination(origin, amBound, useLocalPool);
    if (!dest) {
      // Every one of the bounded importance samples landed back on the
      // origin zone — likeliest when the near-network pool is tiny. The
      // trip was still generated, so it has to be counted: returning
      // silently here made transit share read optimistically high.
      this.kpis.unservedTrips++;
      this.traffic.carTripsToday++;
      return;
    }
    if (this.lines.size === 0) {
      this.kpis.unservedTrips++;
      this.traffic.carTripsToday++;
      return;
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
      this.traffic.carTripsToday++;
      return;
    }
    this.traffic.avoidedCarTripsToday++;

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

  private recomputeFacilityConnections(): void {
    let changed = false;
    for (const facility of this.facilities) {
      let connected = false;
      for (const station of this.stations.values()) {
        if (
          Math.hypot(
            station.pos.x - facility.pos.x,
            station.pos.y - facility.pos.y,
          ) <= facility.catchmentM
        ) {
          connected = true;
          break;
        }
      }
      if (connected !== facility.connected) {
        facility.connected = connected;
        changed = true;
      }
    }
    if (changed) this.mobilityVersion++;
    this.recalculateTraffic();
  }

  private accrueOperatingCosts(): void {
    let maintenanceThisTick = 0;
    for (const vehicle of this.vehicles) {
      if (vehicle.lineId === null) continue;
      const line = this.lines.get(vehicle.lineId);
      if (!line) continue;
      const stock = getRollingStockSpec(vehicle.modelId);
      const hourlyCost =
        getTransitModeSpec(line.mode, line.alignment)
          .operatingCostPerVehicleHour + stock.maintenanceCostPerHour;
      const cost = (hourlyCost * SIM_DT) / 3600;
      maintenanceThisTick += cost;
      line.stats.maintenanceCostToday += cost;
    }
    for (const line of this.lines.values()) {
      const infrastructureCost =
        (((line.constructionCost * 0.015) / (365 * 24)) * SIM_DT) / 3600;
      maintenanceThisTick += infrastructureCost;
      line.stats.maintenanceCostToday += infrastructureCost;
    }
    for (const facility of this.facilities) {
      if (!facility.builtIn) {
        maintenanceThisTick +=
          (((facility.constructionCost * 0.025) / (365 * 24)) * SIM_DT) /
          3600;
      }
    }

    this.economy.maintenanceCostToday += maintenanceThisTick;
    this.economy.operatingCostToday += maintenanceThisTick;
    this.economy.operatingBalance -= maintenanceThisTick;

    const subsidyThisTick = (DAILY_OPERATING_SUBSIDY * SIM_DT) / DAY_SEC;
    this.economy.subsidyToday += subsidyThisTick;
    this.economy.operatingBalance += subsidyThisTick;
    this.economy.netCashflowToday =
      this.economy.fareRevenueToday +
      this.economy.subsidyToday -
      this.economy.operatingCostToday;
    const elapsed = Math.max(300, this.simTimeSec - this.economyDayStartedAt);
    this.economy.projectedDailyCashflow =
      (this.economy.netCashflowToday / elapsed) * DAY_SEC;
  }

  private recalculateEnvironment(): void {
    let totalLength = 0;
    let weightedNoise = 0;
    let demolitions = 0;
    for (const line of this.lines.values()) {
      for (const detail of line.segmentDetails) {
        totalLength += detail.lengthM;
        weightedNoise += detail.lengthM * detail.noiseDb;
        demolitions += detail.demolishedBuildings;
      }
    }
    const trackNoise = totalLength > 0 ? weightedNoise / totalLength : 28;
    const activeFleet = this.vehicles.filter(
      (vehicle) => vehicle.lineId !== null,
    );
    const fleetNoise =
      activeFleet.length > 0
        ? activeFleet.reduce((sum, vehicle) => sum + vehicle.noiseDb, 0) /
          activeFleet.length
        : 0;
    const combinedNoise =
      activeFleet.length > 0 ? trackNoise * 0.72 + fleetNoise * 0.28 : trackNoise;
    this.environment.networkNoiseIndex = Math.round(
      Math.max(0, Math.min(100, ((combinedNoise - 28) / 62) * 100)),
    );
    this.environment.residentsExposedToNoise = Math.round(
      (totalLength / 1_000) * Math.max(0, combinedNoise - 48) * 72,
    );
    this.environment.demolishedBuildings = demolitions;
  }

  private recalculateTraffic(): void {
    const totalTrips =
      this.traffic.carTripsToday + this.traffic.avoidedCarTripsToday;
    const share =
      totalTrips > 0 ? this.traffic.avoidedCarTripsToday / totalTrips : 0;
    const connectedFacilities = this.facilities.filter(
      (facility) => facility.connected,
    );
    const facilityRelief = Math.min(
      0.28,
      connectedFacilities.reduce(
        (sum, facility) => sum + facility.trafficRelief,
        0,
      ),
    );
    const outsideFacilities = this.facilities.filter(
      (facility) => facility.connectsOutside,
    );
    const outsideCapacity = outsideFacilities.reduce(
      (sum, facility) => sum + facility.dailyCapacity,
      0,
    );
    const unconnectedOutsideCapacity = outsideFacilities.reduce(
      (sum, facility) =>
        sum + (facility.connected ? 0 : facility.dailyCapacity),
      0,
    );
    const gatewayPressure =
      outsideCapacity > 0
        ? (unconnectedOutsideCapacity / outsideCapacity) * 12
        : 0;
    const hour = Math.floor((this.simTimeSec % DAY_SEC) / 3600);
    const peak = HOURLY_WEIGHT[hour] / PEAK_HOURLY_WEIGHT;
    const unconstrained = 48 + peak * 48 + gatewayPressure;
    this.traffic.transitShare = share;
    this.traffic.connectedGateways = connectedFacilities.filter(
      (facility) => facility.connectsOutside,
    ).length;
    this.traffic.congestionIndex = Math.round(
      Math.max(
        12,
        Math.min(100, unconstrained * (1 - share * 0.58 - facilityRelief)),
      ),
    );
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
      facilities: this.facilities,
      mobilityVersion: this.mobilityVersion,
      economy: this.economy,
      environment: this.environment,
      traffic: this.traffic,
      kpis: this.kpis,
    };
  }
}
