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
  tagsDiffer,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
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
  /** Resource group of the storage account. Changing it replaces the share. */
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
   */
  metadata?: Record<string, string>;
  /**
   * Stored access policies (at most 5) that shared access signatures can
   * reference.
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
 * An Azure Files share in a Storage account, mountable over SMB (or NFS on
 * premium `FileStorage` accounts).
 *
 * Shares cannot be tagged, so Alchemy records ownership in share metadata
 * (`alchemy_stack`, `alchemy_stage`, `alchemy_id`). Deleting the share
 * deletes every file and snapshot in it (subject to the account's share
 * soft-delete policy).
 *
 * @see https://learn.microsoft.com/azure/storage/files/storage-files-introduction
 *
 * ### Creating a File Share
 * **Example:** 5 GiB SMB share
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const share = yield* Azure.Storage.FileShare("documents", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   shareQuota: 5,
 * });
 * ```
 *
 * **Example:** Cool tier share with metadata
 * ```typescript
 * const archive = yield* Azure.Storage.FileShare("archive", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   shareQuota: 100,
 *   accessTier: "Cool",
 *   metadata: { purpose: "archive" },
 * });
 * ```
 *
 * ### Access Policies
 * **Example:** Stored access policy for SAS tokens
 * ```typescript
 * const share = yield* Azure.Storage.FileShare("exports", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   accessPolicies: [
 *     { id: "readers", permission: "rl", expiryTime: "2030-01-01T00:00:00Z" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const FileShare = Resource<FileShare>("Azure.Storage.FileShare");

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
    stables: [
      "shareName",
      "storageAccount",
      "resourceGroup",
      "shareId",
      "enabledProtocols",
    ],

    // Shares live inside a storage account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
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
      const name =
        output?.shareName ?? olds?.name ?? (yield* createStorageChildName(id));
      const observed = yield* getShare(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties?.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name =
        news.name ?? output?.shareName ?? (yield* createStorageChildName(id));
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
        if (
          news.shareQuota !== undefined &&
          props.shareQuota !== news.shareQuota
        ) {
          changed.shareQuota = news.shareQuota;
        }
        if (
          news.accessTier !== undefined &&
          props.accessTier !== news.accessTier
        ) {
          changed.accessTier = news.accessTier;
        }
        if (
          news.rootSquash !== undefined &&
          props.rootSquash !== news.rootSquash
        ) {
          changed.rootSquash = news.rootSquash;
        }
        if (
          accessPoliciesDiffer(
            props.signedIdentifiers,
            news.accessPolicies ?? [],
          )
        ) {
          changed.signedIdentifiers = toSignedIdentifiers(
            news.accessPolicies ?? [],
          );
        }
        if (Object.keys(changed).length > 0) {
          yield* storage.UpdateFileShare({ ...where, properties: changed });
        }
      }

      const fresh = yield* waitForProvisioned(
        `file share ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
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
        getShare(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.shareName,
        ),
      );
    }),
  });
