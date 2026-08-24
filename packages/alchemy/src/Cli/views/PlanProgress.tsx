/** @jsxImportSource react */
import { useState, useSyncExternalStore, type JSX } from "react";
import { useProgress, useTitle } from "@alchemy.run/sigil";
import {
  Box,
  Spinner,
  Status,
  TaskRow,
  Text,
  useBorderStyle,
  useGlyphs,
  useTerminalInput,
  useTerminalSize,
} from "../CliKit/components.ts";
import type { CRUD, Plan, ActionApply, ActionDelete } from "../../Plan.ts";
import type { ApplyEvent, ApplyStatus, StatusChangeEvent } from "../Event.ts";
import {
  buildNamespaceTree,
  flattenTree,
  type FlattenedItem,
  type ActionVerb,
} from "../NamespaceTree.ts";
import { formatModeNote } from "../ModeTag.ts";
import { theme } from "../CliKit/index.ts";
import type { ProviderMode } from "../../ProviderMode.ts";
import { actionStyle, applyStatusColor, isInProgress } from "./statusStyle.ts";
import { NamespaceRow } from "./PlanRow.tsx";

interface PlanTask extends Required<Pick<StatusChangeEvent, "id" | "status">> {
  key: string;
  message?: string;
}

interface PlanProgressProps {
  store: PlanProgressStore;
  stage?: string;
}

interface PlanProgressState {
  readonly tasks: Map<string, PlanTask>;
  readonly outcome?: "success" | "failure";
}

type PlanItem = CRUD | NonNullable<Plan["deletions"][string]>;

export type ProgressRow =
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
    }
  | {
      key: string;
      type: "task";
      id: string;
      depth: number;
      action: ActionVerb;
    };

const getTaskKey = (item: FlattenedItem) => item.path.join("/");

type ResourceProgressRow = Extract<ProgressRow, { type: "resource" }>;

export const buildProgressRows = (plan: Plan): ProgressRow[] => {
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions).filter(
      (item): item is NonNullable<Plan["deletions"][string]> =>
        item !== undefined,
    ),
  ] as PlanItem[];
  const taskItems = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ].filter((task): task is ActionApply | ActionDelete => task !== undefined);
  const tree = buildNamespaceTree(items, taskItems);
  return flattenTree(tree)
    .filter((item) => item.type !== "binding")
    .map((item) => {
      if (item.type === "namespace") {
        return {
          key: getTaskKey(item),
          type: "namespace" as const,
          id: item.id,
          depth: item.depth,
          action: item.action,
        };
      }
      if (item.type === "action") {
        return {
          key: getTaskKey(item),
          type: "task" as const,
          id: item.id,
          depth: item.depth,
          action: item.action as ActionVerb,
        };
      }
      return {
        key: getTaskKey(item),
        type: "resource" as const,
        id: item.id,
        resourceType: item.resourceType ?? "Unknown",
        depth: item.depth,
        action: item.action as CRUD["action"],
        providerMode: item.providerMode,
        fromProviderMode: item.fromProviderMode,
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

const buildLogicalIdIndex = (rows: ProgressRow[]) => {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    if (row.type !== "resource" && row.type !== "task") continue;
    const keys = index.get(row.id);
    if (keys) {
      keys.push(row.key);
    } else {
      index.set(row.id, [row.key]);
    }
  }
  return index;
};

const toPlanTask = (row: ResourceProgressRow): PlanTask => ({
  key: row.key,
  id: row.id,
  status:
    row.action === "noop" ? (row.persistedApplyStatus ?? "created") : "pending",
});

const buildInitialTasks = (rows: ProgressRow[]) =>
  new Map(
    rows.flatMap((row) =>
      row.type === "resource"
        ? [[row.key, toPlanTask(row)]]
        : row.type === "task"
          ? [
              [
                row.key,
                {
                  key: row.key,
                  id: row.id,
                  // `noop` tasks are skipped — render as gray `•` from the start
                  // rather than briefly flashing the `ran` cyan styling.
                  status:
                    row.action === "noop"
                      ? ("skipped" as ApplyStatus)
                      : ("pending" as ApplyStatus),
                },
              ],
            ]
          : [],
    ),
  );

export class PlanProgressStore {
  readonly rows: ProgressRow[];
  private readonly logicalIdIndex: Map<string, string[]>;
  private state: PlanProgressState;
  private readonly listeners = new Set<() => void>();

  constructor(readonly plan: Plan) {
    this.rows = buildProgressRows(plan);
    this.logicalIdIndex = buildLogicalIdIndex(this.rows);
    this.state = { tasks: buildInitialTasks(this.rows) };
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = () => this.state;

  readonly finish = (outcome: "success" | "failure") => {
    this.state = { ...this.state, outcome };
    for (const listener of this.listeners) listener();
  };

  emit(event: ApplyEvent) {
    const next = new Map(this.state.tasks);
    const keys = this.logicalIdIndex.get(event.id) ?? [];

    if (event.kind === "status-change") {
      if (!event.bindingId) {
        for (const key of keys) {
          const current = next.get(key);
          next.set(key, {
            key,
            id: event.id,
            status: event.status,
            message: event.message ?? current?.message,
          });
        }
      }
    } else {
      for (const key of keys) {
        const current = next.get(key);
        if (!current) continue;
        next.set(key, { ...current, message: event.message });
      }
    }

    this.state = { ...this.state, tasks: next };
    for (const listener of this.listeners) listener();
  }
}

const runLabel = (plan: Plan, failed: boolean, finished: boolean) => {
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

export function PlanProgress(props: PlanProgressProps): JSX.Element {
  const { store, stage } = props;
  const { plan, rows } = store;
  const glyphs = useGlyphs();
  const borderStyle = useBorderStyle();
  const { rows: terminalRows } = useTerminalSize();
  const { tasks, outcome } = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
  );
  const taskRows = [] as Array<(typeof rows)[number]>;
  let completed = 0;
  let failures = 0;
  let noops = 0;
  for (const row of rows) {
    if (row.type !== "resource" && row.type !== "task") continue;
    const status = tasks.get(row.key)?.status;
    if (row.action !== "noop") {
      taskRows.push(row);
      if (status !== undefined && isTerminalStatus(status)) completed++;
    } else {
      noops++;
    }
    if (status === "fail") failures++;
  }
  const failed = outcome === "failure" || failures > 0;
  const finished = outcome !== undefined;
  useProgress({
    state: failed
      ? "error"
      : finished || taskRows.length === 0
        ? "inactive"
        : "normal",
    value:
      taskRows.length === 0 ? undefined : (completed / taskRows.length) * 100,
  });
  const label =
    taskRows.length === 0 && !failed
      ? "No changes"
      : runLabel(plan, failed, finished);
  const summary = `(${completed}/${taskRows.length}) · ${completed} done · ${noops} noop${failures > 0 ? ` · ${failures} failed` : ""}`;
  const titleProgress = finished ? "" : ` ${completed}/${taskRows.length}`;
  useTitle(
    stage === undefined
      ? `${label}${titleProgress}`
      : `${label}${titleProgress} · ${stage}`,
  );
  const visibleRowCount = Math.max(4, terminalRows - 8);
  const maxOffset = Math.max(0, rows.length - visibleRowCount);
  const activeIndex = rows.findIndex((row) => {
    if (row.type !== "resource" && row.type !== "task") return false;
    const status = tasks.get(row.key)?.status;
    return status !== undefined && !isTerminalStatus(status);
  });
  const followedOffset = Math.min(
    maxOffset,
    Math.max(
      0,
      (activeIndex < 0 ? rows.length : activeIndex) -
        Math.floor(visibleRowCount / 3),
    ),
  );
  const [manualOffset, setManualOffset] = useState<number>();
  const offset = Math.min(maxOffset, manualOffset ?? followedOffset);
  const visibleRows = rows.slice(offset, offset + visibleRowCount);
  const renderedRows = finished ? rows : visibleRows;

  useTerminalInput((_input, key) => {
    if (finished) return;
    if (key.up)
      setManualOffset((current) => Math.max(0, (current ?? offset) - 1));
    else if (key.down)
      setManualOffset((current) =>
        Math.min(maxOffset, (current ?? offset) + 1),
      );
    else if (key.pageUp)
      setManualOffset((current) =>
        Math.max(0, (current ?? offset) - visibleRowCount),
      );
    else if (key.pageDown)
      setManualOffset((current) =>
        Math.min(maxOffset, (current ?? offset) + visibleRowCount),
      );
    else if (key.home) setManualOffset(0);
    else if (key.end) setManualOffset(undefined);
  });

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
        {finished ? (
          <Status variant={failed ? "error" : "success"} detail={summary}>
            {label}
          </Status>
        ) : (
          <Spinner label={label} detail={summary} />
        )}
      </Box>
      <Box flexDirection="column">
        {!finished && offset > 0 ? (
          <Text tone="muted">
            {glyphs.overflowUp} {offset} earlier rows
          </Text>
        ) : null}
        {renderedRows.map((row) => {
          if (row.type === "namespace") {
            return (
              <NamespaceRow
                key={row.key}
                id={row.id}
                depth={row.depth}
                action={row.action}
              />
            );
          }

          if (row.type === "task") {
            const t = tasks.get(row.key);
            const status: ApplyStatus =
              t?.status ?? (row.action === "noop" ? "ran" : "pending");
            const color = applyStatusColor(status);
            const icon = taskIcon(row.action, status, glyphs);
            const label =
              row.action === "delete"
                ? status === "deleted" || status === "retained"
                  ? status
                  : "drop"
                : status === "ran"
                  ? row.action === "noop"
                    ? "skip"
                    : "ran"
                  : status === "running"
                    ? "running"
                    : status === "fail"
                      ? "fail"
                      : row.action === "noop"
                        ? "skip"
                        : "run";

            return (
              <Box key={row.key} flexDirection="column">
                <TaskRow
                  spinning={isInProgress(status)}
                  icon={icon}
                  iconColor={color}
                  label={row.id}
                  detail={t?.message}
                  depth={row.depth}
                >
                  <Text color={color}>{label}</Text>
                  <Text color={theme.color.info} dimColor>
                    [action]
                  </Text>
                </TaskRow>
              </Box>
            );
          }

          const task = tasks.get(row.key) ?? toPlanTask(row);
          const displayStatus = getDisplayStatus(row, task.status);
          const color = applyStatusColor(displayStatus);
          const running = isInProgress(task.status);
          const modeNote = formatModeNote({
            mode: row.providerMode,
            priorMode: row.fromProviderMode,
            defaultMode: plan.defaultMode,
          });

          return (
            <Box key={row.key} flexDirection="column">
              <TaskRow
                spinning={running}
                icon={
                  task.status === "pending"
                    ? glyphs.bullet
                    : task.status === "fail"
                      ? glyphs.error
                      : glyphs.success
                }
                iconColor={color}
                label={
                  <>
                    {task.id} <Text tone="muted">({row.resourceType})</Text>
                  </>
                }
                detail={task.message}
                depth={row.depth}
              >
                {modeNote ? <Text tone="muted">({modeNote})</Text> : null}
                <Text color={color}>{displayStatus}</Text>
              </TaskRow>
            </Box>
          );
        })}
        {!finished && offset + visibleRows.length < rows.length ? (
          <Text tone="muted">
            {glyphs.overflowDown} {rows.length - offset - visibleRows.length}{" "}
            more rows
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

const isTerminalStatus = (status: ApplyStatus): boolean =>
  status === "created" ||
  status === "updated" ||
  status === "deleted" ||
  status === "retained" ||
  status === "replaced" ||
  status === "ran" ||
  status === "skipped" ||
  status === "fail";

function getDisplayStatus(
  row: ResourceProgressRow,
  status: ApplyStatus,
): ApplyStatus | "no change" {
  if (row.action === "noop" && (status === "created" || status === "updated")) {
    return "no change";
  }

  return status;
}

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
  if (status === "deleted" || status === "retained") return glyphs.success;
  if (action === "delete") return glyphs[actionStyle.delete.icon];
  if (action === "noop") return glyphs[actionStyle.noop.icon];
  return glyphs[actionStyle.run.icon];
}

const findCrudByLogicalId = (
  plan: Plan,
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
