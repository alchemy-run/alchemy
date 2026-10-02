import * as cs from "@distilled.cloud/azure/containerservice";
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
  isClusterOwned,
  sameName,
  subsetMatches,
  whileClusterBusy,
} from "./Common.ts";

export type MaintenanceConfigurationName =
  | "default"
  | "aksManagedAutoUpgradeSchedule"
  | "aksManagedNodeOSUpgradeSchedule";

export interface MaintenanceConfigurationProps {
  /** Resource group of the cluster. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the configuration. */
  cluster: string;
  /**
   * Configuration name. AKS honours `default` (planned maintenance for AKS
   * releases), `aksManagedAutoUpgradeSchedule` (cluster auto-upgrades), and
   * `aksManagedNodeOSUpgradeSchedule` (node OS auto-upgrades). Changing it
   * replaces the configuration.
   */
  name: MaintenanceConfigurationName;
  /**
   * Allowed weekly time slots (only used by `default`), e.g.
   * `[{ day: "Sunday", hourSlots: [2, 3] }]`.
   */
  timeInWeek?: cs.TimeInWeek[];
  /** Time spans in which maintenance is not allowed. */
  notAllowedTime?: cs.TimeSpan[];
  /**
   * The maintenance window (required for the `aksManaged*` schedules), e.g.
   * a weekly window of 4 hours starting Sunday 02:00 UTC.
   */
  maintenanceWindow?: cs.MaintenanceWindow;
}

export interface MaintenanceConfiguration extends Resource<
  "Azure.ContainerService.MaintenanceConfiguration",
  MaintenanceConfigurationProps,
  {
    /** Name of the configuration. */
    configName: string;
    /** ARM resource ID of the configuration. */
    configId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** The observed maintenance window. */
    maintenanceWindow: cs.MaintenanceWindow | undefined;
  },
  never,
  Providers
> {}

/**
 * A planned-maintenance schedule of an AKS managed cluster, controlling when
 * AKS may upgrade the control plane or node images.
 *
 * Maintenance configurations cannot be tagged; ownership follows the
 * cluster's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/aks/planned-maintenance
 *
 * ### Scheduling Upgrades
 * **Example:** Weekly auto-upgrade window
 * ```typescript
 * yield* Azure.ContainerService.MaintenanceConfiguration("upgrades", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   name: "aksManagedAutoUpgradeSchedule",
 *   maintenanceWindow: {
 *     schedule: { weekly: { intervalWeeks: 1, dayOfWeek: "Sunday" } },
 *     durationHours: 4,
 *     startTime: "02:00",
 *     utcOffset: "+00:00",
 *   },
 * });
 * ```
 *
 * **Example:** Node OS upgrades every day
 * ```typescript
 * yield* Azure.ContainerService.MaintenanceConfiguration("node-os", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   name: "aksManagedNodeOSUpgradeSchedule",
 *   maintenanceWindow: {
 *     schedule: { daily: { intervalDays: 1 } },
 *     durationHours: 6,
 *     startTime: "00:00",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const MaintenanceConfiguration = Resource<MaintenanceConfiguration>(
  "Azure.ContainerService.MaintenanceConfiguration",
);

const getConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  configName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetMaintenanceConfiguration({
      subscriptionId,
      resourceGroupName,
      resourceName,
      configName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  config: cs.GetMaintenanceConfigurationResponse,
): MaintenanceConfiguration["Attributes"] => ({
  configName: name,
  configId: config.id ?? "",
  cluster,
  resourceGroup,
  maintenanceWindow: config.properties?.maintenanceWindow,
});

const desiredProperties = (
  news: MaintenanceConfigurationProps,
): cs.MaintenanceConfigurationProperties => ({
  timeInWeek: news.timeInWeek,
  notAllowedTime: news.notAllowedTime,
  maintenanceWindow: news.maintenanceWindow,
});

/** Whether the observed configuration matches the desired one exactly. */
const matches = (
  desired: cs.MaintenanceConfigurationProperties,
  observed: cs.MaintenanceConfigurationProperties | undefined,
) => {
  const keys = ["timeInWeek", "notAllowedTime", "maintenanceWindow"] as const;
  return keys.every((key) => {
    const want = desired[key];
    const have = observed?.[key];
    const haveEmpty =
      have === undefined || (Array.isArray(have) && have.length === 0);
    if (want === undefined || (Array.isArray(want) && want.length === 0)) {
      return haveEmpty;
    }
    return subsetMatches(want, have);
  });
};

export const MaintenanceConfigurationProvider = () =>
  Provider.succeed(MaintenanceConfiguration, {
    stables: ["configName", "configId", "cluster", "resourceGroup"],

    // Configurations live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.cluster, output.cluster) ||
        news.name !== output.configName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const name = output?.configName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getConfig(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isClusterOwned(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const { resourceGroup, cluster, name } = news;
      const get = getConfig(subscriptionId, resourceGroup, cluster, name);
      const desired = desiredProperties(news);

      // Observe, then PUT (a synchronous upsert) only on drift.
      const observed = yield* get;
      if (observed === undefined || !matches(desired, observed.properties)) {
        yield* cs
          .MaintenanceConfigurationsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: cluster,
            configName: name,
            properties: desired,
          })
          .pipe(Effect.retry(whileClusterBusy));
      }

      const fresh = yield* waitForProvisioned(
        `maintenance configuration ${cluster}/${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, cluster, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteMaintenanceConfiguration({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.cluster,
            configName: output.configName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `maintenance configuration ${output.cluster}/${output.configName}`,
        getConfig(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.configName,
        ),
      );
    }),
  });
