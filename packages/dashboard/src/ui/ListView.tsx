import { LayoutGroup, MotionConfig, motion } from "motion/react";
import { memo, useMemo } from "react";
import { Loader2, Search, X } from "lucide-react";
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
  NEUTRAL_COLOR,
  PLAN_COLORS,
  PLAN_LABELS,
  RESULT_COLORS,
  RESULT_LABELS,
  serviceOf,
  statusColor,
  statusInFlight,
  SUNK_INPUT,
  typeName,
} from "../theme.ts";
import { safeUI, uiCtxOf, useRegistry } from "../uiRegistry.ts";
import { ResourceIcon } from "./Icon.tsx";

// Subtle, shared easing for the whole list: rows FLIP between groups via
// layoutId, sections settle as their contents change. Hoisted so memoized
// rows keep prop identity. MotionConfig reducedMotion="user" turns it all
// off for prefers-reduced-motion.
const ROW_TRANSITION = {
  layout: { type: "tween", duration: 0.28, ease: [0.25, 0.1, 0.25, 1] },
  opacity: { duration: 0.22 },
} as const;
const ROW_INITIAL = { opacity: 0 } as const;
const ROW_ANIMATE = { opacity: 1 } as const;

/**
 * The List view: ONE flat list in a STABLE alphabetical order. Rows never
 * move while a deployment runs — group-by-status was tried and re-bucketed
 * rows on every transition, which read as chaos. Instead each row's
 * indicators (plan chip, spinner, result chip, status color) change in
 * place; motion only eases genuine structural changes (a node entering or
 * leaving the stack).
 */
export const ListView = memo(function ListView() {
  const groups = useProjection("list");
  const filter = useFilter();

  // flatten the projection's groups and impose a stable, state-independent
  // order; the filter REMOVES rows here (unlike the canvas, which dims)
  const rows = useMemo(() => {
    const all = groups.flatMap((group) => group.nodes);
    all.sort(
      (a, b) =>
        a.logicalId.localeCompare(b.logicalId) || a.fqn.localeCompare(b.fqn),
    );
    const query = filter.trim().toLowerCase();
    if (query === "") {
      return all;
    }
    const state = dashboardStore.getState();
    return all.filter((node) => !isDimmed(state, node.fqn));
  }, [groups, filter]);

  if (groups.length === 0) {
    return (
      <p className="p-8 text-center font-serif text-[15px] text-[var(--alc-fg-3)]">
        This stack defines no resources
      </p>
    );
  }
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup>
        <div className="mx-auto max-w-4xl space-y-4 p-6">
          <FilterBar />
          {rows.length === 0 && (
            <p className="p-8 text-center font-serif text-[15px] text-[var(--alc-fg-3)]">
              No resources match the filter
            </p>
          )}
          {rows.length > 0 && (
            <div className="rounded-[var(--alc-radius-lg)] border border-[var(--alc-hairline-2)] bg-[var(--alc-bg-elev-1)] shadow-[var(--alc-shadow-sm)]">
              {rows.map((node) => (
                <Row key={node.fqn} fqn={node.fqn} />
              ))}
            </div>
          )}
        </div>
      </LayoutGroup>
    </MotionConfig>
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
    <motion.button
      layout
      layoutId={fqn}
      initial={ROW_INITIAL}
      animate={ROW_ANIMATE}
      transition={ROW_TRANSITION}
      onClick={() => setSelectedFqn(fqn)}
      className={`flex w-full items-center gap-3 border-t border-[var(--alc-hairline)] px-4 py-2 text-left text-[12.5px] transition-colors duration-[var(--alc-dur-fast)] first:rounded-t-[var(--alc-radius-lg)] first:border-t-0 last:rounded-b-[var(--alc-radius-lg)] hover:bg-[var(--alc-bg-elev-2)] ${
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
          className="inline-flex w-28 items-center gap-1.5"
          style={{ color: statusColor(status) }}
        >
          {statusInFlight(status) ? (
            <Loader2 size={12} className="shrink-0 animate-spin" />
          ) : (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: statusColor(status) }}
            />
          )}
          <span className="truncate">{status}</span>
        </span>
      </span>
    </motion.button>
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
