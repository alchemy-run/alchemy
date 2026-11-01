import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Share } from "./Share.ts";

export interface GetShareRequest extends Omit<
  sfs.GetShareRequest,
  "projectId" | "region" | "resourcePoolId" | "shareId"
> {}

/**
 * Runtime binding for File Storage `getShare`: read a share: its state, mount path, space limit and export policy.
 *
 * Bind this operation to a {@link Share} in a Function/Worker init phase and provide
 * {@link GetShareHttp}. The share's project, region, pool and id are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.share.list`, bound on the project
 * holding the share. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage share in that project.
 *
 * ### Calling `getShare`
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
 * export const Assets = Effect.gen(function* () {
 *   const pool = yield* Files;
 *   return yield* Stackit.FileStorage.Share("Assets", {
 *     resourcePoolId: pool.resourcePoolId,
 *     spaceHardLimitGigabytes: 100,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Assets;
 *     const getShare = yield* Stackit.FileStorage.GetShare(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getShare({});
 *         return yield* HttpServerResponse.json({ state: result.share?.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.GetShareHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface GetShare extends Binding.Service<
  GetShare,
  "Stackit.FileStorage.GetShare",
  (
    share: Share,
  ) => Effect.Effect<
    (
      request: GetShareRequest,
    ) => Effect.Effect<sfs.GetShareResponse, sfs.GetShareError, RuntimeContext>
  >
> {}

export const GetShare = Binding.Service<GetShare>("Stackit.FileStorage.GetShare");
