/**
 * The routable street network, loaded from the baked binary graph.
 *
 * This exists because the renderer's street graph is built from
 * `map.querySourceFeatures()`, which returns only the vector tiles the camera
 * currently has loaded. That is exactly right for *drawing* roads and exactly
 * wrong for *routing* on them: a bus line could not be drafted past one
 * screenful, and — worse — `estimateLineConstruction` priced a route from
 * whatever happened to be loaded, so the same line cost different money at
 * different zoom levels. In a kernel whose whole contract is reproducibility
 * from a seed (GDD §4.3), that is a determinism bug, not a rough edge.
 *
 * `scripts/bake.mts` already produces this graph, versioned and reproducible.
 * Nothing here depends on the camera.
 *
 * It is fetched lazily — the game asks for it the first time the player draws
 * a bus line — so the < 8 s boot gate is untouched. About 5.5 MB over the
 * wire, then decoded straight into typed arrays with no JSON parse.
 */
import type { Projection } from "./geo";
import type { Vec2 } from "./types";

const MAGIC = "MSG1";

/** Grid cell for the segment index, metres. Mirrors scripts/lib/conflate.mts,
 *  which solves the same nearest-segment problem over the same graph. */
const CELL_M = 150;

/** Beyond this the nearest street is a different street. */
export const SNAP_TOLERANCE_M = 120;

/**
 * Expansion cap for a single route search.
 *
 * A bus line drawn across the metro is a long search, but an unreachable
 * target must not spin forever — the graph has 330k edges and the player is
 * waiting on a click. Hitting this returns null, which reads to the player as
 * "these two points do not connect by road".
 */
const MAX_EXPANSIONS = 200_000;

interface GraphHeader {
  version: number;
  bbox: number[];
  coordScale: number;
  classes: string[];
  nodeCount: number;
  edgeCount: number;
  geomDeltaLength: number;
}

/**
 * Relative travel cost per road class, as a divisor on length.
 *
 * A bus routed purely on distance threads residential back-streets to shave
 * a corner, which is not how a real route is planned. Weighting arterials
 * down and residential up biases toward the roads buses actually run on,
 * without forbidding anything.
 */
const CLASS_COST: Record<string, number> = {
  motorway: 0.75,
  trunk: 0.8,
  primary: 0.85,
  secondary: 0.9,
  tertiary: 1,
  unclassified: 1.3,
  residential: 1.6,
  living_street: 2,
  motorway_link: 0.9,
  trunk_link: 0.95,
  primary_link: 1,
  secondary_link: 1.05,
  tertiary_link: 1.15,
};

export interface RoadSnap {
  /** Projected position on the network, in world metres. */
  pos: Vec2;
  /** Nearest graph node, the entry point for routing. */
  nodeIndex: number;
  distanceM: number;
}

export class RoadGraph {
  private constructor(
    private readonly header: GraphHeader,
    private readonly nodes: Int32Array,
    private readonly edges: Uint32Array,
    private readonly edgeClass: Uint8Array,
    private readonly edgeOneway: Int8Array,
    private readonly edgeLenM: Float32Array,
    private readonly geomOffset: Uint32Array,
    private readonly geomDelta: Int16Array,
    private readonly projection: Projection,
  ) {
    this.nodeWorld = new Float64Array(header.nodeCount * 2);
    for (let n = 0; n < header.nodeCount; n++) {
      const p = this.projection.toWorld(
        this.nodes[n * 2 + 1] / header.coordScale,
        this.nodes[n * 2] / header.coordScale,
      );
      this.nodeWorld[n * 2] = p.x;
      this.nodeWorld[n * 2 + 1] = p.y;
    }
    this.edgeCost = new Float32Array(header.edgeCount);
    for (let e = 0; e < header.edgeCount; e++) {
      const name = header.classes[this.edgeClass[e]];
      this.edgeCost[e] = this.edgeLenM[e] * (CLASS_COST[name] ?? 1.4);
    }
    this.buildAdjacency();
    this.buildShapePoints();
    this.buildGrid();
  }

  /** Node positions in projected world metres — what the game works in. */
  private readonly nodeWorld: Float64Array;
  private readonly edgeCost: Float32Array;

  // Every shape point of every edge, flattened. Snapping indexes these
  // rather than just the junction nodes: junctions in a grid city are
  // 100-300 m apart, so a click mid-block is nowhere near one. Indexing
  // nodes alone missed 44% of census-tract centres outright, and a failed
  // snap fails the whole route.
  private pointX!: Float32Array;
  private pointY!: Float32Array;
  private pointEdge!: Int32Array;
  /** Slice bounds into the point arrays, per edge. */
  private pointStart!: Int32Array;

  // Adjacency in CSR form: neighbours of node n are the slice
  // adjStart[n]..adjStart[n+1] of adjNode/adjEdge.
  private adjStart!: Int32Array;
  private adjNode!: Int32Array;
  private adjEdge!: Int32Array;

  // Uniform grid over node positions, also CSR.
  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridMinX = 0;
  private gridMinY = 0;
  private gridStart!: Int32Array;
  private gridItems!: Int32Array;

  get nodeCount(): number {
    return this.header.nodeCount;
  }

  get edgeCount(): number {
    return this.header.edgeCount;
  }

  /**
   * The graph's coverage, as [south, west, north, east] in degrees.
   *
   * The OSM bake is scoped to the metro core, which is a smaller box than the
   * census tracts span — 19% of tract centroids fall outside it. Anything
   * asking this graph to route should expect "not covered" as a real answer
   * rather than treating it as a failure.
   */
  get bounds(): { south: number; west: number; north: number; east: number } {
    const [south, west, north, east] = this.header.bbox;
    return { south, west, north, east };
  }

  /** Whether a lng/lat lies inside the baked coverage. */
  covers(lng: number, lat: number): boolean {
    const b = this.bounds;
    return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
  }

  /**
   * Fetch and decode the baked graph.
   *
   * Typed arrays are constructed as views over the downloaded buffer where
   * alignment allows, so decoding is bookkeeping rather than copying.
   */
  static async load(
    baseUrl: string,
    projection: Projection,
    city = "houston",
    version = "v1",
  ): Promise<RoadGraph> {
    const url = `${baseUrl}world/${city}/${version}/street_graph.bin`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`street graph fetch failed (${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== MAGIC) {
      throw new Error(`street graph: bad magic "${magic}"`);
    }
    const view = new DataView(buffer);
    const headerLength = view.getUint32(4, true);
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)),
    ) as GraphHeader;
    if (header.version !== 1) {
      throw new Error(`street graph: unsupported version ${header.version}`);
    }

    let offset = 8 + headerLength;
    offset += (4 - (offset % 4)) % 4;
    const start = offset;
    const take = <T>(
      make: (buf: ArrayBuffer, byteOffset: number, length: number) => T,
      length: number,
      bytesPer: number,
    ): T => {
      const out = make(buffer, offset, length);
      offset += length * bytesPer;
      // Each array is padded up to the next 4-byte boundary so the following
      // view is constructible directly over the buffer.
      offset += (4 - ((offset - start) % 4)) % 4;
      return out;
    };

    const nodes = take(
      (b, o, l) => new Int32Array(b, o, l),
      header.nodeCount * 2,
      4,
    );
    const edges = take(
      (b, o, l) => new Uint32Array(b, o, l),
      header.edgeCount * 2,
      4,
    );
    const edgeClass = take(
      (b, o, l) => new Uint8Array(b, o, l),
      header.edgeCount,
      1,
    );
    const edgeOneway = take(
      (b, o, l) => new Int8Array(b, o, l),
      header.edgeCount,
      1,
    );
    const edgeLenM = take(
      (b, o, l) => new Float32Array(b, o, l),
      header.edgeCount,
      4,
    );
    const geomOffset = take(
      (b, o, l) => new Uint32Array(b, o, l),
      header.edgeCount + 1,
      4,
    );
    const geomDelta = take(
      (b, o, l) => new Int16Array(b, o, l),
      header.geomDeltaLength,
      2,
    );

    return new RoadGraph(
      header,
      nodes,
      edges,
      edgeClass,
      edgeOneway,
      edgeLenM,
      geomOffset,
      geomDelta,
      projection,
    );
  }

  private buildAdjacency(): void {
    const { nodeCount, edgeCount } = this.header;
    // Counting sort, two passes — same shape as the conflation grid.
    const counts = new Int32Array(nodeCount + 1);
    for (let e = 0; e < edgeCount; e++) {
      const a = this.edges[e * 2];
      const b = this.edges[e * 2 + 1];
      const oneway = this.edgeOneway[e];
      if (oneway >= 0) counts[a + 1]++;
      if (oneway <= 0) counts[b + 1]++;
    }
    for (let n = 0; n < nodeCount; n++) counts[n + 1] += counts[n];

    const total = counts[nodeCount];
    this.adjStart = counts;
    this.adjNode = new Int32Array(total);
    this.adjEdge = new Int32Array(total);
    const cursor = counts.slice(0, nodeCount);
    for (let e = 0; e < edgeCount; e++) {
      const a = this.edges[e * 2];
      const b = this.edges[e * 2 + 1];
      const oneway = this.edgeOneway[e];
      if (oneway >= 0) {
        const at = cursor[a]++;
        this.adjNode[at] = b;
        this.adjEdge[at] = e;
      }
      if (oneway <= 0) {
        const at = cursor[b]++;
        this.adjNode[at] = a;
        this.adjEdge[at] = e;
      }
    }
  }

  /**
   * Decode every edge's polyline once into flat world-metre arrays.
   *
   * Costs about 16 MB alongside the 11 MB buffer, which buys snapping that
   * actually finds the street the player clicked on, and lets edgeShape read
   * a slice instead of re-walking deltas and re-projecting on every call.
   */
  private buildShapePoints(): void {
    const { edgeCount, coordScale } = this.header;
    // One point per delta pair, plus the leading node point per edge.
    const totalPoints = this.header.geomDeltaLength / 2 + edgeCount;
    this.pointX = new Float32Array(totalPoints);
    this.pointY = new Float32Array(totalPoints);
    this.pointEdge = new Int32Array(totalPoints);
    this.pointStart = new Int32Array(edgeCount + 1);

    let at = 0;
    for (let e = 0; e < edgeCount; e++) {
      this.pointStart[e] = at;
      const a = this.edges[e * 2];
      let lng = this.nodes[a * 2];
      let lat = this.nodes[a * 2 + 1];

      let p = this.projection.toWorld(lat / coordScale, lng / coordScale);
      this.pointX[at] = p.x;
      this.pointY[at] = p.y;
      this.pointEdge[at] = e;
      at++;

      for (let g = this.geomOffset[e]; g < this.geomOffset[e + 1]; g += 2) {
        lng += this.geomDelta[g];
        lat += this.geomDelta[g + 1];
        p = this.projection.toWorld(lat / coordScale, lng / coordScale);
        this.pointX[at] = p.x;
        this.pointY[at] = p.y;
        this.pointEdge[at] = e;
        at++;
      }
    }
    this.pointStart[edgeCount] = at;
  }

  private buildGrid(): void {
    const count = this.pointX.length;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = this.pointX[i];
      const y = this.pointY[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.gridMinX = minX;
    this.gridMinY = minY;
    this.gridCellsX = Math.max(1, Math.ceil((maxX - minX) / CELL_M));
    this.gridCellsY = Math.max(1, Math.ceil((maxY - minY) / CELL_M));

    const cellCount = this.gridCellsX * this.gridCellsY;
    const counts = new Int32Array(cellCount + 1);
    const cellOf = (i: number): number => {
      const cx = Math.min(
        this.gridCellsX - 1,
        Math.max(0, Math.floor((this.pointX[i] - minX) / CELL_M)),
      );
      const cy = Math.min(
        this.gridCellsY - 1,
        Math.max(0, Math.floor((this.pointY[i] - minY) / CELL_M)),
      );
      return cy * this.gridCellsX + cx;
    };
    for (let i = 0; i < count; i++) counts[cellOf(i) + 1]++;
    for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
    this.gridStart = counts;
    this.gridItems = new Int32Array(counts[cellCount]);
    const cursor = counts.slice(0, cellCount);
    for (let i = 0; i < count; i++) this.gridItems[cursor[cellOf(i)]++] = i;
  }

  /** World-metre position of an edge's start node. Used by the round-trip test. */
  edgeStartPosition(edge: number): Vec2 {
    return this.nodePosition(this.edges[edge * 2]);
  }

  /** Total shape points across all edges — the snapping index's population. */
  get shapePointCount(): number {
    return this.pointX.length;
  }

  /** A point known to lie on the network, for probing it in tests. */
  samplePoint(index: number): Vec2 {
    const i = index % this.pointX.length;
    return { x: this.pointX[i], y: this.pointY[i] };
  }

  /** World-metre position of a graph node. */
  nodePosition(nodeIndex: number): Vec2 {
    return {
      x: this.nodeWorld[nodeIndex * 2],
      y: this.nodeWorld[nodeIndex * 2 + 1],
    };
  }

  /**
   * Nearest routable point to a world position.
   *
   * Searches the grid in expanding rings and stops as soon as the ring's own
   * inner distance exceeds the best hit so far — otherwise a point in an
   * empty area scans the whole city.
   */
  snap(pos: Vec2, toleranceM = SNAP_TOLERANCE_M): RoadSnap | null {
    const cx = Math.floor((pos.x - this.gridMinX) / CELL_M);
    const cy = Math.floor((pos.y - this.gridMinY) / CELL_M);
    const maxRing = Math.ceil(toleranceM / CELL_M) + 1;

    let bestPoint = -1;
    let bestSq = toleranceM * toleranceM;

    for (let ring = 0; ring <= maxRing; ring++) {
      // Everything in this ring is at least (ring - 1) cells away, so once
      // that already beats the best hit there is nothing left to find.
      if (bestPoint >= 0 && (ring - 1) * CELL_M > Math.sqrt(bestSq)) break;

      const x0 = cx - ring;
      const x1 = cx + ring;
      const y0 = cy - ring;
      const y1 = cy + ring;
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= this.gridCellsY) continue;
        const edgeRow = y === y0 || y === y1;
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= this.gridCellsX) continue;
          // Interior cells were covered by a smaller ring.
          if (!edgeRow && x !== x0 && x !== x1) continue;
          const cell = y * this.gridCellsX + x;
          for (let k = this.gridStart[cell]; k < this.gridStart[cell + 1]; k++) {
            const i = this.gridItems[k];
            const dx = this.pointX[i] - pos.x;
            const dy = this.pointY[i] - pos.y;
            const sq = dx * dx + dy * dy;
            if (sq < bestSq) {
              bestSq = sq;
              bestPoint = i;
            }
          }
        }
      }
    }

    if (bestPoint < 0) return null;

    // The nearest *vertex* can be up to half a segment from the nearest
    // point on the road, so project onto the two segments meeting it.
    const edge = this.pointEdge[bestPoint];
    const from = this.pointStart[edge];
    const to = this.pointStart[edge + 1];
    let onRoad: Vec2 = { x: this.pointX[bestPoint], y: this.pointY[bestPoint] };
    let onRoadSq = bestSq;
    for (const other of [bestPoint - 1, bestPoint + 1]) {
      if (other < from || other >= to) continue;
      const projected = projectOnSegment(
        pos,
        this.pointX[bestPoint],
        this.pointY[bestPoint],
        this.pointX[other],
        this.pointY[other],
      );
      const dx = projected.x - pos.x;
      const dy = projected.y - pos.y;
      const sq = dx * dx + dy * dy;
      if (sq < onRoadSq) {
        onRoadSq = sq;
        onRoad = projected;
      }
    }

    // Routing happens between junctions, so hand back whichever end of this
    // edge is nearer — the same choice the tile-based snapper made.
    const a = this.edges[edge * 2];
    const b = this.edges[edge * 2 + 1];
    const da =
      (this.nodeWorld[a * 2] - onRoad.x) ** 2 +
      (this.nodeWorld[a * 2 + 1] - onRoad.y) ** 2;
    const db =
      (this.nodeWorld[b * 2] - onRoad.x) ** 2 +
      (this.nodeWorld[b * 2 + 1] - onRoad.y) ** 2;

    return {
      pos: onRoad,
      nodeIndex: da <= db ? a : b,
      distanceM: Math.sqrt(onRoadSq),
    };
  }

  /**
   * Shortest road route between two graph nodes, as a world-metre polyline.
   *
   * A* with a straight-line heuristic, scaled by the cheapest class weight so
   * it stays admissible against the class-weighted edge costs — an
   * inadmissible heuristic would quietly return non-shortest routes.
   */
  route(fromNode: number, toNode: number): Vec2[] | null {
    if (fromNode === toNode) return [this.nodePosition(fromNode)];

    const { nodeCount } = this.header;
    const dist = new Float64Array(nodeCount).fill(Infinity);
    const cameFrom = new Int32Array(nodeCount).fill(-1);
    const cameEdge = new Int32Array(nodeCount).fill(-1);
    const closed = new Uint8Array(nodeCount);

    const goalX = this.nodeWorld[toNode * 2];
    const goalY = this.nodeWorld[toNode * 2 + 1];
    // 0.75 is the smallest CLASS_COST, so this never overestimates.
    const heuristic = (n: number): number => {
      const dx = this.nodeWorld[n * 2] - goalX;
      const dy = this.nodeWorld[n * 2 + 1] - goalY;
      return Math.hypot(dx, dy) * 0.75;
    };

    const heap = new BinaryHeap();
    dist[fromNode] = 0;
    heap.push(fromNode, heuristic(fromNode));

    let expansions = 0;
    let found = false;
    while (heap.size > 0) {
      const current = heap.pop();
      if (closed[current]) continue;
      if (current === toNode) {
        found = true;
        break;
      }
      closed[current] = 1;
      if (++expansions > MAX_EXPANSIONS) break;

      for (let k = this.adjStart[current]; k < this.adjStart[current + 1]; k++) {
        const next = this.adjNode[k];
        if (closed[next]) continue;
        const edge = this.adjEdge[k];
        const tentative = dist[current] + this.edgeCost[edge];
        if (tentative < dist[next]) {
          dist[next] = tentative;
          cameFrom[next] = current;
          cameEdge[next] = edge;
          heap.push(next, tentative + heuristic(next));
        }
      }
    }
    if (!found) return null;

    // Walk back, collecting each edge's full shape rather than just its
    // endpoints — a bus should follow the road's actual curve.
    const nodesBack: number[] = [];
    const edgesBack: number[] = [];
    for (let n = toNode; n !== -1 && n !== fromNode; n = cameFrom[n]) {
      nodesBack.push(n);
      edgesBack.push(cameEdge[n]);
    }
    nodesBack.push(fromNode);
    nodesBack.reverse();
    edgesBack.reverse();

    const path: Vec2[] = [this.nodePosition(fromNode)];
    for (let i = 0; i < edgesBack.length; i++) {
      const edge = edgesBack[i];
      const arrivingAt = nodesBack[i + 1];
      const shape = this.edgeShape(edge, arrivingAt);
      // The first point of the shape is where we already are.
      for (let p = 1; p < shape.length; p++) path.push(shape[p]);
    }
    return path;
  }

  /** Convenience: snap both ends and route between them. */
  routeBetween(from: Vec2, to: Vec2): Vec2[] | null {
    const a = this.snap(from);
    const b = this.snap(to);
    if (!a || !b) return null;
    return this.route(a.nodeIndex, b.nodeIndex);
  }

  /**
   * An edge's polyline in world metres, oriented to end at `towardNode`.
   *
   * The stored geometry runs from the edge's start node to its end node as
   * deltas; the leading absolute point is not stored at all, because it is
   * the start node's own position.
   */
  private edgeShape(edge: number, towardNode: number): Vec2[] {
    const from = this.pointStart[edge];
    const to = this.pointStart[edge + 1];
    const points: Vec2[] = new Array(to - from);
    for (let i = from; i < to; i++) {
      points[i - from] = { x: this.pointX[i], y: this.pointY[i] };
    }
    // Stored start-to-end; reverse when the route arrives at the start node.
    if (towardNode !== this.edges[edge * 2 + 1]) points.reverse();
    return points;
  }
}

/** Closest point to `p` on the segment (ax, ay)-(bx, by). */
function projectOnSegment(
  p: Vec2,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Vec2 {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: ax, y: ay };
  const t = Math.max(
    0,
    Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / lengthSq),
  );
  return { x: ax + dx * t, y: ay + dy * t };
}

/**
 * Binary min-heap over (node, priority).
 *
 * The existing transit planner uses a linear scan with a splice, which is
 * fine over a few hundred stations and quadratic here — this graph has
 * 330,000 edges. No decrease-key: a node can be pushed more than once and
 * stale entries are skipped by the closed set, which is the standard trade
 * and cheaper than maintaining positions.
 */
class BinaryHeap {
  private readonly items: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.priorities.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (
          left < this.items.length &&
          this.priorities[left] < this.priorities[smallest]
        ) {
          smallest = left;
        }
        if (
          right < this.items.length &&
          this.priorities[right] < this.priorities[smallest]
        ) {
          smallest = right;
        }
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = item;
    const priority = this.priorities[a];
    this.priorities[a] = this.priorities[b];
    this.priorities[b] = priority;
  }
}
