import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createAlnumName,
  fieldsMatch,
  isWorkspaceOwnedByStack,
  type SqlPoolChildAttrs,
  type SqlPoolChildProps,
  sqlPoolChildMoved,
  sqlPoolChildRef,
  sqlPoolWhere,
  syncSetting,
} from "./common.ts";

export interface WorkloadGroupProps extends SqlPoolChildProps {
  /**
   * Group name (letters and digits). If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /** Resources (percent) reserved exclusively for the group. */
  minResourcePercent: number;
  /** Maximum resources (percent) the group may use. */
  maxResourcePercent: number;
  /** Minimum resources (percent) granted to each request. */
  minResourcePercentPerRequest: number;
  /** Maximum resources (percent) granted to each request. */
  maxResourcePercentPerRequest?: number;
  /**
   * Default importance of the group's requests.
   * @default "normal"
   */
  importance?: "low" | "below_normal" | "normal" | "above_normal" | "high";
  /** Seconds before a request is cancelled (0 = no timeout). */
  queryExecutionTimeout?: number;
}

export interface WorkloadGroup extends Resource<
  "Azure.Synapse.WorkloadGroup",
  WorkloadGroupProps,
  SqlPoolChildAttrs & {
    /** Name of the group. */
    workloadGroupName: string;
    /** ARM resource ID of the group. */
    workloadGroupId: string;
    /** Reserved resources (percent). */
    minResourcePercent: number | undefined;
    /** Maximum resources (percent). */
    maxResourcePercent: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A workload group of a dedicated SQL pool — workload isolation that
 * reserves and caps the pool's resources for a class of requests. Pair it
 * with `Azure.Synapse.WorkloadClassifier` to route requests into the group.
 * The pool must be online (not paused) to create or change groups.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-workload-isolation
 *
 * ### Isolating Workloads
 * **Example:** Reserve 20% of the pool for loads
 * ```typescript
 * const loads = yield* Azure.Synapse.WorkloadGroup("loads", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   minResourcePercent: 20,
 *   maxResourcePercent: 100,
 *   minResourcePercentPerRequest: 5,
 *   importance: "high",
 * });
 * ```
 *
 * @resource
 */
export const WorkloadGroup = Resource<WorkloadGroup>(
  "Azure.Synapse.WorkloadGroup",
);

type Observed = synapse.GetSqlPoolWorkloadGroupResponse;

const createGroupName = (id: string) => createAlnumName(id, 60);

const getGroup = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  workloadGroupName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPoolWorkloadGroup({
      ...sqlPoolWhere(subscriptionId, ref),
      workloadGroupName,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  name: string,
  group: Observed,
): WorkloadGroup["Attributes"] => ({
  ...ref,
  workloadGroupName: name,
  workloadGroupId: group.id ?? "",
  minResourcePercent: group.properties?.minResourcePercent,
  maxResourcePercent: group.properties?.maxResourcePercent,
});

export const WorkloadGroupProvider = () =>
  Provider.succeed(WorkloadGroup, {
    stables: [
      "workloadGroupName",
      "workloadGroupId",
      "workspaceName",
      "resourceGroup",
      "sqlPoolName",
    ],

    // Groups live inside a SQL pool; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        sqlPoolChildMoved(news, output) ||
        (news.name !== undefined && news.name !== output.workloadGroupName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = sqlPoolChildRef(olds, output);
      if (ref === undefined) return undefined;
      const name =
        output?.workloadGroupName ?? olds?.name ?? (yield* createGroupName(id));
      const observed = yield* getGroup(subscriptionId, ref, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, name, observed);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          ref.resourceGroup,
          ref.workspaceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const ref = {
        resourceGroup: news.resourceGroup,
        workspaceName: news.workspace,
        sqlPoolName: news.sqlPool,
      };
      const name =
        news.name ?? output?.workloadGroupName ?? (yield* createGroupName(id));
      const desired: synapse.WorkloadGroupProperties = {
        minResourcePercent: news.minResourcePercent,
        maxResourcePercent: news.maxResourcePercent,
        minResourcePercentPerRequest: news.minResourcePercentPerRequest,
        maxResourcePercentPerRequest: news.maxResourcePercentPerRequest,
        importance: news.importance,
        queryExecutionTimeout: news.queryExecutionTimeout,
      };
      // Observe, then create or converge in one long-running PUT.
      const fresh = yield* syncSetting({
        label: `synapse workload group ${name}`,
        get: getGroup(subscriptionId, ref, name),
        matches: (group: Observed) => fieldsMatch(group.properties, desired),
        put: synapse.SqlPoolWorkloadGroupCreateOrUpdate({
          ...sqlPoolWhere(subscriptionId, ref),
          workloadGroupName: name,
          properties: desired,
        }),
      });
      return toAttrs(ref, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteSqlPoolWorkloadGroup({
          ...sqlPoolWhere(subscriptionId, output),
          workloadGroupName: output.workloadGroupName,
        }),
      );
      yield* waitUntilGone(
        `synapse workload group ${output.workloadGroupName}`,
        getGroup(subscriptionId, output, output.workloadGroupName),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
