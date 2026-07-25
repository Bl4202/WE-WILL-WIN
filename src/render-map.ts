/**
 * Phase-1 render stack (GDD §1.2): MapLibre GL dark basemap (OpenStreetMap
 * vector tiles via OpenFreeMap — hosted for now, self-hosted PMTiles later)
 * with deck.gl layers on top via MapboxOverlay:
 *
 *   H3HexagonLayer   demand heatmap (toggle · D)
 *   PathLayer        METRO reference-network ghost (toggle · G)
 *   PathLayer        player lines (colored, rounded)
 *   ScatterplotLayer stations (white dots, dark ring; larger = interchange)
 *   ScatterplotLayer vehicles (larger dots in their line's color)
 *   TextLayer        waiting-passenger counts
 *
 * Static layers are cached and rebuilt only when the network version or
 * selection changes; vehicle/draft layers rebuild every frame.
 */
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { Layer } from "@deck.gl/core";
import maplibregl from "maplibre-gl";
import type { Game } from "./game";
import type { WorldBundle } from "./world";
import type { Line, SimSnapshot, Station, Vec2, Zone } from "./types";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

type RGBA = [number, number, number, number];

const STATION_FILL: RGBA = [246, 248, 250, 255];
const STATION_RING: RGBA = [23, 29, 36, 255];
/** Kept soft and semi-transparent so a train reads as a bead on its line
 *  rather than a dot with a hard black outline sitting over the track. */
const VEHICLE_RING: RGBA = [13, 17, 22, 150];

function hexToRgb(hex: string): RGBA {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255,
  ];
}

export class MapRenderer {
  readonly map: maplibregl.Map;
  private readonly overlay: MapboxOverlay;

  /** Cursor position (already station-snapped) for the draft preview. */
  hoverLngLat: [number, number] | null = null;
  showDemand = false;
  showGhost = false;

  private demandLayer: H3HexagonLayer<Zone> | null = null;
  private ghostLayer: PathLayer | null = null;
  private cachedNetworkLayers: Layer[] = [];
  private cachedNetworkKey = "";

  constructor(
    container: HTMLElement,
    private readonly world: WorldBundle,
  ) {
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: [world.demand.origin.lng, world.demand.origin.lat],
      zoom: 10.3,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: { compact: true },
    });
    this.map.doubleClickZoom.disable();
    this.map.touchZoomRotate.disableRotation();
    this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.map.addControl(this.overlay as unknown as maplibregl.IControl);
  }

  /** Planar sim metres → [lng, lat]. */
  toLngLat(p: Vec2): [number, number] {
    return this.world.projection.toLngLat(p);
  }

  /** Geographic → planar sim metres. */
  toWorld(lat: number, lng: number): Vec2 {
    return this.world.projection.toWorld(lat, lng);
  }

  /** Hit-test a station near a screen point (snap radius in px). */
  pickStation(snap: SimSnapshot, screen: Vec2): Station | null {
    let best: Station | null = null;
    let bestD = 14;
    for (const s of snap.stations.values()) {
      const sp = this.map.project(this.toLngLat(s.pos));
      const d = Math.hypot(sp.x - screen.x, sp.y - screen.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** Return the id of the line whose polyline passes near the point, if any. */
  pickLine(snap: SimSnapshot, screen: Vec2): number | null {
    const THRESHOLD = 8;
    for (const line of snap.lines.values()) {
      for (let i = 1; i < line.stationIds.length; i++) {
        const a = this.map.project(
          this.toLngLat(snap.stations.get(line.stationIds[i - 1])!.pos),
        );
        const b = this.map.project(
          this.toLngLat(snap.stations.get(line.stationIds[i])!.pos),
        );
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const lenSq = abx * abx + aby * aby;
        const t =
          lenSq === 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  ((screen.x - a.x) * abx + (screen.y - a.y) * aby) / lenSq,
                ),
              );
        const d = Math.hypot(
          screen.x - (a.x + abx * t),
          screen.y - (a.y + aby * t),
        );
        if (d < THRESHOLD) return line.id;
      }
    }
    return null;
  }

  update(snap: SimSnapshot, game: Game): void {
    const layers: Layer[] = [];
    if (this.showDemand) layers.push(this.getDemandLayer());
    if (this.showGhost) layers.push(this.getGhostLayer());
    layers.push(...this.getNetworkLayers(snap, game));
    layers.push(...this.buildDraftLayers(game));
    layers.push(this.buildVehicleLayer(snap, game.tickAlpha));
    layers.push(this.buildWaitingLayer(snap));
    this.overlay.setProps({ layers });
  }

  // ── Static/toggle layers ────────────────────────────────────────────

  private getDemandLayer(): H3HexagonLayer<Zone> {
    if (!this.demandLayer) {
      const zones = this.world.demand.zones as unknown as Zone[];
      let maxMass = 1;
      for (const z of zones) maxMass = Math.max(maxMass, z.pop + z.jobs);
      const logMax = Math.log1p(maxMass);
      this.demandLayer = new H3HexagonLayer<Zone>({
        id: "demand-hexes",
        data: zones,
        getHexagon: (z) => z.h3,
        filled: true,
        extruded: false,
        stroked: false,
        getFillColor: (z) => {
          const t = Math.log1p(z.pop + z.jobs) / logMax;
          return [
            40 + 215 * t,
            50 + 140 * t,
            90 - 30 * t,
            20 + 150 * t,
          ] as RGBA;
        },
        pickable: false,
      });
    }
    return this.demandLayer;
  }

  private getGhostLayer(): PathLayer {
    if (!this.ghostLayer) {
      this.ghostLayer = new PathLayer({
        id: "gtfs-ghost",
        data: this.world.baseline.routes,
        getPath: (r) => r.shape,
        getColor: (r) =>
          r.type <= 2 ? [255, 255, 255, 110] : [150, 170, 190, 40],
        getWidth: (r) => (r.type <= 2 ? 3.5 : 1.5),
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        pickable: false,
      });
    }
    return this.ghostLayer;
  }

  // ── Player network (cached on network version + selection) ──────────

  private getNetworkLayers(snap: SimSnapshot, game: Game): Layer[] {
    const key = `${snap.networkVersion}|${game.selection?.kind ?? ""}:${game.selection?.id ?? ""}`;
    if (key === this.cachedNetworkKey) return this.cachedNetworkLayers;

    const lines = [...snap.lines.values()];
    const stations = [...snap.stations.values()];
    const selLine =
      game.selection?.kind === "line" ? game.selection.id : null;
    const selStation =
      game.selection?.kind === "station" ? game.selection.id : null;

    this.cachedNetworkLayers = [
      new PathLayer<Line>({
        id: "player-lines",
        data: lines,
        getPath: (l) =>
          l.stationIds.map((sid) =>
            this.toLngLat(snap.stations.get(sid)!.pos),
          ),
        getColor: (l) => hexToRgb(l.color),
        getWidth: (l) => (l.id === selLine ? 8 : 5.5),
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
      new ScatterplotLayer<Station>({
        id: "stations",
        data: stations,
        getPosition: (s) => this.toLngLat(s.pos),
        getRadius: (s) => (s.lineIds.length > 1 ? 7 : 5),
        radiusUnits: "pixels",
        getFillColor: STATION_FILL,
        stroked: true,
        getLineColor: (s) =>
          s.id === selStation ? ([79, 195, 247, 255] as RGBA) : STATION_RING,
        getLineWidth: (s) => (s.id === selStation ? 3 : 2),
        lineWidthUnits: "pixels",
        pickable: false,
      }),
    ];
    this.cachedNetworkKey = key;
    return this.cachedNetworkLayers;
  }

  // ── Per-frame layers ────────────────────────────────────────────────

  private buildDraftLayers(game: Game): Layer[] {
    if (game.mode !== "build" || game.draft.length === 0) return [];
    const pts = game.draft.map((p) => this.toLngLat(p.pos));
    const preview = this.hoverLngLat ? [...pts, this.hoverLngLat] : pts;
    return [
      new PathLayer({
        id: "draft-line",
        data: [preview],
        getPath: (p: [number, number][]) => p,
        getColor: [255, 255, 255, 170],
        getWidth: 3.5,
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
      new ScatterplotLayer({
        id: "draft-points",
        data: pts,
        getPosition: (p: [number, number]) => p,
        getRadius: 5,
        radiusUnits: "pixels",
        getFillColor: [255, 255, 255, 235],
        stroked: true,
        getLineColor: STATION_RING,
        getLineWidth: 1.5,
        lineWidthUnits: "pixels",
        pickable: false,
      }),
    ];
  }

  /**
   * @param alpha How far this frame sits between the last sim tick and the
   * next. Vehicles are drawn lerped across the tick, so they glide at 1×
   * instead of stepping four times a second.
   */
  private buildVehicleLayer(snap: SimSnapshot, alpha: number): Layer {
    return new ScatterplotLayer({
      id: "vehicles",
      // Fresh array each frame: `snap.vehicles` is the sim's own mutable
      // array (mutated in place, never reassigned), and deck.gl diffs `data`
      // by reference — without a new reference here it never notices
      // vehicles moving (or existing at all past the first, empty frame).
      data: [...snap.vehicles],
      getPosition: (v) => {
        const line = snap.lines.get(v.lineId)!;
        const dist = v.prevDist + (v.dist - v.prevDist) * alpha;
        return this.toLngLat(positionOnLine(snap, line, dist));
      },
      getRadius: 10,
      radiusUnits: "pixels",
      getFillColor: (v) => hexToRgb(snap.lines.get(v.lineId)!.color),
      stroked: true,
      getLineColor: VEHICLE_RING,
      getLineWidth: 1,
      lineWidthUnits: "pixels",
      pickable: false,
    });
  }

  private buildWaitingLayer(snap: SimSnapshot): Layer {
    const busy = [...snap.stations.values()].filter(
      (s) => s.waiting.length > 0,
    );
    return new TextLayer<Station>({
      id: "waiting-counts",
      data: busy,
      getPosition: (s) => this.toLngLat(s.pos),
      getText: (s) => String(s.waiting.length),
      getSize: 13,
      getColor: [255, 183, 77, 255],
      getPixelOffset: [12, -12],
      fontFamily: "system-ui, sans-serif",
      outlineWidth: 2,
      outlineColor: [10, 14, 18, 255],
      fontSettings: { sdf: true },
      pickable: false,
    });
  }
}

/** Interpolate a world position at `dist` metres along a line's polyline. */
function positionOnLine(snap: SimSnapshot, line: Line, dist: number): Vec2 {
  const ids = line.stationIds;
  const cum = line.stationDist;
  if (dist <= 0) return snap.stations.get(ids[0])!.pos;
  for (let i = 1; i < ids.length; i++) {
    if (dist <= cum[i]) {
      const a = snap.stations.get(ids[i - 1])!.pos;
      const b = snap.stations.get(ids[i])!.pos;
      const span = cum[i] - cum[i - 1];
      const t = span > 0 ? (dist - cum[i - 1]) / span : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return snap.stations.get(ids[ids.length - 1])!.pos;
}
