import { useCallback, useEffect, useState } from "react";

/** The operator's pick — `system` follows the OS. */
export type Theme = "light" | "dark" | "system";

/** Read by the pre-paint script in `index.html` too — keep in sync. */
export const THEME_KEY = "alchemy-org:theme";

const isTheme = (value: unknown): value is Theme =>
  value === "light" || value === "dark" || value === "system";

const readTheme = (): Theme => {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isTheme(raw) ? raw : "system";
  } catch {
    return "system";
  }
};

const systemDark = () => matchMedia("(prefers-color-scheme: dark)");

/** What the page actually shows for a pick. */
const resolve = (theme: Theme): "light" | "dark" =>
  theme === "system" ? (systemDark().matches ? "dark" : "light") : theme;

const apply = (theme: Theme) => {
  document.documentElement.classList.toggle("dark", resolve(theme) === "dark");
};

/**
 * Light / dark, remembered in `localStorage` and applied as the `dark`
 * class on `<html>` (Tailwind's `dark:` variant + the CSS tokens key off
 * it). Until the operator picks, the page follows the OS (`system`);
 * `toggle` flips whatever is showing and remembers it. `index.html`
 * applies the remembered pick before the first paint so a dark page
 * never flashes light.
 */
export const useTheme = (): {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
  /** Flip light ⇄ dark from what is currently showing. */
  toggle: () => void;
} => {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [resolved, setResolved] = useState(() => resolve(theme));

  useEffect(() => {
    apply(theme);
    setResolved(resolve(theme));
    if (theme !== "system") return;
    // following the OS: re-apply when it flips
    const media = systemDark();
    const onChange = () => {
      apply("system");
      setResolved(resolve("system"));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage disabled — the pick still holds for this page
    }
  }, []);

  const toggle = useCallback(
    () => setTheme(resolved === "dark" ? "light" : "dark"),
    [resolved, setTheme],
  );

  return { theme, resolved, setTheme, toggle };
};
