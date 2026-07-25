/**
 * DOM UI: floating cards over the map — time controls, the Glance stats card
 * (daily boardings + secondary KPIs, GDD §5.2 reduced to Phase-0 scope), the
 * mode rail, and a minimal read-only Focus panel for the selected station or
 * line (§5.4 in embryo). Foldable cards collapse via a shared `.fold-btn`.
 */
import { DAY_SEC } from "./constants";
import type { Game } from "./game";
import type { SimSnapshot } from "./types";

export class Ui {
  private readonly clock = document.getElementById("clock")!;
  private readonly kpiBoardings = document.querySelector(
    "#kpi-boardings strong",
  )!;
  private readonly kpiYesterday = document.getElementById("kpi-yesterday")!;
  private readonly statWaiting = document.getElementById("stat-waiting")!;
  private readonly statCompleted = document.getElementById("stat-completed")!;
  private readonly statUnserved = document.getElementById("stat-unserved")!;
  private readonly statStations = document.getElementById("stat-stations")!;
  private readonly statLines = document.getElementById("stat-lines")!;
  private readonly statLength = document.getElementById("stat-length")!;
  private readonly speedButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#time-controls button"),
  );
  private readonly modeInspect = document.getElementById(
    "mode-inspect",
  ) as HTMLButtonElement;
  private readonly modeBuild = document.getElementById(
    "mode-build",
  ) as HTMLButtonElement;
  private readonly finishBtn = document.getElementById(
    "btn-finish-line",
  ) as HTMLButtonElement;
  private readonly focusPanel = document.getElementById("focus-panel")!;

  constructor(private readonly game: Game) {
    for (const btn of this.speedButtons) {
      btn.addEventListener("click", () =>
        game.setSpeed(Number(btn.dataset.speed)),
      );
    }
    this.modeInspect.addEventListener("click", () => game.setMode("inspect"));
    this.modeBuild.addEventListener("click", () => game.setMode("build"));
    this.finishBtn.addEventListener("click", () => game.finishLine());

    for (const btn of document.querySelectorAll<HTMLButtonElement>(".fold-btn")) {
      btn.addEventListener("click", () =>
        btn.closest(".float-card")?.classList.toggle("collapsed"),
      );
    }

    const sidebar = document.getElementById("sidebar")!;
    document
      .getElementById("sidebar-toggle")!
      .addEventListener("click", () => sidebar.classList.toggle("collapsed"));
  }

  update(snap: SimSnapshot): void {
    const t = snap.simTimeSec % DAY_SEC;
    const hh = String(Math.floor(t / 3600)).padStart(2, "0");
    const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    this.clock.textContent = `Day ${snap.day} · ${hh}:${mm}`;

    this.kpiBoardings.textContent =
      snap.kpis.boardingsToday.toLocaleString();

    let waiting = 0;
    for (const s of snap.stations.values()) waiting += s.waiting.length;
    this.statWaiting.textContent = waiting.toLocaleString();
    this.statCompleted.textContent = snap.kpis.completedTrips.toLocaleString();
    this.statUnserved.textContent = snap.kpis.unservedTrips.toLocaleString();
    this.statStations.textContent = String(snap.stations.size);
    this.statLines.textContent = String(snap.lines.size);

    let totalLen = 0;
    for (const l of snap.lines.values()) totalLen += l.length;
    this.statLength.textContent = `${(totalLen / 1000).toFixed(1)} km`;

    const hasYesterday = snap.kpis.boardingsYesterday > 0;
    this.kpiYesterday.classList.toggle("hidden", !hasYesterday);
    if (hasYesterday) {
      this.kpiYesterday.textContent =
        `yesterday ${snap.kpis.boardingsYesterday.toLocaleString()}`;
    }

    for (const btn of this.speedButtons) {
      btn.classList.toggle(
        "active",
        Number(btn.dataset.speed) === this.game.speedIndex,
      );
    }
    this.modeInspect.classList.toggle("active", this.game.mode === "inspect");
    this.modeBuild.classList.toggle("active", this.game.mode === "build");
    this.finishBtn.classList.toggle(
      "hidden",
      !(this.game.mode === "build" && this.game.draft.length >= 2),
    );

    this.updateFocusPanel(snap);
  }

  private updateFocusPanel(snap: SimSnapshot): void {
    const sel = this.game.selection;
    if (!sel) {
      this.focusPanel.classList.add("hidden");
      return;
    }
    this.focusPanel.classList.remove("hidden");

    const row = (label: string, value: string) =>
      `<div class="row"><span>${label}</span><span>${value}</span></div>`;

    if (sel.kind === "station") {
      const s = snap.stations.get(sel.id);
      if (!s) return;
      const lineNames = s.lineIds
        .map((id) => snap.lines.get(id)?.name ?? "?")
        .join(", ");
      this.focusPanel.innerHTML =
        `<h3>${s.name}</h3>` +
        row("Waiting now", String(s.waiting.length)) +
        row("Lines", lineNames || "—");
    } else {
      const l = snap.lines.get(sel.id);
      if (!l) return;
      const fleet = snap.vehicles.filter((v) => v.lineId === l.id);
      const onboard = fleet.reduce((n, v) => n + v.onboard.length, 0);
      this.focusPanel.innerHTML =
        `<h3>${l.name}</h3>` +
        row("Stations", String(l.stationIds.length)) +
        row("Length", `${(l.length / 1000).toFixed(1)} km`) +
        row("Headway", `${Math.round(l.headwaySec / 60)} min`) +
        row("Trains", String(fleet.length)) +
        row("On board now", String(onboard));
    }
  }
}
