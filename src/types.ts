/**
 * Core data model for the Phase-0 "Dots on Lines" prototype (GDD §8, Phase 0).
 *
 * Deliberately small: zones with pop/jobs (the demand seed), player-drawn
 * lines and stations, vehicles as dots on schedules, and passengers as
 * lightweight records that spawn, wait, board, and alight.
 */

/** World coordinates are metres in a flat city plane. */
export interface Vec2 {
  x: number;
  y: number;
}

/** A demand cell — a census tract from the baked world bundle (GDD §1.4). */
export interface Zone {
  id: number;
  /** 11-digit census tract GEOID. */
  geoid: string;
  lat: number;
  lng: number;
  /** Cell centre in local planar metres (see geo.ts). */
  center: Vec2;
  /** Residents — trip productions in the AM, attractions in the PM. */
  pop: number;
  /** Employment — trip attractions in the AM, productions in the PM. */
  jobs: number;
}

export interface Station {
  id: number;
  name: string;
  pos: Vec2;
  /** Dominant engineering form of the station's first platforms. */
  primaryAlignment: RailAlignment;
  /** Metres relative to street level: negative underground, positive elevated. */
  levelM: number;
  platformLengthM: number;
  /**
   * Angle of the platform's long axis in the planar metre frame, radians.
   * Chosen by the player while drafting, so it is stored rather than guessed
   * from the track at render time.
   */
  orientationRad: number;
  platformCount: number;
  entrances: number;
  boardingsToday: number;
  /** Lines serving this station (enables transfers at shared stations). */
  lineIds: number[];
  /** Passengers currently waiting here, by id. */
  waiting: number[];
}

export type TransitMode = "metro" | "bus" | "regional-rail";
export type RailAlignment = "surface" | "elevated" | "underground";
export type LineAlignment = RailAlignment | "mixed";
export type ServiceDirection = "bidirectional" | "one-way";
export type FacilityType = "bus-hub" | "rail-terminal" | "airport" | "harbor";
export type EnergyType = "electricity" | "diesel";
export type RollingStockModelId =
  | "metro-nova-m7"
  | "metro-quietline-q2"
  | "metro-titan-x"
  | "bus-ecity-12"
  | "bus-artic-d"
  | "rail-arrow-emu"
  | "rail-bilevel-d";

export interface TrackSegmentDetail {
  index: number;
  alignment: RailAlignment;
  /** Exact engineered centreline. Bus segments follow the street network. */
  path: Vec2[];
  /** Metres relative to street level. */
  levelM: number;
  lengthM: number;
  speedLimitKph: number;
  constructionCost: number;
  demolitionCost: number;
  demolishedBuildings: number;
  /** Representative wayside sound level after depth/structure mitigation. */
  noiseDb: number;
  /** Deterministic clearance sites rendered as construction/demolition scars. */
  demolitionSites: Vec2[];
  /** Vector-tile feature ids removed from the 3D building layer after opening. */
  demolishedBuildingFeatureIds: Array<string | number>;
}

export interface LineOperatingStats {
  boardingsToday: number;
  revenueToday: number;
  energyCostToday: number;
  maintenanceCostToday: number;
  energyUsedToday: number;
}

export interface Line {
  id: number;
  name: string;
  color: string;
  mode: TransitMode;
  alignment: LineAlignment;
  direction: ServiceDirection;
  /** Alignment for every edge from station i to station i + 1. */
  segmentAlignments: RailAlignment[];
  segmentDetails: TrackSegmentDetail[];
  /** One-time capital cost charged when this line was committed. */
  constructionCost: number;
  /** Ordered station ids along the alignment. */
  stationIds: number[];
  /** Cumulative distance (m) from the first station to each station. */
  stationDist: number[];
  /** Total one-way length in metres. */
  length: number;
  /** Desired scheduled headway between departures, seconds. */
  targetHeadwaySec: number;
  /** Achievable headway from the assigned fleet. Zero means no service. */
  headwaySec: number;
  /**
   * Mean free-flow top speed of the assigned fleet, m/s. Kept on the line so
   * the journey planner prices rides at the speed the stock actually runs
   * rather than falling back to the generic metro maximum.
   */
  topSpeedMps: number;
  vehicleIds: number[];
  stats: LineOperatingStats;
}

export interface ConstructionEstimate {
  trackCost: number;
  stationCost: number;
  systemsCost: number;
  demolitionCost: number;
  totalCost: number;
  lengthM: number;
  newStations: number;
  demolishedBuildings: number;
  averageNoiseDb: number;
  averageDepthM: number;
  segmentDetails: TrackSegmentDetail[];
}

export interface MobilityFacility {
  id: number;
  type: FacilityType;
  name: string;
  code?: string;
  pos: Vec2;
  /** Real-world facilities exist at scenario start and cost the player $0. */
  builtIn: boolean;
  connectsOutside: boolean;
  connected: boolean;
  constructionCost: number;
  catchmentM: number;
  trafficRelief: number;
  dailyCapacity: number;
}

export interface EconomyState {
  capitalBalance: number;
  operatingBalance: number;
  constructionSpent: number;
  fleetSpent: number;
  fareRevenueToday: number;
  subsidyToday: number;
  operatingCostToday: number;
  energyCostToday: number;
  maintenanceCostToday: number;
  netCashflowToday: number;
  /** Current run-rate, projected over a full day. */
  projectedDailyCashflow: number;
}

export interface EnvironmentState {
  /** Weighted network wayside noise on a 0-100 planning scale. */
  networkNoiseIndex: number;
  residentsExposedToNoise: number;
  demolishedBuildings: number;
  electricityKwhToday: number;
  dieselLitersToday: number;
  emissionsKgToday: number;
}

export interface TrafficState {
  /** Citywide road pressure from 0 (free-flowing) to 100 (gridlock). */
  congestionIndex: number;
  carTripsToday: number;
  avoidedCarTripsToday: number;
  transitShare: number;
  connectedGateways: number;
  totalGateways: number;
}

/** "running" covers the whole accelerate → cruise → brake profile. */
export type VehicleState = "running" | "dwelling";

export interface Vehicle {
  id: number;
  /** Null while stored in the unassigned fleet pool. */
  lineId: number | null;
  modelId: RollingStockModelId;
  name: string;
  capacity: number;
  purchaseCost: number;
  energyType: EnergyType;
  energyPerKm: number;
  noiseDb: number;
  reliabilityPct: number;
  conditionPct: number;
  distanceTodayM: number;
  lifetimeDistanceM: number;
  energyUsedToday: number;
  /** Distance along the line polyline from station 0, metres. */
  dist: number;
  /** `dist` at the start of the current tick — the renderer lerps from it. */
  prevDist: number;
  /** Current speed, m/s — 0 at a stand, at most TRAIN_MAX_SPEED. */
  speed: number;
  /** +1 toward the last station, -1 back toward the first. */
  dir: 1 | -1;
  state: VehicleState;
  /** Seconds of dwell remaining when state === "dwelling". */
  dwellRemaining: number;
  /** Index into line.stationIds of the station being dwelt at / last passed. */
  atStationIdx: number;
  /** Passenger ids on board. */
  onboard: number[];
}

/** One ride on one line, from one station to another. */
export interface TripLeg {
  lineId: number;
  boardStationId: number;
  alightStationId: number;
  /** Travel direction on the line for this leg. */
  dir: 1 | -1;
}

export type PassengerPhase =
  | "walking-to-station" // spawned, in walk access time
  | "waiting" // queued at a station
  | "riding"; // on board a vehicle

export interface Passenger {
  id: number;
  phase: PassengerPhase;
  /** Sim time (s) the trip was requested — for travel-time stats. */
  spawnedAt: number;
  /** Sim time the passenger arrives at their first station. */
  arrivesAtStationAt: number;
  /** Planned journey; legs[legIndex] is the current leg. */
  legs: TripLeg[];
  legIndex: number;
}

/** Aggregate counters surfaced in the Glance strip. */
export interface Kpis {
  /** Boardings since the current sim day started (the Phase-0 headline KPI). */
  boardingsToday: number;
  /** Final total for the previous sim day. */
  boardingsYesterday: number;
  completedTrips: number;
  /** Spawned trips with no viable transit path — the "unmet demand" signal. */
  unservedTrips: number;
}

/** Everything the renderer / UI needs, read-only. */
export interface SimSnapshot {
  simTimeSec: number;
  day: number;
  /** Bumped whenever lines/stations change — lets the renderer cache layers. */
  networkVersion: number;
  zones: Zone[];
  stations: Map<number, Station>;
  lines: Map<number, Line>;
  vehicles: Vehicle[];
  passengers: Map<number, Passenger>;
  facilities: MobilityFacility[];
  mobilityVersion: number;
  economy: EconomyState;
  environment: EnvironmentState;
  traffic: TrafficState;
  kpis: Kpis;
}
