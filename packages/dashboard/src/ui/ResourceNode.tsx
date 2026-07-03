/**
 * The canvas node card (v1 visual design, v2 data flow).
 *
 * React Flow hands this component `data: { fqn }` ONLY — everything else is
 * read from the store via per-fqn subscriptions, so:
 * - a decorate patch re-renders exactly the affected node(s);
 * - clicking re-renders 2 nodes (old + new selection);
 * - a filter keystroke only re-renders nodes whose dimmed flag flips.
 *
 * History overlay: `useNode` is overlay-aware (structure is always live,
 * decoration comes from the selected deployment when one is open), so
 * flipping through past deployments recolors cards with zero layout change.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ResourceUIContext } from "alchemy/UI/UIProvider";
import { Loader2 } from "lucide-react";
import { memo, useMemo } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "../layout/elkGraph.ts";
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
import { safeUI, uiCtxOf, useRegistry } from "../uiRegistry.ts";
import { useIsDimmed, useIsSelected, useMeta, useNode } from "../store.ts";
import { ResourceIcon } from "./Icon.tsx";

export type CanvasNode = Node<{ fqn: string }, "resource">;

export { NODE_HEIGHT, NODE_WIDTH };

export const ResourceNode = memo(function ResourceNode({
  data,
}: NodeProps<CanvasNode>) {
  const { fqn } = data;
  const { node, decoration } = useNode(fqn);
  const selected = useIsSelected(fqn);
  const dimmed = useIsDimmed(fqn);
  const meta = useMeta();
  const registry = useRegistry();

  // live overlay wins over the structural baseline
  const status = decoration?.status ?? node?.status ?? "unknown";
  const ui = node !== undefined ? registry?.get(node.type) : undefined;

  // UIProvider hooks are pure functions of the ctx — memoized on the node's
  // structural identity + decoration-driven status, so they re-run only
  // when THIS node's slice changes (the component itself is memo'd and
  // renders only on its own subscriptions).
  const ctx = useMemo<ResourceUIContext | undefined>(
    () => (node === undefined ? undefined : uiCtxOf(node, status, meta)),
    [node, status, meta],
  );
  const summary = useMemo(
    () =>
      ui?.summary !== undefined && ctx !== undefined
        ? safeUI(() => ui.summary?.(ctx))
        : undefined,
    [ui, ctx],
  );
  const link = useMemo(
    () =>
      ui?.link !== undefined && ctx !== undefined
        ? safeUI(() => ui.link?.(ctx))
        : undefined,
    [ui, ctx],
  );

  if (node === undefined || ctx === undefined) {
    // transient: the flow-node array still holds an fqn a structure-replace
    // just retired; the next commit removes it
    return null;
  }

  const Card = ui?.Card;
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? "#8b8b96";
  const plan = decoration?.planAction ?? node.planAction;
  const result = decoration?.applyResult;
  const note = decoration?.note;
  const hidden = decoration?.hidden === true;
  const planColor = plan ? PLAN_COLORS[plan] : undefined;
  const resultColor = result ? RESULT_COLORS[result] : undefined;
  // terminated / declared-only resources render "dead": gray dashed shell
  const ghost =
    node.ghost !== undefined || result === "deleted" || status === "deleted";

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
        borderStyle: status === "pending" || ghost ? "dashed" : "solid",
        boxShadow: selected ? `0 0 0 1px ${color}` : undefined,
        // filter dimming is decoration-only: layout and viewport never move
        opacity:
          dimmed || hidden
            ? 0.2
            : ghost
              ? 0.55
              : plan === "delete"
                ? 0.8
                : undefined,
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
        {statusInFlight(status) ? (
          <Loader2
            size={13}
            className="ml-auto shrink-0 animate-spin"
            style={{ color: statusColor(status) }}
            aria-label={status}
          />
        ) : (
          <span
            className="ml-auto h-2 w-2 shrink-0 rounded-full"
            style={{ background: statusColor(status) }}
            title={status}
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
      {note && statusInFlight(status) && (
        <div
          className="mt-1 truncate text-[10.5px] text-amber-300/90"
          title={note}
        >
          {note}
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
});
