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
  createStorageChildName as createContainerName,
  isOwnedByMetadata as isOwnedContainer,
  ownershipMetadata,
  userMetadata,
} from "./StorageOwnership.ts";

export type BlobPublicAccess = "None" | "Blob" | "Container";

export interface BlobContainerProps {
  /**
   * Resource group of the storage account. Changing it replaces the container.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
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
   * @default {}
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
 * A blob container (`Microsoft.Storage/storageAccounts/blobServices/containers`):
 * the object store of an Azure Storage account, Azure's counterpart to an
 * S3 bucket.
 *
 * Containers are private by default. Bind a container to a runtime and the
 * binding grants a Storage Blob data role on that container only.
 * Containers cannot be tagged, so Alchemy records ownership in container
 * metadata (`alchemy_stack`, `alchemy_stage`, `alchemy_id`).
 *
 * :::caution[Changing `name`, `storageAccount`, or `resourceGroup` replaces the container]
 * Alchemy creates a new, empty container and deletes the old one with every
 * blob in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/storage-blobs-introduction
 *
 * ### Creating a Container
 * **Example:** Private container
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files");
 * const uploads = yield* Azure.Storage.BlobContainer("uploads", {
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Container with a fixed name and metadata
 * ```typescript
 * const uploads = yield* Azure.Storage.BlobContainer("uploads", {
 *   storageAccount: account.storageAccountName,
 *   name: "user-uploads",
 *   metadata: { purpose: "user_uploads" },
 * });
 * ```
 *
 * ### Public Read Access
 * `publicAccess: "Blob"` lets anyone read a blob by its URL;
 * `"Container"` also lets anyone list the container. Both need
 * `allowBlobPublicAccess: true` on the account.
 *
 * **Example:** Public images
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("assets", {
 *   allowBlobPublicAccess: true,
 * });
 * const images = yield* Azure.Storage.BlobContainer("images", {
 *   storageAccount: account.storageAccountName,
 *   publicAccess: "Blob",
 * });
 * // https://{account}.blob.core.windows.net/{images.containerName}/logo.png
 * ```
 *
 * ### Soft Delete and Versioning
 * Turn them on for the account with `Azure.Storage.BlobServiceProperties`.
 *
 * **Example:** Recover deleted blobs and containers for 7 days
 * ```typescript
 * yield* Azure.Storage.BlobServiceProperties("files-blob", {
 *   storageAccount: account.storageAccountName,
 *   isVersioningEnabled: true,
 *   deleteRetentionPolicy: { enabled: true, days: 7 },
 *   containerDeleteRetentionPolicy: { enabled: true, days: 7 },
 * });
 * ```
 *
 * ### Data Lake Filesystems
 * On an account with `isHnsEnabled: true`, a container is a Data Lake
 * Storage Gen2 filesystem with real directories.
 *
 * **Example:** Filesystem with directory operations
 * ```typescript
 * const lake = yield* Azure.Storage.StorageAccount("lake", { isHnsEnabled: true });
 * const raw = yield* Azure.Storage.BlobContainer("raw", {
 *   storageAccount: lake.storageAccountName,
 * });
 *
 * // in a runtime: Storage Blob Data Contributor on the filesystem
 * const files = yield* Azure.Storage.DataLakeFileSystemReadWrite(raw);
 * yield* files.write("logs/app.log", "started\n");
 * // …provided with Effect.provide(Azure.Storage.DataLakeFileSystemReadWriteHttp)
 * ```
 *
 * ### Binding to a runtime
 * Pick the access level the runtime needs:
 * `BlobContainerRead` grants **Storage Blob Data Reader**, and
 * `BlobContainerWrite` and `BlobContainerReadWrite` grant **Storage Blob
 * Data Contributor**, each on this container only. On an Azure Function,
 * Web App, Container App, container group, or VM the role goes to the
 * host's managed identity. On any other host (a Cloudflare Worker, an AWS
 * Lambda) Alchemy creates an Entra service principal for the host.
 *
 * **Example:** Read and write blobs from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const uploads = yield* Uploads;
 *     const blobs = yield* Azure.Storage.BlobContainerReadWrite(uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const body = new Uint8Array(yield* request.arrayBuffer);
 *         const { etag } = yield* blobs.put("uploads/photo.png", body, {
 *           contentType: "image/png",
 *         });
 *         return yield* HttpServerResponse.json({ etag });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** Read-only access from a Container App
 * ```typescript
 * Effect.gen(function* () {
 *   const reports = yield* Azure.Storage.BlobContainerRead(reportsContainer);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const blob = yield* reports.get("latest.json");
 *       return HttpServerResponse.text(blob?.text() ?? "{}");
 *     }).pipe(Effect.orDie),
 *   };
 * }).pipe(Effect.provide(Azure.Storage.BlobContainerReadHttp))
 * ```
 *
 * **Example:** Write blobs from a Cloudflare Worker
 * ```typescript
 * export default class Worker extends Cloudflare.Worker<Worker>()(
 *   "Worker",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const files = yield* Azure.Storage.BlobContainerWrite(container);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* files.put("from-worker.txt", "hello", { contentType: "text/plain" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.BlobContainerWriteHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Download, inspect, and list blobs
 * ```typescript
 * // init
 * const files = yield* Azure.Storage.BlobContainerReadWrite(uploads);
 *
 * // runtime
 * const blob = yield* files.get("reports/latest.json"); // undefined when missing
 * const report = blob ? JSON.parse(blob.text()) : undefined;
 * const head = yield* files.head("reports/latest.json"); // size, contentType, etag
 * const { blobs, nextMarker } = yield* files.list({ prefix: "reports/" });
 * ```
 *
 * **Example:** Delete a blob
 * ```typescript
 * yield* files.delete("reports/stale.json"); // succeeds when already gone
 * ```
 *
 * **Example:** Upload a large file in blocks
 * ```typescript
 * const id = (n: number) => btoa(`block-${n}`);
 * yield* files.stageBlock("big.bin", { blockid: id(0), body: part0 });
 * yield* files.stageBlock("big.bin", { blockid: id(1), body: part1 });
 * yield* files.commitBlockList("big.bin", { Latest: [id(0), id(1)] });
 * ```
 *
 * **Example:** One operation with its own least-privilege role
 * ```typescript
 * // init: a custom role with only `blobs/tags/write` on the container
 * const setBlobTags = yield* Azure.Storage.SetBlobTags(uploads);
 * // …provided with Effect.provide(Azure.Storage.SetBlobTagsHttp)
 * ```
 *
 * ### Event Sources
 * `consumeBlobCreated` runs a handler for each new or replaced blob. Events
 * arrive through the account's Event Grid system topic; read the blob with
 * a `BlobContainerRead` binding when you need its bytes.
 *
 * **Example:** Index each upload under `uploads/`
 * ```typescript
 * export default class Indexer extends Azure.Functions.Function<Indexer>()(
 *   "Indexer",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const uploads = yield* Uploads;
 *     const blobs = yield* Azure.Storage.BlobContainerRead(uploads);
 *     yield* Azure.Storage.consumeBlobCreated(uploads, { prefix: "uploads/" }, (event) =>
 *       Effect.gen(function* () {
 *         const blob = yield* blobs.get(event.blobName);
 *         yield* Effect.log(`${event.blobName}: ${blob?.size ?? 0} bytes`);
 *       }).pipe(Effect.orDie),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(
 *     Effect.provide([Azure.Functions.BlobCreatedEventSource, Azure.Storage.BlobContainerReadHttp]),
 *   ),
 * ) {}
 * ```
 *
 * **Example:** Only `.png` files
 * ```typescript
 * yield* Azure.Storage.consumeBlobCreated(images, { suffix: ".png" }, (event) =>
 *   Effect.log(`${event.url} (${event.contentType})`),
 * );
 * ```
 *
 * ### Deleting a Container
 * Destroying the container deletes every blob in it. With
 * `containerDeleteRetentionPolicy` on the account, Azure keeps the deleted
 * container recoverable for that many days.
 *
 * **Example:** Keep the container when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const uploads = yield* Azure.Storage.BlobContainer("uploads", {
 *   storageAccount: account.storageAccountName,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const BlobContainer = GroupedResource<BlobContainer>("Azure.Storage.BlobContainer", {
  local: true,
});

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
    stables: ["containerName", "storageAccount", "resourceGroup", "containerId"],

    // Containers live inside a storage account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
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
      const name = output?.containerName ?? olds?.name ?? (yield* createContainerName(id));
      const observed = yield* getContainer(subscriptionId, resourceGroup, storageAccount, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isOwnedContainer(id, observed.properties?.metadata)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name = news.name ?? output?.containerName ?? (yield* createContainerName(id));
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
      const get = getContainer(subscriptionId, resourceGroup, storageAccount, name);

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

      const fresh = yield* waitForProvisioned(`blob container ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
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
