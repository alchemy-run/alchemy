import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import { canonical, clusterOwnedByStage, lower, reveal } from "./Common.ts";

export type AzureMonitorSelectedConfigurations =
  hdinsight.AzureMonitorSelectedConfigurations;

export interface AzureMonitorIntegrationProps {
  /** Resource group of the cluster. Changing it replaces the integration. */
  resourceGroup: string;
  /** Cluster to monitor. Changing it replaces the integration. */
  cluster: string;
  /** Log Analytics workspace (customer) ID that receives the logs and metrics. */
  workspaceId: string;
  /** Primary shared key of the Log Analytics workspace. */
  primaryKey: Redacted.Redacted<string>;
  /**
   * Tables and global settings to collect. Omit to collect HDInsight's
   * default selection.
   */
  selectedConfigurations?: AzureMonitorSelectedConfigurations;
}

export interface AzureMonitorIntegration extends Resource<
  "Azure.HDInsight.AzureMonitorIntegration",
  AzureMonitorIntegrationProps,
  {
    /** Cluster being monitored. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Whether the cluster reports Azure Monitor as enabled. */
    enabled: boolean;
    /** Log Analytics workspace ID receiving the data. */
    workspaceId: string | undefined;
    /** Collection selection observed on the cluster. */
    selectedConfigurations: AzureMonitorSelectedConfigurations | undefined;
  },
  never,
  Providers
> {}

/**
 * The Azure Monitor integration of an HDInsight cluster — sends the
 * cluster's logs and metrics to a Log Analytics workspace. There is one
 * per cluster: creating it enables the integration, deleting it disables
 * it. The workspace, key, and selection are updated in place.
 *
 * Enabling or reconfiguring the integration touches every node and takes
 * several minutes. It carries no tags; Alchemy treats it as owned when its
 * cluster carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/hdinsight/hdinsight-hadoop-oms-log-analytics-tutorial
 *
 * ### Enabling Azure Monitor
 * **Example:** Send cluster logs to a workspace
 * ```typescript
 * const monitor = yield* Azure.HDInsight.AzureMonitorIntegration("monitor", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   workspaceId: workspace.customerId,
 *   primaryKey: workspaceKey,
 * });
 * ```
 *
 * ### Selecting Tables
 * **Example:** Collect only selected tables
 * ```typescript
 * const monitor = yield* Azure.HDInsight.AzureMonitorIntegration("monitor", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   workspaceId: workspace.customerId,
 *   primaryKey: workspaceKey,
 *   selectedConfigurations: {
 *     configurationVersion: "1.0",
 *     tableList: [{ name: "HDInsightAmbariClusterAlerts" }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const AzureMonitorIntegration = Resource<AzureMonitorIntegration>(
  "Azure.HDInsight.AzureMonitorIntegration",
);

/** The integration's status; `undefined` when it is disabled or the cluster is gone. */
const getStatus = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    hdinsight.GetExtensionAzureMonitorStatus({
      subscriptionId,
      resourceGroupName,
      clusterName,
    }),
  ).pipe(
    Effect.map((status) =>
      status?.clusterMonitoringEnabled === true ? status : undefined,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  status: hdinsight.AzureMonitorResponse | undefined,
): AzureMonitorIntegration["Attributes"] => ({
  cluster,
  resourceGroup,
  enabled: status?.clusterMonitoringEnabled === true,
  workspaceId: status?.workspaceId,
  selectedConfigurations: status?.selectedConfigurations,
});

const matches = (
  status: hdinsight.AzureMonitorResponse,
  news: AzureMonitorIntegrationProps,
) =>
  lower(status.workspaceId) === lower(news.workspaceId) &&
  (news.selectedConfigurations === undefined ||
    canonical(status.selectedConfigurations) ===
      canonical(news.selectedConfigurations));

export const AzureMonitorIntegrationProvider = () =>
  Provider.succeed(AzureMonitorIntegration, {
    stables: ["cluster", "resourceGroup"],

    // The integration lives on a cluster; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cluster) !== lower(output.cluster)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const observed = yield* getStatus(subscriptionId, resourceGroup, cluster);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, observed);
      return (yield* clusterOwnedByStage(
        subscriptionId,
        resourceGroup,
        cluster,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HDInsight");
      const { resourceGroup, cluster } = news;
      const get = getStatus(subscriptionId, resourceGroup, cluster);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The key is not observable: a key change is detected
      // against the previously applied props.
      const keyChanged =
        olds !== undefined &&
        reveal(olds.primaryKey) !== Redacted.value(news.primaryKey);
      if (observed === undefined || !matches(observed, news) || keyChanged) {
        yield* hdinsight.EnableExtensionAzureMonitor({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          workspaceId: news.workspaceId,
          primaryKey: Redacted.value(news.primaryKey),
          selectedConfigurations: news.selectedConfigurations,
        });
      }

      // Enabling reconfigures every node (5-15 minutes).
      const fresh = yield* waitForProvisioned(
        `Azure Monitor integration of ${cluster}`,
        get,
        (status) =>
          lower(status.workspaceId) === lower(news.workspaceId)
            ? undefined
            : "Updating",
        { interval: "20 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hdinsight.DisableExtensionAzureMonitor({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
        }),
      );
      yield* waitUntilGone(
        `Azure Monitor integration of ${output.cluster}`,
        getStatus(subscriptionId, output.resourceGroup, output.cluster),
        { interval: "20 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.HDInsight.Cluster", "Azure.Resources.ResourceGroup"],
    },
  });
