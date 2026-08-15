/**
 * Conflation: GTFS stops snapped onto the OSM graph (GDD §8 Phase 1).
 *
 * Every stop is projected onto the nearest segment of a mode-compatible edge
 * — bus and other road stops onto the street network, rail stops onto rail —
 * and the result records which edge, how far along it, and how far the stop
 * had to move. That last number is the honest part: a feed whose stops sit
 * 40 m off the street they claim to serve produces a walk-access model that
 * is wrong by 40 m everywhere, so the distribution of snap distances (and
 * the list of stops that matched nothing at all) is reported rather than
 * quietly absorbed.
 *
 * Downstream this is what lets §4.1 access/egress walk on real streets
 * instead of straight lines, and what anchors the reference network to the
 * same graph the player's own alignments will be drawn on.
 */
import { FIRST_RAIL_CLASS, type OsmGraph } from "./osm.mts";

export interface ConflationStop {
  id: string;
  lat: number;
  lng: number;
  /** GTFS route_types serving this stop; empty means unserved. */
  modes: number[];
}

export interface Conflation {
  toleranceM: number;
  stopIds: string[];
  /** Index into the graph's edge arrays, or -1 when nothing matched. */
  edge: number[];
  /** Fraction along the matched edge's polyline, by length. */
  t: number[];
  distM: number[];
  /** Snapped position, flat [lng, lat, …] at the graph's coordScale. */
  snap: number[];
}

export interface ConflationStats {
  stops: number;
  matched: number;
  unmatched: number;
  /** Matched within 25 m — the stop is on the street it says it is. */
  matchedTight: number;
  medianDistM: number;
  p90DistM: number;
  maxDistM: number;
  railStops: number;
  railMatched: number;
}

/** Snap radius. Beyond this the nearest street is a different street. */
const TOLERANCE_M = 100;
/** Grid cell for the segment index; a little over the tolerance. */
const CELL_M = 150;

/** GTFS route_types that ride rails rather than roads (tram/metro/rail,
 *  plus the extended 100–999 rail range and 900–999 tram range). */
function isRailMode(routeType: number): boolean {
  if (routeType <= 2) return true;
  if (routeType === 5 || routeType === 7 || routeType === 12) return true; // cable/funicular/monorail
  return routeType >= 100 && routeType < 1000;
}

/**
 * Decode the graph's delta-encoded polylines into one flat array of absolute
 * local-metre coordinates, plus a segment table the grid can index.
 */
function decodeSegments(g: OsmGraph) {
  const mPerLat = 110540;
  const mPerLng = 111320 * Math.cos((((g.bbox[0] + g.bbox[2]) / 2) * Math.PI) / 180);
  const pointCount = g.geom.length / 2;
  const px = new Float64Array(pointCount);
  const py = new Float64Array(pointCount);
  const pLng = new Float64Array(pointCount);
  const pLat = new Float64Array(pointCount);

  const edgeCount = g.edgeLenM.length;
  let segCount = 0;
  for (let e = 0; e < edgeCount; e++) {
    const from = g.geomOffset[e] / 2;
    const to = g.geomOffset[e + 1] / 2;
    let lng = 0;
    let lat = 0;
    for (let i = from; i < to; i++) {
      if (i === from) {
        lng = g.geom[i * 2];
        lat = g.geom[i * 2 + 1];
      } else {
        lng += g.geom[i * 2];
        lat += g.geom[i * 2 + 1];
      }
      pLng[i] = lng / g.coordScale;
      pLat[i] = lat / g.coordScale;
      px[i] = (pLng[i] - g.bbox[1]) * mPerLng;
      py[i] = (pLat[i] - g.bbox[0]) * mPerLat;
    }
    segCount += Math.max(0, to - from - 1);
  }

  // Segment i runs from point segPt[i] to segPt[i] + 1, on edge segEdge[i].
  const segEdge = new Int32Array(segCount);
  const segPt = new Int32Array(segCount);
  let s = 0;
  for (let e = 0; e < edgeCount; e++) {
    const from = g.geomOffset[e] / 2;
    const to = g.geomOffset[e + 1] / 2;
    for (let i = from; i < to - 1; i++) {
      segEdge[s] = e;
      segPt[s] = i;
      s++;
    }
  }
  return { px, py, pLng, pLat, segEdge, segPt, segCount, mPerLat, mPerLng };
}

/** Uniform grid over the segments, in CSR form (counting sort, two passes). */
function buildGrid(
  seg: ReturnType<typeof decodeSegments>,
  width: number,
  height: number,
) {
  const cellsX = Math.max(1, Math.ceil(width / CELL_M));
  const cellsY = Math.max(1, Math.ceil(height / CELL_M));
  const cellCount = cellsX * cellsY;
  const counts = new Int32Array(cellCount + 1);

  const clampX = (v: number) => Math.max(0, Math.min(cellsX - 1, v));
  const clampY = (v: number) => Math.max(0, Math.min(cellsY - 1, v));

  const visit = (s: number, fn: (cell: number) => void): void => {
    const i = seg.segPt[s];
    const x0 = clampX(Math.floor(Math.min(seg.px[i], seg.px[i + 1]) / CELL_M));
    const x1 = clampX(Math.floor(Math.max(seg.px[i], seg.px[i + 1]) / CELL_M));
    const y0 = clampY(Math.floor(Math.min(seg.py[i], seg.py[i + 1]) / CELL_M));
    const y1 = clampY(Math.floor(Math.max(seg.py[i], seg.py[i + 1]) / CELL_M));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) fn(y * cellsX + x);
    }
  };

  for (let s = 0; s < seg.segCount; s++) visit(s, (c) => counts[c + 1]++);
  for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
  const items = new Int32Array(counts[cellCount]);
  const cursor = counts.slice(0, cellCount);
  for (let s = 0; s < seg.segCount; s++) visit(s, (c) => { items[cursor[c]++] = s; });

  return { cellsX, cellsY, counts, items };
}

export function conflateStops(
  graph: OsmGraph,
  stops: ConflationStop[],
): { conflation: Conflation; stats: ConflationStats; unmatched: string[] } {
  const seg = decodeSegments(graph);
  const width = (graph.bbox[3] - graph.bbox[1]) * seg.mPerLng;
  const height = (graph.bbox[2] - graph.bbox[0]) * seg.mPerLat;
  const grid = buildGrid(seg, width, height);
  const reach = Math.ceil(TOLERANCE_M / CELL_M);

  const out: Conflation = {
    toleranceM: TOLERANCE_M,
    stopIds: stops.map((s) => s.id),
    edge: new Array(stops.length).fill(-1),
    t: new Array(stops.length).fill(0),
    distM: new Array(stops.length).fill(-1),
    snap: new Array(stops.length * 2).fill(0),
  };
  const unmatched: string[] = [];
  const dists: number[] = [];
  let railStops = 0;
  let railMatched = 0;
  let matchedTight = 0;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    // A stop served only by rail must snap to rail; anything a road mode
    // touches (including a rail/bus interchange) may snap to a street.
    const railOnly = stop.modes.length > 0 && stop.modes.every(isRailMode);
    if (railOnly) railStops++;

    const sx = (stop.lng - graph.bbox[1]) * seg.mPerLng;
    const sy = (stop.lat - graph.bbox[0]) * seg.mPerLat;
    const cx = Math.floor(sx / CELL_M);
    const cy = Math.floor(sy / CELL_M);

    let bestDist = Infinity;
    let bestSeg = -1;
    let bestT = 0;
    for (let y = cy - reach; y <= cy + reach; y++) {
      if (y < 0 || y >= grid.cellsY) continue;
      for (let x = cx - reach; x <= cx + reach; x++) {
        if (x < 0 || x >= grid.cellsX) continue;
        const cell = y * grid.cellsX + x;
        for (let k = grid.counts[cell]; k < grid.counts[cell + 1]; k++) {
          const s = grid.items[k];
          const isRailEdge = graph.edgeClass[seg.segEdge[s]] >= FIRST_RAIL_CLASS;
          if (railOnly !== isRailEdge) continue;
          const p = seg.segPt[s];
          const ax = seg.px[p];
          const ay = seg.py[p];
          const dx = seg.px[p + 1] - ax;
          const dy = seg.py[p + 1] - ay;
          const lenSq = dx * dx + dy * dy;
          const t = lenSq === 0
            ? 0
            : Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / lenSq));
          const d = Math.hypot(sx - (ax + dx * t), sy - (ay + dy * t));
          if (d < bestDist) {
            bestDist = d;
            bestSeg = s;
            bestT = t;
          }
        }
      }
    }

    if (bestSeg === -1 || bestDist > TOLERANCE_M) {
      unmatched.push(stop.id);
      continue;
    }

    const e = seg.segEdge[bestSeg];
    const p = seg.segPt[bestSeg];
    // Position along the whole edge, not just the segment that won.
    const from = graph.geomOffset[e] / 2;
    const to = graph.geomOffset[e + 1] / 2;
    let before = 0;
    let total = 0;
    for (let m = from; m < to - 1; m++) {
      const l = Math.hypot(seg.px[m + 1] - seg.px[m], seg.py[m + 1] - seg.py[m]);
      if (m < p) before += l;
      else if (m === p) before += l * bestT;
      total += l;
    }

    const snapLng = seg.pLng[p] + (seg.pLng[p + 1] - seg.pLng[p]) * bestT;
    const snapLat = seg.pLat[p] + (seg.pLat[p + 1] - seg.pLat[p]) * bestT;
    out.edge[i] = e;
    out.t[i] = total > 0 ? Math.round((before / total) * 1e4) / 1e4 : 0;
    out.distM[i] = Math.round(bestDist * 10) / 10;
    out.snap[i * 2] = Math.round(snapLng * graph.coordScale);
    out.snap[i * 2 + 1] = Math.round(snapLat * graph.coordScale);
    dists.push(bestDist);
    if (bestDist <= 25) matchedTight++;
    if (railOnly) railMatched++;
  }

  dists.sort((a, b) => a - b);
  const at = (q: number) =>
    dists.length === 0
      ? 0
      : Math.round(dists[Math.min(dists.length - 1, Math.floor(q * dists.length))] * 10) / 10;

  return {
    conflation: out,
    stats: {
      stops: stops.length,
      matched: dists.length,
      unmatched: unmatched.length,
      matchedTight,
      medianDistM: at(0.5),
      p90DistM: at(0.9),
      maxDistM: dists.length ? Math.round(dists[dists.length - 1] * 10) / 10 : 0,
      railStops,
      railMatched,
    },
    unmatched,
  };
}
