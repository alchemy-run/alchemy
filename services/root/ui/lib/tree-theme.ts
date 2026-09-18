import { useResolvedTheme } from "@/lib/theme";
import { themeToTreeStyles } from "@pierre/trees";
import { useMemo } from "react";

/**
 * The file tree wears the APP's own surface — not the code editor's.
 * The theme is built from the live CSS tokens (the same --background,
 * --foreground, --accent the sidebar around it uses), so the tree is
 * indistinguishable from the rest of the chrome in either mode.
 */
const token = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const useTreeStyles = (): Record<string, string> => {
  const mode = useResolvedTheme();
  return useMemo(() => {
    const background = token("--background");
    const foreground = token("--foreground");
    const accent = token("--accent");
    const muted = token("--muted-foreground");
    return {
      ...themeToTreeStyles({
        type: mode,
        colors: {
          "editor.background": background,
          "editor.foreground": foreground,
          "sideBar.background": background,
          "sideBar.foreground": foreground,
          "list.hoverBackground": accent,
          "list.activeSelectionBackground": accent,
          "list.activeSelectionForeground": foreground,
          "list.inactiveSelectionBackground": accent,
          "list.focusBackground": accent,
          "icon.foreground": muted,
          foreground,
        },
      }),
      // themeToTreeStyles has no mapping for icon.foreground, so the
      // tree's muted tone (repo marks, indent guides, decorations)
      // would fall back to the package's gray — hand it the app's
      // muted tan outright
      "--trees-fg-muted-override": muted,
    };
  }, [mode]);
};
