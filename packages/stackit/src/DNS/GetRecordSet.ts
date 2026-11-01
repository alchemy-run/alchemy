import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface GetRecordSetRequest extends Omit<
  dns.GetRecordSetRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `getRecordSet`: read one record set of a zone by
 * id.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link GetRecordSetHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.zone.list` permission on the project holding the zone, so the
 * host can read every zone in that project, not only this one.
 *
 * ### Reading a Record Set
 * **Example:** Read a record set from a Cloudflare Worker
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
 *     const getRecordSet = yield* Stackit.DNS.GetRecordSet(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rrset } = yield* getRecordSet({ rrSetId: "<record-set-id>" });
 *         return yield* HttpServerResponse.json({ records: rrset.records });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.GetRecordSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface GetRecordSet extends Binding.Service<
  GetRecordSet,
  "Stackit.DNS.GetRecordSet",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: GetRecordSetRequest,
    ) => Effect.Effect<dns.RecordSetResponse, dns.GetRecordSetError, RuntimeContext>
  >
> {}

export const GetRecordSet = Binding.Service<GetRecordSet>("Stackit.DNS.GetRecordSet");
