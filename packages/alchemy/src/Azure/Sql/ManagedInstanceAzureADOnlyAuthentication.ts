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

export interface ManagedInstanceAzureADOnlyAuthenticationProps {
  /** Resource group of the managed instance. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the setting. */
  managedInstance: string;
  /**
   * Allow only Microsoft Entra authentication (SQL logins are rejected).
   * Requires a Microsoft Entra administrator
   * (`Azure.Sql.ManagedInstanceAdministrator`).
   */
  azureADOnlyAuthentication: boolean;
}

export interface ManagedInstanceAzureADOnlyAuthentication extends Resource<
  "Azure.Sql.ManagedInstanceAzureADOnlyAuthentication",
  ManagedInstanceAzureADOnlyAuthenticationProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Whether only Microsoft Entra authentication is allowed. */
    azureADOnlyAuthentication: boolean;
  },
  never,
  Providers
> {}

/**
 * Microsoft Entra-only authentication of an Azure SQL Managed Instance —
 * when enabled, SQL logins are rejected.
 *
 * This is a singleton setting that always exists on an instance.
 * Destroying the resource allows SQL logins again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/authentication-azure-ad-only-authentication
 *
 * ### Entra-Only Authentication
 * **Example:** Reject SQL logins
 * ```typescript
 * yield* Azure.Sql.ManagedInstanceAzureADOnlyAuthentication("entra-only", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   azureADOnlyAuthentication: true,
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstanceAzureADOnlyAuthentication =
  Resource<ManagedInstanceAzureADOnlyAuthentication>(
    "Azure.Sql.ManagedInstanceAzureADOnlyAuthentication",
  );

type Observed = sql.GetManagedInstanceAzureADOnlyAuthenticationResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstanceAzureADOnlyAuthentication({
      ...instancePath(subscriptionId, scope),
      authenticationName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): ManagedInstanceAzureADOnlyAuthentication["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  azureADOnlyAuthentication:
    observed.properties?.azureADOnlyAuthentication ?? false,
});

export const ManagedInstanceAzureADOnlyAuthenticationProvider = () =>
  Provider.succeed(ManagedInstanceAzureADOnlyAuthentication, {
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
        azureADOnlyAuthentication: news.azureADOnlyAuthentication,
      };
      const fresh = yield* syncSetting({
        label: `sql managed instance entra-only authentication on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          observed.properties?.azureADOnlyAuthentication ===
          desired.azureADOnlyAuthentication,
        put: sql.ManagedInstanceAzureADOnlyAuthenticationsCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          authenticationName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed instance entra-only authentication on ${output.managedInstanceName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; allow SQL logins again.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, {
              azureADOnlyAuthentication: false,
            }),
          put: sql.ManagedInstanceAzureADOnlyAuthenticationsCreateOrUpdate({
            ...instancePath(subscriptionId, output),
            authenticationName: SETTING_NAME,
            properties: { azureADOnlyAuthentication: false },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
