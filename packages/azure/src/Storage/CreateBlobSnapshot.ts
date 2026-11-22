import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `CreateBlobSnapshot` request without the `url` and `containerName` the bound container supplies. */
export interface CreateBlobSnapshotRequest extends Omit<
  blob.CreateBlobSnapshotRequest,
  "url" | "containerName"
> {}

/**
 * Create a read-only snapshot of a blob (`Snapshot Blob`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link CreateBlobSnapshotHttp}.
 *
 * ### Creating Snapshots
 * **Example:** Snapshot a blob
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *     const files = yield* Azure.Storage.BlobContainer("Files", {
 *       storageAccount: account.storageAccountName,
 *     });
 *
 *     // init: bind the operation to the container
 *     const createBlobSnapshot = yield* Azure.Storage.CreateBlobSnapshot(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const snap = yield* createBlobSnapshot({ blob: "disk.vhd" });
 *         const snapshot = snap.xMsSnapshot;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CreateBlobSnapshotHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateBlobSnapshot extends Binding.Service<
  CreateBlobSnapshot,
  "Azure.Storage.CreateBlobSnapshot",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: CreateBlobSnapshotRequest,
    ) => Effect.Effect<
      blob.CreateBlobSnapshotResponse,
      blob.CreateBlobSnapshotError,
      RuntimeContext
    >
  >
> {}

export const CreateBlobSnapshot = Binding.Service<CreateBlobSnapshot>(
  "Azure.Storage.CreateBlobSnapshot",
);
