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
import {
  bearingRad,
  stationCorners,
  stationHalfLengthM,
  stationHalfWidthM,
  stationNodes,
  wrapAngle,
} from "./geo";
import {
  defaultPlatformLengthM,
  FACILITY_SPECS,
  facilityBuildCost,
  getRollingStockSpec,
  platformSegmentPath,
} from "./mobility";
import type { ThemeMode } from "./preferences";
import type { LinePoint } from "./simulation";
import { RoadGraph } from "./road-graph";
import type { Ring, WorldBundle } from "./world";
import type {
  Line,
  MobilityFacility,
  RailAlignment,
  SimSnapshot,
  Station,
  TransitMode,
  Vec2,
  Vehicle,
} from "./types";

const BASEMAP_STYLES: Record<ThemeMode, string> = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/bright",
};
const BUILDINGS_LAYER_ID = "real-world-3d-buildings";
const BUILDINGS_SOURCE_ID = "openmaptiles";
const BUILDINGS_SOURCE_LAYER = "building";
const THREE_DIMENSIONAL_MIN_ZOOM = 14.85;
const TRAFFIC_LAYER_ID = "live-road-congestion";
const TRAFFIC_CARS_LAYER_ID = "live-road-cars";
const TRAFFIC_CAR_IMAGE_ID = "traffic-car-model";

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

/**
 * Parsed channel triples, keyed by the hex string.
 *
 * Callers get a fresh array (several of them set the alpha afterwards), but
 * the string slicing and three parseInt calls happen once per distinct
 * colour for the life of the page. The palettes are fixed and small — ten
 * line colours and a handful of facility ones — while this runs per vehicle
 * per frame, so the map never grows and the parse never repeats.
 */
const HEX_CHANNEL_CACHE = new Map<string, [number, number, number]>();

/** Drop points a routed path repeats at joins between consecutive edges. */
function dedupePath(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) <= 0.5) continue;
    out.push(point);
  }
  return out;
}

function hexToRgb(hex: string): RGBA {
  let channels = HEX_CHANNEL_CACHE.get(hex);
  if (!channels) {
    const h = hex.replace("#", "");
    channels = [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
    HEX_CHANNEL_CACHE.set(hex, channels);
  }
  return [channels[0], channels[1], channels[2], 255];
}

function compactMoney(value: number): string {
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }
  return `$${Math.round(value / 1_000_000)}M`;
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
  path: [number, number, number][];
  color: RGBA;
  width: number;
  mode: TransitMode;
  alignment: RailAlignment;
  levelM: number;
  noiseDb: number;
}

interface StationModel {
  station: Station;
  polygon: [number, number, number][];
  elevation: number;
  color: RGBA;
}

interface VehicleModel {
  vehicle: Vehicle;
  polygon: [number, number, number][];
  position: [number, number, number];
  color: RGBA;
  /** Marker radius in metres, by line mode. */
  radiusM: number;
}

interface DemolitionSite {
  pos: Vec2;
  alignment: RailAlignment;
}

interface RoadModel {
  /** Projected metres, used for cursor snapping. */
  points: Vec2[];
  /** Raw lng/lat, fed straight to the GeoJSON source. */
  line: [number, number][];
  roadClass: string;
  /** Slip road / interchange ramp, per the tiles' own `ramp` flag. */
  isRamp: boolean;
  widthM: number;
  /** World-metre bounds, so cursor snapping can reject in four comparisons. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface RoadNode {
  pos: Vec2;
  links: Map<string, number>;
}

interface BuildingFootprint {
  featureId?: string | number;
  /** Extruded height in metres, matching the basemap's render_height. */
  heightM: number;
  /** Tagged hide_3d: real enough to demolish, but never drawn as a solid. */
  hide3d: boolean;
  ring: [number, number][];
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  center: Vec2;
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
  valid: boolean;
  /** Platform angle to place with, radians. Always resolved. */
  orientationRad: number;
  /**
   * The same angle *before* the player's rotation offset is added.
   *
   * The preview re-adds the offset every frame instead of caching the final
   * angle, because the cursor can sit perfectly still while a rotate key is
   * held — and the ghost still has to turn.
   */
  orientationBaseRad: number;
  /** True when the angle belongs to something already placed — a built
   *  platform, or a draft point being closed onto — and the rotate keys must
   *  leave it alone. */
  orientationLocked: boolean;
}

/** What snapping produces before the platform angle is worked out. */
type UnorientedBuildTarget = Omit<
  BuildTarget,
  "orientationRad" | "orientationBaseRad" | "orientationLocked"
>;

/** Web Mercator ground resolution (metres/pixel) at this latitude/zoom —
 *  used to offset parallel track segments by a constant number of *screen*
 *  pixels regardless of how far the player has zoomed. */
/**
 * Padding on the world-space road-snap pre-filter. A tilted camera makes the
 * screen-pixel:metre ratio vary widely across the viewport, so the cheap
 * rejection radius is scaled up rather than computed exactly — it only has to
 * never discard a road the precise screen-space test would have matched.
 */
const ROAD_SNAP_REJECT_FACTOR = 6;

function metersPerPixel(latDeg: number, zoom: number): number {
  return (156543.03392 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom;
}

function isLngLat(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function roadLineStrings(
  geometry: { type: string; coordinates: unknown },
): [number, number][][] {
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    const line = geometry.coordinates.filter(isLngLat);
    return line.length >= 2 ? [line] : [];
  }
  if (
    geometry.type === "MultiLineString" &&
    Array.isArray(geometry.coordinates)
  ) {
    return geometry.coordinates
      .filter(Array.isArray)
      .map((line) => line.filter(isLngLat))
      .filter((line) => line.length >= 2);
  }
  return [];
}

function buildingOuterRings(
  geometry: { type: string; coordinates: unknown },
): [number, number][][] {
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    const outer = geometry.coordinates[0];
    return Array.isArray(outer) ? [outer.filter(isLngLat)] : [];
  }
  if (
    geometry.type === "MultiPolygon" &&
    Array.isArray(geometry.coordinates)
  ) {
    const rings: [number, number][][] = [];
    for (const polygon of geometry.coordinates) {
      if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) continue;
      const outer = polygon[0].filter(isLngLat);
      if (outer.length >= 3) rings.push(outer);
    }
    return rings;
  }
  return [];
}

function roadWidthM(roadClass: string, isRamp: boolean): number {
  // A freeway ramp carries class=motorway in the tiles, so without this it was
  // drawn at the mainline's full 19 m. At an interchange that fused every ramp
  // into one continuous slab — 220 of the 390 motorway features around the
  // I-45 junction are ramps.
  if (isRamp) {
    return roadClass === "motorway" || roadClass === "trunk" ? 8 : 6.5;
  }
  if (roadClass === "motorway") return 19;
  if (roadClass === "trunk") return 16;
  if (roadClass === "primary") return 13;
  if (roadClass === "secondary") return 10;
  if (roadClass === "tertiary") return 8.5;
  if (roadClass === "service") return 5.5;
  return 7;
}

/**
 * Snap radius for placing a bus stop, in screen pixels and in metres.
 *
 * Kept in pixels because that is what the gesture is — the player is aiming
 * at a road they can see, and a tolerance that ignored zoom would either
 * refuse a click that visually landed on a street (zoomed out) or grab a
 * street a block away (zoomed in). The clamps stop it degenerating at the
 * extremes: at region zoom 28 px is kilometres, and at street zoom it is a
 * couple of metres, which would make the tool feel broken in both directions.
 *
 * Only *which* road the click chooses depends on the camera. The path and its
 * cost come from the baked graph, so a committed line prices the same at any
 * zoom — which was the whole point of the rework.
 */
const BUS_SNAP_PX = 28;
const BUS_SNAP_MIN_M = 45;
const BUS_SNAP_MAX_M = 400;

const ROAD_SOURCE_ID = "game-road-structures";
const ROAD_LAYER_SHADOW = "game-road-shadow";
const ROAD_LAYER_EDGE = "game-road-edge";
const ROAD_LAYER_SURFACE = "game-road-surface";
const ROAD_LAYER_STRIPE = "game-road-stripe";
const ROAD_LAYER_IDS = [
  ROAD_LAYER_SHADOW,
  ROAD_LAYER_EDGE,
  ROAD_LAYER_SURFACE,
  ROAD_LAYER_STRIPE,
];

/** Classes that carry a painted centre line. */
const ARTERY_CLASSES = new Set(["motorway", "trunk", "primary", "secondary"]);

/**
 * Pixels per metre at z10 and z22, at Houston's latitude.
 *
 * MapLibre line widths are in screen pixels, but these are real carriageways
 * and have to hold their ground width.
 *
 * Note the 512. MapLibre's world is `512 * 2^zoom` pixels across, so the
 * familiar `156543.03392 / 2^zoom` metres-per-pixel constant — which assumes
 * 256 px tiles — is exactly twice the real value here. Using it rendered every
 * carriageway at half width, which also let the basemap's own wider casings
 * show out from under them as heavy dark halos.
 *
 * Mercator pixel size halves every zoom level, so an `exponential` base-2
 * interpolation between two anchors whose outputs differ by exactly 2^(z2-z1)
 * is metre-exact everywhere between them — hence 4096x across these twelve.
 */
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const ROAD_PX_PER_M_Z10 =
  (512 * 2 ** 10) /
  (EARTH_CIRCUMFERENCE_M * Math.cos((29.76 * Math.PI) / 180));
const ROAD_PX_PER_M_Z22 = ROAD_PX_PER_M_Z10 * 4096;

/**
 * Below these zooms a road class is not worth extruding. A residential street
 * at z12 is a sub-pixel sliver, but there are tens of thousands of them: the
 * tile source yields 34,285 road features at z11 against 2,074 at z17, and
 * every one of them used to be turned into deck geometry on the main thread.
 */
const ROAD_CLASS_MIN_ZOOM: Record<string, number> = {
  motorway: 0,
  trunk: 0,
  primary: 11,
  secondary: 12.5,
  tertiary: 13.5,
  minor: 14.5,
  street: 14.5,
  street_limited: 14.5,
  residential: 14.5,
  unclassified: 14.5,
  living_street: 15,
  service: 15.5,
};

function roadNodeKey(lng: number, lat: number): string {
  // Quantised to the same 1e-6 grid toFixed(6) produced, but without the
  // number-to-string formatter: this runs twice per road segment, which is
  // tens of thousands of calls on every extraction.
  return `${Math.round(lng * 1e6)},${Math.round(lat * 1e6)}`;
}

function orientation(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return (
    ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) &&
    ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0))
  );
}

function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

interface QueueEntry {
  key: string;
  priority: number;
}

class MinQueue {
  private readonly entries: QueueEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(entry: QueueEntry): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.entries[parent].priority <= entry.priority) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): QueueEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (!first || !last || this.entries.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      const child =
        right < this.entries.length &&
        this.entries[right].priority < this.entries[left].priority
          ? right
          : left;
      if (this.entries[child].priority >= last.priority) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

export class MapRenderer {
  readonly map: maplibregl.Map;
  private readonly overlay: MapboxOverlay;

  /** Cursor position (already station-snapped) for the draft preview. */
  hoverLngLat: [number, number] | null = null;
  /** Whether hoverLngLat latched onto a station/draft point rather than
   *  free space — drawn as a ring so the snap is visible before clicking. */
  hoverSnapped = false;
  /**
   * Angle of the platform ghost under the cursor *before* the rotation
   * offset, radians. The offset is applied at draw time rather than stored
   * here, so holding a rotate key turns the ghost even though no mousemove
   * fires to refresh this.
   */
  hoverBaseOrientationRad = 0;
  /** True when the hovered target's angle is fixed by what it snapped to,
   *  and the rotate keys do not apply. */
  hoverOrientationLocked = false;
  /** Station under the cursor, if any. Its waiting count is shown on demand
   *  rather than labelling every busy station at once, which buried the map
   *  in numbers as soon as the network got going. */
  hoveredStationId: number | null = null;
  showDemand = false;
  showGhost = false;
  // Off by default: the congestion wash is a diagnostic, and it reads as the
  // loudest thing on the map when all you wanted was to look at the city.
  showTraffic = false;
  private threeDimensional: boolean;
  private theme: ThemeMode;
  private trafficStyleKey = "";

  /** Derived choropleth data, cached — but never the Layer instance itself
   *  (see getDemandLayer). */
  private demandParts: DemandPart[] | null = null;
  /** Track and station layers are cached separately so the vehicle layer can
   *  be composited between them (see update). */
  private cachedNetwork: { track: Layer[]; stations: Layer[] } | null = null;
  private cachedNetworkKey = "";
  /**
   * The baked citywide street graph, once it has loaded.
   *
   * Null until the player first needs it — see ensureRoadGraph. Everything
   * that touches it keeps a tile-graph fallback, so bus building works from
   * the first click and simply gets better when this arrives.
   */
  private roadGraph: RoadGraph | null = null;
  private roadGraphLoad: Promise<void> | null = null;
  /** networkVersion the parallel-edge answer below was computed for. */
  private zoomKeyVersion = -1;
  private zoomKeyNeeded = false;
  private cachedMobility: Layer[] | null = null;
  private cachedMobilityKey = "";
  private roadModels: RoadModel[] = [];
  private roadNodes = new Map<string, RoadNode>();
  private buildingFootprints: BuildingFootprint[] = [];
  private roadGeometryRevision = 0;
  /** Revision last pushed to the GeoJSON source. */
  private roadDataRevision = -1;
  private roadStripeStyleKey = "";
  private roadLayersVisible: boolean | null = null;
  private geometryViewportKey = "";
  private demolitionFilterKey = "";
  /** networkVersion the demolition filter was last computed for; the set
   *  only changes when the network does. */
  private demolitionFilterVersion = -1;

  constructor(
    container: HTMLElement,
    private readonly world: WorldBundle,
    options: { initial3d?: boolean; theme?: ThemeMode } = {},
  ) {
    this.threeDimensional = options.initial3d ?? true;
    this.theme = options.theme ?? "dark";
    this.map = new maplibregl.Map({
      container,
      style: BASEMAP_STYLES[this.theme],
      center:
        world.meta.city.toLowerCase() === "houston"
          ? [-95.3698, 29.7604]
          : [world.demand.origin.lng, world.demand.origin.lat],
      zoom: this.threeDimensional ? 15.05 : 10.3,
      pitch: this.threeDimensional ? 58 : 0,
      bearing: this.threeDimensional ? -24 : 0,
      dragRotate: this.threeDimensional,
      pitchWithRotate: true,
      touchPitch: this.threeDimensional,
      maxPitch: 65,
      canvasContextAttributes: { antialias: true },
      attributionControl: { compact: true },
    });
    this.map.doubleClickZoom.disable();
    if (this.threeDimensional) {
      this.map.touchZoomRotate.enableRotation();
      this.map.keyboard.enableRotation();
    } else {
      this.map.touchZoomRotate.disableRotation();
      this.map.keyboard.disableRotation();
    }
    // One overlay, holding the transit network only. It is non-interleaved, so
    // it draws in its own pass over the finished map frame and lines, trains
    // and stations stay legible above the city — which is what we want for
    // them, and exactly what we do not want for the roads. Those live in
    // MapLibre itself (see ensureRoadStructureLayers) so that the basemap's own
    // labels and icons can draw on top of them.
    this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.map.addControl(this.overlay as unknown as maplibregl.IControl);
    this.map.on("load", () => {
      this.ensureBuildingsLayer();
      this.ensureRoadStructureLayers();
      this.ensureTrafficLayers();
      this.declutterRoadLabels();
    });
    this.map.on("idle", this.refreshWorldGeometry);
  }

  setTheme(theme: ThemeMode): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.trafficStyleKey = "";
    this.cachedNetworkKey = "";
    this.cachedMobilityKey = "";
    this.geometryViewportKey = "";
    this.demolitionFilterKey = "";
    this.demolitionFilterVersion = -1;
    // setStyle drops every layer and source we added, so the road layers are
    // rebuilt from scratch below and their cached state has to go with them.
    this.roadDataRevision = -1;
    this.roadStripeStyleKey = "";
    this.roadLayersVisible = null;
    this.map.setStyle(BASEMAP_STYLES[theme]);
    this.map.once("style.load", () => {
      this.ensureBuildingsLayer();
      this.ensureRoadStructureLayers();
      this.ensureTrafficLayers();
      this.declutterRoadLabels();
      // No re-extraction here: the permanent `idle` listener added in the
      // constructor already covers it, and the street graph comes from the
      // tile source, which a theme change does not touch. The layers that
      // setStyle really did drop are rebuilt above, and their data is
      // re-pushed by ensureRoadStructureLayers.
    });
  }

  /**
   * Start loading the citywide street graph, if it is not already on its way.
   *
   * Called when the player switches to bus mode rather than at boot: the file
   * is about 5.5 MB over the wire, and putting it on the boot path would cost
   * every player who never builds a bus line. Idempotent, and failures are
   * swallowed to a console warning — bus building keeps working off the tile
   * graph, just limited to the loaded viewport as before.
   */
  ensureRoadGraph(): void {
    if (this.roadGraph || this.roadGraphLoad) return;
    this.roadGraphLoad = RoadGraph.load(
      import.meta.env.BASE_URL,
      this.world.projection,
    )
      .then((graph) => {
        this.roadGraph = graph;
      })
      .catch((error) => {
        console.warn(
          "street graph unavailable; bus routing stays limited to loaded tiles",
          error,
        );
      });
  }

  /** Whether the citywide graph has arrived. */
  get hasRoadGraph(): boolean {
    return this.roadGraph !== null;
  }

  /** Whether the map is currently using the pitched, real-height city view. */
  get is3d(): boolean {
    return this.threeDimensional;
  }

  get geometryStats(): {
    roads: number;
    roadNodes: number;
    buildings: number;
  } {
    return {
      roads: this.roadModels.length,
      roadNodes: this.roadNodes.size,
      buildings: this.buildingFootprints.length,
    };
  }

  /**
   * Toggle a pitched city view built from OpenStreetMap building footprints.
   * OpenFreeMap's render_height and render_min_height fields preserve tagged
   * real-world height/base data and provide schema-level estimates where a
   * building has no explicit height tag.
   */
  set3dMode(enabled: boolean): void {
    if (enabled === this.threeDimensional) return;
    this.threeDimensional = enabled;
    this.syncRoadStructureVisibility();

    if (this.map.isStyleLoaded()) this.ensureBuildingsLayer();

    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 850;

    if (enabled) {
      this.setBuildingsVisibility("visible");
      this.map.dragRotate.enable();
      this.map.touchZoomRotate.enableRotation();
      this.map.touchPitch.enable();
      this.map.keyboard.enableRotation();
      this.map.easeTo({
        pitch: 58,
        bearing: -24,
        zoom: Math.max(this.map.getZoom(), THREE_DIMENSIONAL_MIN_ZOOM),
        duration,
      });
      return;
    }

    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();
    this.map.touchPitch.disable();
    this.map.keyboard.disableRotation();
    this.map.easeTo({
      pitch: 0,
      bearing: 0,
      zoom: Math.min(this.map.getZoom(), 12.6),
      duration,
    });
    this.map.once("moveend", () => {
      if (!this.threeDimensional) this.setBuildingsVisibility("none");
    });
  }

  /**
   * Anchor for layers painted onto the roadway: above the last road line,
   * below the first label that sits over it.
   *
   * Deliberately *not* "the first symbol layer in the style". The two
   * OpenFreeMap styles order their layers completely differently — `bright`
   * puts its first symbol at index 94, after all 57 road layers, while `dark`
   * puts a `water_name` label at index 8, *before* all 15 of its roads and
   * before its flat `building` fill. Anchoring to the first symbol therefore
   * worked in light mode and silently buried our layers underneath every road,
   * and underneath an opaque rgb(10,10,10) building fill, in dark mode.
   */
  private roadLabelAnchorId(): string | undefined {
    const layers = this.map.getStyle().layers;
    let lastRoadLayer = -1;
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index];
      if (
        layer.type === "line" &&
        "source-layer" in layer &&
        layer["source-layer"] === "transportation"
      ) {
        lastRoadLayer = index;
      }
    }
    for (let index = lastRoadLayer + 1; index < layers.length; index++) {
      if (layers[index].type === "symbol") return layers[index].id;
    }
    return undefined;
  }

  /**
   * Anchor for the 3D extrusions: above every street-level label, below the
   * place names.
   *
   * Street labels are painted flat on the ground — road names, shields,
   * one-way arrows, POI pins — so leaving them above the extrusions made
   * street names read straight through the middle of a tower. Both styles
   * order these the same way (dark 32-33, bright 94-108), and in both the
   * first `place` layer is the boundary: everything before it is street
   * furniture that belongs behind the geometry, everything from it on is a
   * neighbourhood, city or state name that has to stay legible over downtown.
   */
  private buildingAnchorId(): string | undefined {
    for (const layer of this.map.getStyle().layers) {
      if (
        layer.type === "symbol" &&
        "source-layer" in layer &&
        layer["source-layer"] === "place"
      ) {
        return layer.id;
      }
    }
    return undefined;
  }

  private ensureBuildingsLayer(): void {
    if (this.map.getLayer(BUILDINGS_LAYER_ID)) {
      this.setBuildingsVisibility(this.threeDimensional ? "visible" : "none");
      return;
    }

    // Place names stay above the extrusions, street furniture goes behind
    // them — see buildingAnchorId.
    const labelAnchor = this.buildingAnchorId();
    // The low steps stay deliberately close to the basemap so Houston's
    // low-rise sprawl reads as texture rather than as thousands of blocks.
    // The tall steps climb hard on purpose: downtown towers have to sit well
    // clear of the dark basemap's rgb(12,12,12) ground, or their shaded walls
    // sink into it and the whole mass reads as see-through.
    const buildingColors =
      this.theme === "light"
        ? ["#ededed", "#dcdcdc", "#c2c2c6", "#a2a2ab", "#83838f"]
        : ["#1f1f23", "#2b2b32", "#3f3f4a", "#565664", "#727284"];

    this.map.addLayer(
      {
        id: BUILDINGS_LAYER_ID,
        type: "fill-extrusion",
        source: BUILDINGS_SOURCE_ID,
        "source-layer": BUILDINGS_SOURCE_LAYER,
        minzoom: 12.5,
        filter: ["!=", ["get", "hide_3d"], true],
        layout: {
          visibility: this.threeDimensional ? "visible" : "none",
        },
        paint: {
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "render_height"], 8],
            0,
            buildingColors[0],
            35,
            buildingColors[1],
            110,
            buildingColors[2],
            180,
            buildingColors[3],
            300,
            buildingColors[4],
          ],
          "fill-extrusion-height": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12.5,
            0,
            14,
            ["coalesce", ["get", "render_height"], 8],
          ],
          "fill-extrusion-base": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12.5,
            0,
            14,
            ["coalesce", ["get", "render_min_height"], 0],
          ],
          // Fully opaque, and it has to stay here: at 0.93 the basemap
          // roadway underneath bled through the towers, which read as roads
          // clipping through the geometry. This is already the maximum — a
          // tower that still looks see-through is a layer-order or contrast
          // problem, not an opacity one.
          "fill-extrusion-opacity": 1,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      labelAnchor,
    );
  }

  private setBuildingsVisibility(visibility: "visible" | "none"): void {
    if (!this.map.getLayer(BUILDINGS_LAYER_ID)) return;
    this.map.setLayoutProperty(BUILDINGS_LAYER_ID, "visibility", visibility);
  }

  /**
   * Traffic stays in MapLibre's tile renderer rather than becoming thousands
   * of JS entities. The overlay follows real OpenStreetMap highway geometry,
   * while repeated lightweight car glyphs provide street-scale activity.
   */
  private ensureTrafficLayers(): void {
    if (this.map.getLayer(TRAFFIC_LAYER_ID)) return;

    if (!this.map.hasImage(TRAFFIC_CAR_IMAGE_ID)) {
      const canvas = document.createElement("canvas");
      canvas.width = 28;
      canvas.height = 14;
      const context = canvas.getContext("2d");
      if (context) {
        context.fillStyle = this.theme === "light" ? "#34474e" : "#f2f8f8";
        context.beginPath();
        context.roundRect(2, 3, 24, 8, 3);
        context.fill();
        context.fillStyle = this.theme === "light" ? "#a9c0c7" : "#6c8791";
        context.fillRect(8, 3, 11, 4);
        context.fillStyle = this.theme === "light" ? "#16262c" : "#081217";
        context.beginPath();
        context.arc(7, 12, 2, 0, Math.PI * 2);
        context.arc(21, 12, 2, 0, Math.PI * 2);
        context.fill();
        this.map.addImage(
          TRAFFIC_CAR_IMAGE_ID,
          context.getImageData(0, 0, canvas.width, canvas.height),
          { pixelRatio: 2 },
        );
      }
    }

    // Below the game's own road decks, which is where this has always
    // effectively sat: as deck.gl geometry the decks were painted over the
    // whole frame and hid it in 3D, while 2D (decks hidden) showed it. Moving
    // the decks into the style made that accident explicit, so anchor beneath
    // them to keep the same result rather than letting the glow and its car
    // icons suddenly paint over every carriageway.
    const trafficAnchor = this.map.getLayer(ROAD_LAYER_SHADOW)
      ? ROAD_LAYER_SHADOW
      : this.map.getLayer(BUILDINGS_LAYER_ID)
        ? BUILDINGS_LAYER_ID
        : this.roadLabelAnchorId();
    const roadFilter: maplibregl.FilterSpecification = [
      "match",
      ["get", "class"],
      ["motorway", "trunk", "primary", "secondary"],
      true,
      false,
    ];

    this.map.addLayer(
      {
        id: TRAFFIC_LAYER_ID,
        type: "line",
        source: BUILDINGS_SOURCE_ID,
        "source-layer": "transportation",
        minzoom: 7,
        filter: roadFilter,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#ef9f58",
          "line-opacity": 0.45,
          "line-blur": 1.2,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            7,
            0.8,
            11,
            2,
            16,
            5,
          ],
        },
      },
      trafficAnchor,
    );

    if (this.map.hasImage(TRAFFIC_CAR_IMAGE_ID)) {
      this.map.addLayer(
        {
          id: TRAFFIC_CARS_LAYER_ID,
          type: "symbol",
          source: BUILDINGS_SOURCE_ID,
          "source-layer": "transportation",
          minzoom: 9,
          filter: [
            "match",
            ["get", "class"],
            ["motorway", "trunk", "primary"],
            true,
            false,
          ],
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 130,
            "icon-image": TRAFFIC_CAR_IMAGE_ID,
            "icon-size": [
              "interpolate",
              ["linear"],
              ["zoom"],
              9,
              0.45,
              16,
              1,
            ],
            "icon-rotation-alignment": "map",
            "icon-pitch-alignment": "map",
            "icon-allow-overlap": false,
          },
          paint: {
            "icon-opacity": 0.72,
          },
        },
        trafficAnchor,
      );
    }
  }

  private updateTrafficStyle(congestionIndex: number): void {
    if (!this.map.getLayer(TRAFFIC_LAYER_ID)) return;
    const bucket = Math.round(congestionIndex / 5) * 5;
    const styleKey = `${this.showTraffic}|${bucket}`;
    if (styleKey === this.trafficStyleKey) return;
    this.trafficStyleKey = styleKey;

    const visibility = this.showTraffic ? "visible" : "none";
    this.map.setLayoutProperty(TRAFFIC_LAYER_ID, "visibility", visibility);
    if (this.map.getLayer(TRAFFIC_CARS_LAYER_ID)) {
      this.map.setLayoutProperty(
        TRAFFIC_CARS_LAYER_ID,
        "visibility",
        visibility,
      );
      this.map.setLayoutProperty(
        TRAFFIC_CARS_LAYER_ID,
        "symbol-spacing",
        Math.max(70, 205 - bucket * 1.25),
      );
      this.map.setPaintProperty(
        TRAFFIC_CARS_LAYER_ID,
        "icon-opacity",
        0.48 + bucket / 250,
      );
    }

    const color =
      bucket >= 85
        ? "#ef6b61"
        : bucket >= 65
          ? "#f08f52"
          : bucket >= 45
            ? "#e4b64f"
            : "#65d49b";
    this.map.setPaintProperty(TRAFFIC_LAYER_ID, "line-color", color);
    this.map.setPaintProperty(
      TRAFFIC_LAYER_ID,
      "line-opacity",
      0.22 + bucket / 145,
    );
  }

  /** Cache the visible street graph and building footprints from vector tiles. */
  private refreshWorldGeometry = (): void => {
    if (!this.map.isStyleLoaded()) return;
    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    // Quantise the viewport to a fraction of its own span rather than to a
    // fixed 0.001 degrees (~110 m). The old key changed on virtually every
    // pan, so a 75-300 ms extraction re-ran constantly; now it re-runs once
    // the camera has actually moved an appreciable part of a screen.
    const spanLng = Math.abs(bounds.getEast() - bounds.getWest());
    const spanLat = Math.abs(bounds.getNorth() - bounds.getSouth());
    const step = Math.max(Math.max(spanLng, spanLat) / 6, 1e-6);
    const cell = (value: number) => Math.round(value / step);
    const viewportKey = [
      Math.round(zoom * 4),
      cell(bounds.getWest()),
      cell(bounds.getSouth()),
      cell(bounds.getEast()),
      cell(bounds.getNorth()),
    ].join("|");
    // Whether the extraction has already run for this camera is its own fact,
    // not something to infer from what it happened to find. Testing
    // `buildingFootprints.length > 0` made the guard unsatisfiable wherever
    // the building source-layer yields nothing — which is every planning
    // zoom, since 2D opens at 10.3 and the extrusion layer starts at 12.5.
    // The array then stayed empty forever (it is only overwritten when
    // non-empty, further down), so this 75-300 ms extraction re-ran on every
    // single `idle`.
    if (viewportKey === this.geometryViewportKey) return;

    let roadFeatures: maplibregl.GeoJSONFeature[];
    let buildingFeatures: maplibregl.GeoJSONFeature[];
    try {
      roadFeatures = this.map.querySourceFeatures(BUILDINGS_SOURCE_ID, {
        sourceLayer: "transportation",
      });
      buildingFeatures = this.map.querySourceFeatures(BUILDINGS_SOURCE_ID, {
        sourceLayer: BUILDINGS_SOURCE_LAYER,
      });
    } catch {
      return;
    }

    const acceptedRoadClasses = new Set([
      "motorway",
      "trunk",
      "primary",
      "secondary",
      "tertiary",
      "minor",
      "street",
      "street_limited",
      "service",
      "residential",
      "unclassified",
      "living_street",
    ]);
    const models: RoadModel[] = [];
    const nodes = new Map<string, RoadNode>();
    const seenRoads = new Set<string>();

    for (const feature of roadFeatures) {
      const properties = feature.properties ?? {};
      const roadClass = String(properties.class ?? properties.subclass ?? "minor");
      if (!acceptedRoadClasses.has(roadClass)) continue;
      if (zoom < (ROAD_CLASS_MIN_ZOOM[roadClass] ?? 14.5)) continue;
      const brunnel = String(properties.brunnel ?? "");
      // A tunnel is below ground. Extruding one put a solid slab across the
      // surface exactly where the road is supposed to disappear.
      if (brunnel === "tunnel") continue;
      const isRamp = properties.ramp === 1 || properties.ramp === "1";
      const geometry = feature.geometry as {
        type: string;
        coordinates?: unknown;
      };
      if (geometry.coordinates === undefined) continue;
      for (const line of roadLineStrings({
        type: geometry.type,
        coordinates: geometry.coordinates,
      })) {
        const first = line[0];
        const last = line[line.length - 1];
        const ends = [roadNodeKey(...first), roadNodeKey(...last)].sort();
        const signature = `${roadClass}|${ends[0]}|${ends[1]}|${line.length}`;
        if (seenRoads.has(signature)) continue;
        seenRoads.add(signature);

        const points = line.map(([lng, lat]) => this.toWorld(lat, lng));
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of points) {
          if (point.x < minX) minX = point.x;
          if (point.x > maxX) maxX = point.x;
          if (point.y < minY) minY = point.y;
          if (point.y > maxY) maxY = point.y;
        }
        models.push({
          points,
          line,
          roadClass,
          isRamp,
          widthM: roadWidthM(roadClass, isRamp),
          minX,
          minY,
          maxX,
          maxY,
        });

        for (let index = 1; index < line.length; index++) {
          const a = points[index - 1];
          const b = points[index];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy);
          if (length < 0.4) continue;

          const aKey = roadNodeKey(...line[index - 1]);
          const bKey = roadNodeKey(...line[index]);
          const aNode = nodes.get(aKey) ?? { pos: a, links: new Map() };
          const bNode = nodes.get(bKey) ?? { pos: b, links: new Map() };
          aNode.links.set(bKey, length);
          bNode.links.set(aKey, length);
          nodes.set(aKey, aNode);
          nodes.set(bKey, bNode);
        }
      }
    }

    const footprints: BuildingFootprint[] = [];
    const seenBuildings = new Set<string>();
    for (const feature of buildingFeatures) {
      const geometry = feature.geometry as {
        type: string;
        coordinates?: unknown;
      };
      if (geometry.coordinates === undefined) continue;
      // Same fallback the extrusion layer uses, so the mask matches what the
      // basemap actually draws.
      const properties = feature.properties ?? {};
      const rawHeight = properties.render_height;
      const heightM =
        typeof rawHeight === "number" && Number.isFinite(rawHeight)
          ? rawHeight
          : 8;
      const hide3d = properties.hide_3d === true;
      for (const ring of buildingOuterRings({
        type: geometry.type,
        coordinates: geometry.coordinates,
      })) {
        if (ring.length < 3) continue;
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        let lngSum = 0;
        let latSum = 0;
        for (const [lng, lat] of ring) {
          minLng = Math.min(minLng, lng);
          minLat = Math.min(minLat, lat);
          maxLng = Math.max(maxLng, lng);
          maxLat = Math.max(maxLat, lat);
          lngSum += lng;
          latSum += lat;
        }
        const centerLng = lngSum / ring.length;
        const centerLat = latSum / ring.length;
        const signature = `${Math.round(centerLng * 1e6)},${Math.round(centerLat * 1e6)}`;
        if (seenBuildings.has(signature)) continue;
        seenBuildings.add(signature);
        footprints.push({
          featureId:
            typeof feature.id === "string" || typeof feature.id === "number"
              ? feature.id
              : undefined,
          heightM,
          hide3d,
          ring,
          minLng,
          minLat,
          maxLng,
          maxLat,
          center: this.toWorld(centerLat, centerLng),
        });
      }
    }

    if (models.length > 0) {
      this.roadModels = models;
      this.roadNodes = nodes;
      // Low-zoom planning tiles omit individual buildings. Keep the last
      // detailed footprint cache when switching from 3D to 2D so clearance
      // checks remain tied to real buildings instead of losing that data.
      if (footprints.length > 0) this.buildingFootprints = footprints;
      this.geometryViewportKey = viewportKey;
      this.roadGeometryRevision++;
      this.pushRoadStructureData();
    }
  };

  /**
   * Invisible extruded copies of the basemap's buildings, drawn immediately
   * ahead of the road decks so that deck.gl's depth buffer knows the towers
   * are there.
   *
   * The roads are deck.gl geometry and the buildings are MapLibre's, so they
   * live in different renderers: deck.gl draws its overlay in a separate pass
   * over the finished map frame, and a street running behind a tower was
   * therefore painted straight over it. No amount of building opacity can fix
   * that — by the time the roads draw, the buildings are already resolved
   * pixels.
   *
   * Interleaving is the documented fix and does not work in this stack:
   * deck.gl 9.3 inside MapLibre 5 has its layer-group render() invoked with
   * valid parameters and produces no pixels whatsoever, taking every road with
   * it. Giving the towers to deck.gl instead keeps the fix inside the renderer
   * that actually works. The mask paints nothing (alpha 0, so MapLibre's own
   * extrusions remain the visible buildings) but its fragments still write
   * depth, and any road behind them is culled.
   */
  /**
   * The game's road structures, as MapLibre layers rather than deck.gl ones.
   *
   * They began in deck.gl, which draws its overlay in a separate pass over the
   * finished map frame — so the decks painted straight over every street name,
   * place label and POI icon. Nothing in a non-interleaved overlay can sit
   * between the basemap's ground and its labels, and interleaving is not
   * usable here: deck.gl 9.3 inside MapLibre 5 has its layer-group render()
   * called with valid parameters and produces no pixels at all.
   *
   * As native layers they simply take their place in the style — above the
   * basemap's roadway, below every label, and below the building extrusions.
   * The towers therefore occlude them for free, which is why the invisible
   * depth-mask this used to need is gone, along with its second overlay.
   */
  private ensureRoadStructureLayers(): void {
    if (!this.map.getSource(ROAD_SOURCE_ID)) {
      this.map.addSource(ROAD_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (this.map.getLayer(ROAD_LAYER_SHADOW)) return;

    const dark = this.theme === "dark";
    const anchor = this.roadLabelAnchorId();
    const visibility = this.threeDimensional ? "visible" : "none";
    // A zoom expression has to be the outermost one, so the per-feature width
    // multiplies inside each stop rather than wrapping the interpolation.
    const width = (property: string) =>
      [
        "interpolate",
        ["exponential", 2],
        ["zoom"],
        10,
        ["*", ["get", property], ROAD_PX_PER_M_Z10],
        22,
        ["*", ["get", property], ROAD_PX_PER_M_Z22],
      ] as unknown as maplibregl.DataDrivenPropertyValueSpecification<number>;

    const lineLayer = (
      id: string,
      widthProperty: string,
      color: string,
      opacity: number,
      filter?: maplibregl.FilterSpecification,
    ): maplibregl.LayerSpecification => ({
      id,
      type: "line",
      source: ROAD_SOURCE_ID,
      ...(filter ? { filter } : {}),
      layout: {
        visibility,
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": color,
        "line-opacity": opacity,
        "line-width": width(widthProperty),
      },
    });

    // Shadow skirt, casing, surface, centre line — added in that order against
    // the same anchor, which keeps them in that order in the style.
    this.map.addLayer(
      lineLayer(
        ROAD_LAYER_SHADOW,
        "ws",
        dark ? "#000000" : "#414446",
        dark ? 0.47 : 0.255,
      ),
      anchor,
    );
    this.map.addLayer(
      lineLayer(ROAD_LAYER_EDGE, "we", dark ? "#0c0c0c" : "#9b9b9b", 1),
      anchor,
    );
    this.map.addLayer(
      lineLayer(ROAD_LAYER_SURFACE, "w", dark ? "#303030" : "#e0e0e0", 1),
      anchor,
    );
    this.map.addLayer(
      lineLayer(ROAD_LAYER_STRIPE, "wt", "#51a968", 0.686, [
        "==",
        ["get", "st"],
        1,
      ]),
      anchor,
    );

    this.roadLayersVisible = this.threeDimensional;
    this.roadDataRevision = -1;
    this.roadStripeStyleKey = "";
    this.pushRoadStructureData();
  }

  /**
   * Space out the basemap's repeated street names, shields and one-way arrows.
   *
   * The bright style repeats one-way arrows every 75 px of line and shields
   * every 200 px. None of that showed while the game's road decks were painted
   * over the whole frame; now that the labels correctly sit on top of them, a
   * freeway in view becomes an unbroken chain of interstate markers. The gap
   * is in pixels, so zooming out puts far more road on screen at the same
   * spacing — which is why it scales with zoom rather than being a constant.
   */
  private declutterRoadLabels(): void {
    const spacing = (near: number, far: number) =>
      [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        far,
        14,
        (near + far) / 2,
        18,
        near,
      ] as unknown as maplibregl.DataDrivenPropertyValueSpecification<number>;
    for (const layer of this.map.getStyle().layers) {
      if (layer.type !== "symbol" || !("source-layer" in layer)) continue;
      // Our own traffic glyphs ride the same source layer; their density is a
      // gameplay signal, not basemap furniture, so leave them alone.
      if (layer.id === TRAFFIC_CARS_LAYER_ID) continue;
      if (layer["source-layer"] === "transportation_name") {
        this.map.setLayoutProperty(
          layer.id,
          "symbol-spacing",
          spacing(400, 1000),
        );
      } else if (layer["source-layer"] === "transportation") {
        this.map.setLayoutProperty(
          layer.id,
          "symbol-spacing",
          spacing(300, 800),
        );
      }
    }
  }

  /** Hand the extracted street graph to the GeoJSON source. */
  private pushRoadStructureData(): void {
    if (this.roadDataRevision === this.roadGeometryRevision) return;
    const source = this.map.getSource(ROAD_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source) return;
    this.roadDataRevision = this.roadGeometryRevision;
    source.setData({
      type: "FeatureCollection",
      features: this.roadModels.map((road) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: road.line },
        properties: {
          // Proportional trim rather than a flat pad: once ramps became 8 m a
          // fixed +6 m skirt was a 75% halo around them instead of the 32% it
          // is on a 19 m mainline.
          ws: road.widthM + Math.min(6, road.widthM * 0.32),
          we: road.widthM + Math.min(2.2, road.widthM * 0.14),
          w: road.widthM,
          wt: Math.max(0.7, road.widthM * 0.075),
          // Ramps carry no centre line: striping every slip road turned an
          // interchange into a starburst of converging lines.
          st: !road.isRamp && ARTERY_CLASSES.has(road.roadClass) ? 1 : 0,
        },
      })),
    });
  }

  private syncRoadStructureVisibility(): void {
    if (this.threeDimensional === this.roadLayersVisible) return;
    if (!this.map.getLayer(ROAD_LAYER_SHADOW)) return;
    this.roadLayersVisible = this.threeDimensional;
    for (const id of ROAD_LAYER_IDS) {
      this.map.setLayoutProperty(
        id,
        "visibility",
        this.threeDimensional ? "visible" : "none",
      );
    }
  }

  /** Centre-line colour tracks the congestion index. */
  private updateRoadStructureStyle(congestionIndex: number): void {
    if (!this.map.getLayer(ROAD_LAYER_STRIPE)) return;
    const bucket = Math.round(congestionIndex / 10) * 10;
    const key = `${bucket}|${this.showTraffic}`;
    if (key === this.roadStripeStyleKey) return;
    this.roadStripeStyleKey = key;
    let color = "#51a968";
    let opacity = 0.686;
    if (!this.showTraffic) {
      opacity = 0;
    } else if (bucket >= 80) {
      color = "#e84840";
      opacity = 0.804;
    } else if (bucket >= 60) {
      color = "#e7843d";
      opacity = 0.765;
    } else if (bucket >= 40) {
      color = "#d7ae49";
      opacity = 0.706;
    }
    this.map.setPaintProperty(ROAD_LAYER_STRIPE, "line-color", color);
    this.map.setPaintProperty(ROAD_LAYER_STRIPE, "line-opacity", opacity);
  }

  private nearestRoadSnap(screen: Vec2, maxDistancePx: number): {
    pos: Vec2;
    nodeKey: string;
  } | null {
    let closest: { pos: Vec2; nodeKey: string } | null = null;
    let closestDistance = maxDistancePx;

    // World-space pre-rejection. The exact test below is in screen space and
    // costs two toLngLat + two map.project per segment — at ~14k roads that
    // was tens of thousands of matrix transforms on every mousemove. Roads
    // nowhere near the cursor are rejected here in plain metres first.
    //
    // Conservative by construction: the radius is padded generously because
    // pitch makes the px→metre ratio vary across the viewport, so anything
    // the exact test could still match survives the filter.
    const cursorGeo = this.map.unproject([screen.x, screen.y]);
    const cursorWorld = this.toWorld(cursorGeo.lat, cursorGeo.lng);
    const metresPerPx = metersPerPixel(cursorGeo.lat, this.map.getZoom());
    const rejectRadius = maxDistancePx * metresPerPx * ROAD_SNAP_REJECT_FACTOR;

    for (const road of this.roadModels) {
      // Bounding-box reject, computed once at extraction. The old version
      // walked every vertex of all ~14k roads before accepting any — on the
      // order of 10^5 distance tests per mousemove just to get started.
      if (
        road.maxX < cursorWorld.x - rejectRadius ||
        road.minX > cursorWorld.x + rejectRadius ||
        road.maxY < cursorWorld.y - rejectRadius ||
        road.minY > cursorWorld.y + rejectRadius
      ) {
        continue;
      }

      // `road.line` is the same lng/lat that toLngLat would reconstruct from
      // road.points — both are filled from the tile feature together — so
      // converting is pure waste. Reading it directly also keeps nodeKey on
      // the *original* coordinates, matching how roadNodes was keyed; the
      // round-trip could land the other side of the 1e-6 quantisation and
      // silently fail to match, which surfaces as "invalid" bus routing.
      let aGeo = road.line[0];
      let a = this.map.project(aGeo);
      for (let index = 1; index < road.points.length; index++) {
        const bGeo = road.line[index];
        const b = this.map.project(bGeo);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        const t =
          lengthSq === 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  ((screen.x - a.x) * dx + (screen.y - a.y) * dy) / lengthSq,
                ),
              );
        const distance = Math.hypot(
          screen.x - (a.x + dx * t),
          screen.y - (a.y + dy * t),
        );
        if (distance < closestDistance) {
          closestDistance = distance;
          const start = road.points[index - 1];
          const end = road.points[index];
          closest = {
            pos: {
              x: start.x + (end.x - start.x) * t,
              y: start.y + (end.y - start.y) * t,
            },
            nodeKey: roadNodeKey(...(t <= 0.5 ? aGeo : bGeo)),
          };
        }
        // This segment's end is the next segment's start, so carrying it
        // forward halves the map.project calls — the expensive part.
        aGeo = bGeo;
        a = b;
      }
    }
    return closest;
  }

  private shortestRoadPath(startKey: string, endKey: string): Vec2[] | null {
    if (startKey === endKey) {
      const node = this.roadNodes.get(startKey);
      return node ? [{ ...node.pos }] : null;
    }
    const goal = this.roadNodes.get(endKey);
    if (!goal || !this.roadNodes.has(startKey)) return null;
    const queue = new MinQueue();
    const costs = new Map<string, number>([[startKey, 0]]);
    const cameFrom = new Map<string, string>();
    queue.push({ key: startKey, priority: 0 });
    let expanded = 0;
    while (queue.size > 0 && expanded < 30_000) {
      const currentEntry = queue.pop();
      if (!currentEntry) break;
      if (currentEntry.key === endKey) break;
      const current = this.roadNodes.get(currentEntry.key);
      if (!current) continue;
      expanded++;
      const currentCost = costs.get(currentEntry.key) ?? Infinity;
      for (const [nextKey, edgeCost] of current.links) {
        const next = this.roadNodes.get(nextKey);
        if (!next) continue;
        const nextCost = currentCost + edgeCost;
        if (nextCost >= (costs.get(nextKey) ?? Infinity)) continue;
        costs.set(nextKey, nextCost);
        cameFrom.set(nextKey, currentEntry.key);
        const heuristic = Math.hypot(
          next.pos.x - goal.pos.x,
          next.pos.y - goal.pos.y,
        );
        queue.push({ key: nextKey, priority: nextCost + heuristic });
      }
    }
    if (!cameFrom.has(endKey)) return null;
    const keys = [endKey];
    let cursor = endKey;
    while (cursor !== startKey) {
      const previous = cameFrom.get(cursor);
      if (!previous) return null;
      keys.push(previous);
      cursor = previous;
    }
    keys.reverse();
    return keys.map((key) => ({ ...this.roadNodes.get(key)!.pos }));
  }

  private findBuildingConflicts(
    start: Vec2,
    end: Vec2,
  ): {
    sites: Vec2[];
    featureIds: Array<string | number>;
  } | null {
    // Runs on every mousemove while blueprinting. Safe only because the
    // viewport guard in refreshWorldGeometry is now satisfiable: this is
    // "make sure the extraction has run for this camera", and it returns
    // immediately once it has. Previously the guard could never be met at a
    // planning zoom, so each mouse movement paid for a full 75-300 ms
    // re-extraction that left the array empty and did it all again.
    if (this.buildingFootprints.length === 0) {
      this.refreshWorldGeometry();
    }
    if (this.buildingFootprints.length === 0) return null;
    const a = this.toLngLat(start);
    const b = this.toLngLat(end);
    const minLng = Math.min(a[0], b[0]);
    const minLat = Math.min(a[1], b[1]);
    const maxLng = Math.max(a[0], b[0]);
    const maxLat = Math.max(a[1], b[1]);
    const conflicts: Vec2[] = [];
    const featureIds: Array<string | number> = [];
    for (const building of this.buildingFootprints) {
      if (
        maxLng < building.minLng ||
        minLng > building.maxLng ||
        maxLat < building.minLat ||
        minLat > building.maxLat
      ) {
        continue;
      }
      let intersects = pointInRing(a, building.ring) || pointInRing(b, building.ring);
      if (!intersects) {
        for (let index = 1; index < building.ring.length; index++) {
          if (
            segmentsIntersect(
              a,
              b,
              building.ring[index - 1],
              building.ring[index],
            )
          ) {
            intersects = true;
            break;
          }
        }
      }
      if (intersects) {
        conflicts.push({ ...building.center });
        if (building.featureId !== undefined) featureIds.push(building.featureId);
      }
    }
    return { sites: conflicts, featureIds };
  }

  private updateDemolishedBuildingFilter(snap: SimSnapshot): void {
    if (!this.map.getLayer(BUILDINGS_LAYER_ID)) return;
    // This runs every frame, but the demolished set only changes when the
    // network does. Checking the version first keeps the flatten + dedupe +
    // sort + join off the hot path; previously all of it ran 60×/s just to
    // rediscover an unchanged key. (Set dedupe rather than the old
    // findIndex scan, which was quadratic in the demolition count.)
    if (snap.networkVersion === this.demolitionFilterVersion) return;
    this.demolitionFilterVersion = snap.networkVersion;

    const ids = [
      ...new Set(
        [...snap.lines.values()].flatMap((line) =>
          line.segmentDetails.flatMap(
            (detail) => detail.demolishedBuildingFeatureIds,
          ),
        ),
      ),
    ];
    const key = ids.map(String).sort().join("|");
    if (key === this.demolitionFilterKey) return;
    this.demolitionFilterKey = key;
    const base: maplibregl.FilterSpecification = [
      "!=",
      ["get", "hide_3d"],
      true,
    ];
    const filter: maplibregl.FilterSpecification =
      ids.length === 0
        ? base
        : [
            "all",
            base,
            ["!", ["in", ["id"], ["literal", ids]]],
          ];
    this.map.setFilter(BUILDINGS_LAYER_ID, filter);
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
  /**
   * Screen-pixel distance from a point to a platform, measured to the whole
   * rectangle rather than to its centre.
   *
   * A metro platform is 180 m of ground. Zoomed in, its ends sit far outside
   * any sensible centre-based radius, so pointing straight at the station you
   * can see used to snap to nothing at all. Zoomed out the rectangle collapses
   * to under a pixel and this degrades to the old centre test on its own.
   */
  private platformScreenDistance(
    pos: Vec2,
    orientationRad: number,
    halfLengthM: number,
    screen: Vec2,
  ): number {
    const [endA, endB] = stationNodes(pos, orientationRad, halfLengthM);
    const a = this.map.project(this.toLngLat(endA));
    const b = this.map.project(this.toLngLat(endB));
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
    return Math.hypot(screen.x - (a.x + abx * t), screen.y - (a.y + aby * t));
  }

  pickStation(
    snap: SimSnapshot,
    screen: Vec2,
    radius = PICK_RADIUS_PX,
  ): Station | null {
    let best: Station | null = null;
    let bestD = radius;
    for (const s of snap.stations.values()) {
      const d = this.platformScreenDistance(
        s.pos,
        s.orientationRad,
        stationHalfLengthM(s.platformLengthM),
        screen,
      );
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  pickFacility(
    snap: SimSnapshot,
    screen: Vec2,
    radius = 18,
  ): MobilityFacility | null {
    let best: MobilityFacility | null = null;
    let bestDistance = radius;
    for (const facility of snap.facilities) {
      const point = this.map.project(this.toLngLat(facility.pos));
      const distance = Math.hypot(point.x - screen.x, point.y - screen.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = facility;
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
    transitMode: TransitMode,
    resolveRoadPath = false,
    rotationOffsetRad = 0,
  ): BuildTarget {
    const target = this.resolveBuildTarget(
      snap,
      draft,
      screen,
      lngLat,
      transitMode,
      resolveRoadPath,
    );
    const angle = this.resolveStationAngle(snap, draft, target);
    return {
      ...target,
      orientationRad: angle.locked
        ? angle.baseRad
        : wrapAngle(angle.baseRad + rotationOffsetRad),
      orientationBaseRad: angle.baseRad,
      orientationLocked: angle.locked,
    };
  }

  /**
   * The angle to lay the platform at.
   *
   * A built station keeps the platform it has — rotating one already in the
   * ground is not a thing the player can do. Everything else lines up with
   * the track arriving from the last drafted point, and the held rotate keys
   * turn it from there.
   */
  private resolveStationAngle(
    snap: SimSnapshot,
    draft: LinePoint[],
    target: UnorientedBuildTarget,
  ): { baseRad: number; locked: boolean } {
    if (target.existingStationId !== undefined) {
      const station = snap.stations.get(target.existingStationId);
      if (station) return { baseRad: station.orientationRad, locked: true };
    }
    // Snapping back onto a point of this same draft — closing a loop — keeps
    // that point's angle rather than laying a second platform across it.
    for (const point of draft) {
      if (
        point.orientationRad !== undefined &&
        Math.hypot(point.pos.x - target.pos.x, point.pos.y - target.pos.y) < 1
      ) {
        return { baseRad: point.orientationRad, locked: true };
      }
    }
    const previous = draft[draft.length - 1];
    const baseRad =
      previous &&
      Math.hypot(previous.pos.x - target.pos.x, previous.pos.y - target.pos.y) >
        1
        ? bearingRad(previous.pos, target.pos)
        : (previous?.orientationRad ?? 0);
    return { baseRad, locked: false };
  }

  private resolveBuildTarget(
    snap: SimSnapshot,
    draft: LinePoint[],
    screen: Vec2,
    lngLat: [number, number],
    transitMode: TransitMode,
    resolveRoadPath: boolean,
  ): UnorientedBuildTarget {
    if (transitMode === "bus") {
      const cursorWorld = this.toWorld(lngLat[1], lngLat[0]);

      // The baked graph is the authority once it has arrived. It covers the
      // whole metro rather than the loaded tiles, so a bus line can be drawn
      // past the edge of the screen and costs the same at any zoom. Until it
      // lands — it is fetched lazily on first entering bus mode — fall back
      // to the tile graph so the tool still works rather than going dead.
      const graph = this.roadGraph;
      if (graph) {
        const tolerance = Math.max(
          BUS_SNAP_MIN_M,
          Math.min(
            BUS_SNAP_MAX_M,
            BUS_SNAP_PX * metersPerPixel(lngLat[1], this.map.getZoom()),
          ),
        );
        const target = graph.snap(cursorWorld, tolerance);
        if (!target) {
          return { pos: cursorWorld, snapped: false, valid: false };
        }
        if (draft.length === 0 || !resolveRoadPath) {
          return { pos: target.pos, snapped: true, valid: true };
        }
        // The previous point is already on the network, so it only needs
        // enough slack to absorb float noise.
        const previous = draft[draft.length - 1];
        const start = graph.snap(previous.pos, BUS_SNAP_MIN_M);
        if (!start) {
          return { pos: target.pos, snapped: true, valid: false };
        }
        const routed = graph.route(start.nodeIndex, target.nodeIndex);
        if (!routed) {
          return { pos: target.pos, snapped: true, valid: false };
        }
        const path = dedupePath([previous.pos, ...routed, target.pos]);
        return {
          pos: target.pos,
          pathFromPrevious: path,
          demolitionSitesFromPrevious: [],
          snapped: true,
          valid: path.length >= 2,
        };
      }

      if (this.roadModels.length === 0) this.refreshWorldGeometry();
      const roadTarget = this.nearestRoadSnap(screen, 28);
      if (!roadTarget) {
        return { pos: cursorWorld, snapped: false, valid: false };
      }
      if (draft.length === 0) {
        return { pos: roadTarget.pos, snapped: true, valid: true };
      }
      if (!resolveRoadPath) {
        return { pos: roadTarget.pos, snapped: true, valid: true };
      }
      const previous = draft[draft.length - 1];
      const previousScreen = this.map.project(this.toLngLat(previous.pos));
      const roadStart = this.nearestRoadSnap(previousScreen, 60);
      if (!roadStart) {
        return { pos: roadTarget.pos, snapped: true, valid: false };
      }
      const routed = this.shortestRoadPath(
        roadStart.nodeKey,
        roadTarget.nodeKey,
      );
      if (!routed) {
        return { pos: roadTarget.pos, snapped: true, valid: false };
      }
      const path = dedupePath([previous.pos, ...routed, roadTarget.pos]);
      return {
        pos: roadTarget.pos,
        pathFromPrevious: path,
        demolitionSitesFromPrevious: [],
        snapped: true,
        valid: path.length >= 2,
      };
    }

    // Built stations and draft points compete on distance rather than in
    // priority order. A built station used to win anywhere inside the whole
    // snap radius, so trying to close a loop onto the draft point directly
    // under the cursor could jump the click twenty pixels away to a station
    // the player was not pointing at.
    //
    // Draft points are platforms too, and the one being closed onto is
    // usually the first — drawn at full size — so both are measured to their
    // rectangle, not to their centre.
    const draftHalfLengthM = stationHalfLengthM(
      defaultPlatformLengthM(transitMode),
    );
    let bestD = SNAP_RADIUS_PX;
    let bestStation: Station | null = null;
    let bestDraft: LinePoint | null = null;
    for (const candidate of snap.stations.values()) {
      const d = this.platformScreenDistance(
        candidate.pos,
        candidate.orientationRad,
        stationHalfLengthM(candidate.platformLengthM),
        screen,
      );
      if (d < bestD) {
        bestD = d;
        bestStation = candidate;
      }
    }
    for (const candidate of draft) {
      const d = this.platformScreenDistance(
        candidate.pos,
        candidate.orientationRad ?? 0,
        draftHalfLengthM,
        screen,
      );
      // Strictly closer, so a built station keeps an exact tie: joining the
      // network is almost always what was meant.
      if (d < bestD) {
        bestD = d;
        bestStation = null;
        bestDraft = candidate;
      }
    }
    let target: UnorientedBuildTarget;
    if (bestStation) {
      target = {
        pos: bestStation.pos,
        existingStationId: bestStation.id,
        snapped: true,
        valid: true,
      };
    } else if (bestDraft) {
      target = {
        pos: { ...bestDraft.pos },
        existingStationId: bestDraft.existingStationId,
        snapped: true,
        valid: true,
      };
    } else {
      target = {
        pos: this.toWorld(lngLat[1], lngLat[0]),
        snapped: false,
        valid: true,
      };
    }
    if (draft.length > 0) {
      const conflicts = this.findBuildingConflicts(
        draft[draft.length - 1].pos,
        target.pos,
      );
      if (conflicts) {
        target.demolitionSitesFromPrevious = conflicts.sites;
        target.demolitionFeatureIdsFromPrevious = conflicts.featureIds;
      }
    }
    return target;
  }

  /** Return the id of the line whose polyline passes near the point, if any. */
  pickLine(snap: SimSnapshot, screen: Vec2): number | null {
    const THRESHOLD = 8;
    for (const line of snap.lines.values()) {
      for (let i = 1; i < line.stationIds.length; i++) {
        const path = line.segmentDetails[i - 1]?.path ?? [
          snap.stations.get(line.stationIds[i - 1])!.pos,
          snap.stations.get(line.stationIds[i])!.pos,
        ];
        for (let pathIndex = 1; pathIndex < path.length; pathIndex++) {
          const a = this.map.project(this.toLngLat(path[pathIndex - 1]));
          const b = this.map.project(this.toLngLat(path[pathIndex]));
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
                    ((screen.x - a.x) * abx + (screen.y - a.y) * aby) /
                      lenSq,
                  ),
                );
          const d = Math.hypot(
            screen.x - (a.x + abx * t),
            screen.y - (a.y + aby * t),
          );
          if (d < THRESHOLD) return line.id;
        }
      }
    }
    return null;
  }

  update(snap: SimSnapshot, game: Game): void {
    this.updateTrafficStyle(snap.traffic.congestionIndex);
    this.updateDemolishedBuildingFilter(snap);
    this.syncRoadStructureVisibility();
    this.updateRoadStructureStyle(snap.traffic.congestionIndex);
    this.pushRoadStructureData();
    const layers: Layer[] = [];
    if (this.showDemand) layers.push(this.getDemandLayer());
    if (this.showGhost) layers.push(this.getGhostLayer());
    // Draw order matters: track → trains → stations. A train rides on top of
    // its own line but passes *under* the station markers, so one sitting at
    // a platform never hides the stop (or its interchange diamond).
    const network = this.getNetworkLayers(snap, game);
    layers.push(...network.track);
    layers.push(...this.buildVehicleLayers(snap, game.tickAlpha));
    layers.push(...network.stations);
    layers.push(...this.getMobilityLayers(snap, game));
    layers.push(...this.buildDraftLayers(snap, game));
    layers.push(...this.buildFacilityPreviewLayers(game));
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
   *
   * Returns a *new* PolygonLayer every call (same `id`, same underlying data
   * array). This layer is only in the `layers` list while `showDemand` is
   * on, so toggling it off drops it from deck.gl's render list and deck.gl
   * finalizes it (frees its GPU resources) — `Layer._initialize` then
   * asserts `!this.internalState`, "finalized layer cannot be reused", if
   * that exact instance is ever pushed again. A fresh instance with the same
   * `id` is deck.gl's actual intended re-render pattern: it reconciles by id
   * and reuses GPU resources when the data reference is unchanged, so this
   * costs nothing beyond the one object allocation.
   */
  private getDemandLayer(): PolygonLayer<DemandPart> {
    if (!this.demandParts) {
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
      this.demandParts = parts;
    }

    return new PolygonLayer<DemandPart>({
      id: "demand-tracts",
      data: this.demandParts,
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

  /**
   * Whether any edge in the network carries more than one line.
   *
   * Only those edges get a zoom-dependent side-by-side offset, so this is
   * what decides whether the track cache has to be invalidated by zoom at
   * all. Recomputed only when the network changes, and it counts station
   * pairs rather than building geometry — cheap next to the rebuild it
   * usually avoids.
   */
  private networkNeedsZoomKey(snap: SimSnapshot): boolean {
    if (this.zoomKeyVersion === snap.networkVersion) return this.zoomKeyNeeded;
    this.zoomKeyVersion = snap.networkVersion;
    this.zoomKeyNeeded = false;

    const seen = new Set<string>();
    for (const line of snap.lines.values()) {
      for (let i = 1; i < line.stationIds.length; i++) {
        const a = line.stationIds[i - 1];
        const b = line.stationIds[i];
        if (a === b) continue;
        const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(edge)) {
          this.zoomKeyNeeded = true;
          return true;
        }
        seen.add(edge);
      }
    }
    return false;
  }

  /** New PathLayer every call — see getDemandLayer for why the *instance*
   *  must not be cached across a toggle off/on. */
  private getGhostLayer(): PathLayer {
    return new PathLayer({
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

  // ── Player network (cached on network version + selection) ──────────

  private getNetworkLayers(
    snap: SimSnapshot,
    game: Game,
  ): { track: Layer[]; stations: Layer[] } {
    // Zoom only enters the key when the network actually needs it.
    //
    // The single zoom-dependent quantity in buildTrackSegments is the
    // parallel-track offset, and that is identically zero for an edge
    // carried by one line — `(i - (n - 1) / 2)` with n = 1 and i = 0. So a
    // network where no two lines share an edge, which is most of them,
    // renders the same at every zoom. Keying on zoom regardless meant every
    // 0.1 of zoom threw away the cache and rebuilt every track segment and
    // station model, cloning every path vertex twice — on most frames of
    // any continuous zoom, including the 850 ms easeTo when toggling 3D.
    //
    // Centre latitude belongs here for the same reason: metersPerPixel
    // depends on it, so panning north or south changes the offsets. It was
    // simply missing before.
    const zoomKey = this.networkNeedsZoomKey(snap)
      ? `${Math.round(this.map.getZoom() * 10)}:${Math.round(this.map.getCenter().lat * 4)}`
      : "flat";
    const key = `${snap.networkVersion}|${game.selection?.kind ?? ""}:${game.selection?.id ?? ""}|${zoomKey}|${this.threeDimensional}|${this.theme}`;
    if (key === this.cachedNetworkKey && this.cachedNetwork) {
      return this.cachedNetwork;
    }

    const stations = [...snap.stations.values()];
    const selLine =
      game.selection?.kind === "line" ? game.selection.id : null;
    const selStation =
      game.selection?.kind === "station" ? game.selection.id : null;

    const trackSegments = this.buildTrackSegments(snap, selLine);
    // Clearance scars mark buildings torn down to build surface and elevated
    // track. Scoped to the selected line on purpose: drawn for the whole
    // network they accumulate into permanent overlapping red blobs that read
    // as a rendering fault rather than as construction impact. Select a line
    // to see what building it cost.
    const demolitionSites: DemolitionSite[] = [];
    if (selLine !== null) {
      const line = snap.lines.get(selLine);
      for (const detail of line?.segmentDetails ?? []) {
        for (const pos of detail.demolitionSites) {
          demolitionSites.push({ pos, alignment: detail.alignment });
        }
      }
    }
    const track: Layer[] = [
      new ScatterplotLayer<DemolitionSite>({
        id: "demolition-clearance-sites",
        data: demolitionSites,
        getPosition: (site) => this.toLngLat(site.pos),
        getRadius: (site) => site.alignment === "surface" ? 26 : 18,
        radiusUnits: "meters",
        radiusMinPixels: 2,
        getFillColor: (site) =>
          site.alignment === "surface"
            ? ([255, 107, 91, 92] as RGBA)
            : ([244, 184, 96, 78] as RGBA),
        stroked: true,
        getLineColor: [255, 215, 154, 150],
        getLineWidth: 1,
        lineWidthUnits: "pixels",
        pickable: false,
      }),
      new PathLayer<TrackSegment>({
      id: "player-track-bed",
      data: trackSegments.filter((segment) => segment.mode !== "bus"),
      getPath: (s) => s.path,
      getColor: (segment) =>
        segment.alignment === "underground"
          ? ([67, 119, 145, 115] as RGBA)
          : segment.alignment === "elevated"
            ? ([228, 237, 238, 230] as RGBA)
            : this.theme === "light"
              ? ([65, 76, 82, 235] as RGBA)
              : ([9, 16, 20, 245] as RGBA),
      getWidth: (s) => s.width + (s.alignment === "elevated" ? 5 : 3.5),
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      pickable: false,
      }),
      new PathLayer<TrackSegment>({
        id: "player-lines",
        data: trackSegments,
        getPath: (s) => s.path,
        getColor: (s) => s.color,
        getWidth: (s) => s.width,
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
      new PathLayer<TrackSegment>({
        id: "player-rail-highlight",
        data: trackSegments.filter(
          (segment) =>
            segment.mode !== "bus" && segment.alignment !== "underground",
        ),
        getPath: (s) => s.path,
        getColor: [245, 249, 249, 175],
        getWidth: 0.75,
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
    ];

    const stationModels = this.buildStationModels(snap);

    const stationLayers: Layer[] = [
      new PolygonLayer<StationModel>({
        id: "station-platform-models",
        data: stationModels,
        getPolygon: (model) => model.polygon,
        getFillColor: (model) => model.color,
        getLineColor: this.theme === "light"
          ? ([54, 71, 79, 230] as RGBA)
          : ([230, 242, 244, 235] as RGBA),
        getLineWidth: 1,
        lineWidthUnits: "pixels",
        stroked: true,
        filled: true,
        extruded: this.threeDimensional,
        getElevation: (model) => model.elevation,
        wireframe: false,
        pickable: false,
      }),
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
      new TextLayer<Station>({
        id: "station-route-labels",
        data: stations,
        getPosition: (station) => this.toLngLat(station.pos),
        getText: (station) => {
          const services = station.lineIds
            .map((lineId) => snap.lines.get(lineId)?.name)
            .filter((name) => name !== undefined)
            .join(" · ");
          return services ? `${station.name}\n${services}` : station.name;
        },
        getSize: (station) => station.lineIds.length > 1 ? 12 : 11,
        getColor: this.theme === "light"
          ? ([24, 43, 51, 245] as RGBA)
          : ([239, 247, 248, 245] as RGBA),
        getPixelOffset: [0, -18],
        getTextAnchor: "middle",
        getAlignmentBaseline: "bottom",
        fontFamily: "Inter, Segoe UI, sans-serif",
        fontWeight: 700,
        outlineWidth: 3,
        outlineColor: this.theme === "light"
          ? ([247, 251, 252, 235] as RGBA)
          : ([5, 13, 17, 240] as RGBA),
        pickable: false,
      }),
    ];
    this.cachedNetwork = { track, stations: stationLayers };
    this.cachedNetworkKey = key;
    return this.cachedNetwork;
  }

  private buildStationModels(snap: SimSnapshot): StationModel[] {
    const models: StationModel[] = [];
    for (const station of snap.stations.values()) {
      const firstLine = station.lineIds
        .map((lineId) => snap.lines.get(lineId))
        .find((line) => line !== undefined);
      const z =
        station.primaryAlignment === "elevated"
          ? station.levelM
          : station.primaryAlignment === "underground"
            ? 0.65
            : 0.35;
      // The angle is the one the player placed it at, not a guess from the
      // first line to serve it.
      const corners = stationCorners(
        station.pos,
        station.orientationRad,
        stationHalfLengthM(station.platformLengthM),
        stationHalfWidthM(firstLine?.mode ?? "metro"),
      );
      const color = firstLine
        ? hexToRgb(firstLine.color)
        : ([105, 126, 134, 230] as RGBA);
      color[3] = station.primaryAlignment === "underground" ? 125 : 225;
      models.push({
        station,
        polygon: corners.map((corner) => {
          const [lng, lat] = this.toLngLat(corner);
          return [lng, lat, z] as [number, number, number];
        }),
        elevation:
          station.primaryAlignment === "elevated"
            ? 3.2
            : station.primaryAlignment === "underground"
              ? 0.8
              : 1.4,
        color,
      });
    }
    return models;
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
      mode: TransitMode;
      alignment: RailAlignment;
      levelM: number;
      noiseDb: number;
      path: Vec2[];
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
          const detailPath = line.segmentDetails[i]?.path ?? [
            snap.stations.get(a)!.pos,
            snap.stations.get(b)!.pos,
          ];
          g.push({
            lineId: line.id,
            color: line.color,
            mode: line.mode,
            alignment: line.segmentAlignments[i] ?? "surface",
            levelM: line.segmentDetails[i]?.levelM ?? 0,
            noiseDb: line.segmentDetails[i]?.noiseDb ?? 80,
            path:
              a < b
                ? detailPath.map((point) => ({ ...point }))
                : [...detailPath].reverse().map((point) => ({ ...point })),
          });
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
      const baseWidth = members.some((member) => member.mode === "regional-rail")
        ? 6
        : members.every((member) => member.mode === "bus")
          ? 3
          : 5.5;
      const totalWidth = members.some((m) => m.lineId === selLine)
        ? baseWidth + 2.5
        : baseWidth;
      const subWidth = totalWidth / n;

      members.forEach((m, i) => {
        const offsetM = (i - (n - 1) / 2) * subWidth * metersPerPx;
        const color = hexToRgb(m.color);
        if (m.mode === "bus") color[3] = 205;
        if (m.alignment === "underground") {
          // Tunnel sections retain some line identity but shift toward the
          // same cool-blue language used by the tunnel drafting tool.
          color[0] = Math.round(color[0] * 0.42 + 112 * 0.58);
          color[1] = Math.round(color[1] * 0.42 + 201 * 0.58);
          color[2] = Math.round(color[2] * 0.42 + 238 * 0.58);
          color[3] = 215;
        }
        segments.push({
          path: m.path.map((basePoint) => {
            const point = {
              x: basePoint.x + perp.x * offsetM,
              y: basePoint.y + perp.y * offsetM,
            };
            const [lng, lat] = this.toLngLat(point);
            const z =
              m.alignment === "elevated"
                ? m.levelM
                : m.alignment === "underground"
                  ? 0.7
                  : 0.35;
            return [lng, lat, z] as [number, number, number];
          }),
          color,
          width: subWidth,
          mode: m.mode,
          alignment: m.alignment,
          levelM: m.levelM,
          noiseDb: m.noiseDb,
        });
      });
    }
    return segments;
  }

  // ── Per-frame layers ────────────────────────────────────────────────

  private getMobilityLayers(snap: SimSnapshot, game: Game): Layer[] {
    const selected =
      game.selection?.kind === "facility" ? game.selection.id : null;
    const key = `${snap.networkVersion}|${snap.mobilityVersion}|${selected ?? ""}`;
    if (key === this.cachedMobilityKey && this.cachedMobility) {
      return this.cachedMobility;
    }

    const facilities = snap.facilities;
    this.cachedMobility = [
      new ScatterplotLayer<MobilityFacility>({
        id: "mobility-hub-rings",
        data: facilities,
        getPosition: (facility) => this.toLngLat(facility.pos),
        getRadius: (facility) =>
          facility.id === selected ? 12 : facility.type === "airport" ? 10 : 8,
        radiusUnits: "pixels",
        getFillColor: (facility) => {
          const color = hexToRgb(FACILITY_SPECS[facility.type].color);
          color[3] = facility.connected ? 245 : 190;
          return color;
        },
        stroked: true,
        getLineColor: (facility) =>
          facility.id === selected
            ? ([255, 255, 255, 255] as RGBA)
            : facility.connected
              ? ([98, 230, 197, 255] as RGBA)
              : ([11, 23, 29, 245] as RGBA),
        getLineWidth: (facility) =>
          facility.id === selected ? 3 : facility.connected ? 2 : 1.5,
        lineWidthUnits: "pixels",
        pickable: false,
      }),
      new TextLayer<MobilityFacility>({
        id: "mobility-hub-glyphs",
        data: facilities,
        getPosition: (facility) => this.toLngLat(facility.pos),
        getText: (facility) => FACILITY_SPECS[facility.type].glyph,
        getSize: 10,
        getColor: [5, 18, 22, 255],
        fontFamily: "Segoe UI, system-ui, sans-serif",
        fontWeight: 800,
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        pickable: false,
      }),
      new TextLayer<MobilityFacility>({
        id: "mobility-hub-labels",
        data: facilities,
        getPosition: (facility) => this.toLngLat(facility.pos),
        getText: (facility) => facility.code ?? facility.name,
        getSize: 10,
        getColor: [226, 239, 241, 235],
        getPixelOffset: [0, 17],
        fontFamily: "Segoe UI, system-ui, sans-serif",
        fontWeight: 650,
        outlineWidth: 3,
        outlineColor: [5, 14, 18, 245],
        getTextAnchor: "middle",
        getAlignmentBaseline: "top",
        pickable: false,
      }),
    ];
    this.cachedMobilityKey = key;
    return this.cachedMobility;
  }

  private buildFacilityPreviewLayers(game: Game): Layer[] {
    if (
      game.mode !== "place" ||
      !game.activeFacilityType ||
      !this.hoverLngLat
    ) {
      return [];
    }
    const spec = FACILITY_SPECS[game.activeFacilityType];
    const color = hexToRgb(spec.color);
    return [
      new ScatterplotLayer({
        id: "facility-placement-preview",
        data: [this.hoverLngLat],
        getPosition: (point: [number, number]) => point,
        getRadius: game.activeFacilityType === "airport" ? 19 : 14,
        radiusUnits: "pixels",
        getFillColor: [color[0], color[1], color[2], 65],
        stroked: true,
        getLineColor: color,
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        pickable: false,
      }),
      new TextLayer({
        id: "facility-placement-label",
        data: [this.hoverLngLat],
        getPosition: (point: [number, number]) => point,
        getText: () =>
          `${spec.label} · ${compactMoney(facilityBuildCost(game.activeFacilityType!))}`,
        getSize: 12,
        getColor: [242, 248, 248, 255],
        getPixelOffset: [0, -25],
        fontFamily: "Segoe UI, system-ui, sans-serif",
        fontWeight: 650,
        outlineWidth: 3,
        outlineColor: [5, 14, 18, 245],
        getTextAnchor: "middle",
        pickable: false,
      }),
    ];
  }

  private buildDraftLayers(snap: SimSnapshot, game: Game): Layer[] {
    if (!game.blueprinting) return [];
    const draftColorFor = (alignment: RailAlignment): RGBA =>
      game.buildTransitMode === "bus"
        ? [244, 184, 96, 220]
        : game.buildTransitMode === "regional-rail"
          ? [189, 156, 255, 225]
          : alignment === "underground"
            ? [112, 201, 238, 225]
            : alignment === "elevated"
              ? [255, 184, 94, 235]
            : [242, 248, 248, 215];
    const activeDraftColor = draftColorFor(game.buildAlignment);

    // A station is a platform on the ground, so the draft shows the real
    // rectangle rather than a dot: what will be built, at the size and angle
    // it will be built at.
    const draftHalfLengthM = stationHalfLengthM(
      defaultPlatformLengthM(game.buildTransitMode),
    );
    const halfWidthM = stationHalfWidthM(game.buildTransitMode);
    // An existing station keeps the platform it was built with, which may be
    // a different length from what is being drawn now.
    const halfLengthFor = (point: LinePoint): number => {
      const station =
        point.existingStationId !== undefined
          ? snap.stations.get(point.existingStationId)
          : undefined;
      return station
        ? stationHalfLengthM(station.platformLengthM)
        : draftHalfLengthM;
    };
    const nodesOf = (point: LinePoint): [Vec2, Vec2] =>
      stationNodes(
        point.pos,
        point.orientationRad ?? 0,
        halfLengthFor(point),
      );

    const hoverWorld = this.hoverLngLat
      ? this.toWorld(this.hoverLngLat[1], this.hoverLngLat[0])
      : null;
    // Resolved here, every frame, instead of being read back from a value
    // cached on the last mousemove. Holding a rotate key has to turn the
    // ghost while the cursor stands perfectly still, and a still cursor
    // fires no mousemove at all.
    const ghostOrientationRad = this.hoverOrientationLocked
      ? this.hoverBaseOrientationRad
      : wrapAngle(this.hoverBaseOrientationRad + game.stationRotationOffset);
    const ghost: LinePoint | null = hoverWorld
      ? {
          pos: hoverWorld,
          orientationRad: ghostOrientationRad,
          // Carried so the ghost is sized by the platform it has latched
          // onto, which may be longer or shorter than what is being drawn.
          existingStationId: this.hoveredStationId ?? undefined,
        }
      : null;

    interface DraftPlatform {
      polygon: [number, number][];
      /**
       * `ghost` is the platform under the cursor, `placed` one already
       * clicked, and `snap` the outline of something the cursor has latched
       * onto — highlighting the whole rectangle you are about to join, which
       * a small ring on its centre never made obvious.
       */
      kind: "ghost" | "placed" | "snap";
    }
    const platforms: DraftPlatform[] = [];
    const nodeMarkers: [number, number][] = [];
    const addPlatform = (
      point: LinePoint,
      kind: DraftPlatform["kind"],
    ): void => {
      // A placed point that latched onto a built station is already drawn by
      // the network layers; a second rectangle on top only reads as a smear.
      // The snap outline is deliberately exempt — that one *is* the highlight.
      if (kind !== "placed" || point.existingStationId === undefined) {
        platforms.push({
          polygon: stationCorners(
            point.pos,
            point.orientationRad ?? 0,
            halfLengthFor(point),
            halfWidthM,
          ).map((corner) => this.toLngLat(corner)),
          kind,
        });
      }
      for (const node of nodesOf(point)) nodeMarkers.push(this.toLngLat(node));
    };
    for (const point of game.draft) addPlatform(point, "placed");
    if (ghost) addPlatform(ghost, this.hoverSnapped ? "snap" : "ghost");

    // Same path the commit will price and build, so the preview cannot
    // promise a route the line does not take.
    const pathBetween = (from: LinePoint, to: LinePoint): [number, number][] =>
      (to.pathFromPrevious && to.pathFromPrevious.length >= 2
        ? to.pathFromPrevious
        : platformSegmentPath(from.pos, nodesOf(from), to.pos, nodesOf(to))
      ).map((point) => this.toLngLat(point));

    const draftSegments: Array<{
      path: [number, number][];
      color: RGBA;
    }> = [];
    for (let i = 1; i < game.draft.length; i++) {
      draftSegments.push({
        path: pathBetween(game.draft[i - 1], game.draft[i]),
        color: draftColorFor(
          game.draft[i].alignmentFromPrevious ?? "surface",
        ),
      });
    }
    const last = game.draft[game.draft.length - 1];
    if (ghost && last) {
      draftSegments.push({
        path: pathBetween(last, ghost),
        color: activeDraftColor,
      });
    }

    const platformFill: RGBA = [
      activeDraftColor[0],
      activeDraftColor[1],
      activeDraftColor[2],
      50,
    ];
    const layers: Layer[] = [];
    // The snap ring shows before the first point is placed too, so the player
    // can see they are about to branch off an existing station.
    if (this.hoverSnapped && this.hoverLngLat) {
      layers.push(
        new ScatterplotLayer({
          id: "snap-target",
          data: [this.hoverLngLat],
          getPosition: (p: [number, number]) => p,
          getRadius: 11,
          radiusUnits: "pixels",
          filled: false,
          stroked: true,
          getLineColor: activeDraftColor,
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: false,
        }),
      );
    }
    if (platforms.length > 0) {
      layers.push(
        new PolygonLayer<DraftPlatform>({
          id: "draft-station-models",
          data: platforms,
          getPolygon: (platform) => platform.polygon,
          filled: true,
          stroked: true,
          extruded: false,
          getFillColor: (platform) =>
            platform.kind === "ghost"
              ? platformFill
              : platform.kind === "snap"
                ? ([0, 0, 0, 0] as RGBA)
                : ([
                    platformFill[0],
                    platformFill[1],
                    platformFill[2],
                    28,
                  ] as RGBA),
          getLineColor: activeDraftColor,
          getLineWidth: (platform) =>
            platform.kind === "ghost"
              ? 2
              : platform.kind === "snap"
                ? 2.5
                : 1.25,
          lineWidthUnits: "pixels",
          pickable: false,
        }),
      );
    }
    if (draftSegments.length > 0) {
      layers.push(
        new PathLayer({
          id: "draft-line",
          data: draftSegments,
          getPath: (segment) => segment.path,
          getColor: (segment) => segment.color,
          getWidth:
            game.buildTransitMode === "bus"
              ? 2.5
              : game.buildTransitMode === "regional-rail"
                ? 4.5
                : 3.5,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
        }),
      );
    }
    if (nodeMarkers.length > 0) {
      // The ends are where track attaches, so they are worth seeing while
      // rotating: they are what the next segment will aim at.
      layers.push(
        new ScatterplotLayer({
          id: "draft-station-nodes",
          data: nodeMarkers,
          getPosition: (p: [number, number]) => p,
          getRadius: 3,
          radiusUnits: "pixels",
          getFillColor: activeDraftColor,
          stroked: true,
          getLineColor: STATION_RING,
          getLineWidth: 1,
          lineWidthUnits: "pixels",
          pickable: false,
        }),
      );
    }
    return layers;
  }

  /**
   * @param alpha How far this frame sits between the last sim tick and the
   * next. Vehicles are drawn lerped across the tick, so they glide at 1×
   * instead of stepping four times a second.
   */
  private buildVehicleLayers(snap: SimSnapshot, alpha: number): Layer[] {
    const assignedVehicles = snap.vehicles.filter(
      (vehicle): vehicle is Vehicle & { lineId: number } =>
        vehicle.lineId !== null && snap.lines.has(vehicle.lineId),
    );
    const models: VehicleModel[] = assignedVehicles.map((vehicle) => {
      const line = snap.lines.get(vehicle.lineId)!;
      const stock = getRollingStockSpec(vehicle.modelId);
      const dist = vehicle.prevDist + (vehicle.dist - vehicle.prevDist) * alpha;
      const center = positionOnLine(snap, line, dist);
      const probe = positionOnLine(
        snap,
        line,
        Math.max(
          0,
          Math.min(
            line.length,
            dist + vehicle.dir * Math.max(6, Math.min(30, stock.lengthM * 0.25)),
          ),
        ),
      );
      let dx = probe.x - center.x;
      let dy = probe.y - center.y;
      const tangentLength = Math.hypot(dx, dy) || 1;
      dx /= tangentLength;
      dy /= tangentLength;
      const perpendicular = { x: -dy, y: dx };
      const halfLength = Math.max(5, stock.lengthM / 2);
      const halfWidth = line.mode === "bus" ? 1.45 : 1.8;
      const detail = line.segmentDetails[segmentIndexAtDistance(line, dist)];
      const z =
        detail?.alignment === "elevated"
          ? detail.levelM + 1.2
          : detail?.alignment === "underground"
            ? 1.2
            : 1;
      const corners: Vec2[] = [
        {
          x: center.x - dx * halfLength - perpendicular.x * halfWidth,
          y: center.y - dy * halfLength - perpendicular.y * halfWidth,
        },
        {
          x: center.x + dx * halfLength - perpendicular.x * halfWidth,
          y: center.y + dy * halfLength - perpendicular.y * halfWidth,
        },
        {
          x: center.x + dx * halfLength + perpendicular.x * halfWidth,
          y: center.y + dy * halfLength + perpendicular.y * halfWidth,
        },
        {
          x: center.x - dx * halfLength + perpendicular.x * halfWidth,
          y: center.y - dy * halfLength + perpendicular.y * halfWidth,
        },
      ];
      const color = hexToRgb(line.color);
      color[3] = detail?.alignment === "underground" ? 175 : 245;
      const [centerLng, centerLat] = this.toLngLat(center);
      return {
        vehicle,
        polygon: corners.map((corner) => {
          const [lng, lat] = this.toLngLat(corner);
          return [lng, lat, z] as [number, number, number];
        }),
        position: [centerLng, centerLat, z],
        color,
        radiusM:
          line.mode === "bus"
            ? VEHICLE_RADIUS_M * 0.55
            : line.mode === "regional-rail"
              ? VEHICLE_RADIUS_M * 1.25
              : VEHICLE_RADIUS_M,
      };
    });

    return [
      new PolygonLayer<VehicleModel>({
        id: "vehicle-models",
        data: models,
        getPolygon: (model) => model.polygon,
        getFillColor: (model) => model.color,
        getLineColor: this.theme === "light"
          ? ([245, 250, 250, 245] as RGBA)
          : ([7, 14, 18, 245] as RGBA),
        getLineWidth: 1,
        lineWidthUnits: "pixels",
        filled: true,
        stroked: true,
        extruded: this.threeDimensional,
        getElevation: 3.1,
        pickable: false,
      }),
      new ScatterplotLayer<VehicleModel>({
      id: "vehicles",
      // Fed `models`, not the raw vehicle list, because every value this
      // layer needs was already computed above. Reading them back off the
      // model means the frame does one positionOnLine per vehicle instead
      // of two, and no hex parsing or Map lookup in an accessor at all.
      //
      // Still a fresh array each frame, which is what deck.gl needs:
      // `snap.vehicles` is the sim's own array, mutated in place and never
      // reassigned, and deck.gl diffs `data` by reference — so handing it
      // that array directly would leave the layer frozen on the first frame.
      data: models,
      getPosition: (model) => model.position,
      // Sized in metres, not screen pixels: a train is a thing on the ground,
      // so zooming out shrinks it along with the city instead of leaving a
      // constant-size dot that swallows the map at region scale. The clamps
      // keep it from vanishing when zoomed right out or ballooning up close.
      getRadius: (model) => model.radiusM,
      radiusUnits: "meters",
      // The floor is the intended cutoff: past roughly zoom 12 (region
      // scale) a train would shrink below its own 5.5px track and melt into
      // the line, so it stops scaling there and holds a legible size. It sits
      // just above the track width for exactly that reason.
      radiusMinPixels: 4,
      // Zooming *in* keeps scaling; this ceiling is only a guard so the
      // marker stays a train-sized bead at street zoom instead of a blob.
      radiusMaxPixels: 13,
      getFillColor: (model) => model.color,
      stroked: true,
      getLineColor: VEHICLE_RING,
      getLineWidth: 1,
      lineWidthUnits: "pixels",
      pickable: false,
      }),
    ];
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
      const path = line.segmentDetails[i - 1]?.path ?? [
        snap.stations.get(ids[i - 1])!.pos,
        snap.stations.get(ids[i])!.pos,
      ];
      let remaining = Math.max(0, dist - cum[i - 1]);
      for (let pathIndex = 1; pathIndex < path.length; pathIndex++) {
        const a = path[pathIndex - 1];
        const b = path[pathIndex];
        const span = Math.hypot(b.x - a.x, b.y - a.y);
        if (remaining <= span || pathIndex === path.length - 1) {
          const t = span > 0 ? Math.min(1, remaining / span) : 0;
          return {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
          };
        }
        remaining -= span;
      }
      return path[path.length - 1];
    }
  }
  return snap.stations.get(ids[ids.length - 1])!.pos;
}

function segmentIndexAtDistance(line: Line, dist: number): number {
  for (let index = 1; index < line.stationDist.length; index++) {
    if (dist <= line.stationDist[index]) return index - 1;
  }
  return Math.max(0, line.segmentDetails.length - 1);
}
