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
import { fieldsMatch, isServerOwnedByStack, lower } from "./common.ts";
import {
  retryInProgress,
  serverPath,
  type ServerScope,
  syncSetting,
} from "./setting.ts";

/** The protector is a singleton named `current`. */
const SETTING_NAME = "current";

export interface EncryptionProtectorProps {
  /** Resource group of the server. Changing it replaces the protector. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the protector. */
  server: string;
  /**
   * Protector type: `ServiceManaged` (Microsoft-managed key) or
   * `AzureKeyVault` (customer-managed key).
   */
  serverKeyType: "ServiceManaged" | "AzureKeyVault";
  /**
   * Name of the server key (see `Azure.Sql.ServerKey`), in the form
   * `<vault>_<key>_<version>`. Required for `AzureKeyVault`.
   */
  serverKeyName?: string;
  /** Automatically rotate to the latest key version (`AzureKeyVault` only). */
  autoRotationEnabled?: boolean;
}

export interface EncryptionProtector extends Resource<
  "Azure.Sql.EncryptionProtector",
  EncryptionProtectorProps,
  {
    /** ARM resource ID of the protector. */
    encryptionProtectorId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Protector type. */
    serverKeyType: string;
    /** Name of the server key in use. */
    serverKeyName: string | undefined;
    /** Key Vault key URI, for `AzureKeyVault`. */
    uri: string | undefined;
    /** Whether automatic key rotation is enabled. */
    autoRotationEnabled: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * The Transparent Data Encryption (TDE) protector of an Azure SQL server —
 * the key that protects every database encryption key on the server.
 * Either Microsoft-managed (`ServiceManaged`) or a customer-managed Key
 * Vault key registered with `Azure.Sql.ServerKey`.
 *
 * This is a singleton setting that always exists on a server. Destroying
 * the resource switches the server back to the service-managed key.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/transparent-data-encryption-byok-overview
 *
 * ### Customer-Managed Keys
 * **Example:** Protect TDE with a Key Vault key
 * ```typescript
 * const serverKey = yield* Azure.Sql.ServerKey("tde-key", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   uri: keyUriWithVersion,
 * });
 * yield* Azure.Sql.EncryptionProtector("protector", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   serverKeyType: "AzureKeyVault",
 *   serverKeyName: serverKey.serverKeyName,
 *   autoRotationEnabled: true,
 * });
 * ```
 *
 * ### Service-Managed Keys
 * **Example:** Use the Microsoft-managed key
 * ```typescript
 * yield* Azure.Sql.EncryptionProtector("protector", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   serverKeyType: "ServiceManaged",
 * });
 * ```
 *
 * @resource
 */
export const EncryptionProtector = Resource<EncryptionProtector>(
  "Azure.Sql.EncryptionProtector",
);

type Observed = sql.GetEncryptionProtectorResponse;

const getSetting = (subscriptionId: string, scope: ServerScope) =>
  orUndefinedIfNotFound(
    sql.GetEncryptionProtector({
      ...serverPath(subscriptionId, scope),
      encryptionProtectorName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: ServerScope,
  observed: Observed,
): EncryptionProtector["Attributes"] => ({
  encryptionProtectorId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  serverKeyType: observed.properties?.serverKeyType ?? "ServiceManaged",
  serverKeyName: observed.properties?.serverKeyName,
  uri: observed.properties?.uri,
  autoRotationEnabled: observed.properties?.autoRotationEnabled,
});

export const EncryptionProtectorProvider = () =>
  Provider.succeed(EncryptionProtector, {
    stables: ["encryptionProtectorId", "resourceGroup", "serverName"],

    // A singleton setting of its server; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, serverName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.serverName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: ServerScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
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
        label: `sql encryption protector on ${scope.serverName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) => fieldsMatch(observed.properties, desired),
        put: sql.EncryptionProtectorsCreateOrUpdate({
          ...serverPath(subscriptionId, scope),
          encryptionProtectorName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The protector cannot be removed; switch back to the service-managed key.
      yield* ignoreNotFound(
        retryInProgress(
          sql.EncryptionProtectorsCreateOrUpdate({
            ...serverPath(subscriptionId, output),
            encryptionProtectorName: SETTING_NAME,
            properties: {
              serverKeyType: "ServiceManaged",
              serverKeyName: "ServiceManaged",
            },
          }),
        ),
      );
    }),

    nuke: { singleton: true },
  });
