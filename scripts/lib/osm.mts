/**
 * OSM extract → routable street/rail graph (GDD §1.4, §8 Phase 1).
 *
 * Overpass is queried tile by tile over the region bbox and each response is
 * distilled to the handful of fields a routing graph needs before it is
 * cached, so a re-bake reads tens of MB off disk instead of re-pulling
 * hundreds from a public API. Ways that straddle a tile edge come back
 * complete in every tile they touch (Overpass returns whole ways plus all
 * their nodes), so deduplicating by way id stitches the tiles into one
 * seamless graph.
 *
 * The graph itself is the standard shape: nodes are junctions and way
 * endpoints only, edges are the degree-2 chains between them carrying their
 * full polyline. Contraction Hierarchies and the road assignment of §4.1
 * consume this in Phase 2; nothing in the client loads it yet, which is why
 * it is allowed to be the largest file in the bundle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** [minLat, minLng, maxLat, maxLng]. */
export type BBox = [number, number, number, number];

/** Everything a bus, car, or train can run on; `service` (driveways, parking
 *  aisles) is excluded — it triples the way count and routes nowhere. */
const HIGHWAY_CLASSES = [
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "unclassified", "residential", "living_street",
  "motorway_link", "trunk_link", "primary_link", "secondary_link",
  "tertiary_link",
];
const RAILWAY_CLASSES = ["rail", "light_rail", "subway", "tram", "narrow_gauge"];

/** Class order is the on-disk encoding — append only, never reorder. */
export const EDGE_CLASSES = [...HIGHWAY_CLASSES, ...RAILWAY_CLASSES];
const CLASS_INDEX = new Map(EDGE_CLASSES.map((c, i) => [c, i]));
/** First index of a rail class, so consumers can split road from rail. */
export const FIRST_RAIL_CLASS = HIGHWAY_CLASSES.length;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Tile size in degrees. ~0.1° keeps the densest inner-city tile near 10 MB. */
const TILE_LAT = 0.1;
const TILE_LNG = 0.11;

/** Cache precision: OSM's own 1e-7 degrees. */
const CACHE_SCALE = 1e7;
/** Output precision: 1e-5 degrees ≈ 1.1 m, far finer than any snap tolerance,
 *  and short enough as an integer to keep the graph file down to tens of MB. */
export const GRAPH_SCALE = 1e5;

/** Distilled Overpass tile: ways as [id, classIdx, oneway, ...nodeIds]. */
interface Tile {
  w: number[][];
  /** Flat [id, lat*1e7, lng*1e7, …]. */
  n: number[];
}

export interface OsmGraph {
  bbox: BBox;
  /** Degrees per unit of every integer coordinate below. */
  coordScale: number;
  classes: string[];
  firstRailClass: number;
  /** Junction/endpoint nodes, flat [lng, lat, …], scaled integers. */
  nodes: number[];
  /** Edge endpoints as node indices, flat [a, b, …]. */
  edges: number[];
  edgeClass: number[];
  /** 1 forward-only, -1 reverse-only, 0 bidirectional. */
  edgeOneway: number[];
  edgeLenM: number[];
  /** Per-edge slice bounds into `geom` (length edgeCount + 1). */
  geomOffset: number[];
  /**
   * Every edge's polyline, endpoints included, flat and scaled. Within an
   * edge the first point is absolute and the rest are deltas from their
   * predecessor — consecutive OSM shape points are metres apart, so the
   * deltas are one- and two-digit integers where absolutes are eight.
   */
  geom: number[];
}

export interface OsmStats {
  tiles: number;
  waysRaw: number;
  nodesRaw: number;
  graphNodes: number;
  graphEdges: number;
  roadKm: number;
  railKm: number;
  /** Share of edge length in the largest connected component, 0–1. */
  largestComponentShare: number;
}

export function tilesFor(bbox: BBox): BBox[] {
  const [minLat, minLng, maxLat, maxLng] = bbox;
  const out: BBox[] = [];
  for (let lat = minLat; lat < maxLat - 1e-9; lat += TILE_LAT) {
    for (let lng = minLng; lng < maxLng - 1e-9; lng += TILE_LNG) {
      out.push([
        lat,
        lng,
        Math.min(lat + TILE_LAT, maxLat),
        Math.min(lng + TILE_LNG, maxLng),
      ]);
    }
  }
  return out;
}

function overpassQuery(t: BBox): string {
  const bb = t.map((v) => v.toFixed(4)).join(",");
  const hw = HIGHWAY_CLASSES.join("|");
  const rw = RAILWAY_CLASSES.join("|");
  return (
    `[out:json][timeout:300];(` +
    `way["highway"~"^(${hw})$"](${bb});` +
    `way["railway"~"^(${rw})$"](${bb});` +
    `);out body qt;>;out skel qt;`
  );
}

function onewayOf(tags: Record<string, string>): number {
  const j = tags.junction;
  if (j === "roundabout" || j === "circular") return 1;
  const o = tags.oneway;
  if (o === "yes" || o === "true" || o === "1") return 1;
  if (o === "-1" || o === "reverse") return -1;
  return 0;
}

interface OverpassResponse {
  elements: {
    type: string;
    id: number;
    nodes?: number[];
    tags?: Record<string, string>;
    lat?: number;
    lon?: number;
  }[];
}

/** Keep only what the graph needs; the raw response is several times this
 *  (TIGER import cruft, names, lane counts) and is discarded unparsed. */
function distill(raw: OverpassResponse): Tile {
  const tile: Tile = { w: [], n: [] };
  for (const e of raw.elements) {
    if (e.type === "way") {
      const tags = e.tags ?? {};
      const cls =
        CLASS_INDEX.get(tags.highway ?? "") ?? CLASS_INDEX.get(tags.railway ?? "");
      if (cls === undefined || !e.nodes || e.nodes.length < 2) continue;
      tile.w.push([e.id, cls, onewayOf(tags), ...e.nodes]);
    } else if (e.type === "node" && e.lat !== undefined && e.lon !== undefined) {
      tile.n.push(
        e.id,
        Math.round(e.lat * CACHE_SCALE),
        Math.round(e.lon * CACHE_SCALE),
      );
    }
  }
  return tile;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one tile, distil it, and cache it. Overpass rate-limits and sheds
 * load under contention, so 429/504 are routine rather than exceptional:
 * back off and fall through to the mirror before giving up.
 */
async function fetchTile(
  t: BBox,
  cacheDir: string,
  warn: (m: string) => void,
): Promise<Tile> {
  const name = `${t[0].toFixed(2)}_${t[1].toFixed(2)}.json`;
  const path = join(cacheDir, name);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as Tile;

  const body = "data=" + encodeURIComponent(overpassQuery(t));
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // Overpass answers 406 without a UA it recognises as a real client.
          "user-agent": "metro-world-baker/0.1 (Metro transit game, GDD Phase 1)",
          accept: "application/json",
        },
        body,
      });
      if (res.status === 429 || res.status === 504) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tile = distill((await res.json()) as OverpassResponse);
      writeFileSync(path, JSON.stringify(tile));
      return tile;
    } catch (e) {
      warn(`overpass tile ${name} attempt ${attempt + 1}: ${e}`);
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`overpass tile ${name} failed after 6 attempts`);
}

/** Growable id→slot table over parallel scaled-integer coordinate arrays;
 *  a Map of plain {lat,lng} objects at this node count is not affordable. */
class NodeStore {
  private readonly index = new Map<number, number>();
  private lat = new Int32Array(1 << 20);
  private lng = new Int32Array(1 << 20);
  size = 0;

  put(id: number, latE7: number, lngE7: number): void {
    if (this.index.has(id)) return;
    if (this.size === this.lat.length) {
      const lat = new Int32Array(this.size * 2);
      const lng = new Int32Array(this.size * 2);
      lat.set(this.lat);
      lng.set(this.lng);
      this.lat = lat;
      this.lng = lng;
    }
    this.lat[this.size] = latE7;
    this.lng[this.size] = lngE7;
    this.index.set(id, this.size++);
  }

  slot(id: number): number | undefined {
    return this.index.get(id);
  }
  latOf(slot: number): number {
    return this.lat[slot] / CACHE_SCALE;
  }
  lngOf(slot: number): number {
    return this.lng[slot] / CACHE_SCALE;
  }
}

/** Union–find, only used to measure how connected the result is. */
function componentShare(
  edges: number[],
  lens: number[],
  nodeCount: number,
): number {
  const parent = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  for (let e = 0; e < lens.length; e++) {
    const a = find(edges[e * 2]);
    const b = find(edges[e * 2 + 1]);
    if (a !== b) parent[a] = b;
  }
  const byRoot = new Map<number, number>();
  let total = 0;
  for (let e = 0; e < lens.length; e++) {
    const r = find(edges[e * 2]);
    byRoot.set(r, (byRoot.get(r) ?? 0) + lens[e]);
    total += lens[e];
  }
  let largest = 0;
  for (const v of byRoot.values()) if (v > largest) largest = v;
  return total > 0 ? largest / total : 0;
}

/**
 * Download (or read from cache) every tile of `bbox` and fold them into one
 * graph. Ways split at every node another way also touches, and the degree-2
 * runs between those junctions collapse into a single edge.
 */
export async function bakeOsmGraph(
  bbox: BBox,
  cacheRoot: string,
  warn: (m: string) => void,
  log: (m: string) => void,
): Promise<{ graph: OsmGraph; stats: OsmStats }> {
  const cacheDir = join(cacheRoot, "osm");
  mkdirSync(cacheDir, { recursive: true });

  const tiles = tilesFor(bbox);
  const nodes = new NodeStore();
  // Way id → [classIdx, oneway, ...node slots]. Deduplicates the overlap
  // between tiles: the same way arrives once per tile it crosses.
  const ways = new Map<number, number[]>();

  for (let i = 0; i < tiles.length; i++) {
    const tile = await fetchTile(tiles[i], cacheDir, warn);
    for (let k = 0; k < tile.n.length; k += 3) {
      nodes.put(tile.n[k], tile.n[k + 1], tile.n[k + 2]);
    }
    for (const w of tile.w) {
      if (ways.has(w[0])) continue;
      const slots: number[] = [w[1], w[2]];
      let complete = true;
      for (let k = 3; k < w.length; k++) {
        const s = nodes.slot(w[k]);
        // Only possible if the way's own tile has not been read yet; it will
        // arrive complete there, so skip this copy rather than truncating it.
        if (s === undefined) {
          complete = false;
          break;
        }
        slots.push(s);
      }
      if (complete && slots.length >= 4) ways.set(w[0], slots);
    }
    log(`  tile ${i + 1}/${tiles.length} · ${ways.size} ways · ${nodes.size} nodes`);
  }

  // Junctions: any node two ways touch, any node a single way visits twice,
  // and every way's own endpoints.
  const refs = new Int32Array(nodes.size);
  for (const w of ways.values()) {
    for (let k = 2; k < w.length; k++) refs[w[k]]++;
    refs[w[2]] += 2;
    refs[w[w.length - 1]] += 2;
  }

  const graphIndex = new Int32Array(nodes.size).fill(-1);
  const gNodes: number[] = [];
  const e5 = (deg: number) => Math.round(deg * GRAPH_SCALE);
  const nodeIndex = (slot: number): number => {
    let g = graphIndex[slot];
    if (g === -1) {
      g = gNodes.length / 2;
      gNodes.push(e5(nodes.lngOf(slot)), e5(nodes.latOf(slot)));
      graphIndex[slot] = g;
    }
    return g;
  };

  const mPerLat = 110540;
  const mPerLng = 111320 * Math.cos((((bbox[0] + bbox[2]) / 2) * Math.PI) / 180);

  const edges: number[] = [];
  const edgeClass: number[] = [];
  const edgeOneway: number[] = [];
  const edgeLenM: number[] = [];
  const geomOffset: number[] = [0];
  const geom: number[] = [];

  for (const w of ways.values()) {
    const cls = w[0];
    const oneway = w[1];
    let startK = 2;
    for (let k = 3; k < w.length; k++) {
      if (k !== w.length - 1 && refs[w[k]] < 2) continue;
      const a = nodeIndex(w[startK]);
      const b = nodeIndex(w[k]);
      if (a !== b || k - startK > 1) {
        let len = 0;
        let prevLng = 0;
        let prevLat = 0;
        for (let m = startK; m <= k; m++) {
          const slot = w[m];
          const lng = e5(nodes.lngOf(slot));
          const lat = e5(nodes.latOf(slot));
          if (m === startK) geom.push(lng, lat);
          else {
            geom.push(lng - prevLng, lat - prevLat);
            len += Math.hypot(
              ((lng - prevLng) / GRAPH_SCALE) * mPerLng,
              ((lat - prevLat) / GRAPH_SCALE) * mPerLat,
            );
          }
          prevLng = lng;
          prevLat = lat;
        }
        edges.push(a, b);
        edgeClass.push(cls);
        edgeOneway.push(oneway);
        edgeLenM.push(Math.round(len));
        geomOffset.push(geom.length);
      }
      startK = k;
    }
  }

  let roadM = 0;
  let railM = 0;
  for (let e = 0; e < edgeLenM.length; e++) {
    if (edgeClass[e] >= FIRST_RAIL_CLASS) railM += edgeLenM[e];
    else roadM += edgeLenM[e];
  }

  return {
    graph: {
      bbox,
      coordScale: GRAPH_SCALE,
      classes: EDGE_CLASSES,
      firstRailClass: FIRST_RAIL_CLASS,
      nodes: gNodes,
      edges,
      edgeClass,
      edgeOneway,
      edgeLenM,
      geomOffset,
      geom,
    },
    stats: {
      tiles: tiles.length,
      waysRaw: ways.size,
      nodesRaw: nodes.size,
      graphNodes: gNodes.length / 2,
      graphEdges: edgeLenM.length,
      roadKm: Math.round(roadM / 1000),
      railKm: Math.round(railM / 1000),
      largestComponentShare:
        Math.round(componentShare(edges, edgeLenM, gNodes.length / 2) * 1000) / 1000,
    },
  };
}
