export type ThemeMode = "dark" | "light";
export type ViewMode = "2d" | "3d";
export type InputAction =
  | "pause"
  | "build"
  | "cycleAlignment"
  | "finishLine"
  | "cancel"
  | "undo"
  | "toggleDemand"
  | "toggleNetwork"
  | "toggleView"
  | "speedUp"
  | "speedDown";

export interface Preferences {
  theme: ThemeMode;
  viewMode: ViewMode;
  keybinds: Record<InputAction, string>;
}

export const DEFAULT_KEYBINDS: Record<InputAction, string> = {
  pause: " ",
  build: "b",
  cycleAlignment: "a",
  finishLine: "Enter",
  cancel: "Escape",
  undo: "Backspace",
  toggleDemand: "d",
  toggleNetwork: "g",
  toggleView: "v",
  speedUp: "]",
  speedDown: "[",
};

export const KEYBIND_LABELS: Record<InputAction, string> = {
  pause: "Pause / resume",
  build: "Build a line",
  cycleAlignment: "Cycle track level",
  finishLine: "Open drafted line",
  cancel: "Cancel / close",
  undo: "Undo draft point",
  toggleDemand: "Demand layer",
  toggleNetwork: "Reference network",
  toggleView: "2D / 3D view",
  speedUp: "Increase speed",
  speedDown: "Decrease speed",
};

const STORAGE_KEY = "transit-authority-preferences-v2";

export function normalizeInputKey(key: string): string {
  return key.length === 1 && key !== " " ? key.toLowerCase() : key;
}

export function displayInputKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function loadPreferences(): Preferences {
  const fallback: Preferences = {
    theme: "dark",
    viewMode: "3d",
    keybinds: { ...DEFAULT_KEYBINDS },
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: saved.theme === "light" ? "light" : "dark",
      viewMode: saved.viewMode === "2d" ? "2d" : "3d",
      keybinds: {
        ...DEFAULT_KEYBINDS,
        ...(saved.keybinds ?? {}),
      },
    };
  } catch {
    return fallback;
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage may be disabled in a private or embedded browser. Preferences
    // still work for the current session through the live object.
  }
}

