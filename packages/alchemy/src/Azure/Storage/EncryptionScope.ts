import * as storage from "@distilled.cloud/azure/storage";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createStorageChildName,
  isAccountOwnedByStack,
} from "./StorageOwnership.ts";

export type EncryptionScopeSource = storage.EncryptionScopeSource;

export interface EncryptionScopeProps {
  /**
   * Resource group of the storage account. Changing it replaces the scope.
   */
  resourceGroup: string;
  /** Storage account that holds the scope. Changing it replaces the scope. */
  storageAccount: string;
  /**
   * Scope name: 3-63 lowercase letters, digits, and single hyphens,
   * starting and ending with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * scope.
   */
  name?: string;
  /**
   * Key provider: Microsoft-managed keys (`Microsoft.Storage`) or a
   * customer-managed Key Vault key (`Microsoft.KeyVault`, requires
   * `keyUri`).
   * @default "Microsoft.Storage"
   */
  source?: EncryptionScopeSource;
  /**
   * Key Vault key identifier (with or without a version) when `source` is
   * `Microsoft.KeyVault`. The account's managed identity needs wrap/unwrap
   * access to the key.
   */
  keyUri?: string;
  /**
   * Apply a second layer of platform-managed encryption at rest. Changing
   * it replaces the scope.
   * @default false
   */
  requireInfrastructureEncryption?: boolean;
  /**
   * Whether the scope accepts new writes. Disabling a scope blocks writes
   * and reads of blobs encrypted with it.
   * @default true
   */
  enabled?: boolean;
}

export interface EncryptionScope extends Resource<
  "Azure.Storage.EncryptionScope",
  EncryptionScopeProps,
  {
    /** Name of the scope; use it as a container's default encryption scope. */
    encryptionScopeName: string;
    /** Storage account that holds the scope. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the scope. */
    encryptionScopeId: string;
    /** Key provider of the scope. */
    source: string;
    /** `Enabled` or `Disabled`. */
    state: string;
    /** Whether infrastructure (double) encryption is applied. */
    requireInfrastructureEncryption: boolean;
    /** Key Vault key in use, including its version (Key Vault scopes only). */
    currentVersionedKeyIdentifier: string | undefined;
    /** When the scope was created. */
    creationTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An encryption scope in a Storage account: a named key (Microsoft-managed
 * or a customer-managed Key Vault key) that containers and blobs can be
 * encrypted with.
 *
 * Azure cannot delete encryption scopes. Destroying the resource
 * **disables** the scope; it remains (disabled) until the storage account
 * is deleted, and deploying a scope with the same name re-enables it.
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/encryption-scope-overview
 *
 * ### Creating an Encryption Scope
 * **Example:** Microsoft-managed key scope
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const scope = yield* Azure.Storage.EncryptionScope("tenant-a", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Scope with infrastructure encryption
 * ```typescript
 * const scope = yield* Azure.Storage.EncryptionScope("sensitive", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   requireInfrastructureEncryption: true,
 * });
 * ```
 *
 * ### Customer-Managed Keys
 * **Example:** Key Vault key scope
 * ```typescript
 * const scope = yield* Azure.Storage.EncryptionScope("cmk", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   source: "Microsoft.KeyVault",
 *   keyUri: "https://my-vault.vault.azure.net/keys/storage-key",
 * });
 * ```
 *
 * @resource
 */
export const EncryptionScope = Resource<EncryptionScope>(
  "Azure.Storage.EncryptionScope",
);

const getScope = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  encryptionScopeName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetEncryptionScope({
      subscriptionId,
      resourceGroupName,
      accountName,
      encryptionScopeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  scope: storage.GetEncryptionScopeResponse,
): EncryptionScope["Attributes"] => ({
  encryptionScopeName: name,
  storageAccount,
  resourceGroup,
  encryptionScopeId: scope.id ?? "",
  source: scope.properties?.source ?? "Microsoft.Storage",
  state: scope.properties?.state ?? "Enabled",
  requireInfrastructureEncryption:
    scope.properties?.requireInfrastructureEncryption ?? false,
  currentVersionedKeyIdentifier:
    scope.properties?.keyVaultProperties?.currentVersionedKeyIdentifier,
  creationTime: scope.properties?.creationTime,
});

const lower = (value: string | undefined) => value?.toLowerCase();

export const EncryptionScopeProvider = () =>
  Provider.succeed(EncryptionScope, {
    stables: [
      "encryptionScopeName",
      "storageAccount",
      "resourceGroup",
      "encryptionScopeId",
      "requireInfrastructureEncryption",
    ],

    // Scopes live inside a storage account and cannot be deleted.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name !== output.encryptionScopeName) ||
        (news.requireInfrastructureEncryption ?? false) !==
          output.requireInfrastructureEncryption
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name =
        output?.encryptionScopeName ??
        olds?.name ??
        (yield* createStorageChildName(id));
      const observed = yield* getScope(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name =
        news.name ??
        output?.encryptionScopeName ??
        (yield* createStorageChildName(id));
      const source = news.source ?? "Microsoft.Storage";
      const state = news.enabled === false ? "Disabled" : "Enabled";
      const keyVaultProperties =
        news.keyUri !== undefined ? { keyUri: news.keyUri } : undefined;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        encryptionScopeName: name,
      };
      const get = getScope(subscriptionId, resourceGroup, storageAccount, name);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* storage.PutEncryptionScope({
          ...where,
          properties: {
            source,
            state,
            keyVaultProperties,
            requireInfrastructureEncryption:
              news.requireInfrastructureEncryption,
          },
        });
      } else {
        // Sync source, key, and state against the observed scope.
        const props = observed.properties ?? {};
        const changed: storage.EncryptionScopePropertiesInput = {};
        if (lower(props.source) !== lower(source)) changed.source = source;
        if (
          keyVaultProperties !== undefined &&
          lower(props.keyVaultProperties?.keyUri) !==
            lower(keyVaultProperties.keyUri)
        ) {
          changed.keyVaultProperties = keyVaultProperties;
        }
        if (lower(props.state) !== lower(state)) changed.state = state;
        if (Object.keys(changed).length > 0) {
          if (changed.source !== undefined && keyVaultProperties) {
            changed.keyVaultProperties = keyVaultProperties;
          }
          yield* storage.PatchEncryptionScope({
            ...where,
            properties: changed,
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `encryption scope ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    // Encryption scopes cannot be deleted; disable the scope instead.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.PatchEncryptionScope({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          encryptionScopeName: output.encryptionScopeName,
          properties: { state: "Disabled" },
        }),
      );
    }),

    nuke: { skip: true },
  });
