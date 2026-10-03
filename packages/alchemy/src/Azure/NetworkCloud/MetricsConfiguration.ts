import * as nc from "@distilled.cloud/azure/networkcloud";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  customLocation,
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  propertyDelta,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";

export interface MetricsConfigurationProps {
  /**
   * Resource group the metrics configuration is created in. Changing it replaces the
   * metrics configuration.
   */
  resourceGroup: string;
  /**
   * Name of the Nexus cluster the configuration belongs to. Changing it replaces the metrics configuration.
   */
  clusterName: string;
  /**
   * Azure location of the metrics configuration; must match the location of the Nexus
   * cluster. Changing it replaces the metrics configuration.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the metrics configuration.
   */
  customLocationId: string;
  /** Metrics collection interval in minutes. */
  collectionInterval: number;
  /** Optional metrics to enable on top of the defaults. */
  enabledMetrics?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MetricsConfiguration extends Resource<
  "Azure.NetworkCloud.MetricsConfiguration",
  MetricsConfigurationProps,
  {
    /** Name of the metrics configuration. */
    metricsConfigurationName: string;
    /** ARM resource ID of the metrics configuration. */
    metricsConfigurationId: string;
    /** Resource group that holds the metrics configuration. */
    resourceGroup: string;
    /** Name of the parent Nexus cluster. */
    clusterName: string;
    /** Location of the metrics configuration. */
    location: string;
    /** Custom location the metrics configuration is deployed to. */
    customLocationId: string | undefined;
    /** Metrics collection interval in minutes. */
    collectionInterval: number;
    /** Optional metrics that are enabled. */
    enabledMetrics: string[];
    /** Optional metrics that are available but disabled. */
    disabledMetrics: string[];
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * The metrics configuration of an Azure Operator Nexus cluster — the
 * collection interval and the optional metrics to scrape. Each cluster has
 * at most one, always named `default`. Needs a deployed Operator Nexus
 * cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-metrics
 *
 * ### Configuring Cluster Metrics
 * **Example:** Collect every 5 minutes
 * ```typescript
 * const metrics = yield* Azure.NetworkCloud.MetricsConfiguration("metrics", {
 *   resourceGroup: cluster.resourceGroup,
 *   clusterName: cluster.clusterName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   collectionInterval: 5,
 *   enabledMetrics: ["kubevirt_vmi_cpu_usage_seconds_total"],
 * });
 * ```
 *
 * @resource
 */
export const MetricsConfiguration = Resource<MetricsConfiguration>(
  "Azure.NetworkCloud.MetricsConfiguration",
);

type Observed = nc.GetMetricsConfigurationResponse;

const getMetricsConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetMetricsConfiguration({
      subscriptionId,
      resourceGroupName,
      clusterName,
      metricsConfigurationName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  clusterName: string,
  name: string,
  observed: Observed,
): MetricsConfiguration["Attributes"] => {
  const p = observed.properties;
  return {
    metricsConfigurationName: name,
    metricsConfigurationId: observed.id ?? "",
    resourceGroup,
    clusterName,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    collectionInterval: p.collectionInterval,
    enabledMetrics: [...(p.enabledMetrics ?? [])],
    disabledMetrics: [...(p.disabledMetrics ?? [])],
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const MetricsConfigurationProvider = () =>
  Provider.succeed(MetricsConfiguration, {
    stables: [
      "metricsConfigurationName",
      "metricsConfigurationId",
      "resourceGroup",
      "clusterName",
      "location",
      "customLocationId",
    ],

    // Children vanish with their cluster; the parent's list covers them.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.clusterName, output.clusterName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const clusterName = output?.clusterName ?? olds?.clusterName;
      if (clusterName === undefined) return undefined;
      const name = "default";
      const observed = yield* getMetricsConfiguration(
        subscriptionId,
        resourceGroup,
        clusterName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, clusterName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const clusterName = news.clusterName;
      const name = "default";
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName,
        metricsConfigurationName: name,
      };
      const label = `Nexus metrics configuration ${name}`;
      const get = getMetricsConfiguration(
        subscriptionId,
        resourceGroup,
        clusterName,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.MetricsConfigurationsCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            collectionInterval: news.collectionInterval,
            enabledMetrics: news.enabledMetrics,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        collectionInterval: news.collectionInterval,
        enabledMetrics: news.enabledMetrics,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* nc.UpdateMetricsConfiguration({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, clusterName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.metricsConfigurationName;
      yield* ignoreNotFound(
        nc.DeleteMetricsConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
          metricsConfigurationName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus metrics configuration ${name}`,
        getMetricsConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.clusterName,
          name,
        ),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.Cluster",
      ],
    },
  });
