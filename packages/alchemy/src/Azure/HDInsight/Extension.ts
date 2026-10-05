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
import { clusterOwnedByStage, lower, reveal } from "./Common.ts";

export interface ExtensionProps {
  /** Resource group of the cluster. Changing it replaces the extension. */
  resourceGroup: string;
  /** Cluster the extension is enabled on. Changing it replaces the extension. */
  cluster: string;
  /**
   * Extension name, e.g. `clustermonitoring` (classic Azure Monitor logs).
   * Use `Azure.HDInsight.AzureMonitorIntegration` for the current Azure
   * Monitor integration. Changing it replaces the extension.
   */
  extensionName: string;
  /** Log Analytics workspace (customer) ID the extension sends data to. */
  workspaceId: string;
  /** Primary shared key of the Log Analytics workspace. */
  primaryKey: Redacted.Redacted<string>;
}

export interface Extension extends Resource<
  "Azure.HDInsight.Extension",
  ExtensionProps,
  {
    /** Name of the extension. */
    extensionName: string;
    /** Cluster the extension is enabled on. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Whether the extension reports monitoring as enabled. */
    enabled: boolean;
    /** Log Analytics workspace ID the extension sends data to. */
    workspaceId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A named HDInsight cluster extension, enabled with a Log Analytics
 * workspace — e.g. `clustermonitoring`, the classic Azure Monitor logs
 * integration. Enabling or disabling it reconfigures every node and takes
 * several minutes.
 *
 * Extensions carry no tags; Alchemy treats one as owned when its cluster
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/hdinsight/hdinsight-hadoop-oms-log-analytics-tutorial
 *
 * ### Enabling an Extension
 * **Example:** Classic cluster monitoring
 * ```typescript
 * const monitoring = yield* Azure.HDInsight.Extension("monitoring", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   extensionName: "clustermonitoring",
 *   workspaceId: workspace.customerId,
 *   primaryKey: workspaceKey,
 * });
 * ```
 *
 * @resource
 */
export const Extension = Resource<Extension>("Azure.HDInsight.Extension");

const getExtension = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  extensionName: string,
) =>
  orUndefinedIfNotFound(
    hdinsight.GetExtension({
      subscriptionId,
      resourceGroupName,
      clusterName,
      extensionName,
    }),
  ).pipe(
    // A disabled extension still answers GET; it does not exist for us.
    Effect.map((status) =>
      status?.clusterMonitoringEnabled === true ? status : undefined,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  extensionName: string,
  status: hdinsight.ClusterMonitoringResponse | undefined,
): Extension["Attributes"] => ({
  extensionName,
  cluster,
  resourceGroup,
  enabled: status?.clusterMonitoringEnabled === true,
  workspaceId: status?.workspaceId,
});

export const ExtensionProvider = () =>
  Provider.succeed(Extension, {
    stables: ["extensionName", "cluster", "resourceGroup"],

    // Extensions live on a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cluster) !== lower(output.cluster) ||
        lower(news.extensionName) !== lower(output.extensionName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const name = output?.extensionName ?? olds?.extensionName;
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getExtension(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
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
      const { resourceGroup, cluster, extensionName } = news;
      const get = getExtension(
        subscriptionId,
        resourceGroup,
        cluster,
        extensionName,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The key is not observable: a key change is detected
      // against the previously applied props.
      const keyChanged =
        olds !== undefined &&
        reveal(olds.primaryKey) !== Redacted.value(news.primaryKey);
      if (
        observed === undefined ||
        lower(observed.workspaceId) !== lower(news.workspaceId) ||
        keyChanged
      ) {
        yield* hdinsight.CreateExtension({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          extensionName,
          workspaceId: news.workspaceId,
          primaryKey: Redacted.value(news.primaryKey),
        });
      }

      // Enabling reconfigures every node (5-15 minutes).
      const fresh = yield* waitForProvisioned(
        `HDInsight extension ${extensionName}`,
        get,
        (status) =>
          lower(status.workspaceId) === lower(news.workspaceId)
            ? undefined
            : "Updating",
        { interval: "20 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, extensionName, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hdinsight.DeleteExtension({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          extensionName: output.extensionName,
        }),
      );
      yield* waitUntilGone(
        `HDInsight extension ${output.extensionName}`,
        getExtension(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.extensionName,
        ),
        { interval: "20 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.HDInsight.Cluster", "Azure.Resources.ResourceGroup"],
    },
  });
