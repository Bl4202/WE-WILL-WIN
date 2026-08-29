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
  FACILITY_SPECS,
  facilityBuildCost,
  getRollingStockSpec,
} from "./mobility";
import type { ThemeMode } from "./preferences";
import type { LinePoint } from "./simulation";
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

function hexToRgb(hex: string): RGBA {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255,
  ];
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
}

interface DemolitionSite {
  pos: Vec2;
  alignment: RailAlignment;
}

interface RoadModel {
  points: Vec2[];
  shadowPath: [number, number, number][];
  topPath: [number, number, number][];
  roadClass: string;
  widthM: number;
  heightM: number;
}

interface RoadDeckSegment {
  polygon: [number, number][];
  roadClass: string;
  heightM: number;
}

interface RoadNode {
  pos: Vec2;
  links: Map<string, number>;
}

interface BuildingFootprint {
  featureId?: string | number;
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
}

/** Web Mercator ground resolution (metres/pixel) at this latitude/zoom —
 *  used to offset parallel track segments by a constant number of *screen*
 *  pixels regardless of how far the player has zoomed. */
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

function roadWidthM(roadClass: string): number {
  if (roadClass === "motorway") return 19;
  if (roadClass === "trunk") return 16;
  if (roadClass === "primary") return 13;
  if (roadClass === "secondary") return 10;
  if (roadClass === "tertiary") return 8.5;
  if (roadClass === "service") return 5.5;
  return 7;
}

function roadHeightM(roadClass: string): number {
  if (roadClass === "motorway") return 8.5;
  if (roadClass === "trunk") return 6.8;
  if (roadClass === "primary") return 2.1;
  if (roadClass === "secondary") return 1.45;
  if (roadClass === "tertiary") return 1.05;
  return 0.82;
}

function roadNodeKey(lng: number, lat: number): string {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
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
  /** Station under the cursor, if any. Its waiting count is shown on demand
   *  rather than labelling every busy station at once, which buried the map
   *  in numbers as soon as the network got going. */
  hoveredStationId: number | null = null;
  showDemand = false;
  showGhost = false;
  showTraffic = true;
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
  private cachedMobility: Layer[] | null = null;
  private cachedMobilityKey = "";
  private roadModels: RoadModel[] = [];
  private roadDeckSegments: RoadDeckSegment[] = [];
  private roadNodes = new Map<string, RoadNode>();
  private buildingFootprints: BuildingFootprint[] = [];
  private roadGeometryRevision = 0;
  private cachedRoadLayers: Layer[] | null = null;
  private cachedRoadLayersKey = "";
  private geometryViewportKey = "";
  private demolitionFilterKey = "";

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
    this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    this.map.addControl(this.overlay as unknown as maplibregl.IControl);
    this.map.on("load", () => {
      this.ensureBuildingsLayer();
      this.ensureTrafficLayers();
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
    this.cachedRoadLayers = null;
    this.demolitionFilterKey = "";
    this.map.setStyle(BASEMAP_STYLES[theme]);
    this.map.once("style.load", () => {
      this.ensureBuildingsLayer();
      this.ensureTrafficLayers();
      this.map.once("idle", this.refreshWorldGeometry);
    });
  }

  /** Whether the map is currently using the pitched, real-height city view. */
  get is3d(): boolean {
    return this.threeDimensional;
  }

  get geometryStats(): {
    roads: number;
    roadDecks: number;
    roadNodes: number;
    buildings: number;
  } {
    return {
      roads: this.roadModels.length,
      roadDecks: this.roadDeckSegments.length,
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
    this.cachedRoadLayers = null;

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

  private ensureBuildingsLayer(): void {
    if (this.map.getLayer(BUILDINGS_LAYER_ID)) {
      this.setBuildingsVisibility(this.threeDimensional ? "visible" : "none");
      return;
    }

    // Keep road/place labels above the extrusions so the city stays usable.
    const firstSymbolLayer = this.map
      .getStyle()
      .layers.find((layer) => layer.type === "symbol")?.id;
    const buildingColors =
      this.theme === "light"
        ? ["#ededed", "#dddddd", "#c9c9c9", "#aeaeae"]
        : ["#1d1d1d", "#292929", "#3b3b3b", "#686868"];

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
            260,
            buildingColors[3],
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
          "fill-extrusion-opacity": 0.93,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      firstSymbolLayer,
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

    const firstSymbolLayer = this.map
      .getStyle()
      .layers.find((layer) => layer.type === "symbol")?.id;
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
      firstSymbolLayer,
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
        firstSymbolLayer,
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
    const viewportKey = [
      Math.round(this.map.getZoom() * 4),
      bounds.getWest().toFixed(3),
      bounds.getSouth().toFixed(3),
      bounds.getEast().toFixed(3),
      bounds.getNorth().toFixed(3),
    ].join("|");
    if (
      viewportKey === this.geometryViewportKey &&
      this.roadModels.length > 0 &&
      this.buildingFootprints.length > 0
    ) {
      return;
    }

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
    const decks: RoadDeckSegment[] = [];
    const nodes = new Map<string, RoadNode>();
    const seenRoads = new Set<string>();

    for (const feature of roadFeatures) {
      const properties = feature.properties ?? {};
      const roadClass = String(properties.class ?? properties.subclass ?? "minor");
      if (!acceptedRoadClasses.has(roadClass)) continue;
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
        const widthM = roadWidthM(roadClass);
        const heightM = roadHeightM(roadClass);
        models.push({
          points,
          shadowPath: line.map(([lng, lat]) => [lng, lat, 0.08]),
          topPath: line.map(([lng, lat]) => [lng, lat, heightM + 0.08]),
          roadClass,
          widthM,
          heightM,
        });

        for (let index = 1; index < line.length; index++) {
          const a = points[index - 1];
          const b = points[index];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy);
          if (length < 0.4) continue;
          const offsetX = (-dy / length) * (widthM / 2 + 0.55);
          const offsetY = (dx / length) * (widthM / 2 + 0.55);
          decks.push({
            polygon: [
              this.toLngLat({ x: a.x + offsetX, y: a.y + offsetY }),
              this.toLngLat({ x: b.x + offsetX, y: b.y + offsetY }),
              this.toLngLat({ x: b.x - offsetX, y: b.y - offsetY }),
              this.toLngLat({ x: a.x - offsetX, y: a.y - offsetY }),
            ],
            roadClass,
            heightM,
          });

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
        const signature = `${centerLng.toFixed(6)},${centerLat.toFixed(6)}`;
        if (seenBuildings.has(signature)) continue;
        seenBuildings.add(signature);
        footprints.push({
          featureId:
            typeof feature.id === "string" || typeof feature.id === "number"
              ? feature.id
              : undefined,
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
      this.roadDeckSegments = decks.slice(0, 12_000);
      this.roadNodes = nodes;
      // Low-zoom planning tiles omit individual buildings. Keep the last
      // detailed footprint cache when switching from 3D to 2D so clearance
      // checks remain tied to real buildings instead of losing that data.
      if (footprints.length > 0) this.buildingFootprints = footprints;
      this.geometryViewportKey = viewportKey;
      this.roadGeometryRevision++;
      this.cachedRoadLayers = null;
    }
  };

  private buildRoadStructureLayers(congestionIndex: number): Layer[] {
    if (!this.threeDimensional || this.roadModels.length === 0) return [];
    const congestionBucket = Math.round(congestionIndex / 10) * 10;
    const key = `${this.roadGeometryRevision}|${this.theme}|${congestionBucket}|${this.showTraffic}`;
    if (this.cachedRoadLayersKey === key && this.cachedRoadLayers) {
      return this.cachedRoadLayers;
    }
    const dark = this.theme === "dark";
    const arteries = this.roadModels.filter((road) =>
      ["motorway", "trunk", "primary", "secondary"].includes(road.roadClass),
    );
    const trafficColor: RGBA = !this.showTraffic
      ? [0, 0, 0, 0]
      : congestionBucket >= 80
        ? [232, 72, 64, 205]
        : congestionBucket >= 60
          ? [231, 132, 61, 195]
          : congestionBucket >= 40
            ? [215, 174, 73, 180]
            : [81, 169, 104, 175];
    this.cachedRoadLayers = [
      new PathLayer<RoadModel>({
        id: "road-structure-shadows",
        data: this.roadModels,
        getPath: (road) => road.shadowPath,
        getWidth: (road) => road.widthM + 6,
        widthUnits: "meters",
        widthMinPixels: 1.5,
        getColor: dark ? [0, 0, 0, 120] : [65, 68, 70, 65],
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
      new PolygonLayer<RoadDeckSegment>({
        id: "road-structure-decks",
        data: this.roadDeckSegments,
        getPolygon: (segment) => segment.polygon,
        getFillColor: (segment) =>
          dark
            ? segment.roadClass === "motorway" || segment.roadClass === "trunk"
              ? [31, 31, 31, 255]
              : [37, 37, 37, 255]
            : segment.roadClass === "motorway" || segment.roadClass === "trunk"
              ? [190, 190, 190, 255]
              : [213, 213, 213, 255],
        extruded: true,
        getElevation: (segment) => segment.heightM,
        wireframe: false,
        material: {
          ambient: 0.42,
          diffuse: 0.7,
          shininess: 18,
          specularColor: [65, 65, 65],
        },
        pickable: false,
      }),
      new PathLayer<RoadModel>({
        id: "road-structure-edges",
        data: this.roadModels,
        getPath: (road) => road.topPath,
        getWidth: (road) => road.widthM + 2.2,
        widthUnits: "meters",
        widthMinPixels: 1.4,
        getColor: dark ? [12, 12, 12, 255] : [155, 155, 155, 255],
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
      new PathLayer<RoadModel>({
        id: "road-structure-surfaces",
        data: this.roadModels,
        getPath: (road) => road.topPath,
        getWidth: (road) => road.widthM,
        widthUnits: "meters",
        widthMinPixels: 1,
        getColor: dark ? [48, 48, 48, 255] : [224, 224, 224, 255],
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
      new PathLayer<RoadModel>({
        id: "road-structure-traffic-stripes",
        data: arteries,
        getPath: (road) => road.topPath,
        getWidth: (road) => Math.max(0.7, road.widthM * 0.075),
        widthUnits: "meters",
        widthMinPixels: 0.65,
        getColor: trafficColor,
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
    ];
    this.cachedRoadLayersKey = key;
    return this.cachedRoadLayers;
  }

  private nearestRoadSnap(screen: Vec2, maxDistancePx: number): {
    pos: Vec2;
    nodeKey: string;
  } | null {
    let closest: { pos: Vec2; nodeKey: string } | null = null;
    let closestDistance = maxDistancePx;
    for (const road of this.roadModels) {
      for (let index = 1; index < road.points.length; index++) {
        const aGeo = this.toLngLat(road.points[index - 1]);
        const bGeo = this.toLngLat(road.points[index]);
        const a = this.map.project(aGeo);
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
        if (distance >= closestDistance) continue;
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
    const ids = [...snap.lines.values()]
      .flatMap((line) =>
        line.segmentDetails.flatMap(
          (detail) => detail.demolishedBuildingFeatureIds,
        ),
      )
      .filter(
        (id, index, values) => values.findIndex((value) => value === id) === index,
      );
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
  ): BuildTarget {
    if (transitMode === "bus") {
      if (this.roadModels.length === 0) this.refreshWorldGeometry();
      const roadTarget = this.nearestRoadSnap(screen, 28);
      if (!roadTarget) {
        return {
          pos: this.toWorld(lngLat[1], lngLat[0]),
          snapped: false,
          valid: false,
        };
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
      const path = [previous.pos, ...routed, roadTarget.pos].filter(
        (point, index, points) =>
          index === 0 ||
          Math.hypot(
            point.x - points[index - 1].x,
            point.y - points[index - 1].y,
          ) > 0.5,
      );
      return {
        pos: roadTarget.pos,
        pathFromPrevious: path,
        demolitionSitesFromPrevious: [],
        snapped: true,
        valid: path.length >= 2,
      };
    }

    const station = this.pickStation(snap, screen, SNAP_RADIUS_PX);
    let target: BuildTarget;
    if (station) {
      target = {
        pos: station.pos,
        existingStationId: station.id,
        snapped: true,
        valid: true,
      };
    } else {
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
      target = best
        ? {
            pos: { ...best.pos },
            existingStationId: best.existingStationId,
            snapped: true,
            valid: true,
          }
        : {
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
    const layers: Layer[] = [];
    layers.push(...this.buildRoadStructureLayers(snap.traffic.congestionIndex));
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
    layers.push(...this.buildDraftLayers(game));
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
    // Bucketed rather than exact: parallel-track offsets need to stay in
    // step with zoom (see buildTrackSegments), but rebuilding on every
    // sub-pixel zoom tick would be wasted work.
    const zoomBucket = Math.round(this.map.getZoom() * 10);
    const key = `${snap.networkVersion}|${game.selection?.kind ?? ""}:${game.selection?.id ?? ""}|${zoomBucket}|${this.threeDimensional}|${this.theme}`;
    if (key === this.cachedNetworkKey && this.cachedNetwork) {
      return this.cachedNetwork;
    }

    const stations = [...snap.stations.values()];
    const selLine =
      game.selection?.kind === "line" ? game.selection.id : null;
    const selStation =
      game.selection?.kind === "station" ? game.selection.id : null;

    const trackSegments = this.buildTrackSegments(snap, selLine);
    const demolitionSites: DemolitionSite[] = [];
    for (const line of snap.lines.values()) {
      for (const detail of line.segmentDetails) {
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
        getRadius: (site) => site.alignment === "surface" ? 34 : 24,
        radiusUnits: "meters",
        radiusMinPixels: 2,
        getFillColor: (site) =>
          site.alignment === "surface"
            ? ([255, 107, 91, 155] as RGBA)
            : ([244, 184, 96, 130] as RGBA),
        stroked: true,
        getLineColor: [255, 215, 154, 205],
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
      let tangent = { x: 1, y: 0 };
      if (firstLine) {
        const index = firstLine.stationIds.indexOf(station.id);
        const neighborId =
          index < firstLine.stationIds.length - 1
            ? firstLine.stationIds[index + 1]
            : firstLine.stationIds[Math.max(0, index - 1)];
        const neighbor = snap.stations.get(neighborId);
        if (neighbor) {
          const dx = neighbor.pos.x - station.pos.x;
          const dy = neighbor.pos.y - station.pos.y;
          const length = Math.hypot(dx, dy) || 1;
          tangent = { x: dx / length, y: dy / length };
        }
      }
      const perpendicular = { x: -tangent.y, y: tangent.x };
      const halfLength = Math.max(16, station.platformLengthM / 2);
      const halfWidth = firstLine?.mode === "bus" ? 4 : 8;
      const z =
        station.primaryAlignment === "elevated"
          ? station.levelM
          : station.primaryAlignment === "underground"
            ? 0.65
            : 0.35;
      const corners: Vec2[] = [
        {
          x: station.pos.x - tangent.x * halfLength - perpendicular.x * halfWidth,
          y: station.pos.y - tangent.y * halfLength - perpendicular.y * halfWidth,
        },
        {
          x: station.pos.x + tangent.x * halfLength - perpendicular.x * halfWidth,
          y: station.pos.y + tangent.y * halfLength - perpendicular.y * halfWidth,
        },
        {
          x: station.pos.x + tangent.x * halfLength + perpendicular.x * halfWidth,
          y: station.pos.y + tangent.y * halfLength + perpendicular.y * halfWidth,
        },
        {
          x: station.pos.x - tangent.x * halfLength + perpendicular.x * halfWidth,
          y: station.pos.y - tangent.y * halfLength + perpendicular.y * halfWidth,
        },
      ];
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

  private buildDraftLayers(game: Game): Layer[] {
    if (game.mode !== "build") return [];
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
            getLineColor: activeDraftColor,
            getLineWidth: 2,
            lineWidthUnits: "pixels",
            pickable: false,
          }),
        ]
      : [];
    if (game.draft.length === 0) return snapRing;

    const pts = game.draft.map((p) => this.toLngLat(p.pos));
    const draftSegments: Array<{
      path: [number, number][];
      color: RGBA;
    }> = [];
    for (let i = 1; i < game.draft.length; i++) {
      draftSegments.push({
        path: (game.draft[i].pathFromPrevious ?? [
          game.draft[i - 1].pos,
          game.draft[i].pos,
        ]).map((point) => this.toLngLat(point)),
        color: draftColorFor(
          game.draft[i].alignmentFromPrevious ?? "surface",
        ),
      });
    }
    if (this.hoverLngLat) {
      draftSegments.push({
        path: [pts[pts.length - 1], this.hoverLngLat],
        color: activeDraftColor,
      });
    }
    return [
      ...snapRing,
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
      new ScatterplotLayer({
        id: "draft-points",
        data: pts,
        getPosition: (p: [number, number]) => p,
        getRadius: 5,
        radiusUnits: "pixels",
        getFillColor: activeDraftColor,
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
      new ScatterplotLayer({
      id: "vehicles",
      // Fresh array each frame: `snap.vehicles` is the sim's own mutable
      // array (mutated in place, never reassigned), and deck.gl diffs `data`
      // by reference — without a new reference here it never notices
      // vehicles moving (or existing at all past the first, empty frame).
      data: assignedVehicles,
      getPosition: (v) => {
        const line = snap.lines.get(v.lineId)!;
        const dist = v.prevDist + (v.dist - v.prevDist) * alpha;
        return this.toLngLat(positionOnLine(snap, line, dist));
      },
      // Sized in metres, not screen pixels: a train is a thing on the ground,
      // so zooming out shrinks it along with the city instead of leaving a
      // constant-size dot that swallows the map at region scale. The clamps
      // keep it from vanishing when zoomed right out or ballooning up close.
      getRadius: (vehicle) => {
        const mode = snap.lines.get(vehicle.lineId)!.mode;
        return mode === "bus"
          ? VEHICLE_RADIUS_M * 0.55
          : mode === "regional-rail"
            ? VEHICLE_RADIUS_M * 1.25
            : VEHICLE_RADIUS_M;
      },
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
