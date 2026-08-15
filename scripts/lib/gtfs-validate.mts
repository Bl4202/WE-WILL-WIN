/**
 * GTFS schema + referential-integrity validation (GDD §8 Phase 1, "ingestion
 * validation/repair stage for malformed feeds").
 *
 * Split into three severities so a re-bake of a new feed says something
 * actionable rather than just crashing:
 *
 *   fatal    — a required file or column is missing; nothing downstream can
 *              be trusted, so the bake stops.
 *   error    — a spec violation inside otherwise-readable data (dangling
 *              reference, impossible coordinate, out-of-order stop_sequence).
 *              Bake continues; the affected rows are already dropped or
 *              repaired by the stages that read them.
 *   warning  — quality signal, not a violation: orphan stops, unused
 *              services, routes with no trips.
 *
 * stop_times.txt alone is ~70 MB and ~1.4 M rows, so it is scanned line by
 * line and never materialised as records.
 */

import { csvLines, splitCsvLine, type GtfsTables, type Row } from "./gtfs-read.mts";

export interface ValidationResult {
  stats: Record<string, number | string>;
  fatal: string[];
  errors: string[];
  warnings: string[];
}

/** Files the spec requires unconditionally. */
const REQUIRED_FILES = [
  "agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt",
];

/** Columns the spec requires, per file. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  "agency.txt": ["agency_name", "agency_url", "agency_timezone"],
  "stops.txt": ["stop_id"],
  "routes.txt": ["route_id", "route_type"],
  "trips.txt": ["route_id", "service_id", "trip_id"],
  "calendar.txt": [
    "service_id", "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday", "start_date", "end_date",
  ],
  "calendar_dates.txt": ["service_id", "date", "exception_type"],
  "shapes.txt": ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
};

const STOP_TIMES_COLUMNS = ["trip_id", "stop_id", "stop_sequence"];

/** route_type values in the base spec; the extended set is 100–1799. */
const BASE_ROUTE_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 11, 12]);

/** Collects one message class, keeping a few examples and a full count. */
class Bucket {
  count = 0;
  private readonly examples: string[] = [];
  constructor(private readonly label: string, private readonly cap = 3) {}

  add(detail: string): void {
    this.count++;
    if (this.examples.length < this.cap) this.examples.push(detail);
  }

  drainInto(out: string[]): void {
    if (this.count === 0) return;
    const more = this.count > this.examples.length
      ? ` (+${this.count - this.examples.length} more)`
      : "";
    out.push(`${this.label}: ${this.count} — ${this.examples.join("; ")}${more}`);
  }
}

const columnsOf = (rows: Row[]): string[] => Object.keys(rows[0] ?? {});

/** "25:41:00" → seconds since noon-12; GTFS allows hours past 24. */
function parseGtfsTime(t: string): number {
  const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(t.trim());
  if (!m) return NaN;
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

export function validateGtfs(t: GtfsTables): ValidationResult {
  const fatal: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Schema: files and columns ──────────────────────────────────────
  for (const f of REQUIRED_FILES) {
    if (!t.files.has(f)) fatal.push(`required file missing: ${f}`);
  }
  if (!t.files.has("calendar.txt") && !t.files.has("calendar_dates.txt")) {
    fatal.push("required file missing: calendar.txt or calendar_dates.txt");
  }

  const tableOf: Record<string, Row[]> = {
    "agency.txt": t.agency,
    "stops.txt": t.stops,
    "routes.txt": t.routes,
    "trips.txt": t.trips,
    "calendar.txt": t.calendar,
    "calendar_dates.txt": t.calendarDates,
    "shapes.txt": t.shapes,
  };
  for (const [file, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!t.files.has(file)) continue;
    const have = new Set(columnsOf(tableOf[file]));
    for (const col of required) {
      if (!have.has(col)) fatal.push(`${file} missing required column: ${col}`);
    }
  }

  const stHeaderLine = csvLines(t.stopTimes).next().value as string | undefined;
  const stColumns = stHeaderLine
    ? splitCsvLine(stHeaderLine).map((h) => h.replace(/^﻿/, "").trim())
    : [];
  for (const col of STOP_TIMES_COLUMNS) {
    if (!stColumns.includes(col)) {
      fatal.push(`stop_times.txt missing required column: ${col}`);
    }
  }
  if (fatal.length > 0) {
    return { stats: {}, fatal, errors, warnings };
  }

  // ── Keys ───────────────────────────────────────────────────────────
  const stopIds = new Set<string>();
  const dupStops = new Bucket("duplicate stop_id");
  for (const s of t.stops) {
    if (stopIds.has(s.stop_id)) dupStops.add(s.stop_id);
    stopIds.add(s.stop_id);
  }
  const routeIds = new Set<string>();
  const dupRoutes = new Bucket("duplicate route_id");
  for (const r of t.routes) {
    if (routeIds.has(r.route_id)) dupRoutes.add(r.route_id);
    routeIds.add(r.route_id);
  }
  const tripIds = new Set<string>();
  const dupTrips = new Bucket("duplicate trip_id");
  for (const tr of t.trips) {
    if (tripIds.has(tr.trip_id)) dupTrips.add(tr.trip_id);
    tripIds.add(tr.trip_id);
  }
  const shapeIds = new Set(t.shapes.map((s) => s.shape_id));
  const serviceIds = new Set([
    ...t.calendar.map((c) => c.service_id),
    ...t.calendarDates.map((c) => c.service_id),
  ]);

  // ── stops.txt values ───────────────────────────────────────────────
  const badCoord = new Bucket("stop with impossible coordinates");
  const badLocType = new Bucket("stop with invalid location_type");
  const danglingParent = new Bucket("stop.parent_station not a known stop");
  const parents = new Set<string>();
  for (const s of t.stops) {
    const locType = s.location_type === "" || s.location_type === undefined
      ? 0
      : Number(s.location_type);
    if (!Number.isInteger(locType) || locType < 0 || locType > 4) {
      badLocType.add(`${s.stop_id}="${s.location_type}"`);
    }
    // Coordinates are required for platforms, stations and entrances only.
    if (locType <= 2) {
      const lat = Number(s.stop_lat);
      const lng = Number(s.stop_lon);
      if (
        !isFinite(lat) || !isFinite(lng) ||
        Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
        (lat === 0 && lng === 0)
      ) {
        badCoord.add(`${s.stop_id}=(${s.stop_lat},${s.stop_lon})`);
      }
    }
    if (s.parent_station) {
      parents.add(s.parent_station);
      if (!stopIds.has(s.parent_station)) {
        danglingParent.add(`${s.stop_id}→${s.parent_station}`);
      }
    }
  }

  // ── routes.txt / trips.txt references ──────────────────────────────
  const oddRouteType = new Bucket("route with unrecognised route_type");
  for (const r of t.routes) {
    const rt = Number(r.route_type);
    if (
      !Number.isInteger(rt) ||
      (!BASE_ROUTE_TYPES.has(rt) && (rt < 100 || rt > 1799))
    ) {
      oddRouteType.add(`${r.route_id}="${r.route_type}"`);
    }
  }

  const danglingRoute = new Bucket("trip.route_id not a known route");
  const danglingService = new Bucket("trip.service_id not in calendar");
  const danglingShape = new Bucket("trip.shape_id not in shapes");
  const usedServices = new Set<string>();
  const usedShapes = new Set<string>();
  const routesWithTrips = new Set<string>();
  for (const tr of t.trips) {
    if (!routeIds.has(tr.route_id)) danglingRoute.add(`${tr.trip_id}→${tr.route_id}`);
    else routesWithTrips.add(tr.route_id);
    if (!serviceIds.has(tr.service_id)) {
      danglingService.add(`${tr.trip_id}→${tr.service_id}`);
    } else usedServices.add(tr.service_id);
    if (tr.shape_id) {
      if (!shapeIds.has(tr.shape_id)) danglingShape.add(`${tr.trip_id}→${tr.shape_id}`);
      else usedShapes.add(tr.shape_id);
    }
  }

  // ── shapes.txt values ──────────────────────────────────────────────
  const badShapePt = new Bucket("shape point with impossible coordinates");
  const shapeSeqSeen = new Map<string, Set<number>>();
  const dupShapeSeq = new Bucket("duplicate shape_pt_sequence");
  for (const s of t.shapes) {
    const lat = Number(s.shape_pt_lat);
    const lng = Number(s.shape_pt_lon);
    const seq = Number(s.shape_pt_sequence);
    if (
      !isFinite(lat) || !isFinite(lng) || !isFinite(seq) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)
    ) {
      badShapePt.add(`${s.shape_id}#${s.shape_pt_sequence}`);
      continue;
    }
    let seen = shapeSeqSeen.get(s.shape_id);
    if (!seen) shapeSeqSeen.set(s.shape_id, (seen = new Set()));
    if (seen.has(seq)) dupShapeSeq.add(`${s.shape_id}#${seq}`);
    seen.add(seq);
  }

  // ── stop_times.txt: one streaming pass ─────────────────────────────
  const cTrip = stColumns.indexOf("trip_id");
  const cStop = stColumns.indexOf("stop_id");
  const cSeq = stColumns.indexOf("stop_sequence");
  const cArr = stColumns.indexOf("arrival_time");
  const cDep = stColumns.indexOf("departure_time");

  const danglingStTrip = new Bucket("stop_time.trip_id not a known trip");
  const danglingStStop = new Bucket("stop_time.stop_id not a known stop");
  const badSeq = new Bucket("stop_sequence not increasing within trip");
  const badTime = new Bucket("unparseable arrival/departure time");
  const backwardsTime = new Bucket("departure before arrival, or time going backwards");

  const stopTimesPerTrip = new Map<string, number>();
  const stopsUsed = new Set<string>();
  let stopTimeRows = 0;
  // Feeds are grouped by trip in practice; tracking only the previous row's
  // trip keeps this pass O(1) in memory over 1.4 M rows.
  let prevTrip = "";
  let prevSeq = -Infinity;
  let prevTime = -Infinity;

  let first = true;
  for (const line of csvLines(t.stopTimes)) {
    if (first) { first = false; continue; }
    const c = splitCsvLine(line);
    stopTimeRows++;
    const trip = c[cTrip];
    const stop = c[cStop];
    const seq = Number(c[cSeq]);

    if (!tripIds.has(trip)) danglingStTrip.add(`${trip}`);
    if (!stopIds.has(stop)) danglingStStop.add(`${stop}`);
    else stopsUsed.add(stop);
    stopTimesPerTrip.set(trip, (stopTimesPerTrip.get(trip) ?? 0) + 1);

    if (trip !== prevTrip) {
      prevTrip = trip;
      prevSeq = -Infinity;
      prevTime = -Infinity;
    }
    if (!isFinite(seq) || seq <= prevSeq) badSeq.add(`${trip}#${c[cSeq]}`);
    prevSeq = seq;

    if (cArr !== -1 && cDep !== -1) {
      const arrRaw = c[cArr] ?? "";
      const depRaw = c[cDep] ?? "";
      if (arrRaw !== "" || depRaw !== "") {
        const arr = parseGtfsTime(arrRaw);
        const dep = parseGtfsTime(depRaw);
        if (isNaN(arr) || isNaN(dep)) badTime.add(`${trip}: "${arrRaw}"/"${depRaw}"`);
        else {
          if (dep < arr || arr < prevTime) {
            backwardsTime.add(`${trip}#${c[cSeq]}: ${arrRaw}→${depRaw}`);
          }
          prevTime = dep;
        }
      }
    }
  }

  // ── Orphans and unused entities ────────────────────────────────────
  const orphanStops = [...stopIds].filter(
    (id) => !stopsUsed.has(id) && !parents.has(id),
  ).length;
  const shortTrips = [...tripIds].filter(
    (id) => (stopTimesPerTrip.get(id) ?? 0) < 2,
  ).length;
  const routesNoTrips = [...routeIds].filter((id) => !routesWithTrips.has(id)).length;
  const unusedShapes = [...shapeIds].filter((id) => !usedShapes.has(id)).length;
  const unusedServices = [...serviceIds].filter((id) => !usedServices.has(id)).length;

  for (const b of [
    dupStops, dupRoutes, dupTrips, badCoord, badLocType, danglingParent,
    danglingRoute, danglingService, danglingShape, badShapePt, dupShapeSeq,
    danglingStTrip, danglingStStop, badSeq, badTime, backwardsTime,
  ]) {
    b.drainInto(errors);
  }
  oddRouteType.drainInto(warnings);
  if (orphanStops) warnings.push(`${orphanStops} stops never served by any trip`);
  if (shortTrips) warnings.push(`${shortTrips} trips with fewer than 2 stop_times`);
  if (routesNoTrips) warnings.push(`${routesNoTrips} routes with no trips`);
  if (unusedShapes) warnings.push(`${unusedShapes} shapes referenced by no trip`);
  if (unusedServices) warnings.push(`${unusedServices} calendar services used by no trip`);

  return {
    stats: {
      filesPresent: t.files.size,
      agencies: t.agency.length,
      stops: t.stops.length,
      routes: t.routes.length,
      trips: t.trips.length,
      stopTimeRows,
      shapePoints: t.shapes.length,
      shapes: shapeIds.size,
      services: serviceIds.size,
      stopsServed: stopsUsed.size,
      orphanStops,
      shortTrips,
      routesWithoutTrips: routesNoTrips,
      unusedShapes,
      unusedServices,
      integrityErrors: errors.length,
    },
    fatal,
    errors,
    warnings,
  };
}
