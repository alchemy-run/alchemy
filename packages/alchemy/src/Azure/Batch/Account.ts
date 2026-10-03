import * as batch from "@distilled.cloud/azure/batch";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getBatchAccount, matches, sameValue } from "./Common.ts";

export type BatchPoolAllocationMode = batch.PoolAllocationMode;
export type BatchAuthenticationMode = batch.AuthenticationMode;

export interface BatchAccountAutoStorage {
  /** ARM resource ID of the storage account used for application packages and task outputs. */
  storageAccountId: string;
  /**
   * How the Batch service authenticates to the storage account.
   * @default "StorageKeys"
   */
  authenticationMode?: "StorageKeys" | "BatchAccountManagedIdentity";
  /**
   * ARM resource ID of a user-assigned identity, assigned to pools, that
   * compute nodes use to reach the auto-storage account.
   */
  nodeIdentityResourceId?: string;
}

export interface BatchAccountIdentityProps {
  /** Identity type. */
  type: "SystemAssigned" | "UserAssigned" | "None";
  /** ARM resource IDs of the user-assigned identities (for `UserAssigned`). */
  userAssignedIdentityIds?: string[];
}

export interface AccountProps {
  /** Resource group the account is created in. Changing it replaces the account. */
  resourceGroup: string;
  /**
   * Account name: 3-24 lowercase letters and digits, unique within the
   * region (it is part of `<name>.<region>.batch.azure.com`). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Where pool VMs are allocated: in the Batch service's subscription
   * (`BatchService`) or in your subscription (`UserSubscription`, which
   * also needs `keyVaultReference`). Changing it replaces the account.
   * @default "BatchService"
   */
  poolAllocationMode?: BatchPoolAllocationMode;
  /**
   * Key vault associated with the account (required for
   * `UserSubscription` allocation). Changing it replaces the account.
   */
  keyVaultReference?: {
    /** ARM resource ID of the key vault. */
    id: string;
    /** Vault URL, e.g. `https://myvault.vault.azure.net/`. */
    url: string;
  };
  /**
   * Auto-storage account, required for application packages and task
   * output files.
   */
  autoStorage?: BatchAccountAutoStorage;
  /**
   * Whether the account's public endpoints accept traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /** IP rules for the account and node-management endpoints (only with public access enabled). */
  networkProfile?: batch.NetworkProfile;
  /**
   * Customer data encryption. Defaults to Microsoft-managed keys; a
   * `Microsoft.KeyVault` key needs a system-assigned identity with key
   * permissions.
   */
  encryption?: batch.EncryptionProperties;
  /**
   * Data-plane authentication modes the account accepts.
   * @default Azure's default (`["SharedKey", "AAD", "TaskAuthenticationToken"]`)
   */
  allowedAuthenticationModes?: BatchAuthenticationMode[];
  /** Managed identity of the account. */
  identity?: BatchAccountIdentityProps;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.Batch.Account",
  AccountProps,
  {
    /** Name of the Batch account. */
    accountName: string;
    /** ARM resource ID of the account. */
    accountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /** Data-plane endpoint, e.g. `<name>.<region>.batch.azure.com`. */
    accountEndpoint: string | undefined;
    /** Endpoint compute nodes use to reach the Batch node-management service. */
    nodeManagementEndpoint: string | undefined;
    /** Pool allocation mode. */
    poolAllocationMode: string | undefined;
    /** Dedicated core quota (absent for `UserSubscription` accounts). */
    dedicatedCoreQuota: number | undefined;
    /** Spot/low-priority core quota (absent for `UserSubscription` accounts). */
    lowPriorityCoreQuota: number | undefined;
    /** Maximum number of pools in the account. */
    poolQuota: number | undefined;
    /** ARM resource ID of the auto-storage account, if configured. */
    autoStorageAccountId: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary shared key (absent when `SharedKey` auth is disabled). */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary shared key (absent when `SharedKey` auth is disabled). */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Batch account — the container for pools of compute nodes, jobs,
 * and application packages used for large-scale parallel and HPC workloads.
 * The account itself is free; compute nodes in its pools bill as VMs.
 *
 * @see https://learn.microsoft.com/azure/batch/accounts
 *
 * ### Creating a Batch Account
 * **Example:** Basic account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("batch");
 * const account = yield* Azure.Batch.Account("jobs", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Account with auto-storage for application packages
 * ```typescript
 * const storage = yield* Azure.Storage.StorageAccount("batchfiles", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const account = yield* Azure.Batch.Account("jobs", {
 *   resourceGroup: group.resourceGroupName,
 *   autoStorage: { storageAccountId: storage.storageAccountId },
 * });
 * ```
 *
 * ### Restricting Authentication
 * **Example:** Entra ID only
 * ```typescript
 * const account = yield* Azure.Batch.Account("jobs", {
 *   resourceGroup: group.resourceGroupName,
 *   allowedAuthenticationModes: ["AAD"],
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.Batch.Account");

type ObservedAccount = batch.GetBatchAccountResponse;

const createAccountName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const lower = (value: string | undefined) => value?.toLowerCase();

const sharedKeyAllowed = (account: ObservedAccount) => {
  const modes = account.properties?.allowedAuthenticationModes;
  return modes == null || modes.includes("SharedKey");
};

const readKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  account: ObservedAccount,
) =>
  sharedKeyAllowed(account)
    ? batch
        .GetBatchAccountKeys({ subscriptionId, resourceGroupName, accountName })
        .pipe(Effect.map((keys) => keys as batch.BatchAccountKeys | undefined))
    : Effect.succeed(undefined);

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
  keys: batch.BatchAccountKeys | undefined,
): Account["Attributes"] => {
  const props = account.properties;
  return {
    accountName: name,
    accountId: account.id ?? "",
    resourceGroup,
    location: account.location,
    accountEndpoint: props?.accountEndpoint,
    nodeManagementEndpoint: props?.nodeManagementEndpoint,
    poolAllocationMode: props?.poolAllocationMode,
    dedicatedCoreQuota: props?.dedicatedCoreQuota ?? undefined,
    lowPriorityCoreQuota: props?.lowPriorityCoreQuota ?? undefined,
    poolQuota: props?.poolQuota,
    autoStorageAccountId: props?.autoStorage?.storageAccountId,
    principalId: account.identity?.principalId,
    primaryKey: keys?.primary ? Redacted.make(keys.primary) : undefined,
    secondaryKey: keys?.secondary ? Redacted.make(keys.secondary) : undefined,
    tags: userTags(account.tags),
  };
};

const toAutoStorage = (
  autoStorage: BatchAccountAutoStorage,
): batch.AutoStorageBaseProperties => ({
  storageAccountId: autoStorage.storageAccountId,
  authenticationMode: autoStorage.authenticationMode,
  nodeIdentityReference: autoStorage.nodeIdentityResourceId
    ? { resourceId: autoStorage.nodeIdentityResourceId }
    : undefined,
});

const toIdentity = (
  identity: BatchAccountIdentityProps,
): batch.BatchAccountIdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentityIds?.length
    ? Object.fromEntries(identity.userAssignedIdentityIds.map((i) => [i, {}]))
    : undefined,
});

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a.map((x) => x.toLowerCase()));
  const right = new Set(b.map((x) => x.toLowerCase()));
  return left.size === right.size && [...left].every((x) => right.has(x));
};

const identityMatches = (
  desired: BatchAccountIdentityProps,
  observed: batch.BatchAccountIdentity | undefined,
) =>
  lower(desired.type) === lower(observed?.type ?? "None") &&
  sameSet(
    desired.userAssignedIdentityIds ?? [],
    Object.keys(observed?.userAssignedIdentities ?? {}),
  );

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["accountName", "accountId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* batch
        .ListBatchAccount({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListBatchAccount", page)),
        );
      return (page.value ?? []).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          group !== undefined &&
          account.name !== undefined
          ? [
              toAttrs(
                group,
                account.name,
                account as ObservedAccount,
                undefined,
              ),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.accountName) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        lower(news.poolAllocationMode ?? "BatchService") !==
          lower(olds?.poolAllocationMode ?? "BatchService") ||
        !sameValue(news.keyVaultReference, olds?.keyVaultReference)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.accountName ?? olds?.name ?? (yield* createAccountName(id));
      const observed = yield* getBatchAccount(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      if (!(yield* isOwned(id, observed.tags))) {
        return Unowned(toAttrs(resourceGroup, name, observed, undefined));
      }
      const keys = yield* readKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Batch");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `batch account ${name}`;
      const get = getBatchAccount(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        label,
        get,
        (account) => account.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (202 + empty body).
      if (observed === undefined) {
        yield* batch.CreateBatchAccount({
          ...where,
          location,
          tags,
          identity: news.identity ? toIdentity(news.identity) : undefined,
          properties: {
            poolAllocationMode: news.poolAllocationMode,
            keyVaultReference: news.keyVaultReference,
            autoStorage: news.autoStorage
              ? toAutoStorage(news.autoStorage)
              : undefined,
            publicNetworkAccess: news.publicNetworkAccess,
            networkProfile: news.networkProfile,
            encryption: news.encryption,
            allowedAuthenticationModes: news.allowedAuthenticationModes,
          },
        });
      }
      observed = yield* waitReady;

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: batch.BatchAccountUpdateProperties = {};
      if (news.autoStorage) {
        const desired = toAutoStorage(news.autoStorage);
        const current = props.autoStorage;
        if (
          lower(current?.storageAccountId) !==
            lower(desired.storageAccountId) ||
          lower(current?.authenticationMode ?? "StorageKeys") !==
            lower(desired.authenticationMode ?? "StorageKeys") ||
          !matches(
            desired.nodeIdentityReference,
            current?.nodeIdentityReference,
          )
        ) {
          changed.autoStorage = desired;
        }
      }
      if (
        news.publicNetworkAccess !== undefined &&
        lower(props.publicNetworkAccess ?? undefined) !==
          lower(news.publicNetworkAccess)
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        news.networkProfile !== undefined &&
        !matches(news.networkProfile, props.networkProfile ?? undefined)
      ) {
        changed.networkProfile = news.networkProfile;
      }
      if (
        news.encryption !== undefined &&
        !matches(news.encryption, props.encryption)
      ) {
        changed.encryption = news.encryption;
      }
      if (
        news.allowedAuthenticationModes !== undefined &&
        !sameSet(
          news.allowedAuthenticationModes,
          props.allowedAuthenticationModes ?? [],
        )
      ) {
        changed.allowedAuthenticationModes = news.allowedAuthenticationModes;
      }
      const identityChanged =
        news.identity !== undefined &&
        !identityMatches(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
        yield* batch.UpdateBatchAccount({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity:
            identityChanged && news.identity
              ? toIdentity(news.identity)
              : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitReady;
      }

      const keys = yield* readKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        batch.DeleteBatchAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
        }),
      );
      // Deleting an account also deletes its pools and applications.
      yield* waitUntilGone(
        `batch account ${output.accountName}`,
        getBatchAccount(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
