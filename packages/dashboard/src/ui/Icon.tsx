import type { UIProviderService } from "alchemy/UI/UIProvider";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import type { CSSProperties, ReactNode } from "react";
import { CATEGORY_ICONS, wash } from "../theme.ts";

/**
 * Medallion wash — a soft tint of the icon's own color so third-party
 * brand hexes (AWS orange, Cloudflare amber, …) sit comfortably on the
 * parchment/walnut surfaces. Cached per color: STABLE identity, safe
 * inside memoized React Flow nodes.
 */
const medallionStyleCache = new Map<string, CSSProperties>();
const medallionStyle = (color: string): CSSProperties => {
  let style = medallionStyleCache.get(color);
  if (style === undefined) {
    style = { background: wash(color, 14) };
    medallionStyleCache.set(color, style);
  }
  return style;
};

const MEDALLION =
  "inline-flex shrink-0 items-center justify-center rounded-[var(--alc-radius-sm)] p-[3px]";

/**
 * Resolve a UIProvider's icon: custom component > lucide name > category
 * default > generic box. The icon keeps its registry-provided color and is
 * wrapped in a soft same-hue wash medallion.
 */
export function ResourceIcon({
  ui,
  color,
  size = 16,
}: {
  ui?: UIProviderService;
  color: string;
  size?: number;
}) {
  let icon: ReactNode;
  if (ui?.icon && typeof ui.icon !== "string") {
    const Custom = ui.icon;
    icon = <Custom size={size} color={color} />;
  } else {
    const name =
      (typeof ui?.icon === "string" ? ui.icon : undefined) ??
      (ui?.category ? CATEGORY_ICONS[ui.category] : undefined) ??
      "box";
    icon = (
      <DynamicIcon
        name={name as IconName}
        size={size}
        color={color}
        fallback={() => <DynamicIcon name="box" size={size} color={color} />}
      />
    );
  }
  return (
    <span className={MEDALLION} style={medallionStyle(color)}>
      {icon}
    </span>
  );
}
