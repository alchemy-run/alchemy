import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface UpdateRecordSetRequest extends Omit<
  dns.PartialUpdateRecordSetRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `partialUpdateRecordSet`: update a record set's
 * records, TTL or comment. `records` replaces the whole set.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link UpdateRecordSetHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.zone.create` permission on the project holding the zone, so the
 * host can change every zone in that project, not only this one. STACKIT authorizes
 * every DNS write with that one permission.
 *
 * ### Updating a Record Set
 * **Example:** Point a record at a new address from a Cloudflare Worker
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
 *     const updateRecordSet = yield* Stackit.DNS.UpdateRecordSet(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const updated = yield* updateRecordSet({
 *           rrSetId: "<record-set-id>",
 *           records: [{ content: "192.0.2.10" }],
 *         });
 *         return yield* HttpServerResponse.json(updated);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.UpdateRecordSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface UpdateRecordSet extends Binding.Service<
  UpdateRecordSet,
  "Stackit.DNS.UpdateRecordSet",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: UpdateRecordSetRequest,
    ) => Effect.Effect<dns.Message, dns.PartialUpdateRecordSetError, RuntimeContext>
  >
> {}

export const UpdateRecordSet = Binding.Service<UpdateRecordSet>("Stackit.DNS.UpdateRecordSet");
