import { DAY_SEC } from "./constants";
import {
  FACILITY_SPECS,
  ROLLING_STOCK_CATALOG,
  getRollingStockSpec,
  getTransitModeSpec,
} from "./mobility";
import {
  DEFAULT_KEYBINDS,
  KEYBIND_LABELS,
  displayInputKey,
  normalizeInputKey,
  savePreferences,
  type InputAction,
  type Preferences,
  type ThemeMode,
  type ViewMode,
} from "./preferences";
import type { Game } from "./game";
import type { MapRenderer } from "./render-map";
import type {
  FacilityType,
  RailAlignment,
  RollingStockModelId,
  ServiceDirection,
  SimSnapshot,
  TransitMode,
} from "./types";

export class Ui {
  private readonly clockDay = document.querySelector<HTMLElement>("#clock strong")!;
  private readonly clockTime = document.querySelector<HTMLElement>("#clock span")!;
  private readonly kpiBoardings = document.querySelector<HTMLElement>("#kpi-boardings strong")!;
  private readonly kpiYesterday = document.getElementById("kpi-yesterday")!;
  private readonly statWaiting = document.getElementById("stat-waiting")!;
  private readonly statCompleted = document.getElementById("stat-completed")!;
  private readonly statUnserved = document.getElementById("stat-unserved")!;
  private readonly statStations = document.getElementById("stat-stations")!;
  private readonly statLines = document.getElementById("stat-lines")!;
  private readonly statLength = document.getElementById("stat-length")!;
  private readonly statCongestion = document.getElementById("stat-congestion")!;
  private readonly statTransitShare = document.getElementById("stat-transit-share")!;
  private readonly statCarTrips = document.getElementById("stat-car-trips")!;
  private readonly statGateways = document.getElementById("stat-gateways")!;
  private readonly statNoise = document.getElementById("stat-noise")!;
  private readonly statEmissions = document.getElementById("stat-emissions")!;
  private readonly capitalBalance = document.getElementById("capital-balance")!;
  private readonly operatingBalance = document.getElementById("operating-balance")!;
  private readonly currentCashflow = document.getElementById("current-cashflow")!;
  private readonly cashflowStat = document.getElementById("cashflow-stat")!;
  private readonly activePassengers = document.getElementById("active-passengers")!;
  private readonly overviewOptions = document.getElementById("overview-options")!;
  private readonly buildOptions = document.getElementById("build-options")!;
  private readonly fleetOptions = document.getElementById("fleet-options")!;
  private readonly buildCost = document.getElementById("build-cost")!;
  private readonly buildBreakdown = document.getElementById("build-breakdown")!;
  private readonly buildAffordability = document.getElementById("build-affordability")!;
  private readonly estimateDemolition = document.getElementById("estimate-demolition")!;
  private readonly estimateNoise = document.getElementById("estimate-noise")!;
  private readonly estimateDepth = document.getElementById("estimate-depth")!;
  private readonly alignmentPicker = document.getElementById("alignment-picker")!;
  private readonly depthPicker = document.getElementById("depth-picker")!;
  private readonly depthInput = document.getElementById("tunnel-depth") as HTMLInputElement;
  private readonly depthValue = document.getElementById("depth-value")!;
  private readonly speedButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#time-controls button"),
  );
  private readonly modeInspect = document.getElementById("mode-inspect") as HTMLButtonElement;
  private readonly modeBuild = document.getElementById("mode-build") as HTMLButtonElement;
  private readonly modeFleet = document.getElementById("mode-fleet") as HTMLButtonElement;
  private readonly finishBtn = document.getElementById("btn-finish-line") as HTMLButtonElement;
  private readonly undoBtn = document.getElementById("btn-undo-line") as HTMLButtonElement;
  private readonly blueprintBtn = document.getElementById("btn-blueprint") as HTMLButtonElement;
  private readonly focusPanel = document.getElementById("focus-panel")!;
  private readonly contextHint = document.getElementById("context-hint-text")!;
  private readonly contextHintBar = document.getElementById("context-hint")!;
  private readonly sidebar = document.getElementById("sidebar")!;
  private readonly sidebarTitle = document.getElementById("sidebar-title")!;
  private readonly sidebarKicker = document.getElementById("sidebar-kicker")!;
  private readonly sidebarToggle = document.getElementById("sidebar-toggle") as HTMLButtonElement;
  private readonly sidebarRestore = document.getElementById("sidebar-restore") as HTMLButtonElement;
  private readonly serviceButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-transit-mode]"),
  );
  private readonly alignmentButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-alignment]"),
  );
  private readonly directionButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-direction]"),
  );
  private readonly facilityButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-facility-type]"),
  );
  private readonly fleetLineSelect = document.getElementById("fleet-line-select") as HTMLSelectElement;
  private readonly fleetLineSummary = document.getElementById("fleet-line-summary")!;
  private readonly fleetCatalog = document.getElementById("fleet-catalog")!;
  private readonly fleetOwned = document.getElementById("fleet-owned")!;
  private readonly toggleTraffic = document.getElementById("toggle-traffic")!;
  private readonly toggleDemand = document.getElementById("toggle-demand")!;
  private readonly toggleGhost = document.getElementById("toggle-ghost")!;
  private readonly viewToggleLabel = document.getElementById("view-toggle-label")!;
  private readonly trendIcon = document.querySelector<HTMLElement>("#cashflow-stat .trend-icon");
  private readonly themeChoiceButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"),
  );
  private readonly viewChoiceButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-view-choice]"),
  );
  private readonly settingsDialog = document.getElementById("settings-dialog") as HTMLDialogElement;
  private readonly keybindGrid = document.getElementById("keybind-grid")!;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  private fleetSelectKey = "";
  private fleetCatalogKey = "";
  private fleetSummaryKey = "";
  private focusKey = "";
  /** The armed keybind listener, so it can be removed without firing. */
  private pendingKeybindCapture: ((event: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly game: Game,
    private readonly renderer: MapRenderer,
    private readonly preferences: Preferences,
  ) {
    for (const button of this.speedButtons) {
      button.addEventListener("click", () =>
        game.setSpeed(Number(button.dataset.speed)),
      );
    }
    this.modeInspect.addEventListener("click", () => {
      game.setMode("inspect");
      this.openSidebar();
    });
    this.modeBuild.addEventListener("click", () => {
      game.setMode("build");
      this.openSidebar();
    });
    this.modeFleet.addEventListener("click", () => {
      game.setMode("fleet");
      if (game.selection?.kind !== "line") {
        const firstLine = game.sim.lines.values().next().value;
        if (firstLine) game.selection = { kind: "line", id: firstLine.id };
      }
      this.openSidebar();
    });
    this.finishBtn.addEventListener("click", () => game.finishLine());
    this.undoBtn.addEventListener("click", () => game.undoDraftPoint());
    this.blueprintBtn.addEventListener("click", () => {
      if (game.blueprinting) game.stopBlueprint();
      else game.startBlueprint();
    });

    for (const button of this.serviceButtons) {
      button.addEventListener("click", () => {
        const mode = button.dataset.transitMode as TransitMode;
        game.setBuildTransitMode(mode);
        // Buses are the only mode that routes on streets, and the citywide
        // graph is a few megabytes — so it is fetched here, on the click that
        // makes it relevant, rather than at boot. Drawing works off the tile
        // graph until it lands.
        if (mode === "bus") renderer.ensureRoadGraph();
      });
    }
    for (const button of this.alignmentButtons) {
      button.addEventListener("click", () =>
        game.setBuildAlignment(button.dataset.alignment as RailAlignment),
      );
    }
    for (const button of this.directionButtons) {
      button.addEventListener("click", () =>
        game.setBuildDirection(button.dataset.direction as ServiceDirection),
      );
    }
    for (const button of this.facilityButtons) {
      button.addEventListener("click", () =>
        game.beginFacilityPlacement(button.dataset.facilityType as FacilityType),
      );
    }
    this.depthInput.addEventListener("input", () => {
      game.setBuildDepth(Number(this.depthInput.value));
    });

    this.sidebarToggle.addEventListener("click", () => this.closeSidebar());
    this.sidebarRestore.addEventListener("click", () => this.openSidebar());

    this.fleetLineSelect.addEventListener("change", () => {
      const lineId = Number(this.fleetLineSelect.value);
      game.selection = lineId > 0 ? { kind: "line", id: lineId } : null;
      this.fleetCatalogKey = "";
      this.focusKey = "";
    });
    this.fleetCatalog.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const buyButton = target.closest<HTMLButtonElement>("[data-buy-model]");
      const assignButton = target.closest<HTMLButtonElement>(
        "[data-assign-vehicle]",
      );
      const unassignButton = target.closest<HTMLButtonElement>(
        "[data-unassign-vehicle]",
      );
      const lineId = Number(this.fleetLineSelect.value);
      if (buyButton) {
        game.purchaseVehicle(
          buyButton.dataset.buyModel as RollingStockModelId,
        );
      } else if (assignButton && lineId > 0) {
        game.assignVehicle(Number(assignButton.dataset.assignVehicle), lineId);
      } else if (unassignButton) {
        game.unassignVehicle(Number(unassignButton.dataset.unassignVehicle));
      } else {
        return;
      }
      this.fleetCatalogKey = "";
      this.focusKey = "";
    });
    this.focusPanel.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-close-focus]")) {
        game.selection = null;
        this.focusKey = "";
      }
      if (target.closest("[data-manage-fleet]")) {
        game.setMode("fleet");
        this.openSidebar();
      }
    });

    document.getElementById("toggle-traffic")!.addEventListener("click", () => {
      renderer.showTraffic = !renderer.showTraffic;
    });
    document.getElementById("toggle-demand")!.addEventListener("click", () => {
      renderer.showDemand = !renderer.showDemand;
    });
    document.getElementById("toggle-ghost")!.addEventListener("click", () => {
      renderer.showGhost = !renderer.showGhost;
    });
    document.getElementById("toggle-view")!.addEventListener("click", () => {
      this.setView(renderer.is3d ? "2d" : "3d");
    });
    document.getElementById("toggle-theme")!.addEventListener("click", () => {
      this.setTheme(preferences.theme === "dark" ? "light" : "dark");
    });
    document.getElementById("settings-open")!.addEventListener("click", () => {
      if (!this.settingsDialog.open) this.settingsDialog.showModal();
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-theme-choice]",
    )) {
      button.addEventListener("click", () =>
        this.setTheme(button.dataset.themeChoice as ThemeMode),
      );
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-view-choice]",
    )) {
      button.addEventListener("click", () =>
        this.setView(button.dataset.viewChoice as ViewMode),
      );
    }
    document.getElementById("reset-keybinds")!.addEventListener("click", () => {
      preferences.keybinds = { ...DEFAULT_KEYBINDS };
      savePreferences(preferences);
      this.renderKeybinds();
    });
    this.keybindGrid.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-keybind-action]",
      );
      if (button) this.captureKeybind(button);
    });

    if (window.matchMedia("(max-width: 760px)").matches) this.closeSidebar();
    this.renderKeybinds();
    this.setTheme(preferences.theme, false);
    this.syncSettingsState();
  }

  update(snap: SimSnapshot): void {
    const time = snap.simTimeSec % DAY_SEC;
    const hh = String(Math.floor(time / 3600)).padStart(2, "0");
    const mm = String(Math.floor((time % 3600) / 60)).padStart(2, "0");
    this.setAnimatedText(this.clockDay, "Day " + snap.day);
    this.setAnimatedText(this.clockTime, hh + ":" + mm);
    this.setAnimatedText(
      this.capitalBalance,
      formatMoney(snap.economy.capitalBalance),
    );
    this.setAnimatedText(
      this.operatingBalance,
      formatMoney(snap.economy.operatingBalance),
    );
    this.setAnimatedText(
      this.currentCashflow,
      formatSignedMoney(snap.economy.projectedDailyCashflow),
    );
    const positiveCashflow = snap.economy.projectedDailyCashflow >= 0;
    this.cashflowStat.classList.toggle("positive", positiveCashflow);
    this.cashflowStat.classList.toggle("negative", !positiveCashflow);
    if (this.trendIcon) {
      this.setText(this.trendIcon, positiveCashflow ? "↗" : "↘");
    }
    this.setAnimatedText(
      this.activePassengers,
      snap.passengers.size.toLocaleString(),
    );

    this.setAnimatedText(
      this.kpiBoardings,
      snap.kpis.boardingsToday.toLocaleString(),
    );
    let waiting = 0;
    for (const station of snap.stations.values()) waiting += station.waiting.length;
    this.setAnimatedText(this.statWaiting, waiting.toLocaleString());
    this.setAnimatedText(
      this.statCompleted,
      snap.kpis.completedTrips.toLocaleString(),
    );
    this.setAnimatedText(
      this.statUnserved,
      snap.kpis.unservedTrips.toLocaleString(),
    );
    this.setAnimatedText(this.statStations, String(snap.stations.size));
    this.setAnimatedText(this.statLines, String(snap.lines.size));
    this.setAnimatedText(
      this.statCongestion,
      snap.traffic.congestionIndex + "/100",
    );
    this.setAnimatedText(
      this.statTransitShare,
      Math.round(snap.traffic.transitShare * 100) + "%",
    );
    this.setAnimatedText(
      this.statCarTrips,
      snap.traffic.carTripsToday.toLocaleString(),
    );
    this.setAnimatedText(
      this.statGateways,
      snap.traffic.connectedGateways + "/" + snap.traffic.totalGateways,
    );
    this.setAnimatedText(
      this.statNoise,
      snap.environment.networkNoiseIndex + "/100",
    );
    this.setAnimatedText(
      this.statEmissions,
      compactNumber(snap.environment.emissionsKgToday) + " kg",
    );
    let totalLength = 0;
    for (const line of snap.lines.values()) totalLength += line.length;
    this.setAnimatedText(
      this.statLength,
      (totalLength / 1_000).toFixed(1) + " km",
    );

    const hasYesterday = snap.kpis.boardingsYesterday > 0;
    this.kpiYesterday.classList.toggle("hidden", !hasYesterday);
    if (hasYesterday) {
      this.setText(
        this.kpiYesterday,
        "yesterday " + snap.kpis.boardingsYesterday.toLocaleString(),
      );
    }

    for (const button of this.speedButtons) {
      button.classList.toggle(
        "active",
        Number(button.dataset.speed) === this.game.speedIndex,
      );
    }
    this.modeInspect.classList.toggle("active", this.game.mode === "inspect");
    this.modeBuild.classList.toggle("active", this.game.mode === "build");
    this.modeFleet.classList.toggle("active", this.game.mode === "fleet");
    this.overviewOptions.classList.toggle(
      "hidden",
      this.game.mode === "build" || this.game.mode === "fleet",
    );
    this.buildOptions.classList.toggle("hidden", this.game.mode !== "build");
    this.fleetOptions.classList.toggle("hidden", this.game.mode !== "fleet");
    // Panel visibility is the player's choice alone — `collapsed`, driven by
    // the toggle and the restore button. It used to *also* be forced closed
    // whenever the mode was "inspect", which is both the startup mode and
    // the one the Inspect button selects. Since #overview-options is shown
    // in every mode except build and fleet, that made the Network-pulse
    // readout, the hub builders and the map-layer toggles reachable only
    // during the brief "place" mode. The same block re-hid #sidebar-restore
    // every frame, so once the panel was closed in inspect mode there was no
    // way left to reopen it.
    this.setText(
      this.sidebarKicker,
      this.game.mode === "build"
        ? "Engineering desk"
        : this.game.mode === "fleet"
          ? "Rolling stock"
          : this.game.mode === "place"
            ? "Site acquisition"
            : "Network command",
    );
    this.setText(
      this.sidebarTitle,
      this.game.mode === "build"
        ? "Construction"
        : this.game.mode === "fleet"
          ? "Pool & line assignments"
          : this.game.mode === "place"
            ? "Place a mobility hub"
            : "Houston system",
    );

    for (const button of this.serviceButtons) {
      button.classList.toggle(
        "active",
        button.dataset.transitMode === this.game.buildTransitMode,
      );
    }
    for (const button of this.alignmentButtons) {
      button.classList.toggle(
        "active",
        button.dataset.alignment === this.game.buildAlignment,
      );
    }
    for (const button of this.directionButtons) {
      button.classList.toggle(
        "active",
        button.dataset.direction === this.game.buildDirection,
      );
    }
    this.alignmentPicker.classList.toggle(
      "unavailable",
      this.game.buildTransitMode !== "metro",
    );
    this.depthPicker.classList.toggle(
      "unavailable",
      this.game.buildTransitMode !== "metro" ||
        this.game.buildAlignment !== "underground",
    );
    const depth = Math.abs(this.game.buildLevelM);
    this.depthInput.value = String(depth || 16);
    this.setText(this.depthValue, (depth || 16) + " m");
    for (const button of this.facilityButtons) {
      button.classList.toggle(
        "active",
        this.game.mode === "place" &&
          button.dataset.facilityType === this.game.activeFacilityType,
      );
    }

    const estimate = this.game.getDraftEstimate();
    const overBudget = estimate.totalCost > snap.economy.capitalBalance;
    this.setText(this.buildCost, formatMoney(estimate.totalCost));
    this.setText(
      this.buildBreakdown,
      this.game.draft.length < 2
        ? "Place two stations to price the route"
        : (estimate.lengthM / 1_000).toFixed(1) +
          " km · " +
          estimate.newStations +
          " new stations",
    );
    this.setText(
      this.estimateDemolition,
      estimate.demolishedBuildings +
        " building" +
        (estimate.demolishedBuildings === 1 ? "" : "s"),
    );
    this.setText(
      this.estimateNoise,
      estimate.averageNoiseDb > 0
        ? Math.round(estimate.averageNoiseDb) + " dB"
        : "—",
    );
    this.setText(this.estimateDepth, estimate.averageDepthM.toFixed(0) + " m");
    this.setText(
      this.buildAffordability,
      overBudget
        ? "Over budget"
        : this.game.draft.length >= 2
          ? "Fundable"
          : "Planning",
    );
    this.buildAffordability.classList.toggle("over-budget", overBudget);
    this.finishBtn.disabled = overBudget || this.game.draft.length < 2;
    this.undoBtn.disabled = this.game.draft.length === 0;
    this.setText(
      this.blueprintBtn,
      this.game.blueprinting ? "Stop blueprint" : "Start blueprint",
    );
    this.blueprintBtn.classList.toggle("active", this.game.blueprinting);
    this.blueprintBtn.setAttribute(
      "aria-pressed",
      String(this.game.blueprinting),
    );

    // The crosshair and the live hint belong to drawing, not to having the
    // panel open.
    document.body.classList.toggle("is-building", this.game.blueprinting);
    document.body.classList.toggle("is-placing", this.game.mode === "place");
    this.updateLayerAndViewControls();
    this.updateFleet(snap);
    this.updateContextHint();
    this.updateFocusPanel(snap);
  }

  private updateFleet(snap: SimSnapshot): void {
    // Everything below writes into #fleet-options, which is `.hidden` in
    // every other mode. Running it anyway cost two filter passes, a spread
    // and a join over every vehicle, sixty times a second, into a subtree
    // nobody could see.
    if (this.game.mode !== "fleet") return;

    const pool = snap.vehicles.filter((vehicle) => vehicle.lineId === null);
    this.setText(
      this.fleetOwned,
      snap.vehicles.length + " owned · " + pool.length + " available",
    );
    const lines = [...snap.lines.values()];
    const selectKey = lines
      .map((line) => line.id + ":" + line.name)
      .join("|");
    if (selectKey !== this.fleetSelectKey) {
      this.fleetLineSelect.innerHTML =
        lines.length === 0
          ? '<option value="">Build a line first</option>'
          : lines
              .map(
                (line) =>
                  '<option value="' +
                  line.id +
                  '">' +
                  line.name +
                  " · " +
                  getTransitModeSpec(line.mode).shortLabel +
                  "</option>",
              )
              .join("");
      this.fleetSelectKey = selectKey;
    }
    if (
      this.game.selection?.kind === "line" &&
      snap.lines.has(this.game.selection.id)
    ) {
      this.fleetLineSelect.value = String(this.game.selection.id);
    }
    if (!this.fleetLineSelect.value && lines[0]) {
      this.fleetLineSelect.value = String(lines[0].id);
    }

    const line = snap.lines.get(Number(this.fleetLineSelect.value));
    const fleet = line
      ? snap.vehicles.filter((vehicle) => vehicle.lineId === line.id)
      : [];
    const required =
      line && fleet.length > 0 && line.headwaySec > 0
        ? Math.max(
            1,
            Math.ceil(
              (fleet.length * line.headwaySec) / line.targetHeadwaySec,
            ),
          )
        : 1;
    // Guarded because assigning innerHTML runs the HTML parser and rebuilds
    // the subtree even when the string is identical.
    const summaryKey = line
      ? `${line.id}|${line.direction}|${fleet.length}|${line.headwaySec}|${required}`
      : "none";
    if (summaryKey !== this.fleetSummaryKey) {
      this.fleetSummaryKey = summaryKey;
      this.fleetLineSummary.innerHTML = line
        ? "<strong>" +
          line.name +
          "</strong> · " +
          (line.direction === "bidirectional" ? "two-way" : "one-way") +
          "<br>" +
          (fleet.length === 0
            ? "No service — assign a compatible vehicle from the pool."
            : fleet.length +
              " assigned · " +
              formatDuration(line.headwaySec) +
              " actual headway · " +
              required +
              " needed for target")
        : "Buy vehicles into the pool now, then assign them after a line is built.";
    }

    const balanceBucket = Math.floor(
      snap.economy.capitalBalance / 100_000,
    );
    const catalogKey =
      (line?.id ?? 0) +
      "|" +
      (line?.mode ?? "none") +
      "|" +
      snap.vehicles
        .map((vehicle) => `${vehicle.id}:${vehicle.modelId}:${vehicle.lineId ?? "pool"}`)
        .join(",") +
      "|" +
      (line?.headwaySec ?? 0) +
      "|" +
      balanceBucket;
    if (catalogKey === this.fleetCatalogKey) return;
    const poolCards = pool.length
      ? pool
          .map((vehicle) => {
            const stock = getRollingStockSpec(vehicle.modelId);
            const compatible = line?.mode === stock.mode;
            return (
              '<article class="fleet-card fleet-card-compact">' +
              '<div class="fleet-card-head"><span><h3>' +
              vehicle.name +
              '</h3><span class="maker">' +
              stock.capacity +
              " seats · " +
              stock.energyType +
              "</span></span>" +
              (line
                ? '<button type="button" data-assign-vehicle="' +
                  vehicle.id +
                  '"' +
                  (compatible ? "" : " disabled") +
                  ">" +
                  (compatible ? "Assign" : "Incompatible") +
                  "</button>"
                : '<span class="pool-badge">Available</span>') +
              "</div></article>"
            );
          })
          .join("")
      : '<p class="empty-pool">No unassigned vehicles. Buy one below.</p>';
    const assignedCards = line
      ? fleet.length
        ? fleet
            .map((vehicle) => {
              const stock = getRollingStockSpec(vehicle.modelId);
              return (
                '<article class="fleet-card fleet-card-compact assigned-card">' +
                '<div class="fleet-card-head"><span><h3>' +
                vehicle.name +
                '</h3><span class="maker">' +
                vehicle.onboard.length +
                "/" +
                stock.capacity +
                " passengers · " +
                Math.round(vehicle.conditionPct) +
                "% condition</span></span>" +
                '<button type="button" data-unassign-vehicle="' +
                vehicle.id +
                '">Return</button></div></article>'
              );
            })
            .join("")
        : '<p class="empty-pool">No vehicles assigned to this line.</p>'
      : "";
    const purchaseCards = ROLLING_STOCK_CATALOG
      .map((stock) => {
        const affordable =
          stock.purchaseCost <= snap.economy.capitalBalance;
        const energyUnit =
          stock.energyType === "electricity" ? "kWh/km" : "L/km";
        return (
          '<article class="fleet-card">' +
          '<div class="fleet-card-head"><span>' +
          "<h3>" +
          stock.name +
          '</h3><span class="maker">' +
          stock.maker +
          " · " +
          stock.energyType +
          "</span></span>" +
          '<strong class="fleet-price">' +
          formatMoney(stock.purchaseCost) +
          "</strong></div>" +
          '<div class="fleet-specs">' +
          "<span><small>Capacity</small><strong>" +
          stock.capacity +
          "</strong></span>" +
          "<span><small>Speed</small><strong>" +
          stock.maxSpeedKph +
          " km/h</strong></span>" +
          "<span><small>Energy</small><strong>" +
          stock.energyPerKm +
          " " +
          energyUnit +
          "</strong></span>" +
          "<span><small>Noise</small><strong>" +
          stock.noiseDb +
          " dB</strong></span>" +
          "</div>" +
          '<button type="button" data-buy-model="' +
          stock.id +
          '"' +
          (affordable ? "" : " disabled") +
          ">" +
          (affordable
            ? "Buy to pool · " + stock.reliabilityPct + "% reliable"
            : "Over capital budget") +
          "</button></article>"
        );
      })
      .join("");
    this.fleetCatalog.innerHTML =
      '<h3 class="fleet-group-title">Unassigned pool</h3>' +
      poolCards +
      (line
        ? '<h3 class="fleet-group-title">Assigned to ' +
          line.name +
          "</h3>" +
          assignedCards
        : "") +
      '<h3 class="fleet-group-title">Purchase vehicles</h3>' +
      purchaseCards;
    this.fleetCatalogKey = catalogKey;
  }

  /**
   * The status bar under the map.
   *
   * The reference design has no permanent hint bar, and the restyle hid it
   * outright — which also silenced every message the game had to give the
   * player. "This route is over the available capital budget", "Bus stops
   * must connect through the visible road network" and the rest were all
   * being written to a `display: none` element, so a failed action simply
   * did nothing with no explanation.
   *
   * So the bar now earns its place: hidden while it would only state the
   * obvious, shown whenever there is something to say. `.has-notice` marks
   * the case that matters and gets the accent treatment.
   */
  private updateContextHint(): void {
    const notice = this.game.lastNotice;
    const text = notice ?? this.ambientHint();
    this.setText(this.contextHint, text ?? "");
    this.contextHintBar.classList.toggle("visible", text !== null);
    this.contextHintBar.classList.toggle("has-notice", notice !== null);
  }

  /**
   * The non-urgent "here is what to do next" line, or null when the current
   * mode speaks for itself and the bar should stay out of the way.
   */
  private ambientHint(): string | null {
    if (this.game.mode === "place" && this.game.activeFacilityType) {
      const spec = FACILITY_SPECS[this.game.activeFacilityType];
      return (
        "Place " +
        spec.label.toLowerCase() +
        " · " +
        formatMoney(spec.cost) +
        " · Esc cancels"
      );
    }
    if (this.game.mode === "fleet" || this.game.mode === "inspect") {
      return null;
    }
    if (this.game.mode !== "build") return null;
    if (!this.game.blueprinting) return null;

    const engineering =
      this.game.buildAlignment === "underground"
        ? Math.abs(this.game.buildLevelM) + " m tunnel"
        : this.game.buildAlignment;
    return this.game.draft.length === 0
      ? "Place the first " +
          getTransitModeSpec(this.game.buildTransitMode).shortLabel.toLowerCase() +
          " station · " +
          engineering
      : this.game.draft.length === 1
        ? "Place one more station to create a service"
        : "Keep drawing · Enter opens infrastructure · fleet is purchased separately";
  }

  private updateFocusPanel(snap: SimSnapshot): void {
    if (this.game.mode !== "inspect") {
      this.focusPanel.classList.add("hidden");
      this.focusKey = "";
      return;
    }
    const selection = this.game.selection;
    if (!selection) {
      this.focusPanel.classList.add("hidden");
      this.focusKey = "";
      return;
    }
    this.focusPanel.classList.remove("hidden");

    if (selection.kind === "station") {
      const station = snap.stations.get(selection.id);
      if (!station) return;
      const key =
        "station|" +
        station.id +
        "|" +
        station.waiting.length +
        "|" +
        station.boardingsToday +
        "|" +
        station.lineIds.join(",");
      if (key === this.focusKey) return;
      const badges = station.lineIds
        .map((id) => snap.lines.get(id))
        .filter((line) => line !== undefined)
        .map(
          (line) =>
            '<span class="line-badge" style="background:' +
            line.color +
            '">' +
            line.name +
            "</span>",
        )
        .join("");
      this.focusPanel.innerHTML =
        focusHeader("Station details", station.name) +
        '<div class="focus-body">' +
        '<div class="focus-hero"><strong>' +
        station.waiting.length.toLocaleString() +
        "</strong><span>passengers waiting now</span></div>" +
        '<section class="detail-section"><h3>Services</h3>' +
        '<div class="line-badges">' +
        (badges || '<span class="stat-sub">No lines</span>') +
        "</div></section>" +
        '<section class="detail-section"><h3>Station engineering</h3>' +
        detailRow(
          "Structure",
          alignmentLabel(station.primaryAlignment, station.levelM),
        ) +
        detailRow(
          "Platforms",
          station.platformCount + " · " + station.platformLengthM + " m",
        ) +
        detailRow("Street entrances", String(station.entrances)) +
        detailRow(
          "Boardings today",
          station.boardingsToday.toLocaleString(),
        ) +
        "</section></div>";
      this.focusKey = key;
      return;
    }

    if (selection.kind === "line") {
      const line = snap.lines.get(selection.id);
      if (!line) return;
      const fleet = snap.vehicles.filter(
        (vehicle) => vehicle.lineId === line.id,
      );
      const onboard = fleet.reduce(
        (sum, vehicle) => sum + vehicle.onboard.length,
        0,
      );
      const key =
        "line|" +
        line.id +
        "|" +
        line.vehicleIds.length +
        "|" +
        onboard +
        "|" +
        line.stats.boardingsToday +
        "|" +
        Math.round(line.stats.energyCostToday) +
        "|" +
        Math.round(line.stats.maintenanceCostToday);
      if (key === this.focusKey) return;
      const segments = line.segmentDetails
        .map(
          (segment) =>
            '<div class="segment-row"><strong>Segment ' +
            (segment.index + 1) +
            " · " +
            alignmentLabel(segment.alignment, segment.levelM) +
            "</strong><span>" +
            (segment.lengthM / 1_000).toFixed(1) +
            " km</span><small>" +
            segment.speedLimitKph +
            " km/h · " +
            segment.noiseDb.toFixed(0) +
            " dB · " +
            segment.demolishedBuildings +
            " demolitions · " +
            formatMoney(
              segment.constructionCost + segment.demolitionCost,
            ) +
            "</small></div>",
        )
        .join("");
      const vehicles = fleet
        .map((vehicle) => {
          const stock = getRollingStockSpec(vehicle.modelId);
          return (
            '<div class="vehicle-row"><strong>' +
            vehicle.name +
            "</strong><span>" +
            vehicle.onboard.length +
            "/" +
            vehicle.capacity +
            "</span><small>" +
            stock.energyType +
            " · " +
            vehicle.energyUsedToday.toFixed(1) +
            " units today · " +
            vehicle.conditionPct.toFixed(1) +
            "% condition</small></div>"
          );
        })
        .join("");
      this.focusPanel.innerHTML =
        focusHeader("Route details", line.name, line.color) +
        '<div class="focus-body">' +
        '<div class="focus-hero"><strong>' +
        onboard.toLocaleString() +
        "</strong><span>on board · " +
        (fleet.length === 0
          ? "service not operating"
          : formatDuration(line.headwaySec) + " headway") +
        "</span></div>" +
        '<section class="detail-section"><h3>Operations</h3>' +
        detailRow(
          "Direction",
          line.direction === "bidirectional" ? "Two-way" : "One-way",
        ) +
        detailRow("Stations", String(line.stationIds.length)) +
        detailRow("Length", (line.length / 1_000).toFixed(1) + " km") +
        detailRow("Fleet", fleet.length + " assigned") +
        detailRow(
          "Boardings today",
          line.stats.boardingsToday.toLocaleString(),
        ) +
        detailRow("Fare revenue", formatMoney(line.stats.revenueToday)) +
        detailRow(
          "Operating cost",
          formatMoney(
            line.stats.energyCostToday + line.stats.maintenanceCostToday,
          ),
        ) +
        "</section>" +
        '<section class="detail-section"><h3>Track engineering</h3>' +
        '<div class="segment-list">' +
        segments +
        "</div></section>" +
        '<section class="detail-section"><h3>Assigned vehicles</h3>' +
        '<div class="vehicle-list">' +
        (vehicles ||
          '<span class="stat-sub">No rolling stock assigned</span>') +
        "</div>" +
        '<button class="focus-action" type="button" data-manage-fleet>Open fleet procurement</button></section>' +
        "</div>";
      this.focusKey = key;
      return;
    }

    const facility = snap.facilities.find(
      (item) => item.id === selection.id,
    );
    if (!facility) return;
    const key =
      "facility|" + facility.id + "|" + String(facility.connected);
    if (key === this.focusKey) return;
    const spec = FACILITY_SPECS[facility.type];
    this.focusPanel.innerHTML =
      focusHeader("Mobility hub", facility.name, spec.color) +
      '<div class="focus-body">' +
      '<div class="focus-hero"><strong>' +
      facility.dailyCapacity.toLocaleString() +
      "</strong><span>passengers per day capacity</span></div>" +
      '<section class="detail-section"><h3>Facility</h3>' +
      detailRow("Type", spec.label) +
      detailRow("Code", facility.code ?? "Player built") +
      detailRow(
        "Ownership",
        facility.builtIn ? "Existing facility" : "Authority owned",
      ) +
      detailRow(
        "Network link",
        facility.connected ? "Connected" : "Needs nearby station",
      ) +
      detailRow(
        "Outside region",
        facility.connectsOutside ? "Yes" : "Local only",
      ) +
      "</section></div>";
    this.focusKey = key;
  }

  private updateLayerAndViewControls(): void {
    const toggles: Array<[HTMLElement, boolean]> = [
      [this.toggleTraffic, this.renderer.showTraffic],
      [this.toggleDemand, this.renderer.showDemand],
      [this.toggleGhost, this.renderer.showGhost],
    ];
    for (const [button, active] of toggles) {
      button.classList.toggle("active", active);
      // classList.toggle is a real no-op when the state already matches, but
      // setAttribute always re-sets the node and re-notifies the
      // accessibility tree — so it needs the guard classList does not.
      const pressed = String(active);
      if (button.getAttribute("aria-pressed") !== pressed) {
        button.setAttribute("aria-pressed", pressed);
      }
    }
    this.setText(this.viewToggleLabel, this.renderer.is3d ? "3D" : "2D");
    document.body.classList.toggle("is-3d", this.renderer.is3d);
    this.preferences.viewMode = this.renderer.is3d ? "3d" : "2d";
    this.syncSettingsState();
  }

  private setTheme(theme: ThemeMode, persist = true): void {
    this.preferences.theme = theme;
    document.body.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        theme === "light" ? "#ffffff" : "#000000",
      );
    this.renderer.setTheme(theme);
    if (persist) savePreferences(this.preferences);
    this.syncSettingsState();
  }

  private setView(view: ViewMode): void {
    this.preferences.viewMode = view;
    this.renderer.set3dMode(view === "3d");
    savePreferences(this.preferences);
    this.syncSettingsState();
  }

  private syncSettingsState(): void {
    // Both lists are static markup in the settings dialog, so they are
    // collected once in the constructor. This runs from update(), and the
    // two whole-document querySelectorAll calls it used to make were the
    // most expensive DOM work in the per-frame path.
    for (const button of this.themeChoiceButtons) {
      button.classList.toggle(
        "active",
        button.dataset.themeChoice === this.preferences.theme,
      );
    }
    for (const button of this.viewChoiceButtons) {
      button.classList.toggle(
        "active",
        button.dataset.viewChoice ===
          (this.renderer.is3d ? "3d" : "2d"),
      );
    }
  }

  private renderKeybinds(): void {
    this.keybindGrid.innerHTML = (
      Object.keys(KEYBIND_LABELS) as InputAction[]
    )
      .map(
        (action) =>
          '<div class="keybind-row"><span>' +
          KEYBIND_LABELS[action] +
          '</span><button type="button" data-keybind-action="' +
          action +
          '">' +
          displayInputKey(this.preferences.keybinds[action]) +
          "</button></div>",
      )
      .join("");
  }

  /**
   * Arm a keybind button to take the next keypress.
   *
   * Explicitly removes its own listener rather than relying on `once`, which
   * only fires *after* a capture completes. Two consequences of that, both
   * real: pressing Escape to dismiss the dialog was swallowed and rebound
   * `cancel` to Escape with no way to refuse, and arming a second button
   * left the first listener alive forever — `stopImmediatePropagation`
   * blocked it, so it never fired, so `once` never removed it, and it sat
   * waiting to eat some later unrelated keypress.
   */
  private captureKeybind(button: HTMLButtonElement): void {
    if (button.classList.contains("recording")) return;
    this.cancelKeybindCapture();

    const action = button.dataset.keybindAction as InputAction;
    const previous = this.preferences.keybinds[action];
    button.classList.add("recording");
    button.textContent = "Press key";

    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.cancelKeybindCapture();

      // Escape means "never mind", not "bind Escape". It is also the key
      // that closes the dialog, so binding it here would be a trap.
      if (event.key === "Escape") {
        this.renderKeybinds();
        return;
      }

      const next = normalizeInputKey(event.key);
      const conflictingAction = (
        Object.keys(this.preferences.keybinds) as InputAction[]
      ).find(
        (candidate) =>
          candidate !== action &&
          normalizeInputKey(this.preferences.keybinds[candidate]) === next,
      );
      if (conflictingAction) {
        this.preferences.keybinds[conflictingAction] = previous;
      }
      this.preferences.keybinds[action] = next;
      savePreferences(this.preferences);
      this.renderKeybinds();
    };

    this.pendingKeybindCapture = capture;
    window.addEventListener("keydown", capture, { capture: true });
  }

  /** Disarm a pending capture, if any. Safe to call when none is armed. */
  private cancelKeybindCapture(): void {
    if (!this.pendingKeybindCapture) return;
    window.removeEventListener("keydown", this.pendingKeybindCapture, {
      capture: true,
    });
    this.pendingKeybindCapture = null;
  }

  private closeSidebar(): void {
    this.sidebar.classList.add("collapsed");
    this.sidebarRestore.classList.remove("hidden");
    this.sidebarToggle.setAttribute("aria-expanded", "false");
  }

  private openSidebar(): void {
    this.sidebar.classList.remove("collapsed");
    this.sidebarRestore.classList.add("hidden");
    this.sidebarToggle.setAttribute("aria-expanded", "true");
  }

  /**
   * Write text only when it actually changed.
   *
   * `textContent =` is never a no-op: it tears down the node's children and
   * inserts a fresh text node every time, so the unguarded writes scattered
   * through update() were doing that roughly a thousand times a second for
   * strings that mostly never change. Same guard as setAnimatedText, without
   * the flourish — for labels that should not flash on every frame.
   */
  private setText(element: Element, value: string): void {
    if (element.textContent !== value) element.textContent = value;
  }

  private setAnimatedText(element: Element, value: string): void {
    if (element.textContent === value) return;
    element.textContent = value;
    if (this.reducedMotion) return;
    element.animate(
      [
        { opacity: 0.55, transform: "translateY(2px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }
}

function focusHeader(
  kicker: string,
  title: string,
  color?: string,
): string {
  return (
    '<header class="focus-head"><div><span class="eyebrow"' +
    (color ? ' style="color:' + color + '"' : "") +
    ">" +
    kicker +
    "</span><h2>" +
    title +
    '</h2></div><button class="icon-btn" type="button" data-close-focus aria-label="Close details">' +
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="m5 5 10 10M15 5 5 15" /></svg>' +
    "</button></header>"
  );
}

function detailRow(label: string, value: string): string {
  return (
    '<div class="detail-row"><span>' +
    label +
    "</span><strong>" +
    value +
    "</strong></div>"
  );
}

function alignmentLabel(
  alignment: RailAlignment,
  levelM: number,
): string {
  if (alignment === "underground") {
    return "Tunnel · " + Math.abs(levelM).toFixed(0) + " m deep";
  }
  if (alignment === "elevated") {
    return "Elevated · " + levelM.toFixed(0) + " m";
  }
  return "Surface";
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "No service";
  if (seconds < 90) return Math.round(seconds) + " sec";
  return Math.round(seconds / 60) + " min";
}

function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return (value / 1_000_000).toFixed(1) + "M";
  }
  if (Math.abs(value) >= 1_000) {
    return (value / 1_000).toFixed(1) + "K";
  }
  return Math.round(value).toLocaleString();
}

function formatSignedMoney(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  return sign + formatMoney(Math.abs(value));
}

function formatMoney(value: number): string {
  const sign = value < 0 ? "−" : "";
  const amount = Math.abs(value);
  if (amount >= 1_000_000_000) {
    return sign + "$" + (amount / 1_000_000_000).toFixed(2) + "B";
  }
  if (amount >= 1_000_000) {
    return sign + "$" + (amount / 1_000_000).toFixed(1) + "M";
  }
  if (amount >= 1_000) {
    return sign + "$" + (amount / 1_000).toFixed(0) + "K";
  }
  return sign + "$" + Math.round(amount).toLocaleString();
}
