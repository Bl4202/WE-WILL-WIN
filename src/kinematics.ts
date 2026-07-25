/**
 * Train longitudinal kinematics — the single source of truth for how fast a
 * train is moving, used both by the per-tick motion in the sim and by the
 * run-time estimates that size fleets and price routes, so the two can never
 * drift apart.
 *
 * The Phase-1 profile is a symmetric triangle: a train accelerates for the
 * first half of every interstation hop and brakes for the second, topping out
 * at the midpoint. How high it tops out scales with the length of the hop
 * (∝ √distance) up to TRAIN_MAX_SPEED, so widely spaced stations give
 * genuinely faster trains — and the acceleration rate falls out of those two
 * numbers rather than being assumed.
 *
 * That is deliberately a game model, not physics: a real train pulls away at
 * a roughly constant ~1.1 m/s² and then *cruises* at line speed, so it beats
 * this profile over a long hop, where holding the peak for the whole midsection
 * would be quicker than easing into it. GDD §3.1 replaces all of this with
 * tractive-effort curves that vary with speed, grade, and the mass of the
 * passengers on board.
 */
import { SIM_DT, TRAIN_FULL_SPEED_DIST, TRAIN_MAX_SPEED } from "./constants";

/** Speed (m/s) a train reaches at the midpoint of a `hopLen` metre hop. */
function peakSpeed(hopLen: number): number {
  if (hopLen <= 0) return 0;
  return TRAIN_MAX_SPEED * Math.min(1, Math.sqrt(hopLen / TRAIN_FULL_SPEED_DIST));
}

/**
 * Acceleration (m/s²) for a hop — whatever rate reaches the peak in exactly
 * half the distance (v² = 2·a·½L). Braking mirrors it, which is what puts the
 * peak at the midpoint. Constant below TRAIN_FULL_SPEED_DIST, then eases off
 * as longer hops stretch the same top speed over a longer ramp.
 */
function hopAccel(hopLen: number): number {
  if (hopLen <= 0) return 0;
  const peak = peakSpeed(hopLen);
  return (peak * peak) / hopLen;
}

/**
 * Advance a train's speed by one sim tick, `distToStop` metres from the next
 * platform on a hop of `hopLen` metres.
 *
 * The train pulls toward the hop's peak speed, but never past the speed it
 * could still brake to a stand from within `distToStop` (v² = 2·a·d). Since
 * both phases use the same rate, that cap takes over exactly at the midpoint.
 */
export function nextSpeed(
  speed: number,
  distToStop: number,
  hopLen: number,
): number {
  const accel = hopAccel(hopLen);
  const brakeCap = Math.sqrt(2 * accel * Math.max(0, distToStop));
  const target = Math.min(peakSpeed(hopLen), brakeCap);
  return speed > target
    ? Math.max(target, speed - accel * SIM_DT)
    : Math.min(target, speed + accel * SIM_DT);
}

/**
 * Time (s) to run one interstation hop of `hopLen` metres, stand to stand,
 * excluding the dwell at either end. A triangle averages half its peak.
 */
export function runTimeSec(hopLen: number): number {
  if (hopLen <= 0) return 0;
  return (2 * hopLen) / peakSpeed(hopLen);
}
