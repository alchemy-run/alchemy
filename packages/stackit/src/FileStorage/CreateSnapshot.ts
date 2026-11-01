import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResourcePool } from "./ResourcePool.ts";

export interface CreateSnapshotRequest extends Omit<
  sfs.CreateResourcePoolSnapshotRequest,
  "projectId" | "region" | "resourcePoolId"
> {}

/**
 * Runtime binding for File Storage `createResourcePoolSnapshot`: snapshot a resource pool, such as right before a risky operation.
 *
 * Bind this operation to a {@link ResourcePool} in a Function/Worker init phase and provide
 * {@link CreateSnapshotHttp}. The pool's project, region and id are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.resource-pool.snapshot.create`, bound on the project
 * holding the resource pool. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage resource pool in that project.
 *
 * ### Calling `createResourcePoolSnapshot`
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
 *     const createSnapshot = yield* Stackit.FileStorage.CreateSnapshot(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* createSnapshot({ name: "before-migration" });
 *         return yield* HttpServerResponse.json({ name: result.resourcePoolSnapshot?.snapshotName });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.CreateSnapshotHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "Stackit.FileStorage.CreateSnapshot",
  (
    pool: ResourcePool,
  ) => Effect.Effect<
    (
      request: CreateSnapshotRequest,
    ) => Effect.Effect<
      sfs.CreateResourcePoolSnapshotResponse,
      sfs.CreateResourcePoolSnapshotError,
      RuntimeContext
    >
  >
> {}

export const CreateSnapshot = Binding.Service<CreateSnapshot>("Stackit.FileStorage.CreateSnapshot");
