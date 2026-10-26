import * as storage from "@distilled.cloud/azure/storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

export type StorageSkuName = storage.SkuName;
export type StorageKind = storage.Kind;
export type StorageAccessTier = storage.AccessTier;
export type MinimumTlsVersion = storage.MinimumTlsVersion;

export interface StorageAccountProps {
  /**
   * Resource group the account is created in. Changing it replaces the
   * account.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
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
   * Account kind: `StorageV2` (general purpose), `BlockBlobStorage` or
   * `FileStorage` (premium, with a `Premium_*` SKU), and the legacy
   * `Storage` and `BlobStorage`. Changing it replaces the account.
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
   * Native data-sharing features allowed on the account. Each flag must be
   * `true` before the matching child can be created:
   * `allowBlobAccessPoints` for `Azure.Storage.BlobAccessPointConfiguration`,
   * `allowStorageDataShares` for `Azure.Storage.DataShare`, and
   * `allowStorageConnectors` for `Azure.Storage.Connector`. Unset flags keep
   * the account's current value.
   * @default Azure's default (all disabled)
   */
  dataCollaborationPolicy?: StorageDataCollaborationPolicy;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

/** Native data-sharing features allowed on a storage account. */
export interface StorageDataCollaborationPolicy {
  /** Allow storage connectors on the account. */
  allowStorageConnectors?: boolean;
  /** Allow Blob Access Point configurations on the account. */
  allowBlobAccessPoints?: boolean;
  /** Allow storage data shares on the account. */
  allowStorageDataShares?: boolean;
  /** Allow data sharing across Entra tenants. */
  allowCrossTenantDataSharing?: boolean;
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
    /** Native data-sharing features allowed on the account. */
    dataCollaborationPolicy: StorageDataCollaborationPolicy;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Storage account (`Microsoft.Storage/storageAccounts`): the
 * namespace that holds your blob containers, queues, tables, and file
 * shares.
 *
 * Alchemy creates a general-purpose v2 account with locally redundant
 * storage (`Standard_LRS`) in the stack's resource group. The account is
 * secure by default: HTTPS only, TLS 1.2 minimum, and anonymous blob access
 * off. Runtimes reach the data with Microsoft Entra ID through bindings on
 * the containers, queues, and tables, so you never handle account keys.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `kind`, or `isHnsEnabled` replaces the account]
 * Alchemy creates a new account and deletes the old one with every blob,
 * message, entity, and file in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/storage/common/storage-account-overview
 *
 * ### Creating a Storage Account
 * **Example:** General-purpose v2 account
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files");
 * ```
 *
 * **Example:** Account with a fixed name and region
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   name: "contosofiles",
 *   location: "westeurope",
 * });
 * // account.primaryEndpoints.blob → "https://contosofiles.blob.core.windows.net/"
 * ```
 *
 * ### Redundancy
 * `sku` picks how Azure replicates your data: `Standard_LRS` (one
 * datacenter), `Standard_ZRS` (three zones), `Standard_GRS` (a second
 * region), and `Standard_RAGRS` (a second region you can read from).
 *
 * **Example:** Zone-redundant account
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   sku: "Standard_ZRS",
 * });
 * ```
 *
 * **Example:** Geo-redundant account with read access to the secondary
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   sku: "Standard_RAGRS",
 * });
 * ```
 *
 * ### Access Tiers
 * **Example:** Cool account for rarely read data
 * ```typescript
 * const archive = yield* Azure.Storage.StorageAccount("archive", {
 *   accessTier: "Cool",
 * });
 * ```
 *
 * ### Authentication and Network Access
 * **Example:** Require Microsoft Entra ID (no account keys or SAS)
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   allowSharedKeyAccess: false,
 * });
 * ```
 *
 * **Example:** Allow public read containers
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("assets", {
 *   allowBlobPublicAccess: true,
 * });
 * const images = yield* Azure.Storage.BlobContainer("images", {
 *   storageAccount: account.storageAccountName,
 *   publicAccess: "Blob",
 * });
 * ```
 *
 * **Example:** Private account behind a private endpoint
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   publicNetworkAccess: "Disabled",
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("files-blob", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: account.storageAccountId, groupIds: ["blob"] },
 *   ],
 * });
 * ```
 *
 * ### Versioning, Soft Delete, and CORS
 * Blob service settings live on `Azure.Storage.BlobServiceProperties`, one
 * per account.
 *
 * **Example:** Versioning with 7-day soft delete
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files");
 * yield* Azure.Storage.BlobServiceProperties("files-blob", {
 *   storageAccount: account.storageAccountName,
 *   isVersioningEnabled: true,
 *   deleteRetentionPolicy: { enabled: true, days: 7 },
 *   containerDeleteRetentionPolicy: { enabled: true, days: 7 },
 * });
 * ```
 *
 * **Example:** Allow browser uploads from one origin
 * ```typescript
 * yield* Azure.Storage.BlobServiceProperties("files-blob", {
 *   storageAccount: account.storageAccountName,
 *   cors: [
 *     {
 *       allowedOrigins: ["https://app.example.com"],
 *       allowedMethods: ["GET", "PUT"],
 *       maxAgeInSeconds: 600,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Lifecycle Rules
 * **Example:** Delete logs 30 days after their last change
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("logs");
 * yield* Azure.Storage.ManagementPolicy("logs-lifecycle", {
 *   storageAccount: account.storageAccountName,
 *   rules: [
 *     {
 *       name: "expireLogs",
 *       filters: { blobTypes: ["blockBlob"], prefixMatch: ["logs/"] },
 *       actions: {
 *         baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Encryption
 * Azure encrypts every account with Microsoft-managed keys. Add an
 * encryption scope when some blobs need their own key.
 *
 * **Example:** Encryption scope with infrastructure encryption
 * ```typescript
 * const scope = yield* Azure.Storage.EncryptionScope("sensitive", {
 *   storageAccount: account.storageAccountName,
 *   requireInfrastructureEncryption: true,
 * });
 * ```
 *
 * ### Data Lake Storage
 * **Example:** Account with a hierarchical namespace
 * ```typescript
 * const lake = yield* Azure.Storage.StorageAccount("lake", {
 *   isHnsEnabled: true,
 * });
 * const raw = yield* Azure.Storage.BlobContainer("raw", {
 *   storageAccount: lake.storageAccountName,
 * });
 * // bind `raw` with Azure.Storage.DataLakeFileSystemReadWrite
 * ```
 *
 * ### Native Data Sharing
 * **Example:** Account that allows Blob Access Points and data shares
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("shared", {
 *   dataCollaborationPolicy: {
 *     allowBlobAccessPoints: true,
 *     allowStorageDataShares: true,
 *   },
 * });
 * ```
 *
 * ### Binding to a runtime
 * Bind the containers, queues, and tables in the account, not the account
 * itself: each binding grants a data role on that one resource. The
 * account-level operations (list or create containers, queues, and tables)
 * bind to the account and grant their custom role on it.
 *
 * **Example:** Read and write blobs from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const uploads = yield* Uploads;
 *     // Storage Blob Data Contributor on the container only.
 *     const blobs = yield* Azure.Storage.BlobContainerReadWrite(uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* blobs.put("hello.txt", "hi", { contentType: "text/plain" });
 *         const blob = yield* blobs.get("hello.txt");
 *         return HttpServerResponse.text(blob?.text() ?? "missing");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** List the account's containers
 * ```typescript
 * // init
 * const listBlobContainers = yield* Azure.Storage.ListBlobContainers(account);
 *
 * // runtime
 * const page = yield* listBlobContainers({ prefix: "tenant-" });
 * const names = page.ContainerItems.map((c) => c.Name);
 * // …provided with Effect.provide(Azure.Storage.ListBlobContainersHttp)
 * ```
 *
 * ### Event Sources
 * **Example:** Consume a Storage queue
 * ```typescript
 * yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.Functions.StorageQueueEventSource)
 * ```
 *
 * **Example:** React to any account event through Event Grid
 * ```typescript
 * yield* Azure.EventGrid.consumeEvents(
 *   "Deletes",
 *   { scope: account.storageAccountId, includedEventTypes: ["Microsoft.Storage.BlobDeleted"] },
 *   (event) => Effect.log(event.subject),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventGridEventSource)
 * ```
 *
 * ### Deleting an Account
 * Destroying the account deletes it with all its data. After a redundancy
 * change (e.g. `Standard_LRS` → `Standard_GRS`), Azure keeps syncing in the
 * background; until it finishes, a delete or another `sku` change fails
 * with `PendingTransactionAlreadyExists`.
 *
 * **Example:** Keep the account when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const account = yield* Azure.Storage.StorageAccount("files").pipe(
 *   RemovalPolicy.retain(),
 * );
 * ```
 *
 * @resource
 */
export const StorageAccount = GroupedResource<StorageAccount>("Azure.Storage.StorageAccount", {
  local: true,
});

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

const getAccount = (subscriptionId: string, resourceGroupName: string, accountName: string) =>
  orUndefinedIfNotFound(
    storage.GetStorageAccountProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

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
    dataCollaborationPolicy: { ...account.properties?.dataCollaborationPolicyProperties },
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
    e._tag === "PendingTransactionAlreadyExists" || e._tag === "StorageAccountOperationInProgress",
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
      const page = yield* collectAll(storage.ListStorageAccounts, { subscriptionId });
      return (page.value ?? []).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) && group !== undefined && account.name !== undefined
          ? [toAttrs(group, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.storageAccountName) ||
        (news.location !== undefined && lower(news.location) !== lower(output.location)) ||
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
      const name = output?.storageAccountName ?? olds?.name ?? (yield* createAccountName(id));
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
      const name = news.name ?? output?.storageAccountName ?? (yield* createAccountName(id));
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
          properties: {
            ...desired,
            isHnsEnabled: news.isHnsEnabled,
            dataCollaborationPolicyProperties: news.dataCollaborationPolicy,
          },
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
      const observedPolicy = props.dataCollaborationPolicyProperties ?? {};
      const policy = Object.fromEntries(
        Object.entries(news.dataCollaborationPolicy ?? {}).filter(([, v]) => v !== undefined),
      ) as StorageDataCollaborationPolicy;
      if (
        (Object.keys(policy) as (keyof StorageDataCollaborationPolicy)[]).some(
          (key) => (observedPolicy[key] ?? false) !== policy[key],
        )
      ) {
        changed.dataCollaborationPolicyProperties = { ...observedPolicy, ...policy };
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
        getAccount(subscriptionId, output.resourceGroup, output.storageAccountName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
