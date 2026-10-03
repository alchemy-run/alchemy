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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isManagedInstanceOwnedByStack, lower } from "./common.ts";
import {
  instancePath,
  type InstanceScope,
  serverKeyNameOf,
} from "./setting.ts";

export interface ManagedInstanceKeyProps {
  /** Resource group of the managed instance. Changing it replaces the key. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the key. */
  managedInstance: string;
  /**
   * Versioned Key Vault key URI, e.g.
   * `https://myvault.vault.azure.net/keys/tde/0123456789abcdef`. The vault
   * needs soft delete and purge protection, and the instance's managed
   * identity needs `get`, `wrapKey`, and `unwrapKey` permissions on the
   * key (e.g. the `Key Vault Crypto Service Encryption User` role).
   * Changing it replaces the key.
   */
  uri: string;
}

export interface ManagedInstanceKey extends Resource<
  "Azure.Sql.ManagedInstanceKey",
  ManagedInstanceKeyProps,
  {
    /** Name of the instance key: `<vault>_<key>_<version>`. */
    keyName: string;
    /** ARM resource ID of the instance key. */
    keyId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Key Vault key URI. */
    uri: string;
    /** Key type (`AzureKeyVault`). */
    serverKeyType: string;
    /** Thumbprint of the key. */
    thumbprint: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Key Vault key registered with an Azure SQL Managed Instance, so it can
 * become the instance's TDE protector (see
 * `Azure.Sql.ManagedInstanceEncryptionProtector`).
 *
 * The key's name is derived from its URI (`<vault>_<key>_<version>`). A
 * key cannot be removed while it is the instance's current protector.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/scripts/transparent-data-encryption-byok-powershell
 *
 * ### Registering a Customer-Managed Key
 * **Example:** Register a Key Vault key with a managed instance
 * ```typescript
 * const key = yield* Azure.Sql.ManagedInstanceKey("tde-key", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   uri: "https://myvault.vault.azure.net/keys/tde/0123456789abcdef",
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstanceKey = Resource<ManagedInstanceKey>(
  "Azure.Sql.ManagedInstanceKey",
);

// A key whose name is not `<vault>_<key>_<version>` cannot exist.
const getKey = (subscriptionId: string, scope: InstanceScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstanceKey({
      ...instancePath(subscriptionId, scope),
      keyName: name,
    }),
  ).pipe(
    Effect.catchTag("SqlServerKeyNameInvalid", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  scope: InstanceScope,
  name: string,
  uri: string,
  key: sql.GetManagedInstanceKeyResponse,
): ManagedInstanceKey["Attributes"] => ({
  keyName: name,
  keyId: key.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  uri: key.properties?.uri ?? uri,
  serverKeyType: key.properties?.serverKeyType ?? "AzureKeyVault",
  thumbprint: key.properties?.thumbprint,
});

export const ManagedInstanceKeyProvider = () =>
  Provider.succeed(ManagedInstanceKey, {
    stables: ["keyName", "keyId", "resourceGroup", "managedInstanceName"],

    // Keys live inside a managed instance; they are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName) ||
        lower(serverKeyNameOf(news.uri)) !== lower(output.keyName)
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
      const uri = output?.uri ?? olds?.uri;
      if (
        resourceGroup === undefined ||
        managedInstanceName === undefined ||
        uri === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName };
      const name = output?.keyName ?? serverKeyNameOf(uri);
      const observed = yield* getKey(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, uri, observed);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(
          subscriptionId,
          resourceGroup,
          managedInstanceName,
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
      const name = serverKeyNameOf(news.uri);
      const get = getKey(subscriptionId, scope, name);

      // Observe, then ensure. A key is identified by its URI; nothing else
      // is mutable.
      const observed = yield* get;
      if (observed === undefined) {
        yield* sql.ManagedInstanceKeysCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          keyName: name,
          properties: { serverKeyType: "AzureKeyVault", uri: news.uri },
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql managed instance key ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, news.uri, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteManagedInstanceKey({
          ...instancePath(subscriptionId, output),
          keyName: output.keyName,
        }),
      ).pipe(Effect.catchTag("SqlServerKeyNameInvalid", () => Effect.void));
      yield* waitUntilGone(
        `sql managed instance key ${output.keyName}`,
        getKey(subscriptionId, output, output.keyName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
