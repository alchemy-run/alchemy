/**
 * Theme mode — deliberately OUTSIDE the zustand document store (module
 * state + useSyncExternalStore) so flipping the theme never touches the
 * render-doctrine-critical document/layout slices.
 *
 * All colors flip via CSS custom properties on [data-theme]; the ONLY
 * JS consumers of the resolved theme are React Flow's `colorMode` prop
 * and the TopBar toggle. Everything else themes for free.
 *
 * Modes: "light" | "dark" | "auto" (auto = prefers-color-scheme, and
 * live-updates when the system theme changes). Persisted under
 * localStorage["alchemy-dashboard-theme"]; index.html applies the same
 * resolution pre-paint so there is never a flash.
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

export interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

const STORAGE_KEY = "alchemy-dashboard-theme";

/** Browser-chrome tint per theme — matches --alc-bg in tokens.css. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#f5efe3",
  dark: "#14110d",
};

const media =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined;

const readStored = (): ThemeMode => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto";
  } catch {
    return "auto";
  }
};

const resolve = (mode: ThemeMode): ResolvedTheme =>
  mode === "auto" ? (media?.matches ? "dark" : "light") : mode;

// Snapshot identity only changes when (mode, resolved) actually changes,
// as useSyncExternalStore requires.
let state: ThemeState = { mode: readStored(), resolved: resolve(readStored()) };

const listeners = new Set<() => void>();

const applyToDocument = (resolved: ResolvedTheme): void => {
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[resolved]);
};

const update = (mode: ThemeMode): void => {
  const resolved = resolve(mode);
  if (state.mode === mode && state.resolved === resolved) {
    return;
  }
  state = { mode, resolved };
  applyToDocument(resolved);
  for (const listener of listeners) {
    listener();
  }
};

/** Set + persist the theme mode ("auto" clears to system preference). */
export const setThemeMode = (mode: ThemeMode): void => {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private mode etc. — theme still applies for this session
  }
  update(mode);
};

// Live-update while in "auto" when the system theme flips.
media?.addEventListener("change", () => update(state.mode));

// Follow changes made from another tab/window.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      update(readStored());
    }
  });
  // index.html's pre-paint script already set data-theme; re-apply so the
  // meta tag and dataset agree with the parsed mode even if storage held
  // an unexpected value.
  applyToDocument(state.resolved);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): ThemeState => state;

/**
 * The one theme hook. `resolved` is what React Flow's `colorMode` must
 * consume; `mode` is what the toggle displays; `setMode` cycles it.
 */
export const useThemeMode = (): ThemeState & {
  setMode: (mode: ThemeMode) => void;
} => {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, setMode: setThemeMode };
};
