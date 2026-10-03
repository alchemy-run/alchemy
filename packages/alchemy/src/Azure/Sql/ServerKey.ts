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
import { isServerOwnedByStack, lower } from "./common.ts";
import { serverKeyNameOf, serverPath, type ServerScope } from "./setting.ts";

export interface ServerKeyProps {
  /** Resource group of the server. Changing it replaces the key. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the key. */
  server: string;
  /**
   * Versioned Key Vault key URI, e.g.
   * `https://myvault.vault.azure.net/keys/tde/0123456789abcdef`. The vault
   * needs soft delete and purge protection, and the server's managed
   * identity needs `get`, `wrapKey`, and `unwrapKey` permissions on the
   * key (e.g. the `Key Vault Crypto Service Encryption User` role).
   * Changing it replaces the key.
   */
  uri: string;
}

export interface ServerKey extends Resource<
  "Azure.Sql.ServerKey",
  ServerKeyProps,
  {
    /** Name of the server key: `<vault>_<key>_<version>`. */
    serverKeyName: string;
    /** ARM resource ID of the server key. */
    serverKeyId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
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
 * A Key Vault key registered with an Azure SQL server, so it can become
 * the server's TDE protector (see `Azure.Sql.EncryptionProtector`).
 *
 * The key's name is derived from its URI (`<vault>_<key>_<version>`).
 * A key cannot be removed while it is the server's current protector.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/transparent-data-encryption-byok-configure
 *
 * ### Registering a Customer-Managed Key
 * **Example:** Register a Key Vault key with a server
 * ```typescript
 * const serverKey = yield* Azure.Sql.ServerKey("tde-key", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   uri: "https://myvault.vault.azure.net/keys/tde/0123456789abcdef",
 * });
 * ```
 *
 * @resource
 */
export const ServerKey = Resource<ServerKey>("Azure.Sql.ServerKey");

// A key whose name is not `<vault>_<key>_<version>` cannot exist.
const getKey = (subscriptionId: string, scope: ServerScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetServerKey({ ...serverPath(subscriptionId, scope), keyName: name }),
  ).pipe(
    Effect.catchTag("SqlServerKeyNameInvalid", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  scope: ServerScope,
  name: string,
  uri: string,
  key: sql.GetServerKeyResponse,
): ServerKey["Attributes"] => ({
  serverKeyName: name,
  serverKeyId: key.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  uri: key.properties?.uri ?? uri,
  serverKeyType: key.properties?.serverKeyType ?? "AzureKeyVault",
  thumbprint: key.properties?.thumbprint,
});

export const ServerKeyProvider = () =>
  Provider.succeed(ServerKey, {
    stables: ["serverKeyName", "serverKeyId", "resourceGroup", "serverName"],

    // Keys live inside a server; they are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(serverKeyNameOf(news.uri)) !== lower(output.serverKeyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const uri = output?.uri ?? olds?.uri;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        uri === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName };
      const name = output?.serverKeyName ?? serverKeyNameOf(uri);
      const observed = yield* getKey(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, uri, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
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
      const name = serverKeyNameOf(news.uri);
      const get = getKey(subscriptionId, scope, name);

      // Observe, then ensure. A key is identified by its URI; nothing else
      // is mutable.
      const observed = yield* get;
      if (observed === undefined) {
        yield* sql.ServerKeysCreateOrUpdate({
          ...serverPath(subscriptionId, scope),
          keyName: name,
          properties: { serverKeyType: "AzureKeyVault", uri: news.uri },
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql server key ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, news.uri, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteServerKey({
          ...serverPath(subscriptionId, output),
          keyName: output.serverKeyName,
        }),
      ).pipe(Effect.catchTag("SqlServerKeyNameInvalid", () => Effect.void));
      yield* waitUntilGone(
        `sql server key ${output.serverKeyName}`,
        getKey(subscriptionId, output, output.serverKeyName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
