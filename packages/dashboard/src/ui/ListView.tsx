import type { ListGroup } from "alchemy/Dashboard/Projections";
import { memo, useMemo } from "react";
import {
  setSelectedFqn,
  useIsDimmed,
  useIsSelected,
  useMeta,
  useNode,
  useProjection,
} from "../store.ts";
import {
  CLOUD_COLORS,
  cloudOf,
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
  serviceOf,
  statusColor,
  typeName,
} from "../theme.ts";
import { safeUI, uiCtxOf, useRegistry } from "../uiRegistry.ts";
import { ResourceIcon } from "./Icon.tsx";

const GROUP_LABELS: Record<ListGroup, string> = {
  failed: "Failed",
  "in-flight": "In flight",
  pending: "Pending",
  completed: "Completed",
  other: "Other",
};

const GROUP_COLORS: Record<ListGroup, string> = {
  failed: "#f87171",
  "in-flight": "#fbbf24",
  pending: "#71717a",
  completed: "#34d399",
  other: "#71717a",
};

/**
 * The List view: structure nodes grouped by effective status in pipeline
 * order (the `listGroupsOf` projection). Group membership comes from the
 * projection; each row then subscribes to its OWN fqn's node/decoration
 * slice, so a decorate patch re-renders exactly that row.
 */
export const ListView = memo(function ListView() {
  const groups = useProjection("list");
  if (groups.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-zinc-600">
        This stack defines no resources
      </p>
    );
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {groups.map((group) => (
        <section key={group.group}>
          <h2 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: GROUP_COLORS[group.group] }}
            />
            {GROUP_LABELS[group.group]}
            <span className="text-zinc-600">{group.nodes.length}</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-[#26262f]">
            {group.nodes.map((node) => (
              <Row key={node.fqn} fqn={node.fqn} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});

/** One resource row — subscribes narrowly to its own fqn's slices. */
const Row = memo(function Row({ fqn }: { fqn: string }) {
  const { node, decoration } = useNode(fqn);
  const selected = useIsSelected(fqn);
  const dimmed = useIsDimmed(fqn);
  const meta = useMeta();
  const registry = useRegistry();

  const status = decoration?.status ?? node?.status ?? "unknown";
  const ui = node !== undefined ? registry?.get(node.type) : undefined;
  const ctx = useMemo(
    () => (node !== undefined ? uiCtxOf(node, status, meta) : undefined),
    [node, status, meta],
  );
  const summary = useMemo(
    () => (ctx !== undefined ? safeUI(() => ui?.summary?.(ctx)) : undefined),
    [ui, ctx],
  );

  if (node === undefined) {
    return null;
  }
  const applyResult = decoration?.applyResult;
  const planAction = node.planAction ?? decoration?.planAction;
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? "#8b8b96";

  return (
    <button
      onClick={() => setSelectedFqn(fqn)}
      className={`flex w-full items-center gap-3 border-t border-[#1c1c24] px-4 py-2 text-left text-[12.5px] first:border-t-0 hover:bg-[#15151c] ${
        selected ? "bg-[#15151c]" : ""
      }`}
      style={dimmed ? { opacity: 0.35 } : undefined}
    >
      <ResourceIcon ui={ui} color={color} size={14} />
      <span className="min-w-0">
        <span className="text-zinc-200">{node.logicalId}</span>
        {node.path.length > 0 && (
          <span className="ml-2 text-[11px] text-zinc-600">
            {node.path.join("/")}
          </span>
        )}
      </span>
      <span className="hidden text-zinc-500 sm:inline">
        {ui?.displayName ??
          `${serviceOf(node.type) ? `${serviceOf(node.type)}.` : ""}${typeName(node.type)}`}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {summary !== undefined && (
          <span className="max-w-56 truncate text-[11.5px] text-zinc-500">
            {summary}
          </span>
        )}
        {decoration?.note !== undefined && (
          <span
            className="max-w-48 truncate text-[11px] text-amber-300/90"
            title={decoration.note}
          >
            {decoration.note}
          </span>
        )}
        {applyResult ? (
          <span
            className="rounded px-1.5 py-px text-[11px] font-medium"
            style={{ color: "#0b0b10", background: RESULT_COLORS[applyResult] }}
          >
            {RESULT_LABELS[applyResult] ?? applyResult}
          </span>
        ) : planAction ? (
          <span
            className="rounded px-1.5 py-px text-[11px] font-medium"
            style={{
              color: PLAN_COLORS[planAction],
              background: `${PLAN_COLORS[planAction]}1f`,
            }}
          >
            {PLAN_LABELS[planAction] ?? planAction}
          </span>
        ) : null}
        <span
          className="inline-flex items-center gap-1.5"
          style={{ color: statusColor(status) }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: statusColor(status) }}
          />
          {status}
        </span>
      </span>
    </button>
  );
});
