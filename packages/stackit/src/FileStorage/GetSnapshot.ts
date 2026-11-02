import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResourcePool } from "./ResourcePool.ts";

export interface GetSnapshotRequest extends Omit<
  sfs.GetResourcePoolSnapshotRequest,
  "projectId" | "region" | "resourcePoolId"
> {}

/**
 * Runtime binding for File Storage `getResourcePoolSnapshot`: read one snapshot of a resource pool by name.
 *
 * Bind this operation to a {@link ResourcePool} in a Function/Worker init phase and provide
 * {@link GetSnapshotHttp}. The pool's project, region and id are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.resource-pool.snapshot.list`, bound on the project
 * holding the resource pool. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage resource pool in that project.
 *
 * ### Calling `getResourcePoolSnapshot`
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
 *     const getSnapshot = yield* Stackit.FileStorage.GetSnapshot(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getSnapshot({ snapshotName: "before-migration" });
 *         return yield* HttpServerResponse.json({ size: result.resourcePoolSnapshot?.sizeGigabytes });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.GetSnapshotHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface GetSnapshot extends Binding.Service<
  GetSnapshot,
  "Stackit.FileStorage.GetSnapshot",
  (
    pool: ResourcePool,
  ) => Effect.Effect<
    (
      request: GetSnapshotRequest,
    ) => Effect.Effect<
      sfs.GetResourcePoolSnapshotResponse,
      sfs.GetResourcePoolSnapshotError,
      RuntimeContext
    >
  >
> {}

export const GetSnapshot = Binding.Service<GetSnapshot>("Stackit.FileStorage.GetSnapshot");
