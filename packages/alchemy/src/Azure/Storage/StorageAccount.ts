import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  orUndefinedIfNotFound,
  requireSinglePage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type StorageSkuName = storage.SkuName;
export type StorageKind = storage.Kind;
export type StorageAccessTier = storage.AccessTier;
export type MinimumTlsVersion = storage.MinimumTlsVersion;

export interface StorageAccountProps {
  /**
   * Resource group the account is created in. Changing it replaces the
   * account.
   */
  resourceGroup: string;
  /**
   * Globally unique account name: 3-24 lowercase letters and digits. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Replication SKU. Some conversions (e.g. to or from `Premium_*`) are not
   * supported in place and fail with an Azure error. Adding or removing geo
   * replication (e.g. `Standard_LRS` → `Standard_GRS`) keeps syncing in the
   * background long after the deploy returns; until Azure finishes, further
   * SKU changes and deleting the account fail with
   * `PendingTransactionAlreadyExists`.
   * @default "Standard_LRS"
   */
  sku?: StorageSkuName;
  /**
   * Account kind. Changing it replaces the account.
   * @default "StorageV2"
   */
  kind?: StorageKind;
  /**
   * Default access tier for blobs (`Hot`, `Cool`, `Cold`).
   * @default Azure's default for the kind (`Hot`)
   */
  accessTier?: StorageAccessTier;
  /**
   * Enable a hierarchical namespace (Azure Data Lake Storage Gen2).
   * Changing it replaces the account.
   * @default false
   */
  isHnsEnabled?: boolean;
  /**
   * Allow containers to be configured for anonymous public read access.
   * @default false
   */
  allowBlobPublicAccess?: boolean;
  /**
   * Allow requests authorized with the account access keys (Shared Key and
   * account SAS). Set `false` to require Microsoft Entra ID authorization.
   * @default Azure's default (`true`)
   */
  allowSharedKeyAccess?: boolean;
  /**
   * Minimum TLS version accepted by the account's endpoints.
   * @default "TLS1_2"
   */
  minimumTlsVersion?: MinimumTlsVersion;
  /**
   * Reject plain HTTP requests.
   * @default true
   */
  supportsHttpsTrafficOnly?: boolean;
  /**
   * Whether the public endpoints accept traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageAccountEndpoints {
  /** Blob service endpoint, e.g. `https://{name}.blob.core.windows.net/`. */
  blob: string | undefined;
  /** Queue service endpoint. */
  queue: string | undefined;
  /** Table service endpoint. */
  table: string | undefined;
  /** File service endpoint. */
  file: string | undefined;
  /** Data Lake Storage (DFS) endpoint. */
  dfs: string | undefined;
  /** Static website endpoint. */
  web: string | undefined;
}

export interface StorageAccount extends Resource<
  "Azure.Storage.StorageAccount",
  StorageAccountProps,
  {
    /** Name of the storage account. */
    storageAccountName: string;
    /** ARM resource ID of the account; use it as a role-assignment scope. */
    storageAccountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /** Replication SKU. */
    sku: string;
    /** Account kind. */
    kind: string;
    /** Whether the hierarchical namespace (Data Lake Gen2) is enabled. */
    isHnsEnabled: boolean;
    /** Primary service endpoints. */
    primaryEndpoints: StorageAccountEndpoints;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Storage account — the namespace for Blob, Queue, Table, and File
 * storage. Accounts are secure by default: HTTPS only, TLS 1.2 minimum, and
 * anonymous blob access disabled.
 *
 * @see https://learn.microsoft.com/azure/storage/common/storage-account-overview
 *
 * ### Creating a Storage Account
 * **Example:** General-purpose v2 account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Geo-redundant account that requires Entra ID auth
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_GRS",
 *   allowSharedKeyAccess: false,
 * });
 * ```
 *
 * ### Data Lake Storage
 * **Example:** Account with a hierarchical namespace
 * ```typescript
 * const lake = yield* Azure.Storage.StorageAccount("lake", {
 *   resourceGroup: group.resourceGroupName,
 *   isHnsEnabled: true,
 * });
 * ```
 *
 * @resource
 */
export const StorageAccount = Resource<StorageAccount>(
  "Azure.Storage.StorageAccount",
);

type ObservedAccount = storage.GetStorageAccountPropertiesResponse;

const createAccountName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetStorageAccountProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const resourceGroupOf = (armId: string | undefined) =>
  armId?.match(/\/resourceGroups\/([^/]+)/i)?.[1];

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): StorageAccount["Attributes"] => {
  const endpoints = account.properties?.primaryEndpoints;
  return {
    storageAccountName: name,
    storageAccountId: account.id ?? "",
    resourceGroup,
    location: account.location,
    sku: account.sku?.name ?? "",
    kind: account.kind ?? "",
    isHnsEnabled: account.properties?.isHnsEnabled ?? false,
    primaryEndpoints: {
      blob: endpoints?.blob,
      queue: endpoints?.queue,
      table: endpoints?.table,
      file: endpoints?.file,
      dfs: endpoints?.dfs,
      web: endpoints?.web,
    },
    tags: userTags(account.tags),
  };
};

const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * A replication (SKU) change keeps running in the background after the
 * account reports `Succeeded`, and no account property exposes it. Updates
 * and deletes fail with `PendingTransactionAlreadyExists` or
 * `StorageAccountOperationInProgress` until it finishes. Short transactions
 * are waited out; a long geo sync surfaces the typed error so the operator
 * can retry later.
 */
const whileGeoChangePending = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "PendingTransactionAlreadyExists" ||
    e._tag === "StorageAccountOperationInProgress",
  schedule: Schedule.spaced("10 seconds"),
  times: 6,
} as const;

export const StorageAccountProvider = () =>
  Provider.succeed(StorageAccount, {
    stables: [
      "storageAccountName",
      "storageAccountId",
      "resourceGroup",
      "location",
      "primaryEndpoints",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* storage
        .ListStorageAccounts({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListStorageAccounts", page),
          ),
        );
      return (page.value ?? []).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          group !== undefined &&
          account.name !== undefined
          ? [toAttrs(group, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.storageAccountName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.kind ?? "StorageV2") !== output.kind ||
        (news.isHnsEnabled ?? false) !== output.isHnsEnabled
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.storageAccountName ??
        olds?.name ??
        (yield* createAccountName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.storageAccountName ??
        (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Standard_LRS";
      const desired = {
        accessTier: news.accessTier,
        allowBlobPublicAccess: news.allowBlobPublicAccess ?? false,
        allowSharedKeyAccess: news.allowSharedKeyAccess,
        minimumTlsVersion: news.minimumTlsVersion ?? "TLS1_2",
        supportsHttpsTrafficOnly: news.supportsHttpsTrafficOnly ?? true,
        publicNetworkAccess: news.publicNetworkAccess,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `storage account ${name}`;

      // Observe.
      let observed = yield* getAccount(subscriptionId, resourceGroup, name);

      // Ensure. Creation is a long-running operation (202 + empty body);
      // re-sending the same PUT for an account we own is idempotent.
      if (observed === undefined) {
        yield* storage.CreateStorageAccount({
          ...where,
          location,
          sku: { name: sku },
          kind: news.kind ?? "StorageV2",
          tags,
          properties: { ...desired, isHnsEnabled: news.isHnsEnabled },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        getAccount(subscriptionId, resourceGroup, name),
        (account) => account.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: storage.StorageAccountPropertiesUpdateParametersInput = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      const skuChanged = observed.sku?.name !== sku;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged) {
        yield* storage
          .UpdateStorageAccount({
            ...where,
            sku: skuChanged ? { name: sku } : undefined,
            tags: tagsChanged ? tags : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          })
          .pipe(Effect.retry(whileGeoChangePending));
        observed = yield* waitForProvisioned(
          label,
          getAccount(subscriptionId, resourceGroup, name),
          (account) => account.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage
          .DeleteStorageAccount({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.storageAccountName,
          })
          .pipe(Effect.retry(whileGeoChangePending)),
      );
      yield* waitUntilGone(
        `storage account ${output.storageAccountName}`,
        getAccount(
          subscriptionId,
          output.resourceGroup,
          output.storageAccountName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
