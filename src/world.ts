/**
 * Baked World Bundle types + loader (GDD §1.4). The bundle is produced by
 * `npm run bake` (scripts/bake.mts) into public/world/{city}/{version}/ and
 * fetched at startup. JSON stands in for PMTiles/Parquet at this phase.
 */
import { Projection } from "./geo";
import type { Zone } from "./types";

export interface DemandFile {
  h3Res: number;
  origin: { lat: number; lng: number };
  zones: { h3: string; lat: number; lng: number; pop: number; jobs: number }[];
}

export interface BaselineRoute {
  id: string;
  shortName: string;
  longName: string;
  /** GTFS route_type: 0 tram/LRT, 1 metro, 2 rail, 3 bus. */
  type: number;
  color: string;
  tripCount: number;
  /** Representative alignment, [lng, lat] pairs. */
  shape: [number, number][];
}

export interface GtfsBaseline {
  stopCount: number;
  routes: BaselineRoute[];
}

export interface WorldMeta {
  city: string;
  version: string;
  generatedAt: string;
  origin: { lat: number; lng: number };
  sources: { name: string; attribution: string; license?: string; note?: string }[];
}

export interface WorldBundle {
  demand: DemandFile;
  baseline: GtfsBaseline;
  meta: WorldMeta;
  projection: Projection;
}

/** Pure transform: bundle demand cells → sim zones in planar metres. */
export function zonesFromDemand(demand: DemandFile, proj: Projection): Zone[] {
  return demand.zones.map((z, i) => ({
    id: i,
    h3: z.h3,
    lat: z.lat,
    lng: z.lng,
    center: proj.toWorld(z.lat, z.lng),
    pop: z.pop,
    jobs: z.jobs,
  }));
}

export async function loadWorld(
  city = "houston",
  version = "v1",
): Promise<WorldBundle> {
  const base = `${import.meta.env.BASE_URL}world/${city}/${version}`;
  const [demand, baseline, meta] = await Promise.all(
    ["demand.json", "gtfs_baseline.json", "meta.json"].map(async (f) => {
      const res = await fetch(`${base}/${f}`);
      if (!res.ok) throw new Error(`world bundle fetch failed: ${f} (${res.status})`);
      return res.json();
    }),
  ) as [DemandFile, GtfsBaseline, WorldMeta];
  return { demand, baseline, meta, projection: new Projection(demand.origin) };
}
