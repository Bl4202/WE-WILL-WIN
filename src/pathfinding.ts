/**
 * Naive transit shortest-path for the Phase-0 toy (GDD §8, Phase 0).
 *
 * Dijkstra over (station, line) states: boarding a line costs half its
 * headway (expected wait), riding costs the actual accelerate/cruise/brake
 * run time plus dwells, and changing lines costs a transfer penalty — so
 * closely-spaced stops are correctly priced as slow. This is a deliberately tiny
 * stand-in for the RAPTOR/hyperpath assignment of §4.1.5, but it already
 * makes transfers and waiting "real" so network design choices matter.
 */
import { DWELL_SEC, TRANSFER_PENALTY_SEC } from "./constants";
import { runTimeSec } from "./kinematics";
import type { Line, Station, TripLeg } from "./types";

/** A candidate access/egress station with its walk-time cost (seconds). */
export interface StationAccess {
  stationId: number;
  walkSec: number;
}

export interface PlannedTrip {
  legs: TripLeg[];
  boardStationId: number;
  /** Total generalized cost, seconds (walk + wait + ride + transfers). */
  costSec: number;
}

/** lineId -1 encodes the "not on any line" state at a station. */
const OFF_LINE = -1;

interface Edge {
  to: string;
  cost: number;
}

const key = (stationId: number, lineId: number) => `${stationId}|${lineId}`;

export class TransitPlanner {
  private edges = new Map<string, Edge[]>();

  /** Rebuild the search graph. Call whenever the network changes. */
  rebuild(lines: Map<number, Line>, stations: Map<number, Station>): void {
    this.edges = new Map();
    const add = (from: string, to: string, cost: number) => {
      let list = this.edges.get(from);
      if (!list) {
        list = [];
        this.edges.set(from, list);
      }
      list.push({ to, cost });
    };

    for (const line of lines.values()) {
      for (let i = 0; i < line.stationIds.length; i++) {
        const sid = line.stationIds[i];
        // Board: expected wait is half the headway.
        add(key(sid, OFF_LINE), key(sid, line.id), line.headwaySec / 2);
        // Alight back to the street (transfer penalty paid on exit; the
        // final alight at the destination is free via the goal check).
        add(key(sid, line.id), key(sid, OFF_LINE), TRANSFER_PENALTY_SEC);
        // Ride to adjacent stations, both directions (vehicles ping-pong).
        for (const j of [i - 1, i + 1]) {
          if (j < 0 || j >= line.stationIds.length) continue;
          const rideDist = Math.abs(line.stationDist[j] - line.stationDist[i]);
          add(
            key(sid, line.id),
            key(line.stationIds[j], line.id),
            runTimeSec(rideDist) + DWELL_SEC,
          );
        }
      }
    }
    void stations; // station positions already encoded in line.stationDist
  }

  /**
   * Multi-source, multi-target Dijkstra. Returns null if no transit path
   * exists (the trip goes unserved — the unmet-demand signal).
   */
  plan(
    origins: StationAccess[],
    dests: StationAccess[],
    lines: Map<number, Line>,
  ): PlannedTrip | null {
    if (origins.length === 0 || dests.length === 0) return null;

    const destCost = new Map<number, number>();
    for (const d of dests) destCost.set(d.stationId, d.walkSec);

    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    // Tiny graph: a sorted-insert array queue is plenty for Phase 0.
    const queue: { k: string; d: number }[] = [];
    const push = (k: string, d: number, from?: string) => {
      const known = dist.get(k);
      if (known !== undefined && known <= d) return;
      dist.set(k, d);
      if (from) prev.set(k, from);
      queue.push({ k, d });
    };

    for (const o of origins) push(key(o.stationId, OFF_LINE), o.walkSec);

    let best: { k: string; d: number } | null = null;
    while (queue.length > 0) {
      let mi = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].d < queue[mi].d) mi = i;
      }
      const cur = queue.splice(mi, 1)[0];
      if (cur.d > (dist.get(cur.k) ?? Infinity)) continue;
      if (best && cur.d >= best.d) break;

      const [sidStr, lineStr] = cur.k.split("|");
      const sid = Number(sidStr);
      const onLine = Number(lineStr) !== OFF_LINE;
      // Goal: arrive at a destination station while on a line (alight free).
      if (onLine && destCost.has(sid)) {
        const total = cur.d + destCost.get(sid)!;
        if (!best || total < best.d) best = { k: cur.k, d: total };
      }

      for (const e of this.edges.get(cur.k) ?? []) {
        push(e.to, cur.d + e.cost, cur.k);
      }
    }
    if (!best) return null;

    // Reconstruct the state chain, then group consecutive same-line rides.
    const chain: string[] = [];
    for (let k2: string | undefined = best.k; k2; k2 = prev.get(k2)) {
      chain.unshift(k2);
    }

    const legs: TripLeg[] = [];
    for (const k2 of chain) {
      const [sidStr, lineStr] = k2.split("|");
      const sid = Number(sidStr);
      const lineId = Number(lineStr);
      if (lineId === OFF_LINE) continue;
      const last = legs[legs.length - 1];
      if (last && last.lineId === lineId) {
        last.alightStationId = sid;
      } else {
        legs.push({ lineId, boardStationId: sid, alightStationId: sid, dir: 1 });
      }
    }
    // Drop degenerate boardings (board and alight at the same station).
    const realLegs = legs.filter((l) => l.boardStationId !== l.alightStationId);
    if (realLegs.length === 0) return null;

    for (const leg of realLegs) {
      const line = lines.get(leg.lineId)!;
      const bi = line.stationIds.indexOf(leg.boardStationId);
      const ai = line.stationIds.indexOf(leg.alightStationId);
      leg.dir = ai > bi ? 1 : -1;
    }

    return {
      legs: realLegs,
      boardStationId: realLegs[0].boardStationId,
      costSec: best.d,
    };
  }
}
