import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface ListRecordSetsRequest extends Omit<
  dns.ListRecordSetsRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `listRecordSets`: list one page of a zone's
 * record sets, with the API's name, type and state filters.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link ListRecordSetsHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.zone.list` permission on the project holding the zone, so the
 * host can read every zone in that project, not only this one.
 *
 * ### Listing Record Sets
 * **Example:** List the TXT records of a zone from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Domain = Stackit.DNS.Zone("Domain", {
 *   dnsName: "example.com",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listRecordSets = yield* Stackit.DNS.ListRecordSets(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rrSets } = yield* listRecordSets({ type_eq_: "TXT" });
 *         return yield* HttpServerResponse.json({ count: rrSets.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.ListRecordSetsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface ListRecordSets extends Binding.Service<
  ListRecordSets,
  "Stackit.DNS.ListRecordSets",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: ListRecordSetsRequest,
    ) => Effect.Effect<dns.ListRecordSetsResponse, dns.ListRecordSetsError, RuntimeContext>
  >
> {}

export const ListRecordSets = Binding.Service<ListRecordSets>("Stackit.DNS.ListRecordSets");
