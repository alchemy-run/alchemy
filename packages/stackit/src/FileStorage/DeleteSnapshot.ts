import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResourcePool } from "./ResourcePool.ts";

export interface DeleteSnapshotRequest extends Omit<
  sfs.DeleteResourcePoolSnapshotRequest,
  "projectId" | "region" | "resourcePoolId"
> {}

/**
 * Runtime binding for File Storage `deleteResourcePoolSnapshot`: delete one snapshot of a resource pool by name. The data it captured is gone, and STACKIT refuses it with `Conflict` while a retention holds.
 *
 * Bind this operation to a {@link ResourcePool} in a Function/Worker init phase and provide
 * {@link DeleteSnapshotHttp}. The pool's project, region and id are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.resource-pool.snapshot.delete`, bound on the project
 * holding the resource pool. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage resource pool in that project.
 *
 * ### Calling `deleteResourcePoolSnapshot`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Files = Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Files;
 *     const deleteSnapshot = yield* Stackit.FileStorage.DeleteSnapshot(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* deleteSnapshot({ snapshotName: "before-migration" });
 *         return yield* HttpServerResponse.json({ deleted: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.DeleteSnapshotHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface DeleteSnapshot extends Binding.Service<
  DeleteSnapshot,
  "Stackit.FileStorage.DeleteSnapshot",
  (
    pool: ResourcePool,
  ) => Effect.Effect<
    (
      request: DeleteSnapshotRequest,
    ) => Effect.Effect<
      sfs.DeleteResourcePoolSnapshotResponse2,
      sfs.DeleteResourcePoolSnapshotError,
      RuntimeContext
    >
  >
> {}

export const DeleteSnapshot = Binding.Service<DeleteSnapshot>("Stackit.FileStorage.DeleteSnapshot");
