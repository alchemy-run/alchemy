import type { ListGroup } from "alchemy/Dashboard/Projections";
import { memo, useMemo } from "react";
import { Search, X } from "lucide-react";
import {
  dashboardStore,
  isDimmed,
  setFilter,
  setSelectedFqn,
  useApproval,
  useDeploymentStartedAt,
  useFilter,
  useFilterCounts,
  useIsSelected,
  useMeta,
  useNode,
  useProjection,
} from "../store.ts";
import {
  badgeStyle,
  CHIP,
  chipStyle,
  CLOUD_COLORS,
  cloudOf,
  EYEBROW,
  NEUTRAL_COLOR,
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
  serviceOf,
  statusColor,
  SUNK_INPUT,
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
  failed: "var(--alc-danger)",
  "in-flight": "var(--alc-warn)",
  pending: "var(--alc-muted)",
  completed: "var(--alc-success)",
  other: "var(--alc-muted)",
};

/**
 * The List view: structure nodes grouped by effective status in pipeline
 * order (the `listGroupsOf` projection). Group membership comes from the
 * projection; each row then subscribes to its OWN fqn's node/decoration
 * slice, so a decorate patch re-renders exactly that row.
 */
export const ListView = memo(function ListView() {
  const groups = useProjection("list");
  const filter = useFilter();

  // the filter REMOVES rows here (unlike the canvas, which dims); empty
  // groups disappear with their rows
  const visibleGroups = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (query === "") {
      return groups;
    }
    const state = dashboardStore.getState();
    return groups
      .map((group) => ({
        ...group,
        nodes: group.nodes.filter((node) => !isDimmed(state, node.fqn)),
      }))
      .filter((group) => group.nodes.length > 0);
  }, [groups, filter]);

  if (groups.length === 0) {
    return (
      <p className="p-8 text-center font-serif text-[15px] text-[var(--alc-fg-3)]">
        This stack defines no resources
      </p>
    );
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <FilterBar />
      {visibleGroups.length === 0 && (
        <p className="p-8 text-center font-serif text-[15px] text-[var(--alc-fg-3)]">
          No resources match the filter
        </p>
      )}
      {visibleGroups.map((group) => (
        <section key={group.group}>
          <h2 className={`${EYEBROW} mb-2 flex items-center gap-2`}>
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: GROUP_COLORS[group.group] }}
            />
            {GROUP_LABELS[group.group]}
            <span className="text-[var(--alc-fg-4)]">{group.nodes.length}</span>
          </h2>
          <div className="overflow-hidden rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] bg-[var(--alc-bg-elev-1)] shadow-[var(--alc-shadow-sm)]">
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
  const approval = useApproval();
  const deployStartedAt = useDeploymentStartedAt();
  const meta = useMeta();
  const registry = useRegistry();

  const rawStatus = decoration?.status ?? node?.status ?? "unknown";
  // deleted tasks are excluded from the destroy story (see ResourceNode)
  const status =
    node?.kind === "action" &&
    (rawStatus === "deleting" || rawStatus === "deleted")
      ? (node?.status ?? "unknown")
      : rawStatus;
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
  const applyResult =
    node.kind === "action" && decoration?.applyResult === "deleted"
      ? undefined
      : decoration?.applyResult;
  const planAction = node.planAction ?? decoration?.planAction;
  // pending plan wins over the PREVIOUS run's result (see ResourceNode);
  // a result from the CURRENT run takes over as each row completes
  const resultIsFresh =
    applyResult !== undefined &&
    deployStartedAt !== undefined &&
    (decoration?.resultAt ?? 0) >= deployStartedAt;
  const showPlanChip =
    planAction !== undefined && (approval !== undefined || !resultIsFresh);
  const color = ui?.color ?? CLOUD_COLORS[cloudOf(node.type)] ?? NEUTRAL_COLOR;

  return (
    <button
      onClick={() => setSelectedFqn(fqn)}
      className={`flex w-full items-center gap-3 border-t border-[var(--alc-hairline)] px-4 py-2 text-left text-[12.5px] transition-colors duration-[var(--alc-dur-fast)] first:border-t-0 hover:bg-[var(--alc-bg-elev-2)] ${
        selected ? "bg-[var(--alc-accent-12)]" : ""
      }`}
    >
      <ResourceIcon ui={ui} color={color} size={14} kind={node.kind} />
      <span className="min-w-0">
        <span className="text-[var(--alc-fg-1)]">{node.logicalId}</span>
        {node.path.length > 0 && (
          <span className="ml-2 font-mono text-[11px] text-[var(--alc-fg-4)]">
            {node.path.join("/")}
          </span>
        )}
      </span>
      <span className="hidden text-[var(--alc-fg-3)] sm:inline">
        {ui?.displayName ??
          `${serviceOf(node.type) ? `${serviceOf(node.type)}.` : ""}${typeName(node.type)}`}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {summary !== undefined && (
          <span className="max-w-56 truncate text-[11.5px] text-[var(--alc-fg-3)]">
            {summary}
          </span>
        )}
        {decoration?.note !== undefined && (
          <span
            className="max-w-48 truncate text-[11px] text-[var(--alc-warn)]"
            title={decoration.note}
          >
            {decoration.note}
          </span>
        )}
        {showPlanChip && planAction ? (
          <span
            className={`${CHIP} border`}
            style={badgeStyle(PLAN_COLORS[planAction] ?? NEUTRAL_COLOR)}
            title={`pending: ${planAction}`}
          >
            {PLAN_LABELS[planAction] ?? planAction}
          </span>
        ) : applyResult && resultIsFresh ? (
          <span
            className={CHIP}
            style={chipStyle(RESULT_COLORS[applyResult] ?? NEUTRAL_COLOR)}
          >
            {RESULT_LABELS[applyResult] ?? applyResult}
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

/** List-local filter — the only place resources are filtered by text. */
const FilterBar = memo(function FilterBar() {
  const filter = useFilter();
  const counts = useFilterCounts();
  const active = filter.trim() !== "";
  return (
    <div className="flex items-center gap-3">
      <div className="relative max-w-xs flex-1">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--alc-fg-4)]"
        />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter resources…"
          className={`${SUNK_INPUT} w-full py-1.5 pl-8 pr-8`}
        />
        {active && (
          <button
            onClick={() => setFilter("")}
            title="Clear filter"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--alc-radius-sm)] p-0.5 text-[var(--alc-fg-4)] transition-colors duration-[var(--alc-dur-fast)] hover:bg-[var(--alc-accent-12)] hover:text-[var(--alc-fg-1)]"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {active && (
        <span className="font-mono text-[11px] text-[var(--alc-fg-4)]">
          {counts.shown} of {counts.total}
        </span>
      )}
    </div>
  );
});
