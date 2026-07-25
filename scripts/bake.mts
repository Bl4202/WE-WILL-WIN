/**
 * World Baker CLI — Phase 1 data-ingestion spike (GDD §1.4, §8 Phase 1).
 *
 * Ingests three open-data sources for Houston and emits a versioned,
 * immutable world bundle the client loads at startup:
 *
 *   GTFS (METRO Houston)        → gtfs_baseline.json   (reference network)
 *   Census ACS tract population ┐
 *   Census gazetteer centroids  ├→ demand.json          (H3 demand grid)
 *   LODES WAC jobs per block    ┘
 *
 * Plus meta.json (provenance/attribution, §6.2) and bake_report.json
 * (the ingestion validation report, §8 Phase 1). Downloads are cached in
 * .cache/ so re-bakes are offline-friendly. JSON stands in for the final
 * PMTiles/Parquet formats until the bundle format hardens (§1.4).
 *
 * Usage:  npm run bake
 */
import AdmZip from "adm-zip";
import { latLngToCell, cellToLatLng } from "h3-js";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
const OUT = join(ROOT, "public", "world", "houston", "v1");

const H3_RES = 8;

/** Houston metro core counties (FIPS): Harris, Fort Bend, Montgomery, Brazoria, Galveston. */
const COUNTIES = ["201", "157", "339", "039", "167"];
const STATE = "48"; // Texas

const GTFS_URLS = [
  "https://metro.resourcespace.com/pages/download.php?ref=4835&ext=zip",
  "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/us-texas-metro-houston-gtfs-2060.zip?alt=media",
];
const GAZETTEER_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_gaz_tracts_48.txt";
const LODES_URLS = [
  "https://lehd.ces.census.gov/data/lodes/LODES8/tx/wac/tx_wac_S000_JT00_2022.csv.gz",
  "https://lehd.ces.census.gov/data/lodes/LODES8/tx/wac/tx_wac_S000_JT00_2021.csv.gz",
];

interface Report {
  generatedAt: string;
  stages: Record<string, Record<string, number | string>>;
  warnings: string[];
}
const report: Report = {
  generatedAt: new Date().toISOString(),
  stages: {},
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

/** Minimal CSV parser handling quoted fields; returns array of records. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = r[i] ?? "";
    return rec;
  });
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

async function bakeGtfs(): Promise<{ routes: BakedRoute[]; stopCount: number }> {
  console.log("Stage A · GTFS (METRO Houston)");
  const zipPath = await download(GTFS_URLS, "houston_gtfs.zip");
  const zip = new AdmZip(zipPath);
  const read = (name: string): string => {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`GTFS missing ${name}`);
    return entry.getData().toString("utf-8");
  };

  const routes = parseCsv(read("routes.txt"));
  const trips = parseCsv(read("trips.txt"));
  const stops = parseCsv(read("stops.txt"));
  const shapeRows = parseCsv(read("shapes.txt"));

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

  report.stages.gtfs = {
    routes: routes.length,
    trips: trips.length,
    stops: stops.length,
    shapePoints: shapeRows.length,
    badShapeRows,
    tripsMissingShape,
    routesWithoutShape,
    railRoutes: baked.filter((b) => b.type <= 2).length,
  };
  console.log(`  ${routes.length} routes, ${stops.length} stops, ` +
    `${baked.filter((b) => b.type <= 2).length} rail`);
  return { routes: baked, stopCount: stops.length };
}

// ── Stage B · Residential population per tract + gazetteer centroids ──
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

async function bakeCensus(): Promise<Map<string, { pop: number; lat: number; lng: number }>> {
  console.log("Stage B · residential population (LODES RAC proxy) + tract centroids");
  const tracts = new Map<string, { pop: number; lat: number; lng: number }>();
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
    const t = tracts.get(geoid) ?? { pop: 0, lat: NaN, lng: NaN };
    t.pop += workers * PERSONS_PER_WORKER;
    tracts.set(geoid, t);
  }

  const gazPath = await download([GAZETTEER_URL], "gaz_tracts_48.txt");
  const gaz = await readFile(gazPath, "utf-8");
  let matched = 0;
  for (const line of gaz.split("\n").slice(1)) {
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 7) continue;
    const geoid = cols[1];
    const t = tracts.get(geoid);
    if (t) {
      t.lat = Number(cols[cols.length - 2]);
      t.lng = Number(cols[cols.length - 1]);
      matched++;
    }
  }
  const unmatched = [...tracts.values()].filter((t) => !isFinite(t.lat)).length;
  report.stages.census = {
    populationSource: "LODES RAC × persons-per-worker (ACS requires API key)",
    personsPerWorker: PERSONS_PER_WORKER,
    racBlockRows: rows,
    blocksInRegion: kept,
    tracts: tracts.size,
    centroidsMatched: matched,
    unmatched,
  };
  if (unmatched > 0) report.warnings.push(`${unmatched} tracts lack centroids (dropped)`);
  report.warnings.push(
    "population is a LODES-RAC-derived proxy; switch to ACS B01003 once a Census API key is configured",
  );
  console.log(`  ${tracts.size} tracts, ${matched} centroids matched`);
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

// ── Stage D · H3 demand grid ──────────────────────────────────────────

interface DemandZone { h3: string; lat: number; lng: number; pop: number; jobs: number }

function bakeDemandGrid(
  tracts: Map<string, { pop: number; lat: number; lng: number }>,
  jobs: Map<string, number>,
): { origin: { lat: number; lng: number }; zones: DemandZone[] } {
  console.log("Stage D · H3 demand grid");
  const cells = new Map<string, { pop: number; jobs: number }>();
  let jobsUnmatchedTracts = 0;
  const seenTracts = new Set<string>();

  for (const [geoid, t] of tracts) {
    if (!isFinite(t.lat)) continue;
    seenTracts.add(geoid);
    const cell = latLngToCell(t.lat, t.lng, H3_RES);
    const e = cells.get(cell) ?? { pop: 0, jobs: 0 };
    e.pop += t.pop;
    e.jobs += jobs.get(geoid) ?? 0;
    cells.set(cell, e);
  }
  for (const geoid of jobs.keys()) {
    if (!seenTracts.has(geoid)) jobsUnmatchedTracts++;
  }

  const zones: DemandZone[] = [];
  let totalPop = 0, totalJobs = 0, latSum = 0, lngSum = 0;
  for (const [h3, e] of cells) {
    if (e.pop <= 0 && e.jobs <= 0) continue;
    const [lat, lng] = cellToLatLng(h3);
    zones.push({ h3, lat: round5(lat), lng: round5(lng), pop: Math.round(e.pop), jobs: Math.round(e.jobs) });
    totalPop += e.pop;
    totalJobs += e.jobs;
    latSum += lat * e.pop;
    lngSum += lng * e.pop;
  }
  const origin = totalPop > 0
    ? { lat: round5(latSum / totalPop), lng: round5(lngSum / totalPop) }
    : { lat: 29.76, lng: -95.36 };

  report.stages.demandGrid = {
    h3Res: H3_RES,
    zones: zones.length,
    totalPop: Math.round(totalPop),
    totalJobs: Math.round(totalJobs),
    jobsTractsOutsideAcs: jobsUnmatchedTracts,
  };
  console.log(`  ${zones.length} H3 cells · pop ${Math.round(totalPop / 1e6 * 10) / 10}M · jobs ${Math.round(totalJobs / 1e6 * 10) / 10}M`);
  return { origin, zones };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const gtfs = await bakeGtfs();
  const tracts = await bakeCensus();
  const jobs = await bakeJobs();
  const demand = bakeDemandGrid(tracts, jobs);

  await writeFile(
    join(OUT, "demand.json"),
    JSON.stringify({ h3Res: H3_RES, origin: demand.origin, zones: demand.zones }),
  );
  await writeFile(
    join(OUT, "gtfs_baseline.json"),
    JSON.stringify({ stopCount: gtfs.stopCount, routes: gtfs.routes }),
  );
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
            name: "US Census LEHD LODES8 RAC/WAC (Texas) + 2023 Gazetteer",
            attribution: "US Census Bureau, LEHD",
            note: "population = RAC employed residents × 2.15 (proxy; see bake_report)",
          },
          {
            name: "Basemap tiles",
            license: "ODbL",
            attribution: "© OpenStreetMap contributors, © OpenFreeMap",
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
