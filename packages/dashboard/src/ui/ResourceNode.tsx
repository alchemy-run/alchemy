import type { UIRegistry } from "alchemy/UI/UIProvider";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Loader2 } from "lucide-react";
import {
  CLOUD_COLORS,
  cloudOf,
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
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
  const result = node.applyResult;
  const resultColor = result ? RESULT_COLORS[result] : undefined;
  // terminated resources render "dead": gray dashed shell, dimmed
  const ghost = result === "deleted" || node.status === "deleted";

  return (
    <div
      className="rounded-xl border bg-[#15151c] px-3.5 py-2.5 transition-colors"
      style={{
        width: NODE_WIDTH,
        borderColor: selected
          ? color
          : ghost
            ? "#3f3f46"
            : (resultColor ?? planColor ?? "#2a2a35"),
        borderStyle: node.status === "pending" || ghost ? "dashed" : "solid",
        boxShadow: selected ? `0 0 0 1px ${color}` : undefined,
        opacity: ghost ? 0.55 : plan === "delete" ? 0.8 : undefined,
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
        {statusInFlight(node.status) ? (
          <Loader2
            size={13}
            className="ml-auto shrink-0 animate-spin"
            style={{ color: statusColor(node.status) }}
            aria-label={node.status}
          />
        ) : (
          <span
            className="ml-auto h-2 w-2 shrink-0 rounded-full"
            style={{ background: statusColor(node.status) }}
            title={node.status}
          />
        )}
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
      {node.note && statusInFlight(node.status) && (
        <div
          className="mt-1 truncate text-[10.5px] text-amber-300/90"
          title={node.note}
        >
          {node.note}
        </div>
      )}
      <div className="flex gap-1">
        {result && (
          <span
            className="mt-1.5 inline-block rounded px-1.5 py-px text-[10px] font-medium"
            style={{
              color: "#0b0b10",
              background: resultColor,
            }}
            title={`last deploy: ${result}`}
          >
            {RESULT_LABELS[result]}
          </span>
        )}
        {plan && !result && (
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
