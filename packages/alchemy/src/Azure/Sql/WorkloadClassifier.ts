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
import { workloadGroupPath, type WorkloadGroupScope } from "./setting.ts";

/**
 * Azure answers InternalServerError when the workload group and classifier
 * names together exceed ~125 characters (T-SQL allows 128 each), so
 * generated names stay short. See `WorkloadGroup`'s matching limit.
 */
const MAX_NAME_LENGTH = 60;

export interface WorkloadClassifierProps {
  /** Resource group of the server. Changing it replaces the classifier. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the classifier. */
  server: string;
  /** Name of the database (a dedicated SQL pool). Changing it replaces the classifier. */
  database: string;
  /** Name of the workload group. Changing it replaces the classifier. */
  workloadGroup: string;
  /**
   * Name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the classifier. Azure
   * answers InternalServerError when this name and the workload group's
   * name together exceed ~125 characters.
   */
  name?: string;
  /** Database user or role whose requests are classified. */
  memberName: string;
  /** Query label (`OPTION (LABEL = ...)`) to match. */
  label?: string;
  /** Session context value to match. */
  context?: string;
  /** Start of the daily time window to match, `HH:MM` (UTC). */
  startTime?: string;
  /** End of the daily time window to match, `HH:MM` (UTC). */
  endTime?: string;
  /** Importance of matched requests: `low`, `below_normal`, `normal`, `above_normal`, or `high`. */
  importance?: "low" | "below_normal" | "normal" | "above_normal" | "high";
}

export interface WorkloadClassifier extends Resource<
  "Azure.Sql.WorkloadClassifier",
  WorkloadClassifierProps,
  {
    /** Name of the classifier. */
    workloadClassifierName: string;
    /** ARM resource ID of the classifier. */
    workloadClassifierId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database (a dedicated SQL pool). */
    databaseName: string;
    /** Name of the workload group. */
    workloadGroupName: string;
    /** Classified user or role. */
    memberName: string;
    /** Importance of matched requests. */
    importance: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A workload classifier of a dedicated SQL pool — routes requests from a
 * user or role (optionally filtered by label, context, and time window)
 * into a workload group with a given importance.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-workload-classification
 *
 * ### Classifying Requests
 * **Example:** Route the loader user into the loads group
 * ```typescript
 * yield* Azure.Sql.WorkloadClassifier("loader", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: warehouse.databaseName,
 *   workloadGroup: loads.workloadGroupName,
 *   memberName: "loader",
 *   importance: "high",
 * });
 * ```
 *
 * @resource
 */
export const WorkloadClassifier = Resource<WorkloadClassifier>(
  "Azure.Sql.WorkloadClassifier",
);

type Observed = sql.GetWorkloadClassifierResponse;

const getChild = (
  subscriptionId: string,
  scope: WorkloadGroupScope,
  name: string,
) =>
  orUndefinedIfNotFound(
    sql.GetWorkloadClassifier({
      ...workloadGroupPath(subscriptionId, scope),
      workloadClassifierName: name,
    }),
  );

const toAttrs = (
  scope: WorkloadGroupScope,
  name: string,
  observed: Observed,
): WorkloadClassifier["Attributes"] => ({
  workloadClassifierName: name,
  workloadClassifierId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  workloadGroupName: scope.workloadGroupName,
  memberName: observed.properties?.memberName ?? "",
  importance: observed.properties?.importance,
});

export const WorkloadClassifierProvider = () =>
  Provider.succeed(WorkloadClassifier, {
    stables: [
      "workloadClassifierName",
      "workloadClassifierId",
      "resourceGroup",
      "serverName",
      "databaseName",
      "workloadGroupName",
    ],

    // Children of a workload group are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.database) !== lower(output.databaseName) ||
        lower(news.workloadGroup) !== lower(output.workloadGroupName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.workloadClassifierName))
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
      const workloadGroupName =
        output?.workloadGroupName ?? olds?.workloadGroup;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        databaseName === undefined ||
        workloadGroupName === undefined
      ) {
        return undefined;
      }
      const scope = {
        resourceGroup,
        serverName,
        databaseName,
        workloadGroupName,
      };
      const generated = yield* createChildName(id, MAX_NAME_LENGTH);
      const name = output?.workloadClassifierName ?? olds?.name ?? generated;
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
      const scope: WorkloadGroupScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        databaseName: news.database,
        workloadGroupName: news.workloadGroup,
      };
      const name =
        news.name ??
        output?.workloadClassifierName ??
        (yield* createChildName(id, MAX_NAME_LENGTH));
      const desired = {
        memberName: news.memberName,
        label: news.label,
        context: news.context,
        startTime: news.startTime,
        endTime: news.endTime,
        importance: news.importance,
      };
      const get = getChild(subscriptionId, scope, name);

      // Observe, then create or converge in one upsert PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !fieldsMatch(observed.properties, desired)
      ) {
        yield* sql.WorkloadClassifiersCreateOrUpdate({
          ...workloadGroupPath(subscriptionId, scope),
          workloadClassifierName: name,
          properties: desired,
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql workload classifier ${name}`,
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
        sql.DeleteWorkloadClassifier({
          ...workloadGroupPath(subscriptionId, output),
          workloadClassifierName: output.workloadClassifierName,
        }),
      );
      yield* waitUntilGone(
        `sql workload classifier ${output.workloadClassifierName}`,
        getChild(subscriptionId, output, output.workloadClassifierName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
