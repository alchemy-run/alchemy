import * as edge from "@distilled.cloud/azure/edge";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { EDGE_WAIT, edgeState, sameJson } from "./EdgeShared.ts";

/** A task that a workflow stage runs. */
export interface WorkflowTask {
  /** Name of the task. */
  name: string;
  /** ARM resource ID of the `Azure.Edge.Target` the task runs against. */
  targetId?: string;
  /** Task specification (free-form JSON). */
  specification: Record<string, unknown>;
}

/** A stage of a workflow version. */
export interface WorkflowStage {
  /** Name of the stage. */
  name: string;
  /** Stage specification (free-form JSON). */
  specification?: Record<string, unknown>;
  /** Tasks the stage runs. */
  tasks?: WorkflowTask[];
  /** How the stage runs its tasks. */
  taskOption?: {
    /**
     * Number of tasks that run in parallel (1-8).
     * @default 1
     */
    concurrency?: number;
    /** What the stage does when a task fails. */
    errorAction?: {
      /**
       * Error mode.
       * @default "stopOnAnyFailure"
       */
      mode?: "stopOnAnyFailure" | "stopOnNFailures" | "silentlyContinue";
      /** Failures tolerated before the stage stops (with `stopOnNFailures`). */
      maxToleratedFailures?: number;
    };
  };
}

export interface WorkflowVersionProps {
  /** Resource group of the context. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the context that holds the workflow. Changing it replaces the version. */
  context: string;
  /** Name of the parent `Azure.Edge.Workflow`. Changing it replaces the version. */
  workflow: string;
  /**
   * Name of the version: 3-61 letters, digits, `-`, and `.`, not starting
   * with `v-` (for example `1.0.0`). Changing it replaces the version.
   */
  version: string;
  /** Stages the workflow runs, in order. */
  stages: WorkflowStage[];
  /** Execution specification (free-form JSON). */
  specification?: Record<string, unknown>;
}

export interface WorkflowVersion extends Resource<
  "Azure.Edge.WorkflowVersion",
  WorkflowVersionProps,
  {
    /** Name of the version. */
    version: string;
    /** Name of the parent workflow. */
    workflow: string;
    /** Name of the context that holds the workflow. */
    context: string;
    /** Resource group of the context. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    workflowVersionId: string;
    /** Names of the version's stages, in order. */
    stageNames: string[];
    /** Revision the service assigned to the version. */
    revision: number | undefined;
    /** State the service reports for the version. */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A version of an Azure Arc workload orchestration workflow
 * (`Microsoft.Edge/contexts/workflows/versions`): the ordered stages, and
 * the tasks in each stage, that a rollout goes through.
 *
 * Versions carry no tags or free-form fields that Alchemy can mark; a
 * version found under the expected name is treated as this resource.
 *
 * :::caution
 * Changing `version`, `workflow`, `context`, or `resourceGroup` replaces
 * the version. `stages` and `specification` update in place.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview
 *
 * ### Defining Stages
 * **Example:** Two-stage workflow version
 * ```typescript
 * yield* Azure.Edge.WorkflowVersion("rollout-v1", {
 *   context: context.contextName,
 *   workflow: workflow.workflowName,
 *   version: "1.0.0",
 *   stages: [{ name: "canary" }, { name: "fleet" }],
 * });
 * ```
 *
 * @resource
 */
export const WorkflowVersion = GroupedResource<WorkflowVersion>("Azure.Edge.WorkflowVersion");

interface Where {
  readonly resourceGroup: string;
  readonly context: string;
  readonly workflow: string;
  readonly version: string;
}

const request = (subscriptionId: string, where: Where) => ({
  subscriptionId,
  resourceGroupName: where.resourceGroup,
  contextName: where.context,
  workflowName: where.workflow,
  versionName: where.version,
});

const getVersion = (subscriptionId: string, where: Where) =>
  orUndefinedIfNotFound(edge.GetWorkflowVersion(request(subscriptionId, where)));

const toAttrs = (
  where: Where,
  observed: edge.GetWorkflowVersionResponse,
): WorkflowVersion["Attributes"] => ({
  version: where.version,
  workflow: where.workflow,
  context: where.context,
  resourceGroup: where.resourceGroup,
  workflowVersionId: observed.id ?? "",
  stageNames: (observed.properties?.stageSpec ?? []).map((stage) => stage.name),
  revision: observed.properties?.revision,
  state: observed.properties?.state,
});

const label = (where: Where) =>
  `edge workflow version ${where.context}/${where.workflow}/${where.version}`;

export const WorkflowVersionProvider = () =>
  Provider.succeed(WorkflowVersion, {
    stables: ["version", "workflow", "context", "resourceGroup", "workflowVersionId"],

    // Versions vanish with their workflow.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.context.toLowerCase() !== output.context.toLowerCase() ||
        news.workflow.toLowerCase() !== output.workflow.toLowerCase() ||
        news.version.toLowerCase() !== output.version.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const source = output ?? olds;
      if (
        source?.resourceGroup === undefined ||
        source.context === undefined ||
        source.workflow === undefined ||
        source.version === undefined
      ) {
        return undefined;
      }
      const where = {
        resourceGroup: source.resourceGroup,
        context: source.context,
        workflow: source.workflow,
        version: source.version,
      };
      const observed = yield* getVersion(subscriptionId, where);
      return observed === undefined ? undefined : toAttrs(where, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const get = getVersion(subscriptionId, news);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* edge.WorkflowVersionsCreateOrUpdate({
          ...request(subscriptionId, news),
          properties: {
            stageSpec: news.stages,
            ...(news.specification !== undefined ? { specification: news.specification } : {}),
          },
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const props = observed.properties;
        const delta: edge.WorkflowVersionPropertiesUpdate = {
          ...(!sameJson(props?.stageSpec, news.stages) ? { stageSpec: news.stages } : {}),
          ...(news.specification !== undefined &&
          !sameJson(props?.specification, news.specification)
            ? { specification: news.specification }
            : {}),
        };
        if (Object.keys(delta).length > 0) {
          yield* edge.UpdateWorkflowVersion({
            ...request(subscriptionId, news),
            properties: delta,
          });
        }
      }

      const fresh = yield* waitForProvisioned(label(news), get, edgeState, EDGE_WAIT);
      return toAttrs(news, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(edge.DeleteWorkflowVersion(request(subscriptionId, output)));
      yield* waitUntilGone(label(output), getVersion(subscriptionId, output), EDGE_WAIT);
    }),
  });
