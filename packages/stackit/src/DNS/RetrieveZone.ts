import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface RetrieveZoneRequest extends Omit<
  dns.RetrieveZoneRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `retrieveZone`: queue a zone transfer for a
 * secondary zone, after a runtime changes the customer's primary. STACKIT
 * tries once, against one primary, so this doesn't guarantee the transfer.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link RetrieveZoneHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.zone.create` permission on the project holding the zone, so the
 * host can change every zone in that project, not only this one. STACKIT authorizes
 * every DNS write with that one permission.
 *
 * ### Transferring a Secondary Zone
 * **Example:** Queue a transfer from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Domain = Stackit.DNS.Zone("Domain", {
 *   dnsName: "example.com",
 *   type: "secondary",
 *   primaries: ["192.0.2.1"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const retrieveZone = yield* Stackit.DNS.RetrieveZone(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const queued = yield* retrieveZone({});
 *         return yield* HttpServerResponse.json(queued);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.RetrieveZoneHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface RetrieveZone extends Binding.Service<
  RetrieveZone,
  "Stackit.DNS.RetrieveZone",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: RetrieveZoneRequest,
    ) => Effect.Effect<dns.Message, dns.RetrieveZoneError, RuntimeContext>
  >
> {}

export const RetrieveZone = Binding.Service<RetrieveZone>("Stackit.DNS.RetrieveZone");
