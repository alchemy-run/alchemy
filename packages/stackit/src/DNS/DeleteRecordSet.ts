import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface DeleteRecordSetRequest extends Omit<
  dns.DeleteRecordSetRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `deleteRecordSet`: delete a record set of a
 * zone. STACKIT soft-deletes it: it stays readable in `DELETE_SUCCEEDED`.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link DeleteRecordSetHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.zone.create` permission on the project holding the zone, so the
 * host can change every zone in that project, not only this one. STACKIT authorizes
 * every DNS write with that one permission.
 *
 * ### Deleting a Record Set
 * **Example:** Remove a DNS-01 challenge from a Cloudflare Worker
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
 *     const deleteRecordSet = yield* Stackit.DNS.DeleteRecordSet(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const deleted = yield* deleteRecordSet({ rrSetId: "<record-set-id>" });
 *         return yield* HttpServerResponse.json(deleted);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.DeleteRecordSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface DeleteRecordSet extends Binding.Service<
  DeleteRecordSet,
  "Stackit.DNS.DeleteRecordSet",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: DeleteRecordSetRequest,
    ) => Effect.Effect<dns.Message, dns.DeleteRecordSetError, RuntimeContext>
  >
> {}

export const DeleteRecordSet = Binding.Service<DeleteRecordSet>("Stackit.DNS.DeleteRecordSet");
