/**
 * Equirectangular projection between geographic coordinates and the sim's
 * local planar metre space, anchored at the world bundle's origin. Good to
 * well under 0.5% distortion at metro scale — fine for Phase 1; a proper
 * projection arrives with the routing graph work (§1.4 conflation).
 */
import type { TransitMode, Vec2 } from "./types";

const M_PER_DEG_LAT = 110540;

export interface LatLng {
  lat: number;
  lng: number;
}

export class Projection {
  private readonly mPerDegLng: number;

  constructor(readonly origin: LatLng) {
    this.mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  }

  toWorld(lat: number, lng: number): Vec2 {
    return {
      x: (lng - this.origin.lng) * this.mPerDegLng,
      y: (this.origin.lat - lat) * M_PER_DEG_LAT,
    };
  }

  /** Returns [lng, lat] — the order deck.gl and MapLibre expect. */
  toLngLat(p: Vec2): [number, number] {
    return [
      this.origin.lng + p.x / this.mPerDegLng,
      this.origin.lat - p.y / M_PER_DEG_LAT,
    ];
  }
}

// ── Station footprint geometry ────────────────────────────────────────
//
// A station is a rectangle on the ground: `platformLengthM` along its own
// axis, a fixed half-width across it. `orientationRad` is the angle of that
// axis in the planar metre frame above, where y runs south — so the tangent
// is (cos, sin) and the perpendicular is (-sin, cos), the same convention the
// renderer already used when it guessed the angle from the track.

/** Half the drawn platform length. Short platforms still need a visible box. */
export function stationHalfLengthM(platformLengthM: number): number {
  return Math.max(16, platformLengthM / 2);
}

export function stationHalfWidthM(mode: TransitMode): number {
  return mode === "bus" ? 4 : 8;
}

/** The four corners of the platform, anticlockwise from the near-left. */
export function stationCorners(
  pos: Vec2,
  orientationRad: number,
  halfLengthM: number,
  halfWidthM: number,
): Vec2[] {
  const tx = Math.cos(orientationRad);
  const ty = Math.sin(orientationRad);
  const px = -ty;
  const py = tx;
  return [
    { x: pos.x - tx * halfLengthM - px * halfWidthM, y: pos.y - ty * halfLengthM - py * halfWidthM },
    { x: pos.x + tx * halfLengthM - px * halfWidthM, y: pos.y + ty * halfLengthM - py * halfWidthM },
    { x: pos.x + tx * halfLengthM + px * halfWidthM, y: pos.y + ty * halfLengthM + py * halfWidthM },
    { x: pos.x - tx * halfLengthM + px * halfWidthM, y: pos.y - ty * halfLengthM + py * halfWidthM },
  ];
}

/**
 * The two ends of the platform. Track attaches here rather than at the
 * centre, so a line meets a station at its end like real track does.
 */
export function stationNodes(
  pos: Vec2,
  orientationRad: number,
  halfLengthM: number,
): [Vec2, Vec2] {
  const tx = Math.cos(orientationRad) * halfLengthM;
  const ty = Math.sin(orientationRad) * halfLengthM;
  return [
    { x: pos.x - tx, y: pos.y - ty },
    { x: pos.x + tx, y: pos.y + ty },
  ];
}

/** Angle from `from` to `to` in the planar frame, radians. */
export function bearingRad(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Fold an angle into (-π, π] so the stored value never drifts. */
export function wrapAngle(rad: number): number {
  const wrapped = rad % (Math.PI * 2);
  if (wrapped > Math.PI) return wrapped - Math.PI * 2;
  if (wrapped <= -Math.PI) return wrapped + Math.PI * 2;
  return wrapped;
}
