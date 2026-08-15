/**
 * Damage tests for the GTFS validation stage (GDD §8 Phase 1).
 *
 * The Houston METRO feed is clean — zero integrity errors — so watching the
 * validator pass on it proves nothing about whether it would catch anything.
 * Each case below takes the real feed, injects exactly one defect, and
 * asserts that defect is reported at the right severity. The last case runs
 * the undamaged feed and asserts silence, so the suite fails if the checks
 * ever start crying wolf.
 *
 * Usage:  npm run check:gtfs
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGtfsTables, type GtfsTables } from "./lib/gtfs-read.mts";
import { validateGtfs } from "./lib/gtfs-validate.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZIP = join(ROOT, ".cache", "houston_gtfs.zip");
if (!existsSync(ZIP)) {
  console.error(`no cached feed at ${ZIP} — run "npm run bake" first`);
  process.exit(1);
}
const base = readGtfsTables(ZIP);

/** Shallow clone so each case mutates in isolation. */
function clone(): GtfsTables {
  return {
    files: new Set(base.files),
    agency: base.agency.map((r) => ({ ...r })),
    stops: base.stops.slice(0, 400).map((r) => ({ ...r })),
    routes: base.routes.map((r) => ({ ...r })),
    trips: base.trips.slice(0, 200).map((r) => ({ ...r })),
    shapes: base.shapes.slice(0, 500).map((r) => ({ ...r })),
    calendar: base.calendar.map((r) => ({ ...r })),
    calendarDates: base.calendarDates.map((r) => ({ ...r })),
    stopTimes: base.stopTimes.slice(0, base.stopTimes.indexOf("\n", 200000)),
  };
}

const cases: [string, (t: GtfsTables) => void, "fatal" | "errors" | "warnings", RegExp][] = [
  ["missing required file", (t) => t.files.delete("stops.txt"), "fatal", /required file missing: stops\.txt/],
  ["missing calendar pair", (t) => { t.files.delete("calendar.txt"); t.files.delete("calendar_dates.txt"); }, "fatal", /calendar\.txt or calendar_dates\.txt/],
  ["missing required column", (t) => { for (const r of t.routes) delete r.route_type; }, "fatal", /routes\.txt missing required column: route_type/],
  ["missing stop_times column", (t) => { t.stopTimes = t.stopTimes.replace("stop_sequence", "seq_no"); }, "fatal", /stop_times\.txt missing required column: stop_sequence/],
  ["duplicate stop_id", (t) => t.stops.push({ ...t.stops[0] }), "errors", /duplicate stop_id/],
  ["impossible coordinates", (t) => { t.stops[0].stop_lat = "999"; }, "errors", /impossible coordinates/],
  ["dangling parent_station", (t) => { t.stops[1].parent_station = "NOPE"; }, "errors", /parent_station not a known stop/],
  ["dangling trip.route_id", (t) => { t.trips[0].route_id = "NOPE"; }, "errors", /trip\.route_id not a known route/],
  ["dangling trip.service_id", (t) => { t.trips[0].service_id = "NOPE"; }, "errors", /trip\.service_id not in calendar/],
  ["dangling trip.shape_id", (t) => { t.trips[0].shape_id = "NOPE"; }, "errors", /trip\.shape_id not in shapes/],
  ["bad shape point", (t) => { t.shapes[0].shape_pt_lat = "abc"; }, "errors", /shape point with impossible coordinates/],
  ["duplicate shape sequence", (t) => t.shapes.push({ ...t.shapes[1] }), "errors", /duplicate shape_pt_sequence/],
  ["dangling stop_time.stop_id", (t) => { t.stops.length = 1; }, "errors", /stop_time\.stop_id not a known stop/],
  ["dangling stop_time.trip_id", (t) => { t.trips.length = 1; }, "errors", /stop_time\.trip_id not a known trip/],
  ["unrecognised route_type", (t) => { t.routes[0].route_type = "42"; }, "warnings", /unrecognised route_type/],
];

let failed = 0;
for (const [name, damage, bucket, expect] of cases) {
  const t = clone();
  damage(t);
  const r = validateGtfs(t);
  const hit = r[bucket].some((m) => expect.test(m));
  if (!hit) {
    failed++;
    console.log(`✗ ${name}\n    expected ${bucket} matching ${expect}\n    got ${JSON.stringify(r[bucket])}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// A trip whose stop_sequence goes backwards, and whose times run backwards.
{
  const t = clone();
  const lines = t.stopTimes.split("\n");
  const header = lines[0].split(",");
  const iSeq = header.indexOf("stop_sequence");
  const iArr = header.indexOf("arrival_time");
  const row = lines[2].split(",");
  row[iSeq] = "0";
  row[iArr] = "99:99:99";
  lines[2] = row.join(",");
  t.stopTimes = lines.join("\n");
  const r = validateGtfs(t);
  for (const [label, re] of [
    ["stop_sequence not increasing", /stop_sequence not increasing/],
    ["unparseable time", /unparseable arrival\/departure time/],
  ] as const) {
    if (r.errors.some((m) => re.test(m))) console.log(`✓ ${label}`);
    else { failed++; console.log(`✗ ${label} — got ${JSON.stringify(r.errors)}`); }
  }
}

// Control: the real, whole feed must come back clean — the sliced clones
// above are deliberately incomplete and would dangle on their own.
{
  const r = validateGtfs(base);
  if (r.fatal.length === 0 && r.errors.length === 0) console.log("✓ control (full feed) clean");
  else { failed++; console.log(`✗ control — ${JSON.stringify([r.fatal, r.errors])}`); }
}

console.log(failed === 0 ? "\nall validator cases pass" : `\n${failed} case(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
