import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResourcePool } from "./ResourcePool.ts";

export interface GetResourcePoolRequest extends Omit<
  sfs.GetResourcePoolRequest,
  "projectId" | "region" | "resourcePoolId"
> {}

/**
 * Runtime binding for File Storage `getResourcePool`: read a resource pool, including how much of its space is used and available.
 *
 * Bind this operation to a {@link ResourcePool} in a Function/Worker init phase and provide
 * {@link GetResourcePoolHttp}. The pool's project, region and id are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.resource-pool.list`, bound on the project
 * holding the resource pool. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage resource pool in that project.
 *
 * ### Calling `getResourcePool`
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
 *     const getResourcePool = yield* Stackit.FileStorage.GetResourcePool(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getResourcePool({});
 *         return yield* HttpServerResponse.json({ space: result.resourcePool?.space });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.GetResourcePoolHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface GetResourcePool extends Binding.Service<
  GetResourcePool,
  "Stackit.FileStorage.GetResourcePool",
  (
    pool: ResourcePool,
  ) => Effect.Effect<
    (
      request: GetResourcePoolRequest,
    ) => Effect.Effect<sfs.GetResourcePoolResponse, sfs.GetResourcePoolError, RuntimeContext>
  >
> {}

export const GetResourcePool = Binding.Service<GetResourcePool>(
  "Stackit.FileStorage.GetResourcePool",
);
