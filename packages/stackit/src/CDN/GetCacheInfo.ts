import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Distribution } from "./Distribution.ts";

export interface GetCacheInfoRequest extends Omit<
  cdn.GetCacheInfoRequest,
  "projectId" | "distributionId"
> {}

/**
 * Runtime binding for CDN `GetCacheInfo`: read when a distribution's cache was last purged, and the purge history.
 *
 * The history holds full purges only, unless you pass `purgePath`.
 *
 * Bind this operation to a {@link Distribution} in a Function/Worker init phase and provide
 * {@link GetCacheInfoHttp}. The resource's project and id are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.get` on the project holding
 * the distribution, so it reaches every distribution in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single
 * distribution. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Reading Cache Info
 * **Example:** Report the last purge from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cdn = Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getCacheInfo = yield* Stackit.CDN.GetCacheInfo(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { lastPurgeTime } = yield* getCacheInfo();
 *         return yield* HttpServerResponse.json({ lastPurgeTime });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.GetCacheInfoHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface GetCacheInfo extends Binding.Service<
  GetCacheInfo,
  "Stackit.CDN.GetCacheInfo",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request?: GetCacheInfoRequest,
    ) => Effect.Effect<cdn.GetCacheInfoResponse, cdn.GetCacheInfoError, RuntimeContext>
  >
> {}

export const GetCacheInfo = Binding.Service<GetCacheInfo>("Stackit.CDN.GetCacheInfo");
