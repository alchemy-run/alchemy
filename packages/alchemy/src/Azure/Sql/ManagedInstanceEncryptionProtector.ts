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

/** The protector is a singleton named `current`. */
const SETTING_NAME = "current";

export interface ManagedInstanceEncryptionProtectorProps {
  /** Resource group of the managed instance. Changing it replaces the protector. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the protector. */
  managedInstance: string;
  /** `ServiceManaged` (Microsoft-managed key) or `AzureKeyVault` (customer-managed key). */
  serverKeyType: "ServiceManaged" | "AzureKeyVault";
  /**
   * Name of the instance key (see `Azure.Sql.ManagedInstanceKey`),
   * `<vault>_<key>_<version>`. Required for `AzureKeyVault`.
   */
  serverKeyName?: string;
  /** Automatically rotate to the latest key version (`AzureKeyVault` only). */
  autoRotationEnabled?: boolean;
}

export interface ManagedInstanceEncryptionProtector extends Resource<
  "Azure.Sql.ManagedInstanceEncryptionProtector",
  ManagedInstanceEncryptionProtectorProps,
  {
    /** ARM resource ID of the protector. */
    encryptionProtectorId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Protector type. */
    serverKeyType: string;
    /** Name of the key in use. */
    serverKeyName: string | undefined;
    /** Key Vault key URI, for `AzureKeyVault`. */
    uri: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The TDE protector of an Azure SQL Managed Instance — the key that
 * protects every database encryption key on the instance.
 *
 * This is a singleton setting that always exists on an instance.
 * Destroying the resource switches back to the service-managed key.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/transparent-data-encryption-byok-overview
 *
 * ### Customer-Managed Keys
 * **Example:** Protect TDE with a Key Vault key
 * ```typescript
 * const key = yield* Azure.Sql.ManagedInstanceKey("tde-key", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   uri: keyUriWithVersion,
 * });
 * yield* Azure.Sql.ManagedInstanceEncryptionProtector("protector", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   serverKeyType: "AzureKeyVault",
 *   serverKeyName: key.keyName,
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstanceEncryptionProtector =
  Resource<ManagedInstanceEncryptionProtector>(
    "Azure.Sql.ManagedInstanceEncryptionProtector",
  );

type Observed = sql.GetManagedInstanceEncryptionProtectorResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstanceEncryptionProtector({
      ...instancePath(subscriptionId, scope),
      encryptionProtectorName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): ManagedInstanceEncryptionProtector["Attributes"] => ({
  encryptionProtectorId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  serverKeyType: observed.properties?.serverKeyType ?? "ServiceManaged",
  serverKeyName: observed.properties?.serverKeyName,
  uri: observed.properties?.uri,
});

export const ManagedInstanceEncryptionProtectorProvider = () =>
  Provider.succeed(ManagedInstanceEncryptionProtector, {
    stables: ["encryptionProtectorId", "resourceGroup", "managedInstanceName"],

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
        serverKeyType: news.serverKeyType,
        serverKeyName:
          news.serverKeyName ??
          (news.serverKeyType === "ServiceManaged"
            ? "ServiceManaged"
            : undefined),
        autoRotationEnabled: news.autoRotationEnabled,
      };
      const fresh = yield* syncSetting({
        label: `sql managed instance encryption protector on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) => fieldsMatch(observed.properties, desired),
        put: sql.ManagedInstanceEncryptionProtectorsCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          encryptionProtectorName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed instance encryption protector on ${output.managedInstanceName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The protector cannot be removed; switch back to the service-managed key.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, {
              serverKeyType: "ServiceManaged",
              serverKeyName: "ServiceManaged",
            }),
          put: sql.ManagedInstanceEncryptionProtectorsCreateOrUpdate({
            ...instancePath(subscriptionId, output),
            encryptionProtectorName: SETTING_NAME,
            properties: {
              serverKeyType: "ServiceManaged",
              serverKeyName: "ServiceManaged",
            },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
