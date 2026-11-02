import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Resolve a name on STACKIT's DNS resolvers from a Function/Worker, such as to
 * check that a record has propagated.
 *
 * The operation takes no project or zone, so this binding has no bound resource.
 * Provide {@link LookupHttp}. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: no role. The operation has no project to bind a role on, and neither
 * its spec nor STACKIT's docs name a role or permission for it. The service
 * account belongs to the profile's project.
 *
 * ### Looking up a Name
 * **Example:** Check a record from a Cloudflare Worker
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
 *     const lookup = yield* Stackit.DNS.Lookup();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* lookup({ address: "www.example.com", recordType: "A" });
 *         return yield* HttpServerResponse.json(result);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.LookupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface Lookup extends Binding.Service<
  Lookup,
  "Stackit.DNS.Lookup",
  () => Effect.Effect<
    (
      request: dns.DnslookupRequest,
    ) => Effect.Effect<dns.DnslookupLookupResponse, dns.DnslookupError, RuntimeContext>
  >
> {}

export const Lookup = Binding.Service<Lookup>("Stackit.DNS.Lookup");
