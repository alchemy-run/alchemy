import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CreateRecordSetRequest } from "./CreateRecordSet.ts";
import type { DeleteRecordSetRequest } from "./DeleteRecordSet.ts";
import type { ImportRecordSetsRequest } from "./ImportRecordSets.ts";
import type { RetrieveZoneRequest } from "./RetrieveZone.ts";
import type { UpdateRecordsRequest } from "./UpdateRecords.ts";
import type { UpdateRecordSetRequest } from "./UpdateRecordSet.ts";
import type { Zone } from "./Zone.ts";

/** The write operations on a bound zone. The zone's project and id are injected. */
export interface WriteZoneClient {
  /** Create a record set. */
  createRecordSet(
    request: CreateRecordSetRequest,
  ): Effect.Effect<dns.RecordSetResponse, dns.CreateRecordSetError, RuntimeContext>;
  /** Update a record set. `records` replaces the whole set. */
  updateRecordSet(
    request: UpdateRecordSetRequest,
  ): Effect.Effect<dns.Message, dns.PartialUpdateRecordSetError, RuntimeContext>;
  /** Add or delete single records in a record set. */
  updateRecords(
    request: UpdateRecordsRequest,
  ): Effect.Effect<dns.Message, dns.PartialUpdateRecordError, RuntimeContext>;
  /** Delete a record set. STACKIT soft-deletes it. */
  deleteRecordSet(
    request: DeleteRecordSetRequest,
  ): Effect.Effect<dns.Message, dns.DeleteRecordSetError, RuntimeContext>;
  /** Bulk-apply record sets to the zone. Alchemy doesn't track what this creates. */
  importRecordSets(
    request?: ImportRecordSetsRequest,
  ): Effect.Effect<dns.ImportRecordSetsResponse, dns.ImportRecordSetsError, RuntimeContext>;
  /** Queue a zone transfer for a secondary zone. */
  retrieveZone(
    request?: RetrieveZoneRequest,
  ): Effect.Effect<dns.Message, dns.RetrieveZoneError, RuntimeContext>;
}

/**
 * Change the record sets of a {@link Zone} from a Function/Worker, such as an
 * ACME DNS-01 challenge or a dynamic DNS update.
 *
 * Bind it in the init phase and provide {@link WriteZoneHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: the `dns.zone.create` permission on the project holding the zone, so the
 * host can change every zone in that project, not only this one. STACKIT authorizes
 * every DNS write with that one permission.
 *
 * ### Writing to a Zone
 * **Example:** Publish a DNS-01 challenge from a Cloudflare Worker
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
 *     const zone = yield* Stackit.DNS.WriteZone(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rrset } = yield* zone.createRecordSet({
 *           name: "_acme-challenge",
 *           type: "TXT",
 *           records: [{ content: "<token>" }],
 *           ttl: 60,
 *         });
 *         return yield* HttpServerResponse.json({ id: rrset.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.WriteZoneHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface WriteZone extends Binding.Service<
  WriteZone,
  "Stackit.DNS.WriteZone",
  (zone: Zone) => Effect.Effect<WriteZoneClient>
> {}

export const WriteZone = Binding.Service<WriteZone>("Stackit.DNS.WriteZone");
