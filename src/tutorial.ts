/**
 * A short, skippable spotlight tour of the main UI regions, shown once on
 * first load and replayable from Settings. It only points and narrates —
 * it never requires the player to perform an action to advance.
 */

const STORAGE_KEY = "transit-authority-tutorial-v1";

export function hasSeenTutorial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTutorialSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage may be disabled in a private or embedded browser. The tour
    // will simply replay next load, which is a harmless fallback.
  }
}

interface TutorialStep {
  targetId: string;
  title: string;
  body: string;
  /**
   * Reveal the target before it is measured/spotlit (e.g. switch mode, open
   * the sidebar). Return true if this triggered a CSS transition the
   * spotlight should wait out before measuring the target's rect.
   */
  onEnter?: () => boolean;
}

const STEPS: TutorialStep[] = [
  {
    targetId: "map",
    title: "Your city",
    body: "This is Houston. Pan and zoom around the map to see the streets, buildings, and demand you're building transit for.",
  },
  {
    targetId: "mode-rail",
    title: "Pick a tool",
    body: "Switch between Inspect, Build, and Fleet here. Inspect looks at what's already running; Build draws new lines; Fleet buys and assigns vehicles.",
    onEnter: () => {
      const inspect = document.getElementById("mode-inspect") as HTMLButtonElement | null;
      if (inspect && !inspect.classList.contains("active")) inspect.click();
      return false;
    },
  },
  {
    targetId: "sidebar",
    title: "Network command",
    body: "Live stats on the network live here, and it becomes the route/construction editor whenever you're in Build mode.",
    onEnter: () => {
      const sidebar = document.getElementById("sidebar");
      const restore = document.getElementById("sidebar-restore") as HTMLButtonElement | null;
      if (sidebar?.classList.contains("collapsed")) {
        restore?.click();
        return true;
      }
      return false;
    },
  },
  {
    targetId: "time-controls",
    title: "Control time",
    body: "Pause, slow down, or fast-forward the simulation while you plan.",
  },
  {
    targetId: "bottom-bar",
    title: "Keep an eye on the books",
    body: "Capital, daily cashflow, active passengers, and operating balance — the numbers that decide whether your network is working.",
  },
  {
    targetId: "top-controls",
    title: "You're set",
    body: "Switch the map view, toggle light/dark theme, or open Settings any time — that's also where you can replay this tour.",
  },
];

export class Tutorial {
  private readonly overlay = document.getElementById("tutorial-overlay")!;
  private readonly spotlight = document.getElementById("tutorial-spotlight")!;
  private readonly tooltip = document.getElementById("tutorial-tooltip")!;
  private readonly stepCount = document.getElementById("tutorial-step-count")!;
  private readonly titleEl = document.getElementById("tutorial-title")!;
  private readonly bodyEl = document.getElementById("tutorial-body")!;
  private readonly backBtn = document.getElementById("tutorial-back") as HTMLButtonElement;
  private readonly nextBtn = document.getElementById("tutorial-next") as HTMLButtonElement;
  private readonly skipBtn = document.getElementById("tutorial-skip") as HTMLButtonElement;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  private stepIndex = 0;
  private active = false;

  private readonly onResize = () => this.positionStep();
  private readonly onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.skip();
  };

  constructor() {
    this.backBtn.addEventListener("click", () => this.back());
    this.nextBtn.addEventListener("click", () => this.next());
    this.skipBtn.addEventListener("click", () => this.skip());
  }

  start(): void {
    this.active = true;
    this.stepIndex = 0;
    this.overlay.classList.remove("hidden");
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeydown);
    this.renderStep();
  }

  private back(): void {
    if (this.stepIndex === 0) return;
    this.stepIndex -= 1;
    this.renderStep();
  }

  private next(): void {
    if (this.stepIndex >= STEPS.length - 1) {
      this.finish();
      return;
    }
    this.stepIndex += 1;
    this.renderStep();
  }

  private skip(): void {
    this.finish();
  }

  private finish(): void {
    this.active = false;
    this.overlay.classList.add("hidden");
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeydown);
    markTutorialSeen();
  }

  private renderStep(): void {
    const step = STEPS[this.stepIndex];
    const transitioning = step.onEnter?.() ?? false;

    this.stepCount.textContent = `${this.stepIndex + 1} / ${STEPS.length}`;
    this.titleEl.textContent = step.title;
    this.bodyEl.textContent = step.body;
    this.backBtn.disabled = this.stepIndex === 0;
    this.nextBtn.textContent = this.stepIndex === STEPS.length - 1 ? "Done" : "Next";

    // .context-panel's open/close slide takes 320ms; wait it out so the
    // sidebar step doesn't measure a rect mid-transition.
    const delay = transitioning && !this.reducedMotion ? 340 : 0;
    window.setTimeout(() => this.positionStep(), delay);
  }

  private positionStep(): void {
    if (!this.active) return;
    const target = document.getElementById(STEPS[this.stepIndex].targetId);
    const rect = target?.getBoundingClientRect();

    if (!rect || (rect.width === 0 && rect.height === 0)) {
      this.spotlight.style.opacity = "0";
    } else {
      const pad = 8;
      this.spotlight.style.opacity = "1";
      this.spotlight.style.left = `${rect.left - pad}px`;
      this.spotlight.style.top = `${rect.top - pad}px`;
      this.spotlight.style.width = `${rect.width + pad * 2}px`;
      this.spotlight.style.height = `${rect.height + pad * 2}px`;
    }

    this.positionTooltip(rect);
  }

  private positionTooltip(rect: DOMRect | undefined): void {
    const margin = 16;
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!rect) {
      this.tooltip.style.left = `${(vw - tw) / 2}px`;
      this.tooltip.style.top = `${(vh - th) / 2}px`;
      this.tooltip.style.opacity = "1";
      return;
    }

    // Try each side of the target in turn and use the first with enough
    // room; a target that spans most of the viewport (e.g. the sidebar)
    // may have no side that fully fits, so fall back to whichever has the
    // most space rather than overlapping the spotlighted element.
    const space = {
      bottom: vh - rect.bottom,
      top: rect.top,
      right: vw - rect.right,
      left: rect.left,
    };
    const fits = {
      bottom: space.bottom >= th + margin,
      top: space.top >= th + margin,
      right: space.right >= tw + margin,
      left: space.left >= tw + margin,
    };
    const order: (keyof typeof space)[] = ["bottom", "right", "top", "left"];
    const placement =
      order.find((side) => fits[side]) ??
      order.reduce((best, side) => (space[side] > space[best] ? side : best));

    let left: number;
    let top: number;
    if (placement === "bottom" || placement === "top") {
      left = rect.left + rect.width / 2 - tw / 2;
      top = placement === "bottom" ? rect.bottom + margin : rect.top - th - margin;
    } else {
      top = rect.top + rect.height / 2 - th / 2;
      left = placement === "right" ? rect.right + margin : rect.left - tw - margin;
    }
    left = Math.max(margin, Math.min(left, vw - tw - margin));
    top = Math.max(margin, Math.min(top, vh - th - margin));

    this.tooltip.style.top = `${top}px`;
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.opacity = "1";
  }
}
