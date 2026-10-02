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

export interface WorkloadClassifierProps extends SqlPoolChildProps {
  /** Name of the workload group requests are routed to. Changing it replaces the classifier. */
  workloadGroup: string;
  /**
   * Classifier name (letters and digits). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * classifier.
   */
  name?: string;
  /** Database user, role, Entra login, or group the classifier matches. */
  memberName: string;
  /** Query label (`OPTION (LABEL = '...')`) the classifier matches. */
  label?: string;
  /** Session context value the classifier matches. */
  context?: string;
  /** Start of the daily time window (`HH:MM`, UTC). */
  startTime?: string;
  /** End of the daily time window (`HH:MM`, UTC). */
  endTime?: string;
  /** Importance of matched requests. */
  importance?: "low" | "below_normal" | "normal" | "above_normal" | "high";
}

export interface WorkloadClassifier extends Resource<
  "Azure.Synapse.WorkloadClassifier",
  WorkloadClassifierProps,
  SqlPoolChildAttrs & {
    /** Name of the workload group. */
    workloadGroupName: string;
    /** Name of the classifier. */
    workloadClassifierName: string;
    /** ARM resource ID of the classifier. */
    workloadClassifierId: string;
    /** Member the classifier matches. */
    memberName: string | undefined;
    /** Importance of matched requests. */
    importance: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A workload classifier of a dedicated SQL pool — routes requests from a
 * user, role, or label into a workload group and sets their importance.
 * The pool must be online (not paused) to create or change classifiers.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-workload-classification
 *
 * ### Classifying Requests
 * **Example:** Route the loader user into the loads group
 * ```typescript
 * yield* Azure.Synapse.WorkloadClassifier("loader", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   workloadGroup: loads.workloadGroupName,
 *   memberName: "loader",
 *   importance: "high",
 * });
 * ```
 *
 * @resource
 */
export const WorkloadClassifier = Resource<WorkloadClassifier>(
  "Azure.Synapse.WorkloadClassifier",
);

type Observed = synapse.GetSqlPoolWorkloadClassifierResponse;

const createClassifierName = (id: string) => createAlnumName(id, 60);

const getClassifier = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  workloadGroupName: string,
  workloadClassifierName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPoolWorkloadClassifier({
      ...sqlPoolWhere(subscriptionId, ref),
      workloadGroupName,
      workloadClassifierName,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  group: string,
  name: string,
  classifier: Observed,
): WorkloadClassifier["Attributes"] => ({
  ...ref,
  workloadGroupName: group,
  workloadClassifierName: name,
  workloadClassifierId: classifier.id ?? "",
  memberName: classifier.properties?.memberName,
  importance: classifier.properties?.importance,
});

export const WorkloadClassifierProvider = () =>
  Provider.succeed(WorkloadClassifier, {
    stables: [
      "workloadClassifierName",
      "workloadClassifierId",
      "workloadGroupName",
      "workspaceName",
      "resourceGroup",
      "sqlPoolName",
    ],

    // Classifiers live inside a SQL pool; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        sqlPoolChildMoved(news, output) ||
        news.workloadGroup.toLowerCase() !==
          output.workloadGroupName.toLowerCase() ||
        (news.name !== undefined && news.name !== output.workloadClassifierName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = sqlPoolChildRef(olds, output);
      const group = output?.workloadGroupName ?? olds?.workloadGroup;
      if (ref === undefined || group === undefined) return undefined;
      const name =
        output?.workloadClassifierName ??
        olds?.name ??
        (yield* createClassifierName(id));
      const observed = yield* getClassifier(subscriptionId, ref, group, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, group, name, observed);
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
      const group = news.workloadGroup;
      const name =
        news.name ??
        output?.workloadClassifierName ??
        (yield* createClassifierName(id));
      const desired: synapse.WorkloadClassifierProperties = {
        memberName: news.memberName,
        label: news.label,
        context: news.context,
        startTime: news.startTime,
        endTime: news.endTime,
        importance: news.importance,
      };
      // Observe, then create or converge in one long-running PUT.
      const fresh = yield* syncSetting({
        label: `synapse workload classifier ${name}`,
        get: getClassifier(subscriptionId, ref, group, name),
        matches: (classifier: Observed) =>
          fieldsMatch(classifier.properties, desired),
        put: synapse.SqlPoolWorkloadClassifierCreateOrUpdate({
          ...sqlPoolWhere(subscriptionId, ref),
          workloadGroupName: group,
          workloadClassifierName: name,
          properties: desired,
        }),
      });
      return toAttrs(ref, group, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteSqlPoolWorkloadClassifier({
          ...sqlPoolWhere(subscriptionId, output),
          workloadGroupName: output.workloadGroupName,
          workloadClassifierName: output.workloadClassifierName,
        }),
      );
      yield* waitUntilGone(
        `synapse workload classifier ${output.workloadClassifierName}`,
        getClassifier(
          subscriptionId,
          output,
          output.workloadGroupName,
          output.workloadClassifierName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
