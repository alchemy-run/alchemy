import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isOwnedChild, waitForChild, whileAccountBusy } from "./Shared.ts";

export interface ClientEncryptionKeyWrapMetadata {
  /** Name of the key wrap metadata, e.g. the Key Vault key name. */
  name: string;
  /**
   * Key store provider type.
   * @default "AZURE_KEY_VAULT"
   */
  type?: string;
  /** Key encryption key reference, e.g. the Key Vault key URL. */
  value: string;
  /**
   * Algorithm used to wrap the data encryption key.
   * @default "RSA-OAEP"
   */
  algorithm?: string;
}

export interface ClientEncryptionKeyProps {
  /** Resource group of the account. Changing it replaces the key. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the key. */
  account: string;
  /** Name of the SQL database, e.g. `database.databaseName`. Changing it replaces the key. */
  database: string;
  /**
   * Key name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the key.
   */
  name?: string;
  /**
   * Data encryption algorithm. Changing it replaces the key.
   * @default "AEAD_AES_256_CBC_HMAC_SHA256"
   */
  encryptionAlgorithm?: string;
  /**
   * Base64 data encryption key, wrapped by the key encryption key in
   * `keyWrapMetadata`. Updated in place (rewrap).
   */
  wrappedDataEncryptionKey: string;
  /** Key encryption key that wraps the data encryption key. Updated in place. */
  keyWrapMetadata: ClientEncryptionKeyWrapMetadata;
}

export interface ClientEncryptionKey extends Resource<
  "Azure.CosmosDB.ClientEncryptionKey",
  ClientEncryptionKeyProps,
  {
    /** Name of the key. */
    clientEncryptionKeyName: string;
    /** Name of the SQL database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the key. */
    clientEncryptionKeyId: string;
    /** Data encryption algorithm. */
    encryptionAlgorithm: string | undefined;
    /** Key encryption key reference. */
    keyWrapMetadataValue: string | undefined;
    /** Entity tag (`_etag`). */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A client encryption key (wrapped data encryption key) in an Azure Cosmos
 * DB for NoSQL database, used by containers with a client encryption
 * policy (Always Encrypted).
 *
 * Wrap a random data encryption key with a Key Vault key client-side and
 * pass the base64 result. Cosmos DB has no API to delete a client
 * encryption key: it is removed together with its database, so destroying
 * this resource only forgets it. Keys cannot be tagged; Alchemy treats one
 * it created (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/how-to-always-encrypted
 *
 * ### Creating a Key
 * **Example:** Data encryption key wrapped by a Key Vault key
 * ```typescript
 * const cek = yield* Azure.CosmosDB.ClientEncryptionKey("ssn-key", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   database: database.databaseName,
 *   wrappedDataEncryptionKey: wrappedKeyBase64,
 *   keyWrapMetadata: {
 *     name: "cmk",
 *     value: "https://my-vault.vault.azure.net/keys/cmk/0123456789abcdef",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ClientEncryptionKey = Resource<ClientEncryptionKey>(
  "Azure.CosmosDB.ClientEncryptionKey",
);

type ObservedKey = cosmos.GetSqlResourceClientEncryptionKeyResponse;

const DEFAULT_ALGORITHM = "AEAD_AES_256_CBC_HMAC_SHA256";

const createKeyName = (id: string) => createPhysicalName({ id, maxLength: 255 });

const getKey = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  clientEncryptionKeyName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceClientEncryptionKey({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      clientEncryptionKeyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  name: string,
  key: ObservedKey,
): ClientEncryptionKey["Attributes"] => ({
  clientEncryptionKeyName: name,
  database,
  account,
  resourceGroup,
  clientEncryptionKeyId: key.id ?? "",
  encryptionAlgorithm: key.properties?.resource?.encryptionAlgorithm,
  keyWrapMetadataValue: key.properties?.resource?.keyWrapMetadata?.value,
  etag: key.properties?.resource?._etag,
});

export const ClientEncryptionKeyProvider = () =>
  Provider.succeed(ClientEncryptionKey, {
    stables: [
      "clientEncryptionKeyName",
      "database",
      "account",
      "resourceGroup",
      "clientEncryptionKeyId",
      "encryptionAlgorithm",
    ],

    // Keys disappear with their database.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        news.database !== output.database ||
        (news.name !== undefined &&
          news.name !== output.clientEncryptionKeyName) ||
        (news.encryptionAlgorithm ?? DEFAULT_ALGORITHM) !==
          (output.encryptionAlgorithm ?? DEFAULT_ALGORITHM)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const database = output?.database ?? olds?.database;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        database === undefined
      ) {
        return undefined;
      }
      const name =
        output?.clientEncryptionKeyName ??
        olds?.name ??
        (yield* createKeyName(id));
      const observed = yield* getKey(
        subscriptionId,
        resourceGroup,
        account,
        database,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, database, name, observed);
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, database } = news;
      const name =
        news.name ??
        output?.clientEncryptionKeyName ??
        (yield* createKeyName(id));
      const keyWrapMetadata = {
        name: news.keyWrapMetadata.name,
        type: news.keyWrapMetadata.type ?? "AZURE_KEY_VAULT",
        value: news.keyWrapMetadata.value,
        algorithm: news.keyWrapMetadata.algorithm ?? "RSA-OAEP",
      };
      const get = getKey(subscriptionId, resourceGroup, account, database, name);
      const converged = (key: ObservedKey) => {
        const resource = key.properties?.resource;
        return (
          resource?.wrappedDataEncryptionKey ===
            news.wrappedDataEncryptionKey &&
          resource?.keyWrapMetadata?.name === keyWrapMetadata.name &&
          resource?.keyWrapMetadata?.type === keyWrapMetadata.type &&
          resource?.keyWrapMetadata?.value === keyWrapMetadata.value &&
          resource?.keyWrapMetadata?.algorithm === keyWrapMetadata.algorithm
        );
      };

      // Observe.
      let observed = yield* get;

      // Ensure + sync (rewrap). The algorithm is kept as observed.
      if (observed === undefined || !converged(observed)) {
        yield* cosmos
          .SqlResourcesCreateUpdateClientEncryptionKey({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            databaseName: database,
            clientEncryptionKeyName: name,
            properties: {
              resource: {
                id: name,
                encryptionAlgorithm:
                  observed?.properties?.resource?.encryptionAlgorithm ??
                  news.encryptionAlgorithm ??
                  DEFAULT_ALGORITHM,
                wrappedDataEncryptionKey: news.wrappedDataEncryptionKey,
                keyWrapMetadata,
              },
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB client encryption key ${name}`,
          get,
          converged,
        );
      }

      return toAttrs(resourceGroup, account, database, name, observed);
    }),

    // Cosmos DB has no delete operation for client encryption keys; the key
    // is removed with its database.
    delete: Effect.fn(function* () {}),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.SqlDatabase",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
