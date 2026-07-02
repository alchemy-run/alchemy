import type { UIRegistry } from "alchemy/UI/UIProvider";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  CLOUD_COLORS,
  cloudOf,
  PLAN_COLORS,
  PLAN_LABELS,
  serviceOf,
  statusColor,
  statusInFlight,
  typeName,
} from "../theme.ts";
import type { DashboardMeta, DashboardNode } from "../types.ts";
import { toCtx } from "../registry.ts";
import { ResourceIcon } from "./Icon.tsx";

export type CanvasNode = Node<
  {
    node: DashboardNode;
    registry: UIRegistry;
    meta: DashboardMeta;
    selected?: boolean;
  },
  "resource"
>;

export const NODE_WIDTH = 230;
export const NODE_HEIGHT = 80;

export function ResourceNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, registry, meta } = data;
  const ui = registry.get(node.type);
  const ctx = toCtx(node, meta);
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? "#8b8b96";
  const summary = safeCall(() => ui?.summary?.(ctx));
  const link = safeCall(() => ui?.link?.(ctx));
  const Card = ui?.Card;

  const plan = node.planAction;
  const planColor = plan ? PLAN_COLORS[plan] : undefined;

  return (
    <div
      className="rounded-xl border bg-[#15151c] px-3.5 py-2.5 transition-colors"
      style={{
        width: NODE_WIDTH,
        borderColor: selected ? color : (planColor ?? "#2a2a35"),
        borderStyle: node.status === "pending" ? "dashed" : "solid",
        boxShadow: selected ? `0 0 0 1px ${color}` : undefined,
        opacity: plan === "delete" ? 0.75 : undefined,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-[#3f3f4a] !border-none !w-1.5 !h-1.5"
      />
      <div className="flex items-center gap-2">
        <ResourceIcon ui={ui} color={color} size={16} />
        <span className="truncate text-[13px] font-medium text-zinc-100">
          {node.logicalId}
        </span>
        <span
          className={`ml-auto h-2 w-2 shrink-0 rounded-full ${statusInFlight(node.status) ? "status-pulse" : ""}`}
          style={{ background: statusColor(node.status) }}
          title={node.status}
        />
      </div>
      <div className="mt-1 truncate text-[11px] text-zinc-500">
        {serviceOf(node.type)
          ? `${serviceOf(node.type)}.${typeName(node.type)}`
          : typeName(node.type)}
        {summary ? <span className="text-zinc-400"> · {summary}</span> : null}
      </div>
      {Card ? (
        <div className="mt-1.5">
          <Card ctx={ctx} />
        </div>
      ) : link ? (
        <div className="mt-1 truncate text-[11px] text-indigo-400">{link}</div>
      ) : null}
      <div className="flex gap-1">
        {plan && (
          <span
            className="mt-1.5 inline-block rounded px-1.5 py-px text-[10px] font-medium"
            style={{ color: planColor, background: `${planColor}26` }}
          >
            {PLAN_LABELS[plan]}
          </span>
        )}
        {node.bindings.length > 0 && (
          <span className="mt-1.5 inline-block rounded bg-indigo-500/15 px-1.5 py-px text-[10px] text-indigo-300">
            {node.bindings.length} binding{node.bindings.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-[#3f3f4a] !border-none !w-1.5 !h-1.5"
      />
    </div>
  );
}

const safeCall = <T,>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
