import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResourcePool } from "./ResourcePool.ts";

export interface ListSharesRequest extends Omit<
  sfs.ListSharesRequest,
  "projectId" | "region" | "resourcePoolId"
> {}

/**
 * Runtime binding for File Storage `listShares`: list the shares in a resource pool.
 *
 * Bind this operation to a {@link ResourcePool} in a Function/Worker init phase and provide
 * {@link ListSharesHttp}. The pool's project, region and id are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.share.list`, bound on the project
 * holding the resource pool. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage resource pool in that project.
 *
 * ### Calling `listShares`
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
 *     const listShares = yield* Stackit.FileStorage.ListShares(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* listShares({});
 *         return yield* HttpServerResponse.json({ shares: result.shares?.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.ListSharesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface ListShares extends Binding.Service<
  ListShares,
  "Stackit.FileStorage.ListShares",
  (
    pool: ResourcePool,
  ) => Effect.Effect<
    (
      request: ListSharesRequest,
    ) => Effect.Effect<sfs.ListSharesResponse, sfs.ListSharesError, RuntimeContext>
  >
> {}

export const ListShares = Binding.Service<ListShares>("Stackit.FileStorage.ListShares");
