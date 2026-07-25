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

/** A demand cell — an H3 hex from the baked world bundle (GDD §1.4). */
export interface Zone {
  id: number;
  /** H3 cell index (also drives the demand-hex overlay). */
  h3: string;
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
  /** Lines serving this station (enables transfers at shared stations). */
  lineIds: number[];
  /** Passengers currently waiting here, by id. */
  waiting: number[];
}

export interface Line {
  id: number;
  name: string;
  color: string;
  /** Ordered station ids along the alignment. */
  stationIds: number[];
  /** Cumulative distance (m) from the first station to each station. */
  stationDist: number[];
  /** Total one-way length in metres. */
  length: number;
  /** Scheduled headway between departures, seconds. */
  headwaySec: number;
}

/** "running" covers the whole accelerate → cruise → brake profile. */
export type VehicleState = "running" | "dwelling";

export interface Vehicle {
  id: number;
  lineId: number;
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
  kpis: Kpis;
}
