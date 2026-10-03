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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isManagedInstanceOwnedByStack, lower } from "./common.ts";
import { instancePath, type InstanceScope, syncSetting } from "./setting.ts";

/** The setting is a singleton named `allowPolybaseExport`. */
const SETTING_NAME = "allowPolybaseExport";

export interface ServerConfigurationOptionProps {
  /** Resource group of the managed instance. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the setting. */
  managedInstance: string;
  /**
   * Value of the `allowPolybaseExport` configuration option (`1` allows
   * `CREATE EXTERNAL TABLE AS SELECT` exports, `0` forbids them).
   */
  serverConfigurationOptionValue: 0 | 1;
}

export interface ServerConfigurationOption extends Resource<
  "Azure.Sql.ServerConfigurationOption",
  ServerConfigurationOptionProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Observed option value. */
    serverConfigurationOptionValue: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A server configuration option of an Azure SQL Managed Instance. The only
 * option Azure exposes is `allowPolybaseExport`, which controls PolyBase
 * exports (`CREATE EXTERNAL TABLE AS SELECT`) to storage.
 *
 * Applying the option restarts the instance. Destroying the resource
 * resets it to `0`.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/data-virtualization-overview
 *
 * ### Allowing PolyBase Export
 * **Example:** Enable exports
 * ```typescript
 * yield* Azure.Sql.ServerConfigurationOption("polybase-export", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   serverConfigurationOptionValue: 1,
 * });
 * ```
 *
 * @resource
 */
export const ServerConfigurationOption = Resource<ServerConfigurationOption>(
  "Azure.Sql.ServerConfigurationOption",
);

type Observed = sql.GetServerConfigurationOptionResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetServerConfigurationOption({
      ...instancePath(subscriptionId, scope),
      serverConfigurationOptionName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): ServerConfigurationOption["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  serverConfigurationOptionValue:
    observed.properties?.serverConfigurationOptionValue,
});

export const ServerConfigurationOptionProvider = () =>
  Provider.succeed(ServerConfigurationOption, {
    stables: ["settingId", "resourceGroup", "managedInstanceName"],

    // A singleton setting of its managed instance; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName =
        output?.managedInstanceName ?? olds?.managedInstance;
      if (resourceGroup === undefined || managedInstanceName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.managedInstanceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: InstanceScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
      };
      const desired = {
        serverConfigurationOptionValue: news.serverConfigurationOptionValue,
      };
      const fresh = yield* syncSetting({
        label: `sql managed instance configuration option on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          observed.properties?.serverConfigurationOptionValue ===
            desired.serverConfigurationOptionValue &&
          (observed.properties?.provisioningState === undefined ||
            observed.properties.provisioningState === "Succeeded"),
        put: sql.ServerConfigurationOptionsCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          serverConfigurationOptionName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed instance configuration option on ${output.managedInstanceName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; reset it to `0`.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            observed.properties?.serverConfigurationOptionValue === 0,
          put: sql.ServerConfigurationOptionsCreateOrUpdate({
            ...instancePath(subscriptionId, output),
            serverConfigurationOptionName: SETTING_NAME,
            properties: { serverConfigurationOptionValue: 0 },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
