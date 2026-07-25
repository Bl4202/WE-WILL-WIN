/**
 * Equirectangular projection between geographic coordinates and the sim's
 * local planar metre space, anchored at the world bundle's origin. Good to
 * well under 0.5% distortion at metro scale — fine for Phase 1; a proper
 * projection arrives with the routing graph work (§1.4 conflation).
 */
import type { Vec2 } from "./types";

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
