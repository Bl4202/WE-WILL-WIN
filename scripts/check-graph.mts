/**
 * Round-trip and behaviour tests for the baked street graph.
 *
 * The binary format exists so the client can route buses on the real street
 * network instead of on whatever vector tiles the camera happened to load.
 * That makes two things worth pinning down: that the encoder and the decoder
 * agree byte for byte, and that the graph they carry actually routes.
 *
 * Both halves run here against the real Houston bake — the encoder from
 * street_graph.json, the decoder over the emitted street_graph.bin — with a
 * stubbed `fetch`, because RoadGraph is browser code and its only browser
 * dependency is that one call.
 *
 * Usage:  npm run check:graph
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Projection } from "../src/geo.ts";
import type { DemandFile } from "../src/world.ts";
import { encodeGraphBin, type EncodableGraph } from "./lib/graph-bin.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORLD = join(ROOT, "public", "world", "houston", "v1");
const JSON_GRAPH = join(WORLD, "street_graph.json");
const BIN_GRAPH = join(WORLD, "street_graph.bin");
const DEMAND = join(WORLD, "demand.json");

for (const path of [BIN_GRAPH, DEMAND]) {
  if (!existsSync(path)) {
    console.error(`missing ${path} — run "npm run bake" first`);
    process.exit(1);
  }
}

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const demand = JSON.parse(readFileSync(DEMAND, "utf8")) as DemandFile;
const projection = new Projection(demand.origin);

// RoadGraph fetches; hand it the bytes off disk instead.
const binary = readFileSync(BIN_GRAPH);
const arrayBuffer = binary.buffer.slice(
  binary.byteOffset,
  binary.byteOffset + binary.byteLength,
) as ArrayBuffer;
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => arrayBuffer,
});

const { RoadGraph } = await import("../src/road-graph.ts");

section("decode");
const decodeStart = performance.now();
const graph = await RoadGraph.load("", projection);
const decodeMs = performance.now() - decodeStart;

check(
  "decodes the baked binary",
  graph.nodeCount > 100_000 && graph.edgeCount > 100_000,
  `${graph.nodeCount} nodes, ${graph.edgeCount} edges`,
);
// Measured at 73 ms to decode 11.4 MB and build the adjacency and the
// 1.34M-point spatial index. This runs once, lazily, while the player is
// drawing, so the ceiling is set to catch an order-of-magnitude regression
// rather than to police the exact number on someone else's machine.
check(
  "decode and index stay well under a frame budget's worth of stall",
  decodeMs < 400,
  `${decodeMs.toFixed(0)} ms to decode ${(binary.length / 1048576).toFixed(1)} MB and build both indexes (baseline 73)`,
);

// ── Encoder/decoder agreement ─────────────────────────────────────────

section("round trip");
if (!existsSync(JSON_GRAPH)) {
  console.log("  skip  street_graph.json absent (gitignored) — encoder half");
} else {
  const source = JSON.parse(readFileSync(JSON_GRAPH, "utf8")) as EncodableGraph;
  const encoded = encodeGraphBin(source);

  check(
    "re-encoding the source graph reproduces the committed binary",
    encoded.buffer.length === binary.length &&
      encoded.buffer.equals(binary),
    `${encoded.buffer.length} bytes vs ${binary.length} on disk`,
  );

  // Node positions must survive the node remap. Two filters run — rail, then
  // disconnected islands — so the mapping back to source edges comes from the
  // encoder itself rather than being re-derived here; an off-by-one in the
  // remap would still decode cleanly and route plausibly while pointing at
  // entirely the wrong streets.
  let mismatches = 0;
  let checked = 0;
  for (let i = 0; i < encoded.keptSourceEdges.length; i += 37) {
    checked++;
    const sourceNode = source.edges[encoded.keptSourceEdges[i] * 2];
    const expected = projection.toWorld(
      source.nodes[sourceNode * 2 + 1] / source.coordScale,
      source.nodes[sourceNode * 2] / source.coordScale,
    );
    const actual = graph.edgeStartPosition(i);
    if (
      Math.abs(actual.x - expected.x) > 1e-6 ||
      Math.abs(actual.y - expected.y) > 1e-6
    ) {
      mismatches++;
    }
  }
  check(
    "road edges still point at their original nodes after the remap",
    mismatches === 0,
    `${mismatches} of ${checked} sampled edges moved`,
  );
  check(
    "island pruning kept the graph almost whole",
    encoded.droppedIslandEdges / (encoded.droppedIslandEdges + graph.edgeCount) <
      0.01,
    `${encoded.droppedIslandEdges} road edges dropped as unreachable`,
  );
}

// ── Snapping ──────────────────────────────────────────────────────────

section("snapping");

// The OSM bake covers the metro core, which is a tighter box than the census
// tracts span. Measured: 294 of 1,560 tract centroids (18.8%) sit outside it
// entirely. Those are legitimately unroutable, so coverage is filtered here
// rather than counted as a failure — testing against them would only be
// testing the bbox.
const covered = demand.zones.filter((zone) => graph.covers(zone.lng, zone.lat));
console.log(
  `       ${covered.length}/${demand.zones.length} tract centres inside the graph bbox`,
);

{
  // Probe from points that are actually on the network, displaced by a bounded
  // offset — which is what a player clicking a road they can see looks like.
  //
  // Tract centroids are a bad proxy and were the first thing tried: they are
  // geometric centres, so they land in parks, water and superblock interiors.
  // Brute-forcing all 1.34M road vertices confirmed the misses were real — the
  // nearest road to those centroids is genuinely 154-704 m away — so testing
  // against them measured Houston's land use, not this index.
  const sample = 500;
  const maxOffsetM = 60;
  let hits = 0;
  let worst = 0;
  let deterministic = 0;
  const snapStart = performance.now();
  for (let i = 0; i < sample; i++) {
    const onRoad = graph.samplePoint((i * 104729) % graph.shapePointCount);
    // A fixed spiral rather than random, so a failure is reproducible.
    const angle = i * 2.399963;
    const radius = ((i % 17) / 16) * maxOffsetM;
    const probe = {
      x: onRoad.x + Math.cos(angle) * radius,
      y: onRoad.y + Math.sin(angle) * radius,
    };
    const snap = graph.snap(probe);
    if (snap) {
      hits++;
      worst = Math.max(worst, snap.distanceM);
      const again = graph.snap(probe);
      if (again && again.pos.x === snap.pos.x && again.pos.y === snap.pos.y) {
        deterministic++;
      }
    }
  }
  const perSnapMs = (performance.now() - snapStart) / (sample * 2);

  check(
    "a click near a road always finds it",
    hits === sample,
    `${hits}/${sample} snapped, worst ${worst.toFixed(0)} m for a ${maxOffsetM} m offset`,
  );
  // Projection onto the segment means the result should be no further than
  // the offset itself — if it comes back further, the index missed the real
  // nearest road and found some other one.
  check(
    "snaps land no further away than the probe offset",
    worst <= maxOffsetM + 1,
    `worst ${worst.toFixed(1)} m against a ${maxOffsetM} m offset`,
  );
  check(
    "snapping is deterministic",
    deterministic === hits,
    `${hits - deterministic} of ${hits} differed on a repeat query`,
  );
  check(
    "snapping is fast enough for a mousemove",
    perSnapMs < 1,
    `${perSnapMs.toFixed(3)} ms per snap`,
  );
}

// Reported, not asserted: how much of the populated area is actually
// reachable. This is a property of the bake's extent and Houston's land use,
// not of the code under test, but it is the number to look at if bus building
// ever feels patchy.
{
  let reachable = 0;
  for (let i = 0; i < 400; i++) {
    const zone = covered[(i * 7919) % covered.length];
    if (graph.snap(projection.toWorld(zone.lat, zone.lng), 400)) reachable++;
  }
  console.log(
    `       ${reachable}/400 sampled tract centres have a road within 400 m`,
  );
}

// ── Routing ───────────────────────────────────────────────────────────

section("routing");
{
  // Endpoints taken from the network itself. Routing from tract centroids
  // conflated two different questions — "does this centroid have a road near
  // it" and "do these two roads connect" — and the first one failing made the
  // second look broken.
  const spread = Math.floor(graph.shapePointCount / 11);
  const pairs: Array<[number, number]> = [
    [spread, spread * 2],
    [spread, spread * 5],
    [spread * 3, spread * 4],
    [spread * 2, spread * 9],
    [spread * 6, spread * 10],
  ];
  let routed = 0;
  let worstRatio = 0;
  let slowest = 0;

  for (const [i, j] of pairs) {
    const a = graph.samplePoint(i);
    const b = graph.samplePoint(j);
    const straight = Math.hypot(a.x - b.x, a.y - b.y);
    const started = performance.now();
    const path = graph.routeBetween(a, b);
    const ms = performance.now() - started;
    slowest = Math.max(slowest, ms);

    if (!path || path.length < 2) {
      console.log(
        `       no route for pair ${i}->${j} (${(straight / 1000).toFixed(1)} km apart)`,
      );
      continue;
    }
    routed++;
    let length = 0;
    for (let k = 1; k < path.length; k++) {
      length += Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y);
    }
    worstRatio = Math.max(worstRatio, length / Math.max(1, straight));
    console.log(
      `       ${i}->${j}: ${path.length} pts, ${(length / 1000).toFixed(1)} km road ` +
        `vs ${(straight / 1000).toFixed(1)} km straight, ${ms.toFixed(0)} ms`,
    );
  }

  check(
    "every sampled pair routes",
    routed === pairs.length,
    `${routed}/${pairs.length} connected`,
  );
  // A road route is longer than the crow flies, but not by much on a grid
  // city. A wild ratio means the search is wandering, not that Houston is.
  check(
    "routes are not absurdly indirect",
    worstRatio < 2.2,
    `worst road/straight ratio ${worstRatio.toFixed(2)}`,
  );
  check(
    "a cross-city route stays interactive",
    slowest < 1500,
    `slowest ${slowest.toFixed(0)} ms`,
  );

  // The whole point of the rework: the answer must not depend on anything
  // outside the graph.
  const a = graph.samplePoint(spread);
  const b = graph.samplePoint(spread * 5);
  const first = graph.routeBetween(a, b);
  const second = graph.routeBetween(a, b);
  check(
    "routing is deterministic",
    JSON.stringify(first) === JSON.stringify(second),
    "same query returned two different paths",
  );
}

console.log(
  `\n${checks - failures}/${checks} checks passed` +
    (failures ? ` — ${failures} FAILED` : ""),
);
process.exit(failures ? 1 : 0);
