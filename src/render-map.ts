/**
 * Phase-1 render stack (GDD §1.2): MapLibre GL dark basemap (OpenStreetMap
 * vector tiles via OpenFreeMap — hosted for now, self-hosted PMTiles later)
 * with deck.gl layers on top via MapboxOverlay:
 *
 *   PolygonLayer     demand choropleth over census tracts (toggle · D)
 *   PathLayer        METRO reference-network ghost (toggle · G)
 *   PathLayer        player lines, one segment per (line, edge); edges
 *                    shared by 2+ lines split into side-by-side strips
 *   ScatterplotLayer through-stations (white dots, dark ring)
 *   IconLayer        interchange stations (diamond glyph, 2+ lines)
 *   ScatterplotLayer vehicles (larger dots in their line's color)
 *   TextLayer        waiting-passenger count for the hovered station
 *
 * Static layers are cached and rebuilt only when the network version or
 * selection changes; vehicle/draft layers rebuild every frame.
 */
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  IconLayer,
  PathLayer,
  PolygonLayer,
  ScatterplotLayer,
  TextLayer,
} from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import maplibregl from "maplibre-gl";
import type { Game } from "./game";
import type { LinePoint } from "./simulation";
import type { Ring, WorldBundle } from "./world";
import type { Line, SimSnapshot, Station, Vec2 } from "./types";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

type RGBA = [number, number, number, number];

const STATION_FILL: RGBA = [246, 248, 250, 255];
const STATION_RING: RGBA = [23, 29, 36, 255];
/** Kept soft and semi-transparent so a train reads as a bead on its line
 *  rather than a dot with a hard black outline sitting over the track. */
const VEHICLE_RING: RGBA = [13, 17, 22, 150];

/** Train marker radius in ground metres — roughly a train's own footprint,
 *  so it stays plausible against the map at every zoom. */
const VEHICLE_RADIUS_M = 110;

/**
 * Sequential single-hue amber ramp for the demand choropleth, low → high.
 * Monotone in lightness with an even step gradient (validated: hue spread
 * 17°, all adjacent ΔL ≥ 0.06). The near-zero end is deliberately dark so
 * empty tracts recede into the basemap rather than masking it.
 */
const DEMAND_RAMP: [number, number, number][] = [
  [0x3b, 0x24, 0x10],
  [0x6b, 0x3d, 0x12],
  [0x9c, 0x5a, 0x14],
  [0xc8, 0x7a, 0x1c],
  [0xe8, 0x9c, 0x33],
  [0xff, 0xc2, 0x66],
];

/** One polygon part, carrying the density of the tract it belongs to. */
interface DemandPart {
  rings: Ring[];
  /** Normalised density in [0,1] — already log-scaled and percentile-clamped. */
  t: number;
}

function rampColor(t: number): RGBA {
  const x = Math.max(0, Math.min(1, t)) * (DEMAND_RAMP.length - 1);
  const i = Math.min(DEMAND_RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = DEMAND_RAMP[i];
  const b = DEMAND_RAMP[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    // Opacity rides the ramp too, so sparse tracts stay out of the way and
    // the streets underneath stay readable — this is an overlay, not a
    // standalone choropleth.
    Math.round(18 + 152 * t),
  ];
}

function hexToRgb(hex: string): RGBA {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255,
  ];
}

const ICON_SIZE = 20;

/** An interchange glyph: a diamond (square on its corner) rather than a plain
 *  circle, so a station serving 2+ lines reads as a distinct junction. */
function diamondIconUrl(stroke: string, strokeWidth: number): string {
  const c = ICON_SIZE / 2;
  // Keep the stroke and its rounded joins inside the icon canvas.
  const r = c - strokeWidth;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}">` +
    `<polygon points="${c},${c - r} ${c + r},${c} ${c},${c + r} ${c - r},${c}" ` +
    `fill="rgb(246,248,250)" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DIAMOND_ICON = diamondIconUrl("rgb(23,29,36)", 2);
const DIAMOND_ICON_SELECTED = diamondIconUrl("rgb(79,195,247)", 3);

interface TrackSegment {
  path: [number, number][];
  color: RGBA;
  width: number;
}

/** Hit radius for inspect-mode picking, screen px. */
const PICK_RADIUS_PX = 14;
/**
 * Hit radius for build-mode snapping, screen px — larger than
 * PICK_RADIUS_PX. Connecting to the right station is the whole point of a
 * click in build mode, and a near-miss silently creates a duplicate station
 * a few metres from the one the player meant. Kept modest so placing a stop
 * deliberately close to an existing one is still possible.
 */
const SNAP_RADIUS_PX = 20;

/** Where a build-mode click resolves to, plus whether it latched onto
 *  something (drives the snap indicator). */
export interface BuildTarget extends LinePoint {
  snapped: boolean;
}

/** Web Mercator ground resolution (metres/pixel) at this latitude/zoom —
 *  used to offset parallel track segments by a constant number of *screen*
 *  pixels regardless of how far the player has zoomed. */
function metersPerPixel(latDeg: number, zoom: number): number {
  return (156543.03392 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom;
}

export class MapRenderer {
  readonly map: maplibregl.Map;
  private readonly overlay: MapboxOverlay;

  /** Cursor position (already station-snapped) for the draft preview. */
  hoverLngLat: [number, number] | null = null;
  /** Whether hoverLngLat latched onto a station/draft point rather than
   *  free space — drawn as a ring so the snap is visible before clicking. */
  hoverSnapped = false;
  /** Station under the cursor, if any. Its waiting count is shown on demand
   *  rather than labelling every busy station at once, which buried the map
   *  in numbers as soon as the network got going. */
  hoveredStationId: number | null = null;
  showDemand = false;
  showGhost = false;

  private demandLayer: PolygonLayer<DemandPart> | null = null;
  private ghostLayer: PathLayer | null = null;
  /** Track and station layers are cached separately so the vehicle layer can
   *  be composited between them (see update). */
  private cachedNetwork: { track: Layer; stations: Layer[] } | null = null;
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

  /** Hit-test a station near a screen point (radius in px). */
  pickStation(
    snap: SimSnapshot,
    screen: Vec2,
    radius = PICK_RADIUS_PX,
  ): Station | null {
    let best: Station | null = null;
    let bestD = radius;
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

  /**
   * What a build-mode click at `screen` should attach to, in priority order:
   * a committed station, then a point already placed in the line being drawn,
   * then a brand-new station at the raw cursor location.
   *
   * Snapping to the *draft* is what makes loops and branches drawable at all
   * — until the line is committed its points are not Stations yet, so without
   * this a click back onto the start of the line silently stacked a second
   * station on top of the first instead of closing the loop.
   */
  pickBuildTarget(
    snap: SimSnapshot,
    draft: LinePoint[],
    screen: Vec2,
    lngLat: [number, number],
  ): BuildTarget {
    const station = this.pickStation(snap, screen, SNAP_RADIUS_PX);
    if (station) {
      return { pos: station.pos, existingStationId: station.id, snapped: true };
    }

    let best: LinePoint | null = null;
    let bestD = SNAP_RADIUS_PX;
    for (const p of draft) {
      const sp = this.map.project(this.toLngLat(p.pos));
      const d = Math.hypot(sp.x - screen.x, sp.y - screen.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) {
      return {
        pos: { ...best.pos },
        existingStationId: best.existingStationId,
        snapped: true,
      };
    }

    return { pos: this.toWorld(lngLat[1], lngLat[0]), snapped: false };
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
    // Draw order matters: track → trains → stations. A train rides on top of
    // its own line but passes *under* the station markers, so one sitting at
    // a platform never hides the stop (or its interchange diamond).
    const network = this.getNetworkLayers(snap, game);
    layers.push(network.track);
    layers.push(this.buildVehicleLayer(snap, game.tickAlpha));
    layers.push(...network.stations);
    layers.push(...this.buildDraftLayers(game));
    layers.push(this.buildWaitingLayer(snap));
    this.overlay.setProps({ layers });
  }

  // ── Static/toggle layers ────────────────────────────────────────────

  /**
   * Demand as a census-tract choropleth. Colour encodes *density*, not raw
   * totals: tracts are drawn to hold roughly equal population, so a
   * count-based choropleth would read almost flat while making sprawling
   * rural tracts look as busy as downtown blocks.
   *
   * Classification is by quantile (rank / n) rather than by value. Density
   * here is severely heavy-tailed — the peak tract is ~6× the 98th
   * percentile and ~35× the median — so every value-based scale tried,
   * including log, piled most of the city into one or two ramp steps.
   * Ranking spreads the tracts evenly across the ramp by construction, which
   * is what makes the urban structure legible; the trade is that colour now
   * encodes relative standing, not absolute density.
   */
  private getDemandLayer(): PolygonLayer<DemandPart> {
    if (!this.demandLayer) {
      const zones = this.world.demand.zones;

      const order = zones
        .map((z, i) => ({ i, d: (z.pop + z.jobs) / Math.max(z.areaKm2, 0.05) }))
        .sort((a, b) => a.d - b.d);
      const rank = new Float32Array(zones.length);
      const last = Math.max(1, order.length - 1);
      for (let r = 0; r < order.length; r++) rank[order[r].i] = r / last;

      const parts: DemandPart[] = [];
      for (let i = 0; i < zones.length; i++) {
        const t = rank[i];
        // One datum per part keeps multi-part tracts (bay islands) intact.
        for (const rings of zones[i].parts) parts.push({ rings, t });
      }

      this.demandLayer = new PolygonLayer<DemandPart>({
        id: "demand-tracts",
        data: parts,
        getPolygon: (d) => d.rings,
        filled: true,
        extruded: false,
        // A hairline border is what makes the tract fabric legible as
        // discrete blocks rather than a smeared heat blob.
        stroked: true,
        getFillColor: (d) => rampColor(d.t),
        getLineColor: [255, 255, 255, 30],
        getLineWidth: 0.6,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0.5,
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

  private getNetworkLayers(
    snap: SimSnapshot,
    game: Game,
  ): { track: Layer; stations: Layer[] } {
    // Bucketed rather than exact: parallel-track offsets need to stay in
    // step with zoom (see buildTrackSegments), but rebuilding on every
    // sub-pixel zoom tick would be wasted work.
    const zoomBucket = Math.round(this.map.getZoom() * 10);
    const key = `${snap.networkVersion}|${game.selection?.kind ?? ""}:${game.selection?.id ?? ""}|${zoomBucket}`;
    if (key === this.cachedNetworkKey && this.cachedNetwork) {
      return this.cachedNetwork;
    }

    const stations = [...snap.stations.values()];
    const selLine =
      game.selection?.kind === "line" ? game.selection.id : null;
    const selStation =
      game.selection?.kind === "station" ? game.selection.id : null;

    const track = new PathLayer<TrackSegment>({
      id: "player-lines",
      data: this.buildTrackSegments(snap, selLine),
      getPath: (s) => s.path,
      getColor: (s) => s.color,
      getWidth: (s) => s.width,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      pickable: false,
    });

    const stationLayers: Layer[] = [
      new ScatterplotLayer<Station>({
        id: "stations",
        data: stations.filter((s) => s.lineIds.length <= 1),
        getPosition: (s) => this.toLngLat(s.pos),
        getRadius: 5,
        radiusUnits: "pixels",
        getFillColor: STATION_FILL,
        stroked: true,
        getLineColor: (s) =>
          s.id === selStation ? ([79, 195, 247, 255] as RGBA) : STATION_RING,
        getLineWidth: (s) => (s.id === selStation ? 3 : 2),
        lineWidthUnits: "pixels",
        pickable: false,
      }),
      // Interchanges (2+ lines) get the diamond glyph instead.
      new IconLayer<Station>({
        id: "stations-interchange",
        data: stations.filter((s) => s.lineIds.length > 1),
        getPosition: (s) => this.toLngLat(s.pos),
        getIcon: (s) => ({
          url: s.id === selStation ? DIAMOND_ICON_SELECTED : DIAMOND_ICON,
          width: ICON_SIZE,
          height: ICON_SIZE,
          id: s.id === selStation ? "diamond-sel" : "diamond",
        }),
        sizeUnits: "pixels",
        getSize: ICON_SIZE,
        getColor: [255, 255, 255, 255],
        pickable: false,
      }),
    ];
    this.cachedNetwork = { track, stations: stationLayers };
    this.cachedNetworkKey = key;
    return this.cachedNetwork;
  }

  /**
   * One straight PathLayer entry per (line, edge). An edge shared by more
   * than one line — a parallel/overlapping trunk — is split into equal-width
   * strips offset sideways by a fixed screen-pixel amount, so it reads as
   * colors side by side rather than one line painted over the other.
   */
  private buildTrackSegments(
    snap: SimSnapshot,
    selLine: number | null,
  ): TrackSegment[] {
    interface Member {
      lineId: number;
      color: string;
    }
    const groups = new Map<string, Member[]>();
    const edgeOrder: string[] = [];
    for (const line of snap.lines.values()) {
      for (let i = 0; i < line.stationIds.length - 1; i++) {
        const a = line.stationIds[i];
        const b = line.stationIds[i + 1];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        let g = groups.get(key);
        if (!g) {
          g = [];
          groups.set(key, g);
          edgeOrder.push(key);
        }
        if (!g.some((m) => m.lineId === line.id)) {
          g.push({ lineId: line.id, color: line.color });
        }
      }
    }

    const metersPerPx = metersPerPixel(
      this.map.getCenter().lat,
      this.map.getZoom(),
    );

    const segments: TrackSegment[] = [];
    for (const key of edgeOrder) {
      const [aStr, bStr] = key.split("|");
      const aPos = snap.stations.get(Number(aStr))!.pos;
      const bPos = snap.stations.get(Number(bStr))!.pos;
      const dx = bPos.x - aPos.x;
      const dy = bPos.y - aPos.y;
      const len = Math.hypot(dx, dy) || 1;
      // Consistent regardless of each line's own travel direction, so every
      // member of the group offsets to the same reference side.
      const perp = { x: -dy / len, y: dx / len };

      const members = groups.get(key)!.sort((a, b) => a.lineId - b.lineId);
      const n = members.length;
      const totalWidth = members.some((m) => m.lineId === selLine) ? 8 : 5.5;
      const subWidth = totalWidth / n;

      members.forEach((m, i) => {
        const offsetM = (i - (n - 1) / 2) * subWidth * metersPerPx;
        const oa: Vec2 = {
          x: aPos.x + perp.x * offsetM,
          y: aPos.y + perp.y * offsetM,
        };
        const ob: Vec2 = {
          x: bPos.x + perp.x * offsetM,
          y: bPos.y + perp.y * offsetM,
        };
        segments.push({
          path: [this.toLngLat(oa), this.toLngLat(ob)],
          color: hexToRgb(m.color),
          width: subWidth,
        });
      });
    }
    return segments;
  }

  // ── Per-frame layers ────────────────────────────────────────────────

  private buildDraftLayers(game: Game): Layer[] {
    if (game.mode !== "build") return [];
    // The snap ring shows before the first point is placed too, so the player
    // can see they are about to branch off an existing station.
    const snapRing = this.hoverSnapped && this.hoverLngLat
      ? [
          new ScatterplotLayer({
            id: "snap-target",
            data: [this.hoverLngLat],
            getPosition: (p: [number, number]) => p,
            getRadius: 11,
            radiusUnits: "pixels",
            filled: false,
            stroked: true,
            getLineColor: [79, 195, 247, 235],
            getLineWidth: 2,
            lineWidthUnits: "pixels",
            pickable: false,
          }),
        ]
      : [];
    if (game.draft.length === 0) return snapRing;

    const pts = game.draft.map((p) => this.toLngLat(p.pos));
    const preview = this.hoverLngLat ? [...pts, this.hoverLngLat] : pts;
    return [
      ...snapRing,
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
      // Sized in metres, not screen pixels: a train is a thing on the ground,
      // so zooming out shrinks it along with the city instead of leaving a
      // constant-size dot that swallows the map at region scale. The clamps
      // keep it from vanishing when zoomed right out or ballooning up close.
      getRadius: VEHICLE_RADIUS_M,
      radiusUnits: "meters",
      // The floor is the intended cutoff: past roughly zoom 12 (region
      // scale) a train would shrink below its own 5.5px track and melt into
      // the line, so it stops scaling there and holds a legible size. It sits
      // just above the track width for exactly that reason.
      radiusMinPixels: 4,
      // Zooming *in* keeps scaling; this ceiling is only a guard so the
      // marker stays a train-sized bead at street zoom instead of a blob.
      radiusMaxPixels: 13,
      getFillColor: (v) => hexToRgb(snap.lines.get(v.lineId)!.color),
      stroked: true,
      getLineColor: VEHICLE_RING,
      getLineWidth: 1,
      lineWidthUnits: "pixels",
      pickable: false,
    });
  }

  private buildWaitingLayer(snap: SimSnapshot): Layer {
    const hovered =
      this.hoveredStationId === null
        ? null
        : (snap.stations.get(this.hoveredStationId) ?? null);
    return new TextLayer<Station>({
      id: "waiting-counts",
      // Only the hovered station, and only when someone is actually waiting —
      // a lone "0" floating by a quiet stop is noise, not information.
      data: hovered && hovered.waiting.length > 0 ? [hovered] : [],
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
