/**
 * World Baker CLI — Phase 1 data-ingestion spike (GDD §1.4, §8 Phase 1).
 *
 * Ingests four open-data sources for Houston and emits a versioned,
 * immutable world bundle:
 *
 *   GTFS (METRO Houston)        → gtfs_baseline.json   (reference network)
 *                               → stops.json           (served, mode-tagged)
 *   TIGERweb tract polygons     ┐
 *   LODES RAC residents         ├→ demand.json          (census-tract zones)
 *   LODES WAC jobs per block    ┘
 *   OpenStreetMap via Overpass  → street_graph.json     (routing graph)
 *   stops × graph               → conflation.json       (stops snapped to it)
 *
 * Plus meta.json (provenance/attribution, §6.2) and bake_report.json
 * (the ingestion validation report, §8 Phase 1). Downloads are cached in
 * .cache/ so re-bakes are offline-friendly. JSON stands in for the final
 * PMTiles/Parquet formats until the bundle format hardens (§1.4).
 *
 * The client loads only demand/baseline/meta at startup. street_graph.json
 * is ~26 MB and exists for the Phase-2 kernel (§1.2 contraction hierarchies,
 * §4.1 road assignment); putting it on the boot path would blow the < 8 s
 * Phase-1 exit gate on its own.
 *
 * Usage:  npm run bake                      full bake
 *         npm run bake -- --skip-network    skip Overpass; demand + baseline
 *                                           only, seconds instead of minutes
 */
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conflateStops } from "./lib/conflate.mts";
import {
  readGtfsTables,
  stopsWithModes,
  type BakedStop,
} from "./lib/gtfs-read.mts";
import { validateGtfs } from "./lib/gtfs-validate.mts";
import { bakeOsmGraph, type BBox } from "./lib/osm.mts";

const SKIP_NETWORK = process.argv.includes("--skip-network");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
const OUT = join(ROOT, "public", "world", "houston", "v1");

/** Houston metro core counties (FIPS): Harris, Fort Bend, Montgomery, Brazoria, Galveston. */
const COUNTIES = ["201", "157", "339", "039", "167"];
const STATE = "48"; // Texas

const GTFS_URLS = [
  "https://metro.resourcespace.com/pages/download.php?ref=4835&ext=zip",
  "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/us-texas-metro-houston-gtfs-2060.zip?alt=media",
];

/**
 * Census tract boundaries from TIGERweb, 2020 tabulation vintage — the same
 * vintage as the LODES8 block geocodes, so GEOIDs join exactly. The
 * "Generalized" service is pre-simplified at 1:500,000 with topology
 * preserved, so shared borders stay coincident (simplifying each tract
 * independently here would tear them open into slivers) and tracts arrive at
 * ~32 vertices each. Layer 3 is the attributed tract layer; 0 is labels.
 */
const TRACTS_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_TAB2020" +
  "/Tracts_Blocks/MapServer/3/query?where=" +
  encodeURIComponent(
    `STATE='${STATE}' AND COUNTY IN (${COUNTIES.map((c) => `'${c}'`).join(",")})`,
  ) +
  "&outFields=GEOID,INTPTLAT,INTPTLON,AREALAND&returnGeometry=true" +
  "&outSR=4326&f=geojson";
const LODES_URLS = [
  "https://lehd.ces.census.gov/data/lodes/LODES8/tx/wac/tx_wac_S000_JT00_2022.csv.gz",
  "https://lehd.ces.census.gov/data/lodes/LODES8/tx/wac/tx_wac_S000_JT00_2021.csv.gz",
];

/**
 * Padding around the GTFS stop extent for the OSM pull, degrees (~3 km). The
 * graph has to reach past the outermost stop or the streets those stops walk
 * to are clipped off, and every one of them conflates against a torn edge.
 */
const BBOX_PAD_DEG = 0.03;

interface Report {
  generatedAt: string;
  stages: Record<string, Record<string, number | string>>;
  /** GTFS spec violations found by the validation stage; empty is the goal. */
  gtfsErrors: string[];
  warnings: string[];
}
const report: Report = {
  generatedAt: new Date().toISOString(),
  stages: {},
  gtfsErrors: [],
  warnings: [],
};

// ── Small utilities ───────────────────────────────────────────────────

async function download(urls: string[], cacheName: string): Promise<string> {
  const path = join(CACHE, cacheName);
  if (existsSync(path)) {
    console.log(`  cache hit: ${cacheName}`);
    return path;
  }
  for (const url of urls) {
    try {
      console.log(`  downloading ${url.slice(0, 80)}…`);
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (metro-world-baker)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
      console.log(`  saved ${cacheName} (${(buf.length / 1e6).toFixed(1)} MB)`);
      return path;
    } catch (e) {
      report.warnings.push(`download failed: ${url} (${e})`);
    }
  }
  throw new Error(`all sources failed for ${cacheName}`);
}

/** Douglas–Peucker simplification on [lng,lat] points, tolerance in metres. */
function simplify(pts: [number, number][], tolMetres: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const latRad = (pts[0][1] * Math.PI) / 180;
  const mPerLng = 111320 * Math.cos(latRad);
  const mPerLat = 110540;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a][0] * mPerLng, ay = pts[a][1] * mPerLat;
    const bx = pts[b][0] * mPerLng, by = pts[b][1] * mPerLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * mPerLng, py = pts[i][1] * mPerLat;
      const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
      const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolMetres) {
      keep[maxI] = true;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

// ── Stage A · GTFS → reference network ────────────────────────────────

interface BakedRoute {
  id: string;
  shortName: string;
  longName: string;
  type: number;
  color: string;
  tripCount: number;
  shape: [number, number][];
}

async function bakeGtfs(): Promise<{
  routes: BakedRoute[];
  stopCount: number;
  stops: BakedStop[];
}> {
  console.log("Stage A · GTFS (METRO Houston)");
  const zipPath = await download(GTFS_URLS, "houston_gtfs.zip");
  const tables = readGtfsTables(zipPath);

  // Validate before deriving anything: a feed missing a required file or
  // column cannot produce a trustworthy reference network, and finding that
  // out here beats finding it out as a silently-empty overlay (§8 Phase 1,
  // "ingestion validation/repair stage for malformed feeds").
  const validation = validateGtfs(tables);
  report.stages.gtfsValidation = validation.stats;
  report.gtfsErrors = validation.errors;
  report.warnings.push(...validation.warnings);
  if (validation.fatal.length > 0) {
    for (const f of validation.fatal) console.error(`  ✗ ${f}`);
    throw new Error(
      `feed fails GTFS schema validation (${validation.fatal.length} fatal)`,
    );
  }
  for (const e of validation.errors) console.log(`  ✗ ${e}`);
  console.log(
    `  validated: ${validation.stats.stopTimeRows} stop_times · ` +
      `${validation.errors.length} integrity errors`,
  );

  const routes = tables.routes;
  const trips = tables.trips;
  const stops = tables.stops;
  const shapeRows = tables.shapes;

  // shapes: id → ordered points (repair: sort by sequence, drop bad coords)
  const shapes = new Map<string, { seq: number; lng: number; lat: number }[]>();
  let badShapeRows = 0;
  for (const r of shapeRows) {
    const lat = Number(r.shape_pt_lat), lng = Number(r.shape_pt_lon);
    const seq = Number(r.shape_pt_sequence);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(seq) || lat === 0) {
      badShapeRows++;
      continue;
    }
    let arr = shapes.get(r.shape_id);
    if (!arr) shapes.set(r.shape_id, (arr = []));
    arr.push({ seq, lat, lng });
  }
  for (const arr of shapes.values()) arr.sort((a, b) => a.seq - b.seq);

  // trips: per route, count + most-used shape (direction 0 preferred)
  const perRoute = new Map<string, { count: number; shapeUse: Map<string, number> }>();
  let tripsMissingShape = 0;
  for (const t of trips) {
    let e = perRoute.get(t.route_id);
    if (!e) perRoute.set(t.route_id, (e = { count: 0, shapeUse: new Map() }));
    e.count++;
    if (!t.shape_id || !shapes.has(t.shape_id)) {
      tripsMissingShape++;
      continue;
    }
    const bonus = t.direction_id === "0" ? 1.01 : 1; // prefer direction 0
    e.shapeUse.set(t.shape_id, (e.shapeUse.get(t.shape_id) ?? 0) + bonus);
  }

  const baked: BakedRoute[] = [];
  let routesWithoutShape = 0;
  for (const r of routes) {
    const e = perRoute.get(r.route_id);
    let best = "";
    let bestUse = 0;
    for (const [sid, use] of e?.shapeUse ?? []) {
      if (use > bestUse) { bestUse = use; best = sid; }
    }
    if (!best) { routesWithoutShape++; continue; }
    const pts = shapes.get(best)!.map((p) => [p.lng, p.lat] as [number, number]);
    baked.push({
      id: r.route_id,
      shortName: r.route_short_name ?? "",
      longName: r.route_long_name ?? "",
      type: Number(r.route_type),
      color: r.route_color ? `#${r.route_color}` : "#888888",
      tripCount: e?.count ?? 0,
      shape: simplify(pts, 25).map(([x, y]) => [round5(x), round5(y)]),
    });
  }

  const served = stopsWithModes(tables);
  report.stages.gtfs = {
    routes: routes.length,
    trips: trips.length,
    stops: stops.length,
    servedStops: served.length,
    shapePoints: shapeRows.length,
    badShapeRows,
    tripsMissingShape,
    routesWithoutShape,
    railRoutes: baked.filter((b) => b.type <= 2).length,
  };
  console.log(`  ${routes.length} routes, ${stops.length} stops ` +
    `(${served.length} served), ${baked.filter((b) => b.type <= 2).length} rail`);
  return { routes: baked, stopCount: stops.length, stops: served };
}

// ── Stage B · Residential population per tract ────────────────────────
//
// The Census data API now requires an API key, so residential mass comes
// from LODES RAC (workers by home block, keyless) scaled by the regional
// persons-per-worker ratio — a census-derived proxy sanctioned by §1.4.
// Swap back to ACS B01003 when an API key is configured.

/** Houston metro persons per employed resident (≈7.3M pop / 3.4M workers). */
const PERSONS_PER_WORKER = 2.15;

const RAC_URLS = [
  "https://lehd.ces.census.gov/data/lodes/LODES8/tx/rac/tx_rac_S000_JT00_2022.csv.gz",
  "https://lehd.ces.census.gov/data/lodes/LODES8/tx/rac/tx_rac_S000_JT00_2021.csv.gz",
];

async function bakeCensus(): Promise<Map<string, number>> {
  console.log("Stage B · residential population (LODES RAC proxy)");
  const tracts = new Map<string, number>();
  const prefixes = new Set(COUNTIES.map((c) => STATE + c));

  const racPath = await download(RAC_URLS, "tx_rac.csv.gz");
  let rows = 0, kept = 0;
  const rl = createInterface({
    input: createReadStream(racPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let cGeo = -1, cCount = -1;
  for await (const line of rl) {
    const cols = line.split(",");
    if (cGeo === -1) {
      cGeo = cols.indexOf("h_geocode");
      cCount = cols.indexOf("C000");
      if (cGeo === -1 || cCount === -1) throw new Error("RAC header unexpected");
      continue;
    }
    rows++;
    const geo = cols[cGeo];
    if (!prefixes.has(geo.slice(0, 5))) continue;
    kept++;
    const geoid = geo.slice(0, 11);
    const workers = Number(cols[cCount]) || 0;
    tracts.set(geoid, (tracts.get(geoid) ?? 0) + workers * PERSONS_PER_WORKER);
  }

  report.stages.census = {
    populationSource: "LODES RAC × persons-per-worker (ACS requires API key)",
    personsPerWorker: PERSONS_PER_WORKER,
    racBlockRows: rows,
    blocksInRegion: kept,
    tracts: tracts.size,
  };
  report.warnings.push(
    "population is a LODES-RAC-derived proxy; switch to ACS B01003 once a Census API key is configured",
  );
  console.log(`  ${tracts.size} tracts`);
  return tracts;
}

// ── Stage C · LODES jobs per tract ────────────────────────────────────

async function bakeJobs(): Promise<Map<string, number>> {
  console.log("Stage C · LODES WAC employment");
  const path = await download(LODES_URLS, "tx_wac.csv.gz");
  const jobs = new Map<string, number>();
  const prefixes = new Set(COUNTIES.map((c) => STATE + c));
  let rows = 0, kept = 0;

  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let cGeo = -1, cJobs = -1;
  for await (const line of rl) {
    const cols = line.split(",");
    if (cGeo === -1) {
      cGeo = cols.indexOf("w_geocode");
      cJobs = cols.indexOf("C000");
      if (cGeo === -1 || cJobs === -1) throw new Error("LODES header unexpected");
      continue;
    }
    rows++;
    const geo = cols[cGeo];
    if (!prefixes.has(geo.slice(0, 5))) continue;
    kept++;
    const tract = geo.slice(0, 11);
    jobs.set(tract, (jobs.get(tract) ?? 0) + (Number(cols[cJobs]) || 0));
  }
  report.stages.lodes = { blockRows: rows, blocksInRegion: kept, tractsWithJobs: jobs.size };
  console.log(`  ${rows} block rows → ${jobs.size} tracts with jobs`);
  return jobs;
}

// ── Stage D · census-tract demand zones ───────────────────────────────

/** A polygon ring: [lng, lat] pairs. A part is an outer ring plus any holes. */
type Ring = [number, number][];

interface DemandZone {
  geoid: string;
  /** Interior point (guaranteed inside the tract), used as the sim centroid. */
  lat: number;
  lng: number;
  pop: number;
  jobs: number;
  /** Land area in km² — the density denominator for the choropleth. */
  areaKm2: number;
  /** Polygon parts; each part is [outerRing, ...holes]. */
  parts: Ring[][];
}

interface TractFeature {
  properties: { GEOID: string; INTPTLAT: string; INTPTLON: string; AREALAND: number | string };
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] } | null;
}

async function bakeDemandZones(
  pops: Map<string, number>,
  jobs: Map<string, number>,
): Promise<{ origin: { lat: number; lng: number }; zones: DemandZone[] }> {
  console.log("Stage D · census-tract demand zones");
  const path = await download([TRACTS_URL], "tracts_tab2020.geojson");
  const fc = JSON.parse(await readFile(path, "utf-8")) as {
    error?: unknown;
    features: TractFeature[];
  };
  if (fc.error || !fc.features) {
    throw new Error(`TIGERweb returned no features: ${JSON.stringify(fc.error)}`);
  }

  const zones: DemandZone[] = [];
  let totalPop = 0, totalJobs = 0, latSum = 0, lngSum = 0;
  let multiPart = 0, noGeometry = 0, empty = 0, vertices = 0;
  const seen = new Set<string>();

  for (const f of fc.features) {
    const geoid = f.properties.GEOID;
    seen.add(geoid);
    if (!f.geometry) { noGeometry++; continue; }

    const pop = pops.get(geoid) ?? 0;
    const job = jobs.get(geoid) ?? 0;
    if (pop <= 0 && job <= 0) { empty++; continue; }

    // A Polygon's coordinates are already one part's rings (outer + holes);
    // a MultiPolygon's are a list of those. Wrap the former to match.
    const raw: Ring[][] =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates]
        : f.geometry.coordinates;
    if (raw.length > 1) multiPart++;

    // Round to ~1 m; the service is already generalised, so no simplification.
    const parts = raw.map((rings) =>
      rings.map((ring) => {
        vertices += ring.length;
        return ring.map(([x, y]) => [round5(x), round5(y)] as [number, number]);
      }),
    );

    const lat = Number(f.properties.INTPTLAT);
    const lng = Number(f.properties.INTPTLON);
    if (!isFinite(lat) || !isFinite(lng)) { noGeometry++; continue; }

    zones.push({
      geoid,
      lat: round5(lat),
      lng: round5(lng),
      pop: Math.round(pop),
      jobs: Math.round(job),
      areaKm2: Math.round((Number(f.properties.AREALAND) || 0) / 1e6 * 1e4) / 1e4,
      parts,
    });
    totalPop += pop;
    totalJobs += job;
    latSum += lat * pop;
    lngSum += lng * pop;
  }

  let demandOutsideTracts = 0;
  for (const geoid of new Set([...pops.keys(), ...jobs.keys()])) {
    if (!seen.has(geoid)) demandOutsideTracts++;
  }

  const origin = totalPop > 0
    ? { lat: round5(latSum / totalPop), lng: round5(lngSum / totalPop) }
    : { lat: 29.76, lng: -95.36 };

  report.stages.demandZones = {
    geometry: "TIGERweb Generalized_TAB2020 census tracts (1:500k)",
    tractsReturned: fc.features.length,
    zones: zones.length,
    multiPartTracts: multiPart,
    tractsWithoutGeometry: noGeometry,
    tractsWithNoDemand: empty,
    demandTractsWithoutGeometry: demandOutsideTracts,
    vertices,
    totalPop: Math.round(totalPop),
    totalJobs: Math.round(totalJobs),
  };
  if (demandOutsideTracts > 0) {
    report.warnings.push(
      `${demandOutsideTracts} tracts have LODES demand but no TIGERweb geometry (dropped)`,
    );
  }
  console.log(
    `  ${zones.length} tracts · ${vertices} vertices · ` +
    `pop ${Math.round(totalPop / 1e5) / 10}M · jobs ${Math.round(totalJobs / 1e5) / 10}M`,
  );
  return { origin, zones };
}

// ── Stage E · OSM street/rail graph, Stage F · conflation ─────────────

/** Smallest box containing every stop, padded so walk access is not clipped. */
function bboxOf(stops: { lat: number; lng: number }[]): BBox {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const s of stops) {
    minLat = Math.min(minLat, s.lat);
    maxLat = Math.max(maxLat, s.lat);
    minLng = Math.min(minLng, s.lng);
    maxLng = Math.max(maxLng, s.lng);
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return [
    r(minLat - BBOX_PAD_DEG),
    r(minLng - BBOX_PAD_DEG),
    r(maxLat + BBOX_PAD_DEG),
    r(maxLng + BBOX_PAD_DEG),
  ];
}

async function bakeNetwork(stops: BakedStop[]): Promise<void> {
  const bbox = bboxOf(stops);
  console.log("Stage E · OSM street/rail graph (Overpass, tiled + cached)");
  console.log(`  bbox ${bbox.join(", ")}`);
  const { graph, stats: osmStats } = await bakeOsmGraph(
    bbox,
    CACHE,
    (m) => report.warnings.push(m),
    (m) => process.stdout.write(`\r${m.padEnd(70)}`),
  );
  process.stdout.write("\n");
  report.stages.osmGraph = { ...osmStats };
  console.log(
    `  ${osmStats.graphNodes} nodes · ${osmStats.graphEdges} edges · ` +
      `${osmStats.roadKm} km road + ${osmStats.railKm} km rail · ` +
      `largest component ${(osmStats.largestComponentShare * 100).toFixed(1)}%`,
  );
  if (osmStats.largestComponentShare < 0.9) {
    report.warnings.push(
      `street graph is fragmented: largest connected component holds only ` +
        `${(osmStats.largestComponentShare * 100).toFixed(1)}% of edge length`,
    );
  }

  console.log("Stage F · conflation (GTFS stops → OSM graph)");
  const { conflation, stats, unmatched } = conflateStops(graph, stops);
  report.stages.conflation = {
    ...stats,
    toleranceM: conflation.toleranceM,
    matchedPct: Math.round((stats.matched / stats.stops) * 1000) / 10,
  };
  console.log(
    `  ${stats.matched}/${stats.stops} matched ` +
      `(${((stats.matched / stats.stops) * 100).toFixed(1)}%) · ` +
      `median ${stats.medianDistM} m · p90 ${stats.p90DistM} m · ` +
      `rail ${stats.railMatched}/${stats.railStops}`,
  );

  // Name the misses rather than listing bare ids: in this feed they are all
  // park-and-rides and airport kerbs, which sit on internal drives OSM tags
  // `highway=service` — excluded from the graph on purpose. Naming them is
  // what makes that judgement reviewable instead of a silent 0.1%.
  const byId = new Map(stops.map((s) => [s.id, s]));
  const unmatchedDetail = unmatched.map((id) => {
    const s = byId.get(id)!;
    return { id, name: s.name, lat: s.lat, lng: s.lng, trips: s.trips };
  });
  if (unmatched.length > 0) {
    report.warnings.push(
      `${unmatched.length} stops found no mode-compatible way within ` +
        `${conflation.toleranceM} m — typically facilities reached only by ` +
        `highway=service drives: ${unmatchedDetail
          .slice(0, 5)
          .map((u) => `${u.name} (${u.id})`)
          .join(", ")}`,
    );
  }

  await writeFile(join(OUT, "street_graph.json"), JSON.stringify(graph));
  await writeFile(
    join(OUT, "conflation.json"),
    JSON.stringify({ ...conflation, unmatched: unmatchedDetail }),
  );
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const gtfs = await bakeGtfs();
  const pops = await bakeCensus();
  const jobs = await bakeJobs();
  const demand = await bakeDemandZones(pops, jobs);

  await writeFile(
    join(OUT, "demand.json"),
    JSON.stringify({ origin: demand.origin, zones: demand.zones }),
  );
  await writeFile(
    join(OUT, "gtfs_baseline.json"),
    JSON.stringify({ stopCount: gtfs.stopCount, routes: gtfs.routes }),
  );
  await writeFile(join(OUT, "stops.json"), JSON.stringify({ stops: gtfs.stops }));

  if (SKIP_NETWORK) {
    console.log("Stages E–F · skipped (--skip-network)");
    report.warnings.push(
      "--skip-network: street_graph.json and conflation.json were not rebuilt",
    );
  } else {
    await bakeNetwork(gtfs.stops);
  }
  await writeFile(
    join(OUT, "meta.json"),
    JSON.stringify(
      {
        city: "houston",
        version: "v1",
        generatedAt: report.generatedAt,
        origin: demand.origin,
        sources: [
          {
            name: "METRO Houston GTFS",
            license: "METRO developer terms",
            attribution: "Transit data © Metropolitan Transit Authority of Harris County",
          },
          {
            name: "US Census LEHD LODES8 RAC/WAC (Texas)",
            attribution: "US Census Bureau, LEHD",
            note: "population = RAC employed residents × 2.15 (proxy; see bake_report)",
          },
          {
            name: "US Census TIGERweb Generalized_TAB2020 census tracts",
            attribution: "US Census Bureau, TIGER/Line",
            note: "2020 tabulation vintage, generalised to 1:500,000",
          },
          {
            name: "Basemap tiles",
            license: "ODbL",
            attribution: "© OpenStreetMap contributors, © OpenFreeMap",
          },
          // The routing graph is a derived database under ODbL, so its
          // attribution travels with the bundle, not just with the basemap
          // the client happens to render (§6.2).
          {
            name: "OpenStreetMap via Overpass API (street/rail routing graph)",
            license: "ODbL 1.0",
            attribution: "© OpenStreetMap contributors",
            note: "street_graph.json; see bake_report for extent and coverage",
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(join(OUT, "bake_report.json"), JSON.stringify(report, null, 2));

  console.log(`\nBaked world bundle → ${OUT}`);
  console.log(JSON.stringify(report.stages, null, 2));
  if (report.warnings.length) {
    console.log("Warnings:");
    for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  }
}

main().catch((e) => {
  console.error("BAKE FAILED:", e);
  process.exit(1);
});
