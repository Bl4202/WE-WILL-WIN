/**
 * Binary encoder for the routable street graph.
 *
 * The graph exists as JSON because that is what the bake pipeline works in,
 * but 26 MB of JSON is not something a browser should parse — and the client
 * only ever wants the road half of it, laid out as typed arrays it can index
 * without touching the parser. This writes exactly that.
 *
 * Rail classes are dropped: the client routes buses along streets, and metro
 * alignments are drawn free-hand rather than snapped to existing rail.
 *
 * Layout — one file, so it is one fetch:
 *
 *   magic   4 bytes   "MSG1"
 *   hdrLen  uint32    byte length of the JSON header
 *   header  hdrLen    UTF-8 JSON: bbox, scale, classes, counts
 *   (pad to 4-byte alignment)
 *   nodes      Int32   2 per node, [lng, lat] scaled by coordScale
 *   edges      Uint32  2 per edge, node indices
 *   edgeClass  Uint8   1 per edge
 *   edgeOneway Int8    1 per edge: 1 forward, -1 reverse, 0 both
 *   edgeLenM   Float32 1 per edge
 *   geomOffset Uint32  edgeCount + 1, slice bounds into geomDelta
 *   geomDelta  Int16   2 per shape point after the first, delta from the
 *                      previous point
 *
 * Geometry carries no absolute coordinates at all: an edge's polyline starts
 * at its own start node, so the client seeds from nodes[edges[e * 2]] and
 * walks the deltas. Verified across the whole Houston road network — all
 * 329,672 edges have geom[first] exactly equal to their start node, and
 * geom[last] exactly equal to their end node.
 *
 * That leaves only deltas, which are consecutive OSM shape points a few
 * metres apart and fit Int16 comfortably: measured 2,027,394 of them, none
 * out of range, largest 1,764 against a 32,767 ceiling. encodeGraphBin
 * range-checks every one anyway, because a different city is a different
 * measurement.
 */

export const GRAPH_BIN_MAGIC = "MSG1";

/** The subset of OsmGraph this encoder needs — kept structural so the bake
 *  can pass its graph straight in without a type dance. */
export interface EncodableGraph {
  bbox: [number, number, number, number] | number[];
  coordScale: number;
  classes: string[];
  firstRailClass: number;
  nodes: number[];
  edges: number[];
  edgeClass: number[];
  edgeOneway: number[];
  edgeLenM: number[];
  geomOffset: number[];
  geom: number[];
}

export interface GraphBinHeader {
  version: 1;
  bbox: number[];
  coordScale: number;
  /** Road classes only, re-indexed densely from the source class list. */
  classes: string[];
  nodeCount: number;
  edgeCount: number;
  /** Int16 count in geomDelta (2 per non-leading shape point). */
  geomDeltaLength: number;
}

export interface EncodedGraph {
  buffer: Buffer;
  header: GraphBinHeader;
  /** Nodes dropped: rail-only, orphaned, or outside the main component. */
  droppedNodes: number;
  /** Edges dropped: rail, or stranded on a disconnected island. */
  droppedEdges: number;
  /** Road edges dropped specifically for being off the main component. */
  droppedIslandEdges: number;
  /**
   * Source edge index for each encoded edge, in encoded order.
   *
   * Two filters run here — rail, then disconnected islands — so encoded edge
   * i is not source edge i and nothing downstream should assume it is. Any
   * artefact keyed to the source graph (conflation, above all) has to be
   * remapped through this.
   */
  keptSourceEdges: Int32Array;
}

/**
 * Encode the road subset of a baked graph.
 *
 * Nodes are compacted too: dropping rail leaves a tail of nodes nothing
 * references any more, and they would otherwise be ~10% of the node array
 * and every one of them a false candidate in the client's spatial index.
 */
/**
 * Flags every node in the graph's largest connected road component.
 *
 * Connectivity ignores one-way direction: a one-way street still joins the
 * places at its ends, and treating it as a barrier here would carve the
 * network into far more pieces than really exist.
 */
function largestComponent(
  graph: EncodableGraph,
  roadEdges: number[],
): Uint8Array {
  const nodeCount = graph.nodes.length / 2;

  // Undirected adjacency, CSR.
  const start = new Int32Array(nodeCount + 1);
  for (const e of roadEdges) {
    start[graph.edges[e * 2] + 1]++;
    start[graph.edges[e * 2 + 1] + 1]++;
  }
  for (let n = 0; n < nodeCount; n++) start[n + 1] += start[n];
  const adjacent = new Int32Array(start[nodeCount]);
  const cursor = start.slice(0, nodeCount);
  for (const e of roadEdges) {
    const a = graph.edges[e * 2];
    const b = graph.edges[e * 2 + 1];
    adjacent[cursor[a]++] = b;
    adjacent[cursor[b]++] = a;
  }

  const component = new Int32Array(nodeCount).fill(-1);
  const stack: number[] = [];
  let best = -1;
  let bestSize = 0;
  let next = 0;

  for (let seed = 0; seed < nodeCount; seed++) {
    if (component[seed] !== -1 || start[seed] === start[seed + 1]) continue;
    const id = next++;
    let size = 0;
    component[seed] = id;
    stack.push(seed);
    while (stack.length > 0) {
      const n = stack.pop()!;
      size++;
      for (let k = start[n]; k < start[n + 1]; k++) {
        const m = adjacent[k];
        if (component[m] === -1) {
          component[m] = id;
          stack.push(m);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }

  const inLargest = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    if (component[n] === best) inLargest[n] = 1;
  }
  return inLargest;
}

export function encodeGraphBin(graph: EncodableGraph): EncodedGraph {
  const sourceEdgeCount = graph.edgeClass.length;

  const roadEdges: number[] = [];
  for (let e = 0; e < sourceEdgeCount; e++) {
    if (graph.edgeClass[e] < graph.firstRailClass) roadEdges.push(e);
  }

  // Keep only the largest connected component.
  //
  // The OSM extract leaves islands behind — subdivisions whose only link was
  // clipped at the bbox edge, and similar. Measured on Houston: 189 of them,
  // together 0.31% of road edges and 0.48% of road length, against a main
  // component holding 246,683 nodes. Shipping them makes "these two points do
  // not connect by road" a real answer the player can hit for no visible
  // reason. Dropping them makes routing between any two snapped points a
  // guarantee, which is worth far more than a third of a percent of streets.
  const componentOf = largestComponent(graph, roadEdges);

  const keptEdges: number[] = [];
  const nodeUsed = new Uint8Array(graph.nodes.length / 2);
  for (const e of roadEdges) {
    if (!componentOf[graph.edges[e * 2]]) continue;
    keptEdges.push(e);
    nodeUsed[graph.edges[e * 2]] = 1;
    nodeUsed[graph.edges[e * 2 + 1]] = 1;
  }

  // Dense remap for the surviving nodes.
  const nodeRemap = new Int32Array(nodeUsed.length).fill(-1);
  let nodeCount = 0;
  for (let n = 0; n < nodeUsed.length; n++) {
    if (nodeUsed[n]) nodeRemap[n] = nodeCount++;
  }

  const edgeCount = keptEdges.length;
  // Point counts, not int counts: each shape point is an (x, y) pair, and
  // the first of every edge moves into geomFirst.
  let deltaPoints = 0;
  for (const e of keptEdges) {
    const points = (graph.geomOffset[e + 1] - graph.geomOffset[e]) / 2;
    deltaPoints += Math.max(0, points - 1);
  }

  const nodes = new Int32Array(nodeCount * 2);
  for (let n = 0; n < nodeUsed.length; n++) {
    const to = nodeRemap[n];
    if (to < 0) continue;
    nodes[to * 2] = graph.nodes[n * 2];
    nodes[to * 2 + 1] = graph.nodes[n * 2 + 1];
  }

  const edges = new Uint32Array(edgeCount * 2);
  const edgeClass = new Uint8Array(edgeCount);
  const edgeOneway = new Int8Array(edgeCount);
  const edgeLenM = new Float32Array(edgeCount);
  const geomOffset = new Uint32Array(edgeCount + 1);
  const geomDelta = new Int16Array(deltaPoints * 2);

  let cursor = 0;
  for (let i = 0; i < edgeCount; i++) {
    const e = keptEdges[i];
    edges[i * 2] = nodeRemap[graph.edges[e * 2]];
    edges[i * 2 + 1] = nodeRemap[graph.edges[e * 2 + 1]];
    edgeClass[i] = graph.edgeClass[e];
    edgeOneway[i] = graph.edgeOneway[e];
    edgeLenM[i] = graph.edgeLenM[e];

    // The leading absolute point is skipped: it is the start node, which
    // the client already has.
    const from = graph.geomOffset[e];
    const to = graph.geomOffset[e + 1];
    geomOffset[i] = cursor;
    for (let g = from + 2; g < to; g++) {
      const value = graph.geom[g];
      if (value < -32768 || value > 32767) {
        throw new Error(
          `graph geometry delta ${value} at edge ${e} exceeds the Int16 ` +
            `range this format uses — re-encode geomDelta as Int32`,
        );
      }
      geomDelta[cursor++] = value;
    }
  }
  geomOffset[edgeCount] = cursor;

  const header: GraphBinHeader = {
    version: 1,
    bbox: [...graph.bbox],
    coordScale: graph.coordScale,
    classes: graph.classes.slice(0, graph.firstRailClass),
    nodeCount,
    edgeCount,
    geomDeltaLength: cursor,
  };

  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = 8 + headerBytes.length;
  // Every array after the header is 4-byte wide or aligned to one, so the
  // payload has to start on a 4-byte boundary for the typed-array views to
  // be constructible directly over the buffer on the client.
  const padding = (4 - (prefix % 4)) % 4;
  const payloadStart = prefix + padding;

  const parts: ArrayBufferView[] = [
    nodes,
    edges,
    edgeClass,
    edgeOneway,
    edgeLenM,
    geomOffset,
    geomDelta,
  ];
  // edgeClass (Uint8) and edgeOneway (Int8) can leave the cursor off a
  // 4-byte boundary, so each is padded up before the next array starts.
  let payloadBytes = 0;
  for (const part of parts) {
    payloadBytes += part.byteLength;
    payloadBytes += (4 - (payloadBytes % 4)) % 4;
  }

  const buffer = Buffer.alloc(payloadStart + payloadBytes);
  buffer.write(GRAPH_BIN_MAGIC, 0, "ascii");
  buffer.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(buffer, 8);

  let offset = payloadStart;
  for (const part of parts) {
    Buffer.from(part.buffer, part.byteOffset, part.byteLength).copy(
      buffer,
      offset,
    );
    offset += part.byteLength;
    offset += (4 - ((offset - payloadStart) % 4)) % 4;
  }

  return {
    buffer,
    header,
    droppedNodes: nodeUsed.length - nodeCount,
    droppedEdges: sourceEdgeCount - edgeCount,
    droppedIslandEdges: roadEdges.length - edgeCount,
    keptSourceEdges: Int32Array.from(keptEdges),
  };
}
