import * as storage from "@distilled.cloud/azure/storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  tagsDiffer,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  accessPoliciesDiffer,
  createStorageChildName,
  fromSignedIdentifiers,
  isOwnedByMetadata,
  ownershipMetadata,
  toSignedIdentifiers,
  userMetadata,
  type StorageAccessPolicy,
} from "./StorageOwnership.ts";

export type { StorageAccessPolicy } from "./StorageOwnership.ts";
export type FileShareProtocol = storage.EnabledProtocols;
export type FileShareRootSquash = storage.RootSquashType;
export type FileShareAccessTier = storage.ShareAccessTier;

export interface FileShareProps {
  /**
   * Resource group of the storage account. Changing it replaces the share.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Storage account that holds the share. Changing it replaces the share. */
  storageAccount: string;
  /**
   * Share name: 3-63 lowercase letters, digits, and single hyphens,
   * starting and ending with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * share.
   */
  name?: string;
  /**
   * Provisioned size of the share in GiB (1-5120, or up to 102400 with
   * large file shares enabled on the account).
   * @default Azure's default (5120 GiB for standard accounts)
   */
  shareQuota?: number;
  /**
   * Access tier. General-purpose v2 accounts support `TransactionOptimized`,
   * `Hot`, and `Cool`; `FileStorage` accounts use `Premium`.
   * @default Azure's default (`TransactionOptimized` on standard accounts)
   */
  accessTier?: FileShareAccessTier;
  /**
   * Protocol the share is served over. `NFS` requires a premium
   * `FileStorage` account. Changing it replaces the share.
   * @default "SMB"
   */
  enabledProtocols?: FileShareProtocol;
  /**
   * Root squash behaviour for NFS shares.
   * @default Azure's default (`NoRootSquash`) for NFS shares
   */
  rootSquash?: FileShareRootSquash;
  /**
   * User metadata (letters, digits, and `_` in keys). Alchemy ownership
   * markers (`alchemy_stack`, `alchemy_stage`, `alchemy_id`) are merged in
   * because shares have no tags.
   * @default {}
   */
  metadata?: Record<string, string>;
  /**
   * Stored access policies (at most 5) that shared access signatures can
   * reference. File permissions are `r` (read), `c` (create), `w`
   * (write), `d` (delete), and `l` (list).
   * @default []
   */
  accessPolicies?: StorageAccessPolicy[];
}

export interface FileShare extends Resource<
  "Azure.Storage.FileShare",
  FileShareProps,
  {
    /** Name of the share. */
    shareName: string;
    /** Storage account that holds the share. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the share; use it as a role-assignment scope. */
    shareId: string;
    /** Provisioned size of the share in GiB. */
    shareQuota: number | undefined;
    /** Access tier of the share. */
    accessTier: string | undefined;
    /** Protocol the share is served over. */
    enabledProtocols: string;
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
    /** Stored access policies on the share. */
    accessPolicies: StorageAccessPolicy[];
  },
  never,
  Providers
> {}

/**
 * An Azure Files share (`Microsoft.Storage/storageAccounts/fileServices/shares`):
 * a managed file system in a Storage account that you mount over SMB (or
 * NFS on premium `FileStorage` accounts) or read and write through
 * bindings.
 *
 * Use it when a program expects a file system: a Container App volume, a
 * VM mount, or files shared between apps. For object storage, use
 * `Azure.Storage.BlobContainer`. Shares cannot be tagged, so Alchemy
 * records ownership in share metadata (`alchemy_stack`, `alchemy_stage`,
 * `alchemy_id`).
 *
 * :::caution[Changing `name`, `storageAccount`, `resourceGroup`, or `enabledProtocols` replaces the share]
 * Alchemy creates a new, empty share and deletes the old one with every
 * file and snapshot in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/storage/files/storage-files-introduction
 *
 * ### Creating a File Share
 * **Example:** 5 GiB SMB share
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files");
 * const share = yield* Azure.Storage.FileShare("documents", {
 *   storageAccount: account.storageAccountName,
 *   shareQuota: 5,
 * });
 * ```
 *
 * **Example:** Cool tier share with metadata
 * ```typescript
 * const archive = yield* Azure.Storage.FileShare("archive", {
 *   storageAccount: account.storageAccountName,
 *   shareQuota: 100,
 *   accessTier: "Cool",
 *   metadata: { purpose: "archive" },
 * });
 * ```
 *
 * **Example:** NFS share on a premium account
 * ```typescript
 * const premium = yield* Azure.Storage.StorageAccount("premium-files", {
 *   kind: "FileStorage",
 *   sku: "Premium_LRS",
 *   // NFS does not use HTTPS; Azure rejects NFS mounts on accounts that require it.
 *   supportsHttpsTrafficOnly: false,
 * });
 * const nfs = yield* Azure.Storage.FileShare("shared", {
 *   storageAccount: premium.storageAccountName,
 *   shareQuota: 100,
 *   enabledProtocols: "NFS",
 *   rootSquash: "RootSquash",
 * });
 * ```
 *
 * ### Access Policies
 * **Example:** Stored access policy for SAS tokens
 * ```typescript
 * const share = yield* Azure.Storage.FileShare("exports", {
 *   storageAccount: account.storageAccountName,
 *   accessPolicies: [
 *     { id: "readers", permission: "rl", expiryTime: "2030-01-01T00:00:00Z" },
 *   ],
 * });
 * ```
 *
 * ### Soft Delete
 * Share soft delete is an account setting on
 * `Azure.Storage.FileServiceProperties`.
 *
 * **Example:** Keep deleted shares for 14 days
 * ```typescript
 * yield* Azure.Storage.FileServiceProperties("files-settings", {
 *   storageAccount: account.storageAccountName,
 *   shareDeleteRetentionPolicy: { enabled: true, days: 14 },
 * });
 * ```
 *
 * ### Mounting in Container Apps
 * **Example:** Register the share with an environment and mount it
 * ```typescript
 * const storage = yield* Azure.ContainerApps.EnvironmentStorage("files", {
 *   environment: env.environmentName,
 *   azureFile: {
 *     accountName: account.storageAccountName,
 *     accountKey: Config.redacted("FILES_ACCOUNT_KEY"),
 *     shareName: share.shareName,
 *     accessMode: "ReadWrite",
 *   },
 * });
 * // then add a volume with storageType "AzureFile" and storageName
 * // storage.storageName to the app's template
 * ```
 *
 * ### Binding to a runtime
 * Bindings call the File REST API with Microsoft Entra tokens on any host.
 * `FileShareRead` grants **Storage File Data Privileged Reader** on this
 * share only. `FileShareWrite` grants two custom roles (write, delete), and
 * `FileShareReadWrite` grants all three; none grants ACL changes.
 *
 * **Example:** Read and write files from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const documents = yield* Documents;
 *     const docs = yield* Azure.Storage.FileShareReadWrite(documents);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* docs.put("reports/latest.json", JSON.stringify({ ok: true }), {
 *           contentType: "application/json",
 *         });
 *         const file = yield* docs.get("reports/latest.json");
 *         return HttpServerResponse.text(file?.text() ?? "missing");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.FileShareReadWriteHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** List a directory
 * ```typescript
 * // init
 * const docs = yield* Azure.Storage.FileShareRead(share);
 *
 * // runtime
 * const { files, directories, nextMarker } = yield* docs.list({ directory: "reports" });
 * const head = yield* docs.head("reports/q1.csv"); // undefined when missing
 * // …provided with Effect.provide(Azure.Storage.FileShareReadHttp)
 * ```
 *
 * **Example:** Write, then clean up a directory
 * ```typescript
 * // init
 * const docs = yield* Azure.Storage.FileShareWrite(share);
 *
 * // runtime
 * yield* docs.put("tmp/upload.bin", bytes); // creates missing parent directories
 * yield* docs.delete("tmp/upload.bin");
 * yield* docs.deleteDirectory("tmp"); // fails with DirectoryNotEmpty if not empty
 * // …provided with Effect.provide(Azure.Storage.FileShareWriteHttp)
 * ```
 *
 * ### Deleting a Share
 * Destroying the share deletes every file and snapshot in it. With share
 * soft delete on, Azure keeps it recoverable for the retention period.
 *
 * **Example:** Keep the share when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const share = yield* Azure.Storage.FileShare("documents", {
 *   storageAccount: account.storageAccountName,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const FileShare = GroupedResource<FileShare>("Azure.Storage.FileShare");

const getShare = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetFileShare({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  share: storage.GetFileShareResponse,
): FileShare["Attributes"] => ({
  shareName: name,
  storageAccount,
  resourceGroup,
  shareId: share.id ?? "",
  shareQuota: share.properties?.shareQuota,
  accessTier: share.properties?.accessTier,
  enabledProtocols: share.properties?.enabledProtocols ?? "SMB",
  metadata: userMetadata(share.properties?.metadata),
  accessPolicies: fromSignedIdentifiers(share.properties?.signedIdentifiers),
});

export const FileShareProvider = () =>
  Provider.succeed(FileShare, {
    stables: ["shareName", "storageAccount", "resourceGroup", "shareId", "enabledProtocols"],

    // Shares live inside a storage account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name !== output.shareName) ||
        (news.enabledProtocols ?? "SMB") !== output.enabledProtocols
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
      const name = output?.shareName ?? olds?.name ?? (yield* createStorageChildName(id));
      const observed = yield* getShare(subscriptionId, resourceGroup, storageAccount, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties?.metadata)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name = news.name ?? output?.shareName ?? (yield* createStorageChildName(id));
      const metadata = {
        ...news.metadata,
        ...(yield* ownershipMetadata(id)),
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        shareName: name,
      };
      const get = getShare(subscriptionId, resourceGroup, storageAccount, name);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* storage.CreateFileShare({
          ...where,
          properties: {
            metadata,
            shareQuota: news.shareQuota,
            accessTier: news.accessTier,
            enabledProtocols: news.enabledProtocols,
            rootSquash: news.rootSquash,
            signedIdentifiers: news.accessPolicies
              ? toSignedIdentifiers(news.accessPolicies)
              : undefined,
          },
        });
      } else {
        // Sync each mutable aspect against the observed share.
        const props = observed.properties ?? {};
        const changed: storage.FileSharePropertiesInput = {};
        if (tagsDiffer(props.metadata, metadata)) changed.metadata = metadata;
        if (news.shareQuota !== undefined && props.shareQuota !== news.shareQuota) {
          changed.shareQuota = news.shareQuota;
        }
        if (news.accessTier !== undefined && props.accessTier !== news.accessTier) {
          changed.accessTier = news.accessTier;
        }
        if (news.rootSquash !== undefined && props.rootSquash !== news.rootSquash) {
          changed.rootSquash = news.rootSquash;
        }
        if (accessPoliciesDiffer(props.signedIdentifiers, news.accessPolicies ?? [])) {
          changed.signedIdentifiers = toSignedIdentifiers(news.accessPolicies ?? []);
        }
        if (Object.keys(changed).length > 0) {
          yield* storage.UpdateFileShare({ ...where, properties: changed });
        }
      }

      const fresh = yield* waitForProvisioned(`file share ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteFileShare({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          shareName: output.shareName,
          _include: "snapshots",
        }),
      );
      yield* waitUntilGone(
        `file share ${output.shareName}`,
        getShare(subscriptionId, output.resourceGroup, output.storageAccount, output.shareName),
      );
    }),
  });
