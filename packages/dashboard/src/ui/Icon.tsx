import type { UIProviderService } from "alchemy/UI/UIProvider";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { CATEGORY_ICONS } from "../theme.ts";

/**
 * Resolve a UIProvider's icon: custom component > lucide name > category
 * default > generic box.
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
  if (ui?.icon && typeof ui.icon !== "string") {
    const Custom = ui.icon;
    return <Custom size={size} color={color} />;
  }
  const name =
    (typeof ui?.icon === "string" ? ui.icon : undefined) ??
    (ui?.category ? CATEGORY_ICONS[ui.category] : undefined) ??
    "box";
  return (
    <DynamicIcon
      name={name as IconName}
      size={size}
      color={color}
      fallback={() => <DynamicIcon name="box" size={size} color={color} />}
    />
  );
}
