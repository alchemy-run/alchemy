import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ExportRecordSetsRequest } from "./ExportRecordSets.ts";
import type { GetRecordSetRequest } from "./GetRecordSet.ts";
import type { GetZoneRequest } from "./GetZone.ts";
import type { ListRecordSetsRequest } from "./ListRecordSets.ts";
import type { Zone } from "./Zone.ts";

/** The read operations on a bound zone. The zone's project and id are injected. */
export interface ReadZoneClient {
  /** Read the zone's settings, state and name servers. */
  getZone(
    request?: GetZoneRequest,
  ): Effect.Effect<dns.ZoneResponse, dns.GetZoneError, RuntimeContext>;
  /** Read one record set by id. */
  getRecordSet(
    request: GetRecordSetRequest,
  ): Effect.Effect<dns.RecordSetResponse, dns.GetRecordSetError, RuntimeContext>;
  /** List one page of the zone's record sets. */
  listRecordSets(
    request?: ListRecordSetsRequest,
  ): Effect.Effect<dns.ListRecordSetsResponse, dns.ListRecordSetsError, RuntimeContext>;
  /** Export the zone's record sets as `json`, `csv` or `bind`. */
  exportRecordSets(
    request?: ExportRecordSetsRequest,
  ): Effect.Effect<dns.ZoneDataExchange, dns.ExportRecordSetsError, RuntimeContext>;
}

/**
 * Read a {@link Zone} and its record sets from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadZoneHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: the `dns.zone.list` permission on the project holding the zone, so the
 * host can read every zone in that project, not only this one.
 *
 * ### Reading a Zone
 * **Example:** List a zone's record sets from a Cloudflare Worker
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
 *     const zone = yield* Stackit.DNS.ReadZone(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rrSets } = yield* zone.listRecordSets({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({ count: rrSets.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.ReadZoneHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface ReadZone extends Binding.Service<
  ReadZone,
  "Stackit.DNS.ReadZone",
  (zone: Zone) => Effect.Effect<ReadZoneClient>
> {}

export const ReadZone = Binding.Service<ReadZone>("Stackit.DNS.ReadZone");
