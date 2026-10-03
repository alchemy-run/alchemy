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
import { fieldsMatch, isManagedInstanceOwnedByStack, lower } from "./common.ts";
import { instancePath, type InstanceScope, syncSetting } from "./setting.ts";

export interface SqlAgentConfigurationProps {
  /** Resource group of the managed instance. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the setting. */
  managedInstance: string;
  /** Whether SQL Server Agent is running on the instance. */
  state: "Enabled" | "Disabled";
}

export interface SqlAgentConfiguration extends Resource<
  "Azure.Sql.SqlAgentConfiguration",
  SqlAgentConfigurationProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Observed SQL Agent state. */
    state: string;
  },
  never,
  Providers
> {}

/**
 * SQL Server Agent of an Azure SQL Managed Instance — turns the job
 * scheduler on or off.
 *
 * This is a singleton setting that always exists on an instance.
 * Destroying the resource re-enables SQL Agent (Azure's default).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/job-automation-managed-instance
 *
 * ### Configuring SQL Agent
 * **Example:** Turn SQL Agent off
 * ```typescript
 * yield* Azure.Sql.SqlAgentConfiguration("agent", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   state: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const SqlAgentConfiguration = Resource<SqlAgentConfiguration>(
  "Azure.Sql.SqlAgentConfiguration",
);

type Observed = sql.GetSqlAgentResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetSqlAgent({
      ...instancePath(subscriptionId, scope),
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): SqlAgentConfiguration["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  state: observed.properties?.state ?? "Enabled",
});

export const SqlAgentConfigurationProvider = () =>
  Provider.succeed(SqlAgentConfiguration, {
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
      const desired = { state: news.state };
      const fresh = yield* syncSetting({
        label: `sql managed instance sql agent on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === lower(desired.state),
        put: sql.SqlAgentCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed instance sql agent on ${output.managedInstanceName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; re-enable SQL Agent (Azure's default).
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Enabled" }),
          put: sql.SqlAgentCreateOrUpdate({
            ...instancePath(subscriptionId, output),
            properties: { state: "Enabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
