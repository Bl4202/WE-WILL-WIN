/**
 * GTFS zip → parsed tables, shared by the validation, reference-network and
 * conflation stages so the 12 MB archive is opened once per bake.
 *
 * stop_times.txt is handed on as raw text rather than records: it is ~70 MB
 * and ~1.4 M rows in the Houston feed, and every consumer only ever wants a
 * streaming pass over three or four of its columns.
 */
import AdmZip from "adm-zip";

export type Row = Record<string, string>;

export interface GtfsTables {
  /** Entry names present in the zip. */
  files: Set<string>;
  agency: Row[];
  stops: Row[];
  routes: Row[];
  trips: Row[];
  shapes: Row[];
  calendar: Row[];
  calendarDates: Row[];
  /** Raw text of stop_times.txt — streamed, never parsed into records. */
  stopTimes: string;
}

/** Split one CSV line, honouring quoted fields. */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Iterate a CSV blob's lines without materialising a 1.4 M-element array. */
export function* csvLines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let stop = end;
    if (stop > start && text[stop - 1] === "\r") stop--;
    if (stop > start) yield text.slice(start, stop);
    start = end + 1;
  }
}

/** Minimal CSV parser handling quoted fields; returns array of records. */
export function parseCsv(text: string): Row[] {
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
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1).map((r) => {
    const rec: Row = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = r[i] ?? "";
    return rec;
  });
}

export interface BakedStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Distinct GTFS route_types serving this stop, ascending. */
  modes: number[];
  /** Trips calling here across the whole feed — a first-order importance
   *  weight, and the reason a park-and-ride reads differently to a kerb. */
  trips: number;
}

/**
 * Stops that actual trips call at, tagged with the modes serving them.
 *
 * Requires one streaming pass over stop_times to join stop → trip → route →
 * route_type; the mode tag is what lets conflation snap rail stops to rails
 * and bus stops to streets instead of to whichever happens to be nearer.
 * Stops with no coordinates, and station/entrance/node records that no trip
 * calls at, are dropped — they carry no demand and would only show up as
 * phantom conflation failures.
 */
export function stopsWithModes(t: GtfsTables): BakedStop[] {
  const routeType = new Map<string, number>();
  for (const r of t.routes) routeType.set(r.route_id, Number(r.route_type));
  const tripType = new Map<string, number>();
  for (const tr of t.trips) {
    const rt = routeType.get(tr.route_id);
    if (rt !== undefined && isFinite(rt)) tripType.set(tr.trip_id, rt);
  }

  const modes = new Map<string, Set<number>>();
  const tripCount = new Map<string, number>();
  let header: string[] | null = null;
  let cTrip = -1;
  let cStop = -1;
  for (const line of csvLines(t.stopTimes)) {
    if (header === null) {
      header = splitCsvLine(line).map((h) => h.replace(/^﻿/, "").trim());
      cTrip = header.indexOf("trip_id");
      cStop = header.indexOf("stop_id");
      if (cTrip === -1 || cStop === -1) return [];
      continue;
    }
    // stop_headsign is a quoted free-text field in many feeds; splitting on
    // bare commas would shift every column after it.
    const cols = splitCsvLine(line);
    const stopId = cols[cStop];
    tripCount.set(stopId, (tripCount.get(stopId) ?? 0) + 1);
    const rt = tripType.get(cols[cTrip]);
    if (rt === undefined) continue;
    let set = modes.get(stopId);
    if (!set) modes.set(stopId, (set = new Set()));
    set.add(rt);
  }

  const out: BakedStop[] = [];
  for (const s of t.stops) {
    if (!tripCount.has(s.stop_id)) continue;
    const lat = Number(s.stop_lat);
    const lng = Number(s.stop_lon);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
    out.push({
      id: s.stop_id,
      name: s.stop_name ?? "",
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      modes: [...(modes.get(s.stop_id) ?? [])].sort((a, b) => a - b),
      trips: tripCount.get(s.stop_id) ?? 0,
    });
  }
  return out;
}

export function readGtfsTables(zipPath: string): GtfsTables {
  const zip = new AdmZip(zipPath);
  const files = new Set(zip.getEntries().map((e) => e.entryName));
  const text = (name: string): string => {
    const entry = zip.getEntry(name);
    return entry ? entry.getData().toString("utf-8") : "";
  };
  const table = (name: string): Row[] =>
    files.has(name) ? parseCsv(text(name)) : [];

  return {
    files,
    agency: table("agency.txt"),
    stops: table("stops.txt"),
    routes: table("routes.txt"),
    trips: table("trips.txt"),
    shapes: table("shapes.txt"),
    calendar: table("calendar.txt"),
    calendarDates: table("calendar_dates.txt"),
    stopTimes: text("stop_times.txt"),
  };
}
