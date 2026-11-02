import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Flush a name from the cache of STACKIT's DNS resolvers from a Function/Worker,
 * such as after a runtime record change.
 *
 * The operation takes no project or zone, so this binding has no bound resource.
 * Provide {@link FlushCacheHttp}. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: no role. The operation has no project to bind a role on, and neither
 * its spec nor STACKIT's docs name a role or permission for it. The service
 * account belongs to the profile's project.
 *
 * ### Flushing a Name
 * **Example:** Flush a name from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const flushCache = yield* Stackit.DNS.FlushCache();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const flushed = yield* flushCache({ domain: "www.example.com", type: "A" });
 *         return yield* HttpServerResponse.json(flushed);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.FlushCacheHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface FlushCache extends Binding.Service<
  FlushCache,
  "Stackit.DNS.FlushCache",
  () => Effect.Effect<
    (
      request: dns.FlushRequest,
    ) => Effect.Effect<dns.FlushCreateFlushResponse, dns.FlushError, RuntimeContext>
  >
> {}

export const FlushCache = Binding.Service<FlushCache>("Stackit.DNS.FlushCache");
