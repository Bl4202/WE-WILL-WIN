/** Shared tuning constants for the Phase-0 simulation. */

/** Fixed sim timestep, seconds of sim-time (GDD §4.3: 4 Hz). */
export const SIM_DT = 0.25;

/**
 * Sim-seconds advanced per real second at 1× speed. 1 means 1× is wall-clock
 * real time: trains cross the map at the speed real trains would. The faster
 * multipliers below compress the day (GDD §2.3).1
 */
export const BASE_TIME_SCALE = 1;

/**
 * Speed multipliers for the time controls, as sim-seconds per real second:
 * pause, half-speed, real time, 10×, an hour a minute, and ~1 day/minute
 * (the GDD §2.3 ceiling). A sim day takes 24 real hours at 1×, 60 s at ≫.
 */
export const SPEED_MULTIPLIERS = [0, 0.5, 1, 10, 60, 1440] as const;

/**
 * Hard speed cap, m/s (~80 km/h) — a realistic metro maximum, and the fastest
 * a train may ever be moving no matter how far apart its stations are.
 */
export const TRAIN_MAX_SPEED = 22.2;

/**
 * Interstation distance (m) at which a train just reaches TRAIN_MAX_SPEED.
 * Trains peak at the midpoint of every hop, so shorter hops peak
 * proportionally lower (∝ √distance) and longer ones simply hold the cap for
 * longer: station spacing is the player's main lever on line speed until the
 * GDD §3.1 rolling-stock physics replace this stand-in.
 */
export const TRAIN_FULL_SPEED_DIST = 2500;

/** Dwell time at each station stop, seconds. */
export const DWELL_SEC = 20;

/** Crush capacity per train — passengers beyond this are left behind. */
export const TRAIN_CAPACITY = 200;

/** Default scheduled headway for new lines, seconds (5 min). */
export const DEFAULT_HEADWAY_SEC = 300;

/**
 * Two line points closer together than this are the same station, metres.
 * Build-mode snapping produces exactly-coincident points, so this only needs
 * to absorb float noise — keep it far below any real station spacing.
 */
export const SAME_STATION_M = 5;

/** Max walk distance from a zone centre to a station, metres. */
export const WALK_RADIUS = 1800;

/** Walking speed for access/egress time, m/s. */
export const WALK_SPEED = 1.4;

/** Perceived cost of changing lines, seconds (GDD §3.2: transfer penalty). */
export const TRANSFER_PENALTY_SEC = 120;

/** Length of a simulated day, seconds. */
export const DAY_SEC = 86400;

/**
 * Person-trips the whole city attempts per simulated day. A sampled slice of
 * real metro-wide demand (Houston ~20M+ daily person-trips) so the toy agent
 * model stays cheap; the calibrated four-step model replaces this in Phase 2.
 */
export const DAILY_TRIPS = 40000;

/** Distance-deterrence scale for destination choice, metres (§4.1.3 flavour). */
export const DEST_DETERRENCE_M = 10000;

/**
 * TEMPORARY demand-bootstrap hack, Phase 0 only. Fraction of spawnTrip()
 * calls that draw BOTH origin and destination from zones already near the
 * player's built stations, instead of the full metro-wide gravity pool — a
 * deliberately unrealistic floor of "local, along-my-line" ridership so a
 * brand-new, geographically tiny network doesn't read as dead against tens
 * of thousands of metro-wide unservedTrips. Remove this constant and its
 * Simulation-side branch once the real calibrated four-step gravity/IPF/
 * mode-choice/RAPTOR model (GDD "Phase 2 — Simulation Kernel & Static
 * Model") replaces this Phase-0 toy demand.
 */
export const LOCAL_DEMAND_FRACTION = 0.1;
