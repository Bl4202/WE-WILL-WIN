/**
 * Invariant and regression tests for the simulation kernel.
 *
 * The kernel is the one part of this game with a hard contract — GDD §4.3: a
 * fixed 4 Hz timestep, every draw through one seeded Rng, and therefore the
 * same state from the same seed every time. Nothing enforced that contract
 * until this file existed, so the checks here are deliberately about
 * *properties* rather than golden values: a digest that must match itself, a
 * conservation law, a bound that must hold. Those survive tuning changes;
 * hard-coded expected outputs would not.
 *
 * This runs the real kernel with the real Houston bundle, in Node, with no
 * browser and no test framework. That works because src/simulation.ts and
 * everything it imports are free of DOM references — keep it that way, or
 * this harness dies with it.
 *
 * Usage:  npm run check:sim
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_CACHE_LIMIT } from "../src/constants.ts";
import { Projection } from "../src/geo.ts";
import { createHoustonFacilities } from "../src/mobility.ts";
import { Simulation } from "../src/simulation.ts";
import type { LinePoint } from "../src/simulation.ts";
import type { SimSnapshot, Zone } from "../src/types.ts";
import { zonesFromDemand, type DemandFile } from "../src/world.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEMAND = join(ROOT, "public", "world", "houston", "v1", "demand.json");

if (!existsSync(DEMAND)) {
  console.error(`no demand bundle at ${DEMAND} — run "npm run bake" first`);
  process.exit(1);
}

const demand = JSON.parse(readFileSync(DEMAND, "utf8")) as DemandFile;
const projection = new Projection(demand.origin);
const zones: Zone[] = zonesFromDemand(demand, projection);

/** Zones ordered by population — a stable way to pick plausible station sites. */
const byPop = [...zones].sort((a, b) => b.pop - a.pop || a.id - b.id);

function newSim(): Simulation {
  return new Simulation(zones, createHoustonFacilities(projection));
}

/** Build a line through the `count` densest zones starting at `offset`. */
function line(sim: Simulation, count: number, offset = 0) {
  const points: LinePoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push({ pos: byPop[offset + i].center });
  }
  return sim.commitLine(points, "metro", "surface");
}

/**
 * Money is not the subject of any test here, and every one of them would
 * otherwise be a test of the construction budget instead.
 */
function fund(sim: Simulation): void {
  sim.economy.capitalBalance = 1e12;
}

function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.tick();
}

// ── Test plumbing ─────────────────────────────────────────────────────

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/**
 * A stable fingerprint of everything the kernel is responsible for. Rounded,
 * because the point is to catch a divergent execution path, not to argue
 * about the last bit of a float.
 */
function digest(snap: SimSnapshot): string {
  const parts: string[] = [
    `t=${snap.simTimeSec.toFixed(2)}`,
    `pax=${snap.passengers.size}`,
    `kpi=${JSON.stringify(snap.kpis)}`,
    `cap=${Math.round(snap.economy.capitalBalance)}`,
    `op=${Math.round(snap.economy.operatingBalance)}`,
    `traffic=${JSON.stringify(snap.traffic)}`,
  ];
  for (const v of snap.vehicles) {
    parts.push(`v${v.id}:${v.dist.toFixed(3)}:${v.dir}:${v.onboard.length}`);
  }
  for (const s of [...snap.stations.values()].sort((a, b) => a.id - b.id)) {
    parts.push(`s${s.id}:${s.waiting.length}:${s.boardingsToday}`);
  }
  return parts.join("|");
}

// ── 1. Determinism ────────────────────────────────────────────────────

section("determinism");
{
  const build = (sim: Simulation) => {
    fund(sim);
    const l = line(sim, 8);
    fund(sim);
    for (let i = 0; i < 3; i++) {
      const v = sim.purchaseVehicle("metro-nova-m7");
      if (v && l) sim.assignVehicle(v.id, l.id);
      fund(sim);
    }
  };

  const a = newSim();
  build(a);
  run(a, 20_000);

  const b = newSim();
  build(b);
  run(b, 20_000);

  check(
    "two runs from the same seed agree after 20k ticks",
    digest(a.snapshot()) === digest(b.snapshot()),
  );

  // Same total sim time, reached in differently-sized batches. The fixed
  // timestep means batching must not matter; if it ever does, something is
  // reading wall-clock time.
  const c = newSim();
  build(c);
  for (let i = 0; i < 200; i++) run(c, 100);

  check(
    "tick batching does not change the outcome",
    digest(a.snapshot()) === digest(c.snapshot()),
    "batched run diverged from the single-batch run",
  );
}

// ── 2. Trip conservation ──────────────────────────────────────────────

section("trip conservation");
{
  const sim = newSim();
  fund(sim);
  const l = line(sim, 8);
  fund(sim);
  const v = sim.purchaseVehicle("metro-nova-m7");
  if (v && l) sim.assignVehicle(v.id, l.id);
  fund(sim);

  run(sim, 60_000);
  const before = sim.snapshot().passengers.size;

  // Pull the only vehicle. Every passenger who was relying on that line has
  // to end up somewhere accountable: re-planned onto another line, or
  // retired as unserved. Nobody may simply stay queued forever for a service
  // that no longer runs.
  if (v) sim.unassignVehicle(v.id);
  run(sim, 40_000);

  const snap = sim.snapshot();
  const servedLines = new Set(
    snap.vehicles.filter((veh) => veh.lineId !== null).map((veh) => veh.lineId),
  );
  let strandedWaiting = 0;
  for (const station of snap.stations.values()) {
    for (const pid of station.waiting) {
      const p = snap.passengers.get(pid);
      const leg = p?.legs[p.legIndex];
      if (leg && !servedLines.has(leg.lineId)) strandedWaiting++;
    }
  }

  check(
    "no passenger waits for a line with no vehicle",
    strandedWaiting === 0,
    `${strandedWaiting} stranded (had ${before} active before the unassign)`,
  );
}

// ── 3. Fleet size actually buys service ───────────────────────────────

section("fleet dispatch");
{
  const sim = newSim();
  fund(sim);
  const l = line(sim, 6);
  fund(sim);
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = sim.purchaseVehicle("metro-nova-m7");
    if (v && l) {
      sim.assignVehicle(v.id, l.id);
      ids.push(v.id);
    }
    fund(sim);
  }
  run(sim, 4_000);

  const fleet = sim.snapshot().vehicles.filter((v) => ids.includes(v.id));
  const states = new Set(fleet.map((v) => `${v.dist.toFixed(1)}:${v.dir}`));

  check(
    "four vehicles on a line occupy four distinct positions",
    states.size === 4,
    `${states.size} distinct of ${fleet.length} — vehicles are running as one`,
  );

  // Headway is what the UI advertises and what the planner prices waiting
  // time from, so it has to describe the service that is actually run.
  const served = sim.lines.get(l!.id)!;
  check(
    "advertised headway is positive with a fleet assigned",
    served.headwaySec > 0,
    `headwaySec=${served.headwaySec}`,
  );
}

// ── 4. Bounded memory ─────────────────────────────────────────────────

section("bounded growth");
{
  const sim = newSim();
  fund(sim);
  const l = line(sim, 8);
  fund(sim);
  const v = sim.purchaseVehicle("metro-nova-m7");
  if (v && l) sim.assignVehicle(v.id, l.id);
  fund(sim);

  // No network edits from here, so nothing legitimately invalidates the plan
  // cache — it may only grow to its own bound.
  run(sim, 40_000);
  const early = sim.planCacheSize;
  run(sim, 160_000);
  const late = sim.planCacheSize;

  // The key space is 1560 zones squared — about 2.4M origin/destination
  // pairs — so "it only caches what is asked for" is not a bound.
  check(
    "plan cache stays bounded over a long unedited session",
    late <= PLAN_CACHE_LIMIT,
    `grew ${early} → ${late} entries with no network change`,
  );
}

// ── 5. Performance baselines ──────────────────────────────────────────

section("performance");
{
  const sim = newSim();
  fund(sim);
  for (let i = 0; i < 40; i++) {
    const l = line(sim, 10, i * 10);
    fund(sim);
    for (let k = 0; k < 4 && l; k++) {
      const v = sim.purchaseVehicle("metro-nova-m7");
      if (v) sim.assignVehicle(v.id, l.id);
      fund(sim);
    }
  }

  run(sim, 20_000);
  const t0 = performance.now();
  run(sim, 40_000);
  const usPerTick = ((performance.now() - t0) / 40_000) * 1000;

  // Measured at ~17 us/tick on this network before any optimization. The
  // ceiling is deliberately loose: this exists to catch an order-of-magnitude
  // regression, not to fail on a slow machine or a noisy CI runner.
  check(
    "tick cost stays within budget at 400 stations",
    usPerTick < 120,
    `${usPerTick.toFixed(1)} us/tick (baseline ~17)`,
  );

  const fresh = newSim();
  fund(fresh);
  for (let i = 0; i < 39; i++) {
    line(fresh, 10, i * 10);
    fund(fresh);
  }
  const c0 = performance.now();
  line(fresh, 10, 390);
  const commitMs = performance.now() - c0;

  // Measured 9.4 ms at 400 stations, rising to 20.9 ms at 800 — commitLine
  // scales with the station count because it rescans every zone. It runs
  // synchronously inside the player's click, so it is worth watching even
  // though it is not currently a visible stall.
  check(
    "committing a line into a large network stays responsive",
    commitMs < 40,
    `${commitMs.toFixed(1)} ms to commit the 40th line (baseline 9.4)`,
  );
}

// ── Report ────────────────────────────────────────────────────────────

console.log(
  `\n${checks - failures}/${checks} checks passed` +
    (failures ? ` — ${failures} FAILED` : ""),
);
process.exit(failures ? 1 : 0);
