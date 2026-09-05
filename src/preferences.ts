export type ThemeMode = "dark" | "light";
export type ViewMode = "2d" | "3d";
export type InputAction =
  | "pause"
  | "build"
  | "cycleAlignment"
  | "rotateStationLeft"
  | "rotateStationRight"
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
  rotateStationLeft: "q",
  rotateStationRight: "e",
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
  rotateStationLeft: "Rotate station left (hold)",
  rotateStationRight: "Rotate station right (hold)",
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
  // An action can end up unbound when a new default collides with a key the
  // player had already rebound. The button still opens a capture.
  if (key === "") return "—";
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
      keybinds: mergeKeybinds(saved.keybinds),
    };
  } catch {
    return fallback;
  }
}

/**
 * A saved profile wins over the defaults, and a default whose key that profile
 * has already claimed is dropped rather than left as a duplicate. A new action
 * shipping with a default key an existing player had rebound elsewhere would
 * otherwise put two actions on one key, and the reverse lookup in `input.ts`
 * would silently pick whichever came first.
 */
function mergeKeybinds(
  saved: Partial<Record<InputAction, string>> | undefined,
): Record<InputAction, string> {
  const merged = { ...DEFAULT_KEYBINDS, ...(saved ?? {}) };
  if (!saved) return merged;
  const claimed = new Set(
    Object.values(saved).map((key) => normalizeInputKey(key)),
  );
  for (const action of Object.keys(merged) as InputAction[]) {
    if (action in saved) continue;
    if (claimed.has(normalizeInputKey(merged[action]))) merged[action] = "";
  }
  return merged;
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage may be disabled in a private or embedded browser. Preferences
    // still work for the current session through the live object.
  }
}

