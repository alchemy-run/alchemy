import * as app from "@distilled.cloud/azure/app";
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
import { isEnvironmentOwnedByStack, lower, matchesDesired } from "./common.ts";

/** A weekly window in which the platform may patch the environment. */
export interface MaintenanceWindow {
  /** Day of the week the window starts. */
  weekDay:
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday"
    | "Sunday";
  /** Hour (UTC, 0-23) the window starts. */
  startHourUtc: number;
  /** Length of the window in hours (8-24). */
  durationHours: number;
}

export interface MaintenanceConfigurationProps {
  /** Resource group of the environment. Changing it replaces the configuration. */
  resourceGroup: string;
  /**
   * Name of the Container Apps environment (workload profiles mode).
   * Changing it replaces the configuration.
   */
  environment: string;
  /** Weekly planned maintenance windows. */
  scheduledEntries: MaintenanceWindow[];
}

export interface MaintenanceConfiguration extends Resource<
  "Azure.ContainerApps.MaintenanceConfiguration",
  MaintenanceConfigurationProps,
  {
    /** Name of the configuration (always `default`). */
    configName: string;
    /** ARM resource ID of the configuration. */
    configId: string;
    /** Name of the environment the configuration applies to. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
    /** The observed maintenance windows. */
    scheduledEntries: MaintenanceWindow[];
  },
  never,
  Providers
> {}

/**
 * Planned maintenance for a Container Apps environment
 * (`Microsoft.App/managedEnvironments/maintenanceConfigurations`) — the
 * weekly windows in which the platform may apply non-critical updates.
 *
 * An environment has at most one configuration, named `default`. It cannot
 * be tagged; Alchemy treats it as owned when its environment is owned by
 * the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/planned-maintenance
 *
 * ### Scheduling Maintenance
 * **Example:** Sunday night maintenance window
 * ```typescript
 * yield* Azure.ContainerApps.MaintenanceConfiguration("maintenance", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   scheduledEntries: [{ weekDay: "Sunday", startHourUtc: 1, durationHours: 8 }],
 * });
 * ```
 *
 * @resource
 */
export const MaintenanceConfiguration = Resource<MaintenanceConfiguration>(
  "Azure.ContainerApps.MaintenanceConfiguration",
);

const CONFIG_NAME = "default";

const getConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
) =>
  orUndefinedIfNotFound(
    app.GetMaintenanceConfiguration({
      subscriptionId,
      resourceGroupName,
      environmentName,
      configName: CONFIG_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  observed: app.GetMaintenanceConfigurationResponse,
): MaintenanceConfiguration["Attributes"] => ({
  configName: CONFIG_NAME,
  configId: observed.id ?? "",
  environment,
  resourceGroup,
  scheduledEntries: (observed.properties?.scheduledEntries ?? []).map(
    (entry) => ({
      weekDay: entry.weekDay as MaintenanceWindow["weekDay"],
      startHourUtc: entry.startHourUtc,
      durationHours: entry.durationHours,
    }),
  ),
});

export const MaintenanceConfigurationProvider = () =>
  Provider.succeed(MaintenanceConfiguration, {
    stables: ["configName", "configId", "environment", "resourceGroup"],

    // Lives inside an environment; nuke removes it with the environment.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const environment = output?.environment ?? olds?.environment;
      if (resourceGroup === undefined || environment === undefined) {
        return undefined;
      }
      const observed = yield* getConfig(
        subscriptionId,
        resourceGroup,
        environment,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, environment, observed);
      return (yield* isEnvironmentOwnedByStack(
        subscriptionId,
        resourceGroup,
        environment,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, environment } = news;
      const desired = news.scheduledEntries.map((entry) => ({
        weekDay: entry.weekDay,
        startHourUtc: entry.startHourUtc,
        durationHours: entry.durationHours,
      }));

      // Observe.
      let observed = yield* getConfig(
        subscriptionId,
        resourceGroup,
        environment,
      );

      // Ensure + sync: one full PUT, skipped when the windows already match.
      if (
        observed === undefined ||
        !matchesDesired(desired, observed.properties?.scheduledEntries)
      ) {
        observed = yield* app.MaintenanceConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          environmentName: environment,
          configName: CONFIG_NAME,
          properties: { scheduledEntries: desired },
        });
      }

      return toAttrs(resourceGroup, environment, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteMaintenanceConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          configName: CONFIG_NAME,
        }),
      );
      yield* waitUntilGone(
        `maintenance configuration of ${output.environment}`,
        getConfig(subscriptionId, output.resourceGroup, output.environment),
      );
    }),
  });
