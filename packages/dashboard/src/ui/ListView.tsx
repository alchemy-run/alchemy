import type { UIRegistry } from "alchemy/UI/UIProvider";
import { toCtx } from "../registry.ts";
import {
  CLOUD_COLORS,
  cloudOf,
  PLAN_COLORS,
  PLAN_LABELS,
  serviceOf,
  statusColor,
  typeName,
} from "../theme.ts";
import type { DashboardMeta, DashboardNode } from "../types.ts";
import { ResourceIcon } from "./Icon.tsx";

export function ListView({
  nodes,
  registry,
  meta,
  selected,
  onSelect,
}: {
  nodes: DashboardNode[];
  registry: UIRegistry;
  meta: DashboardMeta;
  selected?: string;
  onSelect: (fqn: string) => void;
}) {
  const sorted = [...nodes].sort((a, b) =>
    a.type === b.type
      ? a.fqn.localeCompare(b.fqn)
      : a.type.localeCompare(b.type),
  );
  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full text-left text-[12.5px]">
        <thead className="sticky top-0 bg-[#0b0b10] text-[11px] uppercase tracking-wider text-zinc-600">
          <tr>
            <th className="px-4 py-2 font-medium">Resource</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Plan</th>
            <th className="px-4 py-2 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((node) => {
            const ui = registry.get(node.type);
            const color =
              ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? "#8b8b96";
            const summary = safe(() => ui?.summary?.(toCtx(node, meta)));
            return (
              <tr
                key={node.fqn}
                onClick={() => onSelect(node.fqn)}
                className={`cursor-pointer border-t border-[#1c1c24] hover:bg-[#15151c] ${
                  node.fqn === selected ? "bg-[#15151c]" : ""
                }`}
              >
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <ResourceIcon ui={ui} color={color} size={14} />
                    <span className="text-zinc-200">{node.logicalId}</span>
                    {node.path.length > 0 && (
                      <span className="text-[11px] text-zinc-600">
                        {node.path.join("/")}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-zinc-500">
                  {ui?.displayName ??
                    `${serviceOf(node.type) ? `${serviceOf(node.type)}.` : ""}${typeName(node.type)}`}
                </td>
                <td className="px-4 py-2">
                  <span
                    className="inline-flex items-center gap-1.5"
                    style={{ color: statusColor(node.status) }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: statusColor(node.status) }}
                    />
                    {node.status}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {node.planAction && (
                    <span
                      className="rounded px-1.5 py-px text-[11px] font-medium"
                      style={{
                        color: PLAN_COLORS[node.planAction],
                        background: `${PLAN_COLORS[node.planAction]}1f`,
                      }}
                    >
                      {PLAN_LABELS[node.planAction] ?? node.planAction}
                    </span>
                  )}
                </td>
                <td className="max-w-64 truncate px-4 py-2 text-zinc-500">
                  {summary ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const safe = <T,>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
