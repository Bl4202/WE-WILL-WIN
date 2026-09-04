/**
 * Shared mobility/economy catalogue. Simulation, UI, and rendering all read
 * the same mode and facility definitions so cost, capacity, and labels cannot
 * drift apart.
 */
import type { Projection } from "./geo";
import type {
  ConstructionEstimate,
  FacilityType,
  LineAlignment,
  MobilityFacility,
  RailAlignment,
  RollingStockModelId,
  EnergyType,
  TrackSegmentDetail,
  TransitMode,
  Vec2,
} from "./types";

export const STARTING_CAPITAL = 4_000_000_000;
export const STARTING_OPERATING_BALANCE = 75_000_000;
export const BASE_FARE = 2.75;
export const DAILY_OPERATING_SUBSIDY = 185_000;

export interface RollingStockSpec {
  id: RollingStockModelId;
  mode: TransitMode;
  name: string;
  maker: string;
  purchaseCost: number;
  capacity: number;
  maxSpeedKph: number;
  accelerationMps2: number;
  energyType: EnergyType;
  /** kWh/km for electric stock, litres/km for diesel stock. */
  energyPerKm: number;
  energyCostPerUnit: number;
  maintenanceCostPerHour: number;
  noiseDb: number;
  reliabilityPct: number;
  lengthM: number;
}

export const ROLLING_STOCK_CATALOG: readonly RollingStockSpec[] = [
  {
    id: "metro-nova-m7",
    mode: "metro",
    name: "Nova M7",
    maker: "Gulf Transit Works",
    purchaseCost: 18_500_000,
    capacity: 760,
    maxSpeedKph: 90,
    accelerationMps2: 1.05,
    energyType: "electricity",
    energyPerKm: 13.8,
    energyCostPerUnit: 0.13,
    maintenanceCostPerHour: 640,
    noiseDb: 74,
    reliabilityPct: 97.2,
    lengthM: 138,
  },
  {
    id: "metro-quietline-q2",
    mode: "metro",
    name: "QuietLine Q2",
    maker: "Kestrel Mobility",
    purchaseCost: 25_000_000,
    capacity: 640,
    maxSpeedKph: 105,
    accelerationMps2: 1.25,
    energyType: "electricity",
    energyPerKm: 8.4,
    energyCostPerUnit: 0.13,
    maintenanceCostPerHour: 520,
    noiseDb: 65,
    reliabilityPct: 99.1,
    lengthM: 126,
  },
  {
    id: "metro-titan-x",
    mode: "metro",
    name: "Titan X",
    maker: "Lone Star Rail",
    purchaseCost: 31_500_000,
    capacity: 1_120,
    maxSpeedKph: 92,
    accelerationMps2: 0.92,
    energyType: "electricity",
    energyPerKm: 18.6,
    energyCostPerUnit: 0.13,
    maintenanceCostPerHour: 820,
    noiseDb: 78,
    reliabilityPct: 96.4,
    lengthM: 172,
  },
  {
    id: "bus-ecity-12",
    mode: "bus",
    name: "eCity 12",
    maker: "Kestrel Mobility",
    purchaseCost: 1_150_000,
    capacity: 82,
    maxSpeedKph: 80,
    accelerationMps2: 1.2,
    energyType: "electricity",
    energyPerKm: 1.35,
    energyCostPerUnit: 0.13,
    maintenanceCostPerHour: 105,
    noiseDb: 63,
    reliabilityPct: 98.3,
    lengthM: 12,
  },
  {
    id: "bus-artic-d",
    mode: "bus",
    name: "MetroLink Artic",
    maker: "Gulf Coach",
    purchaseCost: 860_000,
    capacity: 118,
    maxSpeedKph: 75,
    accelerationMps2: 0.9,
    energyType: "diesel",
    energyPerKm: 0.48,
    energyCostPerUnit: 1.04,
    maintenanceCostPerHour: 145,
    noiseDb: 79,
    reliabilityPct: 95.8,
    lengthM: 18,
  },
  {
    id: "rail-arrow-emu",
    mode: "regional-rail",
    name: "Arrow EMU",
    maker: "Lone Star Rail",
    purchaseCost: 22_000_000,
    capacity: 540,
    maxSpeedKph: 160,
    accelerationMps2: 0.78,
    energyType: "electricity",
    energyPerKm: 16.2,
    energyCostPerUnit: 0.13,
    maintenanceCostPerHour: 910,
    noiseDb: 76,
    reliabilityPct: 98.7,
    lengthM: 148,
  },
  {
    id: "rail-bilevel-d",
    mode: "regional-rail",
    name: "Bayou Bi-Level",
    maker: "Gulf Transit Works",
    purchaseCost: 15_500_000,
    capacity: 780,
    maxSpeedKph: 130,
    accelerationMps2: 0.55,
    energyType: "diesel",
    energyPerKm: 4.2,
    energyCostPerUnit: 1.04,
    maintenanceCostPerHour: 1_180,
    noiseDb: 86,
    reliabilityPct: 96.9,
    lengthM: 184,
  },
] as const;

/**
 * Indexed once, because this is a per-vehicle, per-tick lookup: moveVehicles
 * and accrueOperatingCosts between them call it several times per vehicle on
 * every one of the four ticks a sim-second, and a linear scan of the
 * catalogue for each was pure overhead.
 */
const ROLLING_STOCK_BY_ID = new Map<RollingStockModelId, RollingStockSpec>(
  ROLLING_STOCK_CATALOG.map((item) => [item.id, item]),
);

export function getRollingStockSpec(
  id: RollingStockModelId,
): RollingStockSpec {
  return ROLLING_STOCK_BY_ID.get(id)!;
}

export interface TransitModeSpec {
  label: string;
  shortLabel: string;
  trackCostPerM: number;
  stationCost: number;
  systemsRate: number;
  capacity: number;
  dwellSec: number;
  speedFactor: number;
  operatingCostPerVehicleHour: number;
  congestionExposure: number;
}

const MODE_SPECS: Record<TransitMode, TransitModeSpec> = {
  metro: {
    label: "Metro",
    shortLabel: "Metro",
    trackCostPerM: 18_000,
    stationCost: 45_000_000,
    systemsRate: 0.15,
    capacity: 800,
    dwellSec: 22,
    speedFactor: 1,
    operatingCostPerVehicleHour: 1_100,
    congestionExposure: 0,
  },
  bus: {
    label: "Local bus",
    shortLabel: "Bus",
    trackCostPerM: 1_200,
    stationCost: 800_000,
    systemsRate: 0.05,
    capacity: 80,
    dwellSec: 15,
    speedFactor: 0.58,
    operatingCostPerVehicleHour: 210,
    congestionExposure: 1,
  },
  "regional-rail": {
    label: "Regional rail",
    shortLabel: "Rail",
    trackCostPerM: 9_000,
    stationCost: 22_000_000,
    systemsRate: 0.1,
    capacity: 600,
    dwellSec: 38,
    speedFactor: 1.32,
    operatingCostPerVehicleHour: 1_650,
    congestionExposure: 0,
  },
};

const UNDERGROUND_METRO = {
  trackCostPerM: 115_000,
  stationCost: 190_000_000,
  systemsRate: 0.18,
} as const;

const ELEVATED_METRO = {
  trackCostPerM: 64_000,
  stationCost: 88_000_000,
  systemsRate: 0.16,
} as const;

export interface FacilitySpec {
  label: string;
  cost: number;
  catchmentM: number;
  trafficRelief: number;
  dailyCapacity: number;
  connectsOutside: boolean;
  color: string;
  glyph: string;
}

export const FACILITY_SPECS: Record<FacilityType, FacilitySpec> = {
  "bus-hub": {
    label: "Bus hub",
    cost: 35_000_000,
    catchmentM: 1_800,
    trafficRelief: 0.025,
    dailyCapacity: 30_000,
    connectsOutside: false,
    color: "#f4b860",
    glyph: "B",
  },
  "rail-terminal": {
    label: "Intercity rail",
    cost: 250_000_000,
    catchmentM: 2_400,
    trafficRelief: 0.05,
    dailyCapacity: 45_000,
    connectsOutside: true,
    color: "#bd9cff",
    glyph: "R",
  },
  airport: {
    label: "Airport",
    cost: 2_500_000_000,
    catchmentM: 3_000,
    trafficRelief: 0.09,
    dailyCapacity: 80_000,
    connectsOutside: true,
    color: "#70c9ee",
    glyph: "A",
  },
  harbor: {
    label: "Harbor",
    cost: 650_000_000,
    catchmentM: 2_500,
    trafficRelief: 0.065,
    dailyCapacity: 40_000,
    connectsOutside: true,
    color: "#62e6c5",
    glyph: "H",
  },
};

interface LinePointLike {
  pos: Vec2;
  existingStationId?: number;
  /** Exact centreline from the previous stop. */
  pathFromPrevious?: Vec2[];
  /** Building footprints actually crossed by the centreline. */
  demolitionSitesFromPrevious?: Vec2[];
  demolitionFeatureIdsFromPrevious?: Array<string | number>;
  /** Alignment of the segment that ends at this point. */
  alignmentFromPrevious?: RailAlignment;
  /** Metres relative to the street for the segment that ends here. */
  levelMFromPrevious?: number;
}

/**
 * The two derived metro specs, built once instead of on every lookup.
 *
 * This function is called per vehicle per tick from moveVehicles and
 * accrueOperatingCosts, and the elevated/underground branches each allocated
 * a fresh spread object every time — around 1.15M short-lived objects a
 * second at the top time multiplier, purely for the garbage collector.
 */
const ELEVATED_METRO_SPEC: TransitModeSpec = {
  ...MODE_SPECS.metro,
  ...ELEVATED_METRO,
  speedFactor: 1.04,
};
const UNDERGROUND_METRO_SPEC: TransitModeSpec = {
  ...MODE_SPECS.metro,
  ...UNDERGROUND_METRO,
  speedFactor: 1.08,
};

export function getTransitModeSpec(
  mode: TransitMode,
  alignment: LineAlignment = "surface",
): TransitModeSpec {
  if (mode !== "metro") return MODE_SPECS[mode];
  if (alignment === "elevated") return ELEVATED_METRO_SPEC;
  if (alignment === "underground") return UNDERGROUND_METRO_SPEC;
  return MODE_SPECS.metro;
}

export function estimateLineConstruction(
  points: LinePointLike[],
  mode: TransitMode,
  fallbackAlignment: RailAlignment,
): ConstructionEstimate {
  let lengthM = 0;
  let trackCost = 0;
  let systemsCost = 0;
  let demolitionCost = 0;
  let demolishedBuildings = 0;
  let weightedNoise = 0;
  let weightedDepth = 0;
  const segmentDetails: TrackSegmentDetail[] = [];
  for (let i = 1; i < points.length; i++) {
    const segmentPath =
      points[i].pathFromPrevious && points[i].pathFromPrevious!.length >= 2
        ? points[i].pathFromPrevious!.map((point) => ({ ...point }))
        : [{ ...points[i - 1].pos }, { ...points[i].pos }];
    let segmentLength = 0;
    for (let pathIndex = 1; pathIndex < segmentPath.length; pathIndex++) {
      segmentLength += Math.hypot(
        segmentPath[pathIndex].x - segmentPath[pathIndex - 1].x,
        segmentPath[pathIndex].y - segmentPath[pathIndex - 1].y,
      );
    }
    const segmentAlignment = normalizeAlignment(
      mode,
      points[i].alignmentFromPrevious ?? fallbackAlignment,
    );
    const requestedLevel = points[i].levelMFromPrevious;
    const levelM =
      segmentAlignment === "underground"
        ? Math.min(-8, requestedLevel ?? -16)
        : segmentAlignment === "elevated"
          ? Math.max(8, requestedLevel ?? 12)
          : 0;
    const spec = getTransitModeSpec(mode, segmentAlignment);
    const depthPremium =
      segmentAlignment === "underground"
        ? 1 + Math.max(0, Math.abs(levelM) - 12) * 0.018
        : 1;
    const segmentCost = segmentLength * spec.trackCostPerM * depthPremium;
    const midpoint = segmentPath[Math.floor(segmentPath.length / 2)];
    const centrality = 0.28 + 0.72 * Math.exp(-Math.hypot(midpoint.x, midpoint.y) / 8_500);
    const conflictsPerKm =
      mode === "bus"
        ? 0
        : segmentAlignment === "surface"
          ? 7.2
          : segmentAlignment === "elevated"
            ? 3.4
            : Math.max(0.08, 1.35 - Math.abs(levelM) * 0.055);
    const expectedConflicts = (segmentLength / 1_000) * conflictsPerKm * centrality;
    const deterministicRemainder =
      Math.abs(Math.sin(midpoint.x * 0.00017 + midpoint.y * 0.00011 + i)) * 0.92;
    const detectedSites = points[i].demolitionSitesFromPrevious;
    const detectedFeatureIds = points[i].demolitionFeatureIdsFromPrevious ?? [];
    const segmentDemolitions =
      detectedSites !== undefined
        ? segmentAlignment === "underground" || mode === "bus"
          ? 0
          : detectedSites.length
        : Math.max(0, Math.floor(expectedConflicts + deterministicRemainder));
    const clearancePrice =
      segmentAlignment === "surface"
        ? 4_800_000
        : segmentAlignment === "elevated"
          ? 3_100_000
          : 1_650_000;
    const segmentDemolitionCost = segmentDemolitions * clearancePrice;
    const noiseDb =
      mode === "bus"
        ? 76
        : segmentAlignment === "surface"
          ? mode === "regional-rail"
            ? 84
            : 80
          : segmentAlignment === "elevated"
            ? 88
            : Math.max(29, 59 - Math.abs(levelM) * 0.82);
    const demolitionSites: Vec2[] = detectedSites
      ? segmentDemolitions > 0
        ? detectedSites.slice(0, 24).map((site) => ({ ...site }))
        : []
      : [];
    if (!detectedSites) {
      const visibleSiteCount = Math.min(18, segmentDemolitions);
      for (let site = 0; site < visibleSiteCount; site++) {
        const t = (site + 1) / (visibleSiteCount + 1);
        demolitionSites.push({
          x: points[i - 1].pos.x + (points[i].pos.x - points[i - 1].pos.x) * t,
          y: points[i - 1].pos.y + (points[i].pos.y - points[i - 1].pos.y) * t,
        });
      }
    }
    lengthM += segmentLength;
    trackCost += segmentCost;
    systemsCost += segmentCost * spec.systemsRate;
    demolitionCost += segmentDemolitionCost;
    demolishedBuildings += segmentDemolitions;
    weightedNoise += noiseDb * segmentLength;
    weightedDepth +=
      (segmentAlignment === "underground" ? Math.abs(levelM) : 0) *
      segmentLength;
    segmentDetails.push({
      index: i - 1,
      alignment: segmentAlignment,
      path: segmentPath,
      levelM,
      lengthM: segmentLength,
      speedLimitKph:
        mode === "bus"
          ? 55
          : mode === "regional-rail"
            ? 145
            : segmentAlignment === "surface"
              ? 80
              : 105,
      constructionCost: Math.round(segmentCost),
      demolitionCost: segmentDemolitionCost,
      demolishedBuildings: segmentDemolitions,
      noiseDb,
      demolitionSites,
      demolishedBuildingFeatureIds:
        segmentDemolitions > 0 ? [...detectedFeatureIds] : [],
    });
  }

  const newLocations: Array<{
    pos: Vec2;
    alignment: RailAlignment;
    levelM: number;
  }> = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point.existingStationId !== undefined) continue;
    const incoming = i > 0 ? points[i].alignmentFromPrevious : undefined;
    const outgoing = points[i + 1]?.alignmentFromPrevious;
    const incomingLevel = i > 0 ? points[i].levelMFromPrevious : undefined;
    const outgoingLevel = points[i + 1]?.levelMFromPrevious;
    const stationAlignment = normalizeAlignment(
      mode,
      incoming === "underground" || outgoing === "underground"
        ? "underground"
        : incoming === "elevated" || outgoing === "elevated"
          ? "elevated"
        : fallbackAlignment,
    );
    const stationLevel =
      stationAlignment === "underground"
        ? Math.min(-8, incomingLevel ?? outgoingLevel ?? -16)
        : stationAlignment === "elevated"
          ? Math.max(8, incomingLevel ?? outgoingLevel ?? 12)
          : 0;
    const known = newLocations.find(
      (candidate) =>
        Math.hypot(candidate.pos.x - point.pos.x, candidate.pos.y - point.pos.y) <
        5,
    );
    if (known) {
      if (stationAlignment === "underground") {
        known.alignment = "underground";
        known.levelM = Math.min(known.levelM, stationLevel);
      } else if (
        stationAlignment === "elevated" &&
        known.alignment === "surface"
      ) {
        known.alignment = "elevated";
        known.levelM = stationLevel;
      }
    } else {
      newLocations.push({
        pos: point.pos,
        alignment: stationAlignment,
        levelM: stationLevel,
      });
    }
  }

  let stationCost = 0;
  for (const location of newLocations) {
    const spec = getTransitModeSpec(mode, location.alignment);
    const depthPremium =
      location.alignment === "underground"
        ? 1 + Math.max(0, Math.abs(location.levelM) - 12) * 0.022
        : 1;
    const locationCost = spec.stationCost * depthPremium;
    stationCost += locationCost;
    systemsCost += locationCost * spec.systemsRate;
  }
  return {
    trackCost,
    stationCost,
    systemsCost,
    demolitionCost,
    totalCost: Math.round(
      trackCost + stationCost + systemsCost + demolitionCost,
    ),
    lengthM,
    newStations: newLocations.length,
    demolishedBuildings,
    averageNoiseDb: lengthM > 0 ? weightedNoise / lengthM : 0,
    averageDepthM: lengthM > 0 ? weightedDepth / lengthM : 0,
    segmentDetails,
  };
}

export function normalizeAlignment(
  mode: TransitMode,
  alignment: RailAlignment,
): RailAlignment {
  return mode === "metro" ? alignment : "surface";
}

export function facilityBuildCost(type: FacilityType): number {
  return FACILITY_SPECS[type].cost;
}

export function createHoustonFacilities(
  projection: Projection,
): MobilityFacility[] {
  const realWorld: Array<{
    type: FacilityType;
    name: string;
    code?: string;
    lat: number;
    lng: number;
    dailyCapacity?: number;
  }> = [
    {
      type: "airport",
      name: "George Bush Intercontinental",
      code: "IAH",
      lat: 29.984435,
      lng: -95.341443,
      dailyCapacity: 133_000,
    },
    {
      type: "airport",
      name: "William P. Hobby Airport",
      code: "HOU",
      lat: 29.645417,
      lng: -95.278889,
      dailyCapacity: 38_000,
    },
    {
      type: "airport",
      name: "Ellington Airport / Houston Spaceport",
      code: "EFD",
      lat: 29.607333,
      lng: -95.15875,
      dailyCapacity: 2_000,
    },
    {
      type: "harbor",
      name: "Port Houston Turning Basin",
      code: "PORT",
      lat: 29.748333,
      lng: -95.28833,
      dailyCapacity: 90_000,
    },
    {
      type: "rail-terminal",
      name: "Houston Amtrak Station",
      code: "HOUSTON",
      lat: 29.767356,
      lng: -95.367573,
      dailyCapacity: 2_000,
    },
    {
      type: "bus-hub",
      name: "Downtown Transit Center",
      code: "DTC",
      lat: 29.75023,
      lng: -95.37114,
      dailyCapacity: 25_000,
    },
  ];

  return realWorld.map((item, index) => {
    const spec = FACILITY_SPECS[item.type];
    return {
      id: index + 1,
      type: item.type,
      name: item.name,
      code: item.code,
      pos: projection.toWorld(item.lat, item.lng),
      builtIn: true,
      connectsOutside: spec.connectsOutside,
      connected: false,
      constructionCost: 0,
      catchmentM: spec.catchmentM,
      trafficRelief: spec.trafficRelief,
      dailyCapacity: item.dailyCapacity ?? spec.dailyCapacity,
    };
  });
}
