import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  fieldsMatch,
  isServerOwnedByStack,
  lower,
} from "./common.ts";
import { databasePath, type DatabaseScope } from "./setting.ts";

export interface WorkloadGroupProps {
  /** Resource group of the server. Changing it replaces the workload group. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the workload group. */
  server: string;
  /** Name of the database (a dedicated SQL pool). Changing it replaces the workload group. */
  database: string;
  /**
   * Name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the workload group.
   */
  name?: string;
  /** Minimum share of resources reserved for the group (0-100). */
  minResourcePercent: number;
  /** Maximum share of resources the group may use (1-100). */
  maxResourcePercent: number;
  /** Minimum share of resources per request (0.75-100, depending on the service level). */
  minResourcePercentPerRequest: number;
  /** Maximum share of resources per request. */
  maxResourcePercentPerRequest?: number;
  /** Default importance of requests: `low`, `below_normal`, `normal`, `above_normal`, or `high`. */
  importance?: "low" | "below_normal" | "normal" | "above_normal" | "high";
  /** Maximum query execution time in seconds (0 for unlimited). */
  queryExecutionTimeout?: number;
}

export interface WorkloadGroup extends Resource<
  "Azure.Sql.WorkloadGroup",
  WorkloadGroupProps,
  {
    /** Name of the workload group. */
    workloadGroupName: string;
    /** ARM resource ID of the workload group. */
    workloadGroupId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database (a dedicated SQL pool). */
    databaseName: string;
    /** Minimum resource percentage. */
    minResourcePercent: number | undefined;
    /** Maximum resource percentage. */
    maxResourcePercent: number | undefined;
    /** Default importance. */
    importance: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A workload group of a dedicated SQL pool (data warehouse) on an Azure
 * SQL server — reserves and caps resources for a class of requests
 * (workload isolation). Route requests into it with
 * `Azure.Sql.WorkloadClassifier`.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-workload-isolation
 *
 * ### Isolating Workloads
 * **Example:** Reserve 20% for data loads
 * ```typescript
 * const loads = yield* Azure.Sql.WorkloadGroup("loads", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: warehouse.databaseName,
 *   minResourcePercent: 20,
 *   maxResourcePercent: 100,
 *   minResourcePercentPerRequest: 5,
 *   importance: "high",
 * });
 * ```
 *
 * @resource
 */
export const WorkloadGroup = Resource<WorkloadGroup>("Azure.Sql.WorkloadGroup");

type Observed = sql.GetWorkloadGroupResponse;

const getChild = (subscriptionId: string, scope: DatabaseScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetWorkloadGroup({
      ...databasePath(subscriptionId, scope),
      workloadGroupName: name,
    }),
  );

const toAttrs = (
  scope: DatabaseScope,
  name: string,
  observed: Observed,
): WorkloadGroup["Attributes"] => ({
  workloadGroupName: name,
  workloadGroupId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  minResourcePercent: observed.properties?.minResourcePercent,
  maxResourcePercent: observed.properties?.maxResourcePercent,
  importance: observed.properties?.importance,
});

export const WorkloadGroupProvider = () =>
  Provider.succeed(WorkloadGroup, {
    stables: [
      "workloadGroupName",
      "workloadGroupId",
      "resourceGroup",
      "serverName",
      "databaseName",
    ],

    // Children of a database are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.database) !== lower(output.databaseName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.workloadGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const databaseName = output?.databaseName ?? olds?.database;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        databaseName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, databaseName };
      const generated = yield* createChildName(id, 128);
      const name = output?.workloadGroupName ?? olds?.name ?? generated;
      const observed = yield* getChild(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return output !== undefined ||
        name === generated ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: DatabaseScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        databaseName: news.database,
      };
      const name =
        news.name ??
        output?.workloadGroupName ??
        (yield* createChildName(id, 128));
      const desired = {
        minResourcePercent: news.minResourcePercent,
        maxResourcePercent: news.maxResourcePercent,
        minResourcePercentPerRequest: news.minResourcePercentPerRequest,
        maxResourcePercentPerRequest: news.maxResourcePercentPerRequest,
        importance: news.importance,
        queryExecutionTimeout: news.queryExecutionTimeout,
      };
      const get = getChild(subscriptionId, scope, name);

      // Observe, then create or converge in one upsert PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !fieldsMatch(observed.properties, desired)
      ) {
        yield* sql.WorkloadGroupsCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          workloadGroupName: name,
          properties: desired,
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql workload group ${name}`,
        get,
        (observed) =>
          fieldsMatch(observed.properties, desired) ? "Succeeded" : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteWorkloadGroup({
          ...databasePath(subscriptionId, output),
          workloadGroupName: output.workloadGroupName,
        }),
      );
      yield* waitUntilGone(
        `sql workload group ${output.workloadGroupName}`,
        getChild(subscriptionId, output, output.workloadGroupName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
