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

/** The setting is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface ManagedInstanceAdvancedThreatProtectionSettingsProps {
  /** Resource group of the managed instance. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the setting. */
  managedInstance: string;
  /**
   * Whether Advanced Threat Protection (Microsoft Defender for SQL) is
   * enabled. Enabling it is billed under Microsoft Defender for SQL.
   */
  state: "Enabled" | "Disabled";
}

export interface ManagedInstanceAdvancedThreatProtectionSettings extends Resource<
  "Azure.Sql.ManagedInstanceAdvancedThreatProtectionSettings",
  ManagedInstanceAdvancedThreatProtectionSettingsProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Observed state: `New`, `Enabled`, or `Disabled`. */
    state: string;
    /** When the setting was first enabled, if ever. */
    creationTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Advanced Threat Protection (Microsoft Defender for SQL) for an Azure SQL Managed Instance
 * — detects anomalous activity such as SQL injection and brute-force
 * logins.
 *
 * This is a singleton setting that always exists on its parent.
 * Destroying the resource disables protection again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/threat-detection-overview
 *
 * ### Enabling Threat Protection
 * **Example:** Enable Advanced Threat Protection
 * ```typescript
 * yield* Azure.Sql.ManagedInstanceAdvancedThreatProtectionSettings("atp", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   state: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstanceAdvancedThreatProtectionSettings =
  Resource<ManagedInstanceAdvancedThreatProtectionSettings>(
    "Azure.Sql.ManagedInstanceAdvancedThreatProtectionSettings",
  );

type Observed = sql.GetManagedInstanceAdvancedThreatProtectionSettingsResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstanceAdvancedThreatProtectionSettings({
      ...instancePath(subscriptionId, scope),
      advancedThreatProtectionName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): ManagedInstanceAdvancedThreatProtectionSettings["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  state: observed.properties?.state ?? "New",
  creationTime: observed.properties?.creationTime,
});

export const ManagedInstanceAdvancedThreatProtectionSettingsProvider = () =>
  Provider.succeed(ManagedInstanceAdvancedThreatProtectionSettings, {
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
        label: `sql an Azure SQL Managed Instance threat protection on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === lower(desired.state),
        put: sql.ManagedInstanceAdvancedThreatProtectionSettingsCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          advancedThreatProtectionName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql an Azure SQL Managed Instance threat protection on ${output.managedInstanceName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; disable it.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Disabled" }),
          put: sql.ManagedInstanceAdvancedThreatProtectionSettingsCreateOrUpdate(
            {
              ...instancePath(subscriptionId, output),
              advancedThreatProtectionName: SETTING_NAME,
              properties: { state: "Disabled" },
            },
          ),
        }),
      );
    }),

    nuke: { singleton: true },
  });
