import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface GetZoneRequest extends Omit<dns.GetZoneRequest, "projectId" | "zoneId"> {}

/**
 * Runtime binding for DNS `getZone`: read a zone's settings, state and
 * name servers.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link GetZoneHttp}. The zone's project and id are injected
 * into each request. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: the `dns.reader` role on the project holding the zone. The role name
 * follows STACKIT's `<product>.reader` pattern, but no STACKIT source lists it;
 * check it with `listRoles` before relying on it, because a wrong name fails the
 * deploy.
 *
 * ### Reading the Zone
 * **Example:** Read the zone from a Cloudflare Worker
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
 *     const getZone = yield* Stackit.DNS.GetZone(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { zone: live } = yield* getZone({});
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.GetZoneHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface GetZone extends Binding.Service<
  GetZone,
  "Stackit.DNS.GetZone",
  (
    zone: Zone,
  ) => Effect.Effect<
    (request: GetZoneRequest) => Effect.Effect<dns.ZoneResponse, dns.GetZoneError, RuntimeContext>
  >
> {}

export const GetZone = Binding.Service<GetZone>("Stackit.DNS.GetZone");
