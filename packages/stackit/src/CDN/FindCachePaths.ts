import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Distribution } from "./Distribution.ts";

export interface FindCachePathsRequest extends Omit<
  cdn.FindCachePathsRequest,
  "projectId" | "distributionId"
> {}

/**
 * Runtime binding for CDN `FindCachePaths`: search the paths previously purged from a distribution's cache.
 *
 * `path` is a substring of the paths to find. The most recent purge comes first.
 *
 * Bind this operation to a {@link Distribution} in a Function/Worker init phase and provide
 * {@link FindCachePathsHttp}. The resource's project and id are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.get` on the project holding
 * the distribution, so it reaches every distribution in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single
 * distribution. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Searching Purged Paths
 * **Example:** Find purged paths from a Cloudflare Worker
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
 *     const findCachePaths = yield* Stackit.CDN.FindCachePaths(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { response } = yield* findCachePaths({ path: "/assets" });
 *         return yield* HttpServerResponse.json({ paths: response.map((entry) => entry.path) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.FindCachePathsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface FindCachePaths extends Binding.Service<
  FindCachePaths,
  "Stackit.CDN.FindCachePaths",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request: FindCachePathsRequest,
    ) => Effect.Effect<cdn.FindCachePathsResponse, cdn.FindCachePathsError, RuntimeContext>
  >
> {}

export const FindCachePaths = Binding.Service<FindCachePaths>("Stackit.CDN.FindCachePaths");
