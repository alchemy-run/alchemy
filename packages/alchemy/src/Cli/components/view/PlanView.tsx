/** @jsxImportSource react */
/**
 * THE plan renderer. Every surface that shows a plan tree — `alchemy plan`
 * output, the approval prompt, and the live apply/dev/destroy progress —
 * renders through this one state-driven component, so a plan always looks
 * the same wherever it appears.
 *
 * - One {@link PlanViewStore} holds the flattened tree (namespaces,
 *   resources, bindings, actions) plus per-row runtime state (apply status
 *   and the row's latest log message), updated from engine
 *   {@link ApplyEvent}s.
 * - Two presentation `mode`s: `review` renders action glyphs (`+ ~ - ±`),
 *   `apply` renders live statuses with spinners and per-row messages.
 * - Two `viewport`s: `full` height or `virtual` (a terminal-sized, line-based
 *   window that follows the active row and supports keyboard scrolling).
 * - Property diffs (`detailed`) render in every mode, and the window is
 *   line-budget aware so multi-line rows never overflow the terminal.
 */
import {
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import { useProgress, useTitle } from "@alchemy.run/sigil";
import {
  Box,
  Row,
  SectionHeading,
  Spinner,
  Status,
  TaskRow,
  Text,
  useBorderStyle,
  useGlyphs,
  useTerminalInput,
  useTerminalSize,
} from "../ui/index.ts";
import type {
  CRUD,
  Plan as AlchemyPlan,
  ActionApply,
  ActionDelete,
} from "../../../Plan.ts";
import type {
  ApplyEvent,
  ApplyStatus,
  ResourceStatusChanged,
} from "../../../Report.ts";
import {
  buildNamespaceTree,
  buildPlanSummary,
  flattenTree,
  type ActionVerb,
  type FlattenedItem,
  type PlanSummaryCounts,
} from "../../NamespaceTree.ts";
import { formatModeNote } from "../../ModeTag.ts";
import { theme } from "../../CliKit/index.ts";
import type { ProviderMode } from "../../../ProviderMode.ts";
import { formatElapsed } from "../../Format.ts";
import {
  actionStyle,
  applyStatusColor,
  isInProgress,
  isTerminalStatus,
} from "./statusStyle.ts";
import {
  matchYamlChange,
  matchYamlKey,
  type DeclaredPropertyYaml,
} from "../../PropertyDiff.ts";
import { NamespaceRow, namespaceStyle } from "./PlanRow.tsx";

// ── Row model ─────────────────────────────────────────────────────────────

export type PlanRow =
  | {
      key: string;
      type: "namespace";
      id: string;
      depth: number;
      action: FlattenedItem["action"];
    }
  | {
      key: string;
      type: "resource";
      id: string;
      resourceType: string;
      depth: number;
      action: CRUD["action"];
      /** For `noop` resources, persisted state status to show instead of `pending`. */
      persistedApplyStatus?: "created" | "updated";
      /** Resolved provider mode; `undefined` for mode-agnostic providers. */
      providerMode?: ProviderMode;
      /** On mode-switch replacements, the old generation's stamped mode. */
      fromProviderMode?: ProviderMode;
      /** Declared property diff, present when the store was built `detailed`. */
      propertyYaml?: DeclaredPropertyYaml;
    }
  | {
      key: string;
      type: "binding";
      /** The binding sid, nested under its host resource. */
      id: string;
      depth: number;
      action: "create" | "update" | "delete" | "noop";
    }
  | {
      key: string;
      type: "task";
      id: string;
      depth: number;
      action: ActionVerb;
    };

type ResourceRow = Extract<PlanRow, { type: "resource" }>;

/** Runtime state of one row: latest apply status + its own log line. */
interface RowState extends Required<
  Pick<ResourceStatusChanged, "id" | "status">
> {
  key: string;
  message?: string;
  /** When the row first went in-progress, for the settled-duration suffix. */
  startedAt?: number;
  /** Wall-clock duration once the row settles. */
  elapsedMs?: number;
}

interface PlanViewState {
  readonly tasks: Map<string, RowState>;
  readonly outcome?: "success" | "failure";
  /** Total apply duration, set when the session settles. */
  readonly elapsedMs?: number;
}

export type { PlanSummaryCounts } from "../../NamespaceTree.ts";

/**
 * Row detail: the latest log/annotation line, painted danger when the row
 * failed so the error reads at the row instead of only in the final dump.
 */
const rowDetail = (status: ApplyStatus, message: string | undefined) =>
  message !== undefined && status === "fail" ? (
    <Text color={theme.color.danger}>{message}</Text>
  ) : (
    message
  );

const getRowKey = (item: FlattenedItem) => item.path.join("/");

const buildRows = (plan: AlchemyPlan, detailed: boolean): PlanRow[] => {
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions).filter(
      (item): item is NonNullable<AlchemyPlan["deletions"][string]> =>
        item !== undefined,
    ),
  ] as CRUD[];
  const taskItems = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ].filter((task): task is ActionApply | ActionDelete => task !== undefined);
  const tree = buildNamespaceTree(items, taskItems);
  return flattenTree(tree, { includePropertyYaml: detailed }).map((item) => {
    if (item.type === "namespace") {
      return {
        key: getRowKey(item),
        type: "namespace" as const,
        id: item.id,
        depth: item.depth,
        action: item.action,
      };
    }
    if (item.type === "binding") {
      return {
        key: getRowKey(item),
        type: "binding" as const,
        id: item.bindingSid ?? item.id,
        depth: item.depth,
        action: item.action as "create" | "update" | "delete" | "noop",
      };
    }
    if (item.type === "action") {
      return {
        key: getRowKey(item),
        type: "task" as const,
        id: item.id,
        depth: item.depth,
        action: item.action as ActionVerb,
      };
    }
    return {
      key: getRowKey(item),
      type: "resource" as const,
      id: item.id,
      resourceType: item.resourceType ?? "Unknown",
      depth: item.depth,
      action: item.action as CRUD["action"],
      providerMode: item.providerMode,
      fromProviderMode: item.fromProviderMode,
      propertyYaml: item.propertyYaml,
      persistedApplyStatus:
        item.action === "noop"
          ? (() => {
              const crud = findCrudByLogicalId(plan, item.id);
              return crud?.action === "noop" ? crud.state.status : undefined;
            })()
          : undefined,
    };
  });
};

const initialResourceState = (row: ResourceRow): RowState => ({
  key: row.key,
  id: row.id,
  status:
    row.action === "noop" ? (row.persistedApplyStatus ?? "created") : "pending",
});

const buildInitialTasks = (rows: PlanRow[]) =>
  new Map(
    rows.flatMap((row): Array<[string, RowState]> => {
      if (row.type === "resource")
        return [[row.key, initialResourceState(row)]];
      if (row.type === "binding") {
        // `noop` bindings render as "no change" from the start.
        return [
          [
            row.key,
            {
              key: row.key,
              id: row.id,
              status: row.action === "noop" ? "created" : "pending",
            },
          ],
        ];
      }
      if (row.type === "task") {
        // `noop` tasks are skipped — render as gray `•` from the start
        // rather than briefly flashing the `ran` cyan styling.
        return [
          [
            row.key,
            {
              key: row.key,
              id: row.id,
              status: row.action === "noop" ? "skipped" : "pending",
            },
          ],
        ];
      }
      return [];
    }),
  );

// ── Store ─────────────────────────────────────────────────────────────────

/**
 * The state behind a rendered plan: the flattened rows plus each row's live
 * status and log message. A static review is simply a store nobody emits to.
 */
export class PlanViewStore {
  readonly rows: PlanRow[];
  readonly summary: PlanSummaryCounts;
  private readonly startedAtMs = Date.now();
  private state: PlanViewState;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly plan: AlchemyPlan,
    options: { detailed?: boolean } = {},
  ) {
    this.rows = buildRows(plan, options.detailed ?? false);
    this.summary = buildPlanSummary(plan);
    this.state = { tasks: buildInitialTasks(this.rows) };
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = () => this.state;

  readonly finish = (outcome: "success" | "failure") => {
    this.state = {
      ...this.state,
      outcome,
      elapsedMs: Date.now() - this.startedAtMs,
    };
    for (const listener of this.listeners) listener();
  };

  emit(event: ApplyEvent) {
    const next = new Map(this.state.tasks);
    const key = event.fqn;
    const now = Date.now();
    // First in-progress status starts the row's clock; the settling status
    // stops it. Renderer-side timing keeps the events themselves pure.
    const timing = (current: RowState | undefined, status: ApplyStatus) => {
      const startedAt =
        current?.startedAt ?? (isInProgress(status) ? now : undefined);
      return {
        startedAt,
        elapsedMs:
          isTerminalStatus(status) && startedAt !== undefined
            ? now - startedAt
            : current?.elapsedMs,
      };
    };

    if (event._tag === "apply.resource.status") {
      if (event.bindingId) {
        // Binding rows key as `<host resource key>/<sid>`.
        const bindingId = event.bindingId;
        const bindingKey = `${key}/${bindingId}`;
        const current = next.get(bindingKey);
        if (current) {
          next.set(bindingKey, {
            key: bindingKey,
            id: bindingId,
            status: event.status,
            message: event.message ?? current.message,
            ...timing(current, event.status),
          });
        }
      } else {
        const current = next.get(key);
        if (current)
          next.set(key, {
            key,
            id: event.id,
            status: event.status,
            message: event.message ?? current.message,
            ...timing(current, event.status),
          });
      }
    } else {
      const current = next.get(key);
      if (current) next.set(key, { ...current, message: event.message });
    }

    this.state = { ...this.state, tasks: next };
    for (const listener of this.listeners) listener();
  }
}

// ── Viewport ──────────────────────────────────────────────────────────────

export type PlanViewport =
  /** Render every row. */
  | "full"
  /** Terminal-sized window that follows the active row; ↑/↓ scroll. */
  | "virtual";

type VirtualPlanLine =
  | { readonly kind: "row"; readonly row: PlanRow }
  | {
      readonly kind: "yaml";
      readonly key: string;
      readonly line: string;
      readonly paddingLeft: number;
    }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly paddingLeft: number;
    };

const virtualPlanLines = (
  rows: ReadonlyArray<PlanRow>,
  detailed: boolean,
): VirtualPlanLine[] =>
  rows.flatMap((row): VirtualPlanLine[] => {
    const lines: VirtualPlanLine[] = [{ kind: "row", row }];
    if (row.type !== "resource") return lines;
    const showYaml = detailed || row.propertyYaml?.kind === "drift";
    if (!showYaml) return lines;
    if (row.propertyYaml !== undefined) {
      lines.push(
        ...row.propertyYaml.lines.map((line, index) => ({
          kind: "yaml" as const,
          key: `${row.key}:yaml:${index}`,
          line,
          paddingLeft: row.depth * 2 + 2,
        })),
      );
    } else if (
      row.action === "update" ||
      row.action === "adopted" ||
      row.action === "replace"
    ) {
      lines.push({
        kind: "note",
        key: `${row.key}:note`,
        paddingLeft: row.depth * 2 + 2,
      });
    }
    return lines;
  });

// ── Component ─────────────────────────────────────────────────────────────

export interface PlanViewProps {
  store: PlanViewStore;
  /** `review` renders action glyphs; `apply` renders live statuses. */
  mode: "review" | "apply";
  /** @default "full" for review, "virtual" for apply */
  viewport?: PlanViewport;
  /** Render property diffs beneath changed resources. */
  detailed?: boolean;
  /** Stage shown in the apply title. */
  stage?: string;
}

export function PlanView(props: PlanViewProps): JSX.Element {
  const { store, mode, detailed = false, stage } = props;
  const viewport = props.viewport ?? (mode === "apply" ? "virtual" : "full");
  const { rows } = store;
  const glyphs = useGlyphs();
  const borderStyle = useBorderStyle();
  const { rows: terminalRows } = useTerminalSize();
  const { tasks, outcome, elapsedMs } = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
  );

  // ── Progress accounting (apply header + sigil progress/title) ─────────
  let completed = 0;
  let failures = 0;
  let noops = 0;
  let workRows = 0;
  for (const row of rows) {
    if (row.type !== "resource" && row.type !== "task") continue;
    const status = tasks.get(row.key)?.status;
    if (row.action !== "noop") {
      workRows++;
      if (status !== undefined && isTerminalStatus(status)) completed++;
    } else {
      noops++;
    }
    if (status === "fail") failures++;
  }
  const failed = outcome === "failure" || failures > 0;
  const finished = outcome !== undefined;

  useProgress(
    mode === "apply"
      ? {
          state: failed
            ? "error"
            : finished || workRows === 0
              ? "inactive"
              : "normal",
          value: workRows === 0 ? undefined : (completed / workRows) * 100,
        }
      : { state: "inactive" },
  );
  const applyLabel =
    workRows === 0 && !failed
      ? "No changes"
      : runLabel(store.plan, failed, finished);
  const titleProgress = finished ? "" : ` ${completed}/${workRows}`;
  useTitle(
    mode === "apply"
      ? stage === undefined
        ? `${applyLabel}${titleProgress}`
        : `${applyLabel}${titleProgress} · ${stage}`
      : undefined,
  );

  // ── Windowing ─────────────────────────────────────────────────────────
  const lineBudget =
    viewport === "virtual"
      ? Math.max(4, terminalRows - 8)
      : Number.POSITIVE_INFINITY;
  const budgetRows =
    lineBudget === Number.POSITIVE_INFINITY
      ? rows.length
      : Math.max(1, Math.floor(lineBudget));
  const expandedLines = useMemo(
    () => virtualPlanLines(rows, detailed),
    [rows, detailed],
  );
  const virtualizing = viewport === "virtual" && !finished;
  const scrollLength = virtualizing ? expandedLines.length : rows.length;
  const maxOffset = Math.max(0, scrollLength - budgetRows);
  const activeRowIndex = rows.findIndex((row) => {
    if (row.type !== "resource" && row.type !== "task") return false;
    const status = tasks.get(row.key)?.status;
    return status !== undefined && !isTerminalStatus(status);
  });
  const activeIndex = virtualizing
    ? expandedLines.findIndex(
        (line) => line.kind === "row" && line.row === rows[activeRowIndex],
      )
    : activeRowIndex;
  const followedOffset = Math.min(
    maxOffset,
    Math.max(
      0,
      (activeIndex < 0 ? rows.length : activeIndex) -
        Math.floor(budgetRows / 3),
    ),
  );
  const [manualOffset, setManualOffset] = useState<number>();
  const offset =
    viewport === "full"
      ? 0
      : Math.min(maxOffset, manualOffset ?? followedOffset);
  const visibleRows = rows;
  const visibleLines = virtualizing
    ? expandedLines.slice(offset, offset + budgetRows)
    : undefined;
  const shownOffset = virtualizing ? offset : 0;
  const hiddenBelow = virtualizing
    ? expandedLines.length - shownOffset - (visibleLines?.length ?? 0)
    : 0;

  useTerminalInput((_input, key) => {
    if (viewport !== "virtual" || finished) return;
    const page = Math.max(1, Math.floor(lineBudget));
    if (key.up)
      setManualOffset((current) => Math.max(0, (current ?? offset) - 1));
    else if (key.down)
      setManualOffset((current) =>
        Math.min(maxOffset, (current ?? offset) + 1),
      );
    else if (key.pageUp)
      setManualOffset((current) => Math.max(0, (current ?? offset) - page));
    else if (key.pageDown)
      setManualOffset((current) =>
        Math.min(maxOffset, (current ?? offset) + page),
      );
    else if (key.home) setManualOffset(0);
    else if (key.end) setManualOffset(undefined);
  });

  // ── Header ────────────────────────────────────────────────────────────
  const summary =
    mode === "apply" ? (
      finished ? (
        <Status
          variant={failed ? "error" : "success"}
          detail={applySummary(completed, workRows, noops, failures, elapsedMs)}
        >
          {applyLabel}
        </Status>
      ) : (
        <Spinner
          label={applyLabel}
          detail={applySummary(completed, workRows, noops, failures)}
        />
      )
    ) : (
      <ReviewSummary summary={store.summary} />
    );

  return (
    <Box flexDirection="column">
      <Box
        marginBottom={1}
        borderStyle={borderStyle}
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.color.muted}
        borderDimColor
      >
        {summary}
      </Box>
      <Box flexDirection="column">
        {shownOffset > 0 ? (
          <Text tone="muted">
            {glyphs.overflowUp} {shownOffset} earlier{" "}
            {virtualizing ? "lines" : "rows"}
          </Text>
        ) : null}
        {visibleLines === undefined
          ? visibleRows.map((row) => (
              <PlanRowView
                key={row.key}
                row={row}
                mode={mode}
                detailed={detailed}
                state={tasks.get(row.key)}
                defaultMode={store.plan.defaultMode}
              />
            ))
          : visibleLines.map((line) =>
              line.kind === "row" ? (
                <PlanRowView
                  key={line.row.key}
                  row={line.row}
                  mode={mode}
                  detailed={detailed}
                  includeYaml={false}
                  state={tasks.get(line.row.key)}
                  defaultMode={store.plan.defaultMode}
                />
              ) : line.kind === "yaml" ? (
                <YamlLine
                  key={line.key}
                  line={line.line}
                  paddingLeft={line.paddingLeft}
                />
              ) : (
                <DetailLine key={line.key} paddingLeft={line.paddingLeft}>
                  <Text tone="muted" dimColor>
                    no declared property changes
                  </Text>
                </DetailLine>
              ),
            )}
        {hiddenBelow > 0 ? (
          <Text tone="muted">
            {glyphs.overflowDown} {hiddenBelow} more{" "}
            {virtualizing ? "lines" : "rows"}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────

function PlanRowView(props: {
  row: PlanRow;
  mode: "review" | "apply";
  detailed: boolean;
  state: RowState | undefined;
  defaultMode: AlchemyPlan["defaultMode"];
  includeYaml?: boolean;
}): JSX.Element {
  const { row, mode, detailed, state, defaultMode, includeYaml = true } = props;
  const glyphs = useGlyphs();

  if (row.type === "namespace") {
    return <NamespaceRow id={row.id} depth={row.depth} action={row.action} />;
  }

  if (row.type === "binding") {
    if (mode === "review") {
      const style =
        row.action === "delete"
          ? { color: theme.color.muted, icon: "delete" as const }
          : namespaceStyle(row.action);
      return (
        <Row gap={1} paddingLeft={row.depth * 2}>
          <Text color={style.color}>{glyphs[style.icon]}</Text>
          <Text
            color={
              row.action === "delete" ? theme.color.muted : theme.color.info
            }
          >
            {row.id}
          </Text>
          {row.action === "delete" ? <Text tone="muted">(unbind)</Text> : null}
        </Row>
      );
    }
    const status: ApplyStatus =
      state?.status ?? (row.action === "noop" ? "created" : "pending");
    const displayStatus =
      row.action === "noop" && (status === "created" || status === "updated")
        ? ("no change" as const)
        : status;
    const color =
      row.action === "delete"
        ? theme.color.muted
        : applyStatusColor(displayStatus);
    const bindingStatus =
      row.action !== "delete"
        ? displayStatus
        : status === "deleted"
          ? "unbound"
          : status === "deleting"
            ? "unbinding"
            : "unbind";
    return (
      <TaskRow
        spinning={isInProgress(status)}
        icon={
          status === "pending"
            ? glyphs.bullet
            : status === "fail"
              ? glyphs.error
              : glyphs.success
        }
        iconColor={color}
        label={
          <Text
            color={
              row.action === "delete" ? theme.color.muted : theme.color.info
            }
          >
            {row.id}
          </Text>
        }
        detail={rowDetail(status, state?.message)}
        depth={row.depth}
      >
        <Text color={color}>{bindingStatus}</Text>
        {state?.elapsedMs === undefined ? null : (
          <Text tone="muted">({formatElapsed(state.elapsedMs)})</Text>
        )}
      </TaskRow>
    );
  }

  if (row.type === "task") {
    if (mode === "review") {
      const style = namespaceStyle(row.action);
      return (
        <TaskRow
          icon={glyphs[style.icon]}
          iconColor={style.color}
          label={row.id}
          depth={row.depth}
        >
          <Text color={theme.color.info}>[action]</Text>
        </TaskRow>
      );
    }
    const status: ApplyStatus =
      state?.status ?? (row.action === "noop" ? "ran" : "pending");
    const color = applyStatusColor(status);
    return (
      <TaskRow
        spinning={isInProgress(status)}
        icon={taskIcon(row.action, status, glyphs)}
        iconColor={color}
        label={row.id}
        detail={rowDetail(status, state?.message)}
        depth={row.depth}
      >
        <Text color={color}>{taskLabel(row.action, status)}</Text>
        <Text color={theme.color.info} dimColor>
          [action]
        </Text>
        {state?.elapsedMs === undefined ? null : (
          <Text tone="muted">({formatElapsed(state.elapsedMs)})</Text>
        )}
      </TaskRow>
    );
  }

  // Resource row.
  const modeNote = formatModeNote({
    mode: row.providerMode,
    priorMode: row.fromProviderMode,
    defaultMode,
  });
  const showYaml =
    includeYaml && (detailed || row.propertyYaml?.kind === "drift");
  const yaml = showYaml ? (
    row.propertyYaml === undefined ? (
      row.action === "update" ||
      row.action === "adopted" ||
      row.action === "replace" ? (
        <DetailLine paddingLeft={row.depth * 2 + 2}>
          <Text tone="muted" dimColor>
            no declared property changes
          </Text>
        </DetailLine>
      ) : null
    ) : (
      row.propertyYaml.lines.map((line, index) => (
        <YamlLine
          key={`${index}:${line}`}
          line={line}
          paddingLeft={row.depth * 2 + 2}
        />
      ))
    )
  ) : null;

  if (mode === "review") {
    const style = namespaceStyle(row.action);
    return (
      <Box flexDirection="column" marginTop={showYaml ? 1 : 0}>
        <TaskRow
          icon={glyphs[style.icon]}
          iconColor={style.color}
          label={
            <Text color={row.action === "noop" ? undefined : style.color}>
              {row.id}
            </Text>
          }
          depth={row.depth}
        >
          {modeNote && <Text tone="muted">({modeNote})</Text>}
          <Text tone="muted">({row.resourceType})</Text>
        </TaskRow>
        {yaml}
      </Box>
    );
  }

  const rowState = state ?? initialResourceState(row);
  const displayStatus = resourceDisplayStatus(row, rowState.status);
  const color = applyStatusColor(displayStatus);
  return (
    <Box flexDirection="column">
      <TaskRow
        spinning={isInProgress(rowState.status)}
        icon={
          rowState.status === "pending"
            ? glyphs.bullet
            : rowState.status === "fail"
              ? glyphs.error
              : rowState.status === "adopted"
                ? glyphs.adopt
                : rowState.status === "orphaned"
                  ? glyphs.orphan
                  : glyphs.success
        }
        iconColor={color}
        label={
          <>
            {row.action === "orphaned" ? (
              <Text tone="muted">{row.id}</Text>
            ) : (
              row.id
            )}{" "}
            <Text tone="muted">({row.resourceType})</Text>
          </>
        }
        detail={rowDetail(rowState.status, rowState.message)}
        depth={row.depth}
      >
        {modeNote ? <Text tone="muted">({modeNote})</Text> : null}
        <Text color={color}>{displayStatus}</Text>
        {rowState.elapsedMs === undefined ? null : (
          <Text tone="muted">({formatElapsed(rowState.elapsedMs)})</Text>
        )}
      </TaskRow>
      {yaml}
    </Box>
  );
}

// ── Headers ───────────────────────────────────────────────────────────────

function ReviewSummary(props: { summary: PlanSummaryCounts }): JSX.Element {
  const { counts, taskCounts, bindingChanges } = props.summary;
  const parts = [
    ...(
      ["create", "update", "adopted", "delete", "orphaned", "replace"] as const
    )
      .filter((action) => counts[action] > 0)
      .map((action) => ({
        key: action,
        label: `${counts[action]} to ${action}`,
        color: namespaceStyle(action).color,
      })),
    ...(taskCounts.run > 0
      ? [
          {
            key: "run",
            label: `${taskCounts.run} to run`,
            color: namespaceStyle("run").color,
          },
        ]
      : []),
    ...(taskCounts.delete > 0
      ? [
          {
            key: "drop",
            label: `${taskCounts.delete} to drop`,
            color: namespaceStyle("delete").color,
          },
        ]
      : []),
    ...(bindingChanges > 0
      ? [
          {
            key: "bindings",
            label: `${bindingChanges} binding changes`,
            color: theme.color.info,
          },
        ]
      : []),
  ];
  return (
    <>
      <SectionHeading>Plan</SectionHeading>
      <Text tone="muted"> · </Text>
      {parts.length === 0 ? (
        <Text tone="muted">no changes</Text>
      ) : (
        parts.map((part, index) => (
          <Box key={part.key}>
            {index === 0 ? null : <Text tone="muted"> · </Text>}
            <Text color={part.color}>{part.label}</Text>
          </Box>
        ))
      )}
    </>
  );
}

const applySummary = (
  completed: number,
  workRows: number,
  noops: number,
  failures: number,
  elapsedMs?: number,
) =>
  `(${completed}/${workRows}) · ${completed} done · ${noops} noop${failures > 0 ? ` · ${failures} failed` : ""}${elapsedMs === undefined ? "" : ` · ${formatElapsed(elapsedMs)}`}`;

const runLabel = (plan: AlchemyPlan, failed: boolean, finished: boolean) => {
  if (failed) {
    if (plan.destroy) return "Destroy failed";
    return plan.defaultMode === "local"
      ? "Dev startup failed"
      : "Deploy failed";
  }
  if (plan.destroy) return finished ? "Stack destroyed" : "Destroying stack";
  if (plan.defaultMode === "local") {
    return finished ? "Dev stack ready" : "Starting dev stack";
  }
  return finished ? "Stack deployed" : "Deploying stack";
};

// ── Status helpers ────────────────────────────────────────────────────────

const resourceDisplayStatus = (
  row: ResourceRow,
  status: ApplyStatus,
): ApplyStatus | "no change" =>
  row.action === "noop" && (status === "created" || status === "updated")
    ? "no change"
    : status;

const taskLabel = (action: ActionVerb, status: ApplyStatus): string =>
  action === "delete"
    ? status === "deleted" || status === "orphaned"
      ? status
      : "drop"
    : status === "ran"
      ? action === "noop"
        ? "skip"
        : "ran"
      : status === "running"
        ? "running"
        : status === "fail"
          ? "fail"
          : action === "noop"
            ? "skip"
            : "run";

/** Static glyph for a task row; the running state renders a spinner instead. */
function taskIcon(
  action: ActionVerb,
  status: ApplyStatus,
  glyphs: ReturnType<typeof useGlyphs>,
): string {
  if (status === "fail") return glyphs.error;
  if (status === "skipped") return glyphs.bullet;
  if (status === "ran")
    return action === "noop" ? glyphs.bullet : glyphs.success;
  if (status === "deleted" || status === "orphaned") return glyphs.success;
  if (action === "delete") return glyphs[actionStyle.delete.icon];
  if (action === "noop") return glyphs[actionStyle.noop.icon];
  return glyphs[actionStyle.run.icon];
}

function YamlLine({
  line,
  paddingLeft,
}: {
  readonly line: string;
  readonly paddingLeft: number;
}) {
  const change = matchYamlChange(line);
  const content = change?.content ?? line;
  const key = matchYamlKey(content);
  const removed = change?.marker === "-";
  const added = change?.marker === "+";
  return (
    <DetailLine
      paddingLeft={paddingLeft}
      backgroundColor={
        removed
          ? theme.color.diffRemoveBackground
          : added
            ? theme.color.diffAddBackground
            : undefined
      }
    >
      <Box width={2} flexShrink={0}>
        <Text color={removed ? theme.color.danger : theme.color.success}>
          {change?.marker ?? " "}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="truncate-end">
          {key === undefined ? (
            content
          ) : (
            <>
              {key.indent}
              <Text color={change === undefined ? theme.color.info : undefined}>
                {key.key}
              </Text>
              {key.value}
            </>
          )}
        </Text>
      </Box>
    </DetailLine>
  );
}

function DetailLine({
  paddingLeft,
  backgroundColor,
  children,
}: {
  readonly paddingLeft: number;
  readonly backgroundColor?: string;
  readonly children: ReactNode;
}) {
  const borderStyle = useBorderStyle();
  return (
    <Box paddingLeft={paddingLeft} width="100%">
      <Box
        width="100%"
        paddingLeft={1}
        borderStyle={borderStyle}
        borderLeft
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={theme.color.muted}
        borderDimColor
        backgroundColor={backgroundColor}
      >
        {children}
      </Box>
    </Box>
  );
}

const findCrudByLogicalId = (
  plan: AlchemyPlan,
  logicalId: string,
): CRUD | undefined => {
  for (const node of Object.values(plan.resources)) {
    if (node.resource.LogicalId === logicalId) {
      return node;
    }
  }
  for (const node of Object.values(plan.deletions)) {
    if (node?.resource.LogicalId === logicalId) {
      return node;
    }
  }
  return undefined;
};

// ── Static convenience ────────────────────────────────────────────────────

export interface PlanProps {
  plan: AlchemyPlan;
  /** Include declared resource inputs as YAML beneath each changed row. */
  detailed?: boolean;
}

/** A static plan review — {@link PlanView} over a store nobody emits to. */
export function Plan({ plan, detailed = false }: PlanProps): JSX.Element {
  const store = useMemo(
    () => new PlanViewStore(plan, { detailed }),
    [plan, detailed],
  );
  return (
    <PlanView store={store} mode="review" detailed={detailed} viewport="full" />
  );
}
