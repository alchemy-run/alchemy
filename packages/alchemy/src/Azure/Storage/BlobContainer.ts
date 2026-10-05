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
  createStorageChildName as createContainerName,
  isOwnedByMetadata as isOwnedContainer,
  ownershipMetadata,
  userMetadata,
} from "./StorageOwnership.ts";

export type BlobPublicAccess = "None" | "Blob" | "Container";

export interface BlobContainerProps {
  /** Resource group of the storage account. Changing it replaces the container. */
  resourceGroup: string;
  /** Storage account that holds the container. Changing it replaces the container. */
  storageAccount: string;
  /**
   * Container name: 3-63 lowercase letters, digits, and single hyphens,
   * starting with a letter or digit. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the container.
   */
  name?: string;
  /**
   * Anonymous read access. Anything other than `None` also requires
   * `allowBlobPublicAccess: true` on the storage account.
   * @default "None"
   */
  publicAccess?: BlobPublicAccess;
  /**
   * User metadata (letters, digits, and `_` in keys). Alchemy ownership
   * markers (`alchemy_stack`, `alchemy_stage`, `alchemy_id`) are merged in
   * because containers have no tags.
   */
  metadata?: Record<string, string>;
}

export interface BlobContainer extends Resource<
  "Azure.Storage.BlobContainer",
  BlobContainerProps,
  {
    /** Name of the container. */
    containerName: string;
    /** Storage account that holds the container. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the container; use it as a role-assignment scope. */
    containerId: string;
    /** Anonymous read access level. */
    publicAccess: string;
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A blob container in an Azure Storage account.
 *
 * Containers cannot be tagged, so Alchemy records ownership in container
 * metadata (`alchemy_stack`, `alchemy_stage`, `alchemy_id`). Deleting the
 * container deletes every blob in it.
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/storage-blobs-introduction
 *
 * ### Creating a Container
 * **Example:** Private container
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const uploads = yield* Azure.Storage.BlobContainer("uploads", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Container with metadata
 * ```typescript
 * const uploads = yield* Azure.Storage.BlobContainer("uploads", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   metadata: { purpose: "user_uploads" },
 * });
 * ```
 *
 * @resource
 */
export const BlobContainer = Resource<BlobContainer>(
  "Azure.Storage.BlobContainer",
);

const getContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  containerName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetBlobContainer({
      subscriptionId,
      resourceGroupName,
      accountName,
      containerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  container: storage.GetBlobContainerResponse,
): BlobContainer["Attributes"] => ({
  containerName: name,
  storageAccount,
  resourceGroup,
  containerId: container.id ?? "",
  publicAccess: container.properties?.publicAccess ?? "None",
  metadata: userMetadata(container.properties?.metadata),
});

export const BlobContainerProvider = () =>
  Provider.succeed(BlobContainer, {
    stables: [
      "containerName",
      "storageAccount",
      "resourceGroup",
      "containerId",
    ],

    // Containers live inside a storage account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name !== output.containerName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its account.
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name =
        output?.containerName ?? olds?.name ?? (yield* createContainerName(id));
      const observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isOwnedContainer(id, observed.properties?.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name =
        news.name ?? output?.containerName ?? (yield* createContainerName(id));
      const publicAccess = news.publicAccess ?? "None";
      const metadata = {
        ...news.metadata,
        ...(yield* ownershipMetadata(id)),
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        containerName: name,
      };
      const get = getContainer(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. The PUT fails on an existing container, so only create
      // when it is missing; a concurrent create surfaces as a typed conflict.
      if (observed === undefined) {
        yield* storage.CreateBlobContainer({
          ...where,
          properties: { publicAccess, metadata },
        });
      } else if (
        (observed.properties?.publicAccess ?? "None") !== publicAccess ||
        tagsDiffer(observed.properties?.metadata, metadata)
      ) {
        // Sync public access and metadata against the observed container.
        yield* storage.UpdateBlobContainer({
          ...where,
          properties: { publicAccess, metadata },
        });
      }

      const fresh = yield* waitForProvisioned(
        `blob container ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteBlobContainer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          containerName: output.containerName,
        }),
      );
      yield* waitUntilGone(
        `blob container ${output.containerName}`,
        getContainer(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.containerName,
        ),
      );
    }),
  });
