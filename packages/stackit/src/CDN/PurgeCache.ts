import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Distribution } from "./Distribution.ts";

export interface PurgeCacheRequest extends Omit<
  cdn.PurgeCacheRequest,
  "projectId" | "distributionId"
> {}

/**
 * Runtime binding for CDN `PurgeCache`: purge the whole cache of a distribution, or one path.
 *
 * Without a `path`, the entire cache is invalidated. With one, only that path is:
 * `/some/path` and `/some/path.txt` count as different paths.
 *
 * Bind this operation to a {@link Distribution} in a Function/Worker init phase and provide
 * {@link PurgeCacheHttp}. The resource's project and id are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.edit` and
 * `cdn.distribution.update` on the project holding the distribution, so it reaches
 * every distribution in that project: STACKIT binds roles on projects, folders and
 * organizations, not on a single distribution. The deployer needs `iam.role.add`
 * on that scope to define the role.
 *
 * ### Purging the Cache
 * **Example:** Purge one path from a Cloudflare Worker
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
 *     const purgeCache = yield* Stackit.CDN.PurgeCache(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* purgeCache({ path: "/index.html" });
 *         return HttpServerResponse.text("purged");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.PurgeCacheHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface PurgeCache extends Binding.Service<
  PurgeCache,
  "Stackit.CDN.PurgeCache",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request?: PurgeCacheRequest,
    ) => Effect.Effect<cdn.PurgeCacheResponse2, cdn.PurgeCacheError, RuntimeContext>
  >
> {}

export const PurgeCache = Binding.Service<PurgeCache>("Stackit.CDN.PurgeCache");
