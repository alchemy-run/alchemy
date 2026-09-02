import * as Predicate from "effect/Predicate";
import type { ActionApply, ActionDelete, CRUD, Plan } from "../../../Plan.ts";
import type {
  ApplyEvent,
  ApplyStatus,
  ResourceStatusChanged,
} from "../../../Report.ts";
import type { ProviderMode } from "../../../ProviderMode.ts";
import {
  buildNamespaceTree,
  buildPlanSummary,
  flattenTree,
  type ActionVerb,
  type FlattenedItem,
  type PlanSummaryCounts,
} from "../../NamespaceTree.ts";
import type { DeclaredPropertyYaml } from "../../PropertyDiff.ts";
import { isInProgress, isTerminalStatus } from "./statusStyle.ts";

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
      persistedApplyStatus?: "created" | "updated";
      providerMode?: ProviderMode;
      fromProviderMode?: ProviderMode;
      propertyYaml?: DeclaredPropertyYaml;
    }
  | {
      key: string;
      type: "binding";
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

export type ResourceRow = Extract<PlanRow, { type: "resource" }>;

const isProgressRow = Predicate.not(
  (row: PlanRow) =>
    row.type === "namespace" ||
    (row.type === "binding" && row.action === "noop"),
);

export interface RowState extends Required<
  Pick<ResourceStatusChanged, "id" | "status">
> {
  key: string;
  message?: string;
  startedAt?: number;
  elapsedMs?: number;
}

export type PlanViewport = "full" | "virtual";
export type PlanView = "plan" | "output";
export type PlanOutcome = "success" | "failure";

export interface PlanProgress {
  readonly completed: number;
  readonly failures: number;
  readonly total: number;
}

export interface PlanTreeState {
  readonly tasks: Map<string, RowState>;
  readonly label: string;
  readonly visible: boolean;
  readonly expanded: boolean;
  readonly viewport: PlanViewport;
  readonly busy: boolean;
  readonly outcome: PlanOutcome | undefined;
  readonly output: unknown;
  readonly view: PlanView;
}

export interface PlanTreeOptions {
  readonly detailed?: boolean;
  readonly mode?: "review" | "apply";
  readonly label?: string;
  readonly titleDetail?: string;
  readonly expanded?: boolean;
  readonly visible?: boolean;
  readonly viewport?: PlanViewport;
  readonly busy?: boolean;
  readonly outcome?: PlanOutcome;
  readonly output?: unknown;
}

const getRowKey = (item: FlattenedItem) => item.path.join("/");

const findCrudByLogicalId = (plan: Plan, id: string): CRUD | undefined =>
  [...Object.values(plan.resources), ...Object.values(plan.deletions)].find(
    (item): item is CRUD => item?.resource.LogicalId === id,
  );

const buildRows = (plan: Plan, detailed: boolean): PlanRow[] => {
  const resources = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions).filter(
      (item): item is NonNullable<Plan["deletions"][string]> =>
        item !== undefined,
    ),
  ] as CRUD[];
  const actions = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ].filter((task): task is ActionApply | ActionDelete => task !== undefined);

  return flattenTree(buildNamespaceTree(resources, actions), {
    includePropertyYaml: detailed,
  }).map((item) => {
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

export const initialResourceState = (row: ResourceRow): RowState => ({
  key: row.key,
  id: row.id,
  status:
    row.action === "noop" ? (row.persistedApplyStatus ?? "created") : "pending",
});

const buildInitialTasks = (rows: readonly PlanRow[]) =>
  new Map(
    rows.flatMap((row): Array<[string, RowState]> => {
      if (row.type === "resource")
        return [[row.key, initialResourceState(row)]];
      if (row.type === "binding") {
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

export class PlanTree {
  readonly rows: readonly PlanRow[];
  readonly progressRows: readonly PlanRow[];
  readonly summary: PlanSummaryCounts;
  readonly mode: "review" | "apply";
  readonly detailed: boolean;
  readonly titleDetail?: string;
  private state: PlanTreeState;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly plan: Plan,
    options: PlanTreeOptions = {},
  ) {
    this.detailed = options.detailed ?? false;
    this.mode = options.mode ?? "review";
    this.titleDetail = options.titleDetail;
    this.rows = buildRows(plan, this.detailed);
    this.progressRows = this.rows.filter(isProgressRow);
    this.summary = buildPlanSummary(plan);
    this.state = {
      tasks: buildInitialTasks(this.rows),
      label: options.label ?? "Plan",
      visible: options.visible ?? true,
      expanded: options.expanded ?? true,
      viewport: options.viewport ?? "virtual",
      busy: options.busy ?? false,
      outcome: options.outcome,
      output: options.output,
      view: "plan",
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return this.state;
  }

  progress(): PlanProgress {
    let completed = 0;
    let failures = 0;
    let total = 0;
    for (const row of this.progressRows) {
      const status = this.state.tasks.get(row.key)?.status;
      if (row.action !== "noop") {
        total++;
        if (status !== undefined && isTerminalStatus(status)) completed++;
      }
      if (status === "fail") failures++;
    }
    return { completed, failures, total };
  }

  setLabel(label: string) {
    this.update({ label });
  }

  setExpanded(expanded: boolean) {
    this.update({ expanded });
  }

  setVisible(visible: boolean) {
    this.update({ visible });
  }

  setViewport(viewport: PlanViewport) {
    this.update({ viewport });
  }

  setBusy(busy: boolean) {
    this.update({
      busy,
      outcome: busy ? undefined : this.state.outcome,
      view: busy ? "plan" : this.state.view,
    });
  }

  finish(
    outcome: PlanOutcome,
    label: string,
    view: PlanView = this.state.view,
  ) {
    this.update({ busy: false, outcome, label, view });
  }

  setOutput(output: unknown) {
    this.update({ output });
  }

  setView(view: PlanView) {
    this.update({ view });
  }

  emit(event: ApplyEvent) {
    const tasks = new Map(this.state.tasks);
    const key = event.fqn;
    const now = Date.now();
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
      const rowKey = event.bindingId ? `${key}/${event.bindingId}` : key;
      const current = tasks.get(rowKey);
      if (current) {
        tasks.set(rowKey, {
          key: rowKey,
          id: event.bindingId ?? event.id,
          status: event.status,
          message: event.message ?? current.message,
          ...timing(current, event.status),
        });
      }
    } else {
      const current = tasks.get(key);
      if (current) tasks.set(key, { ...current, message: event.message });
    }

    this.update({ tasks });
  }

  private update(patch: Partial<PlanTreeState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
