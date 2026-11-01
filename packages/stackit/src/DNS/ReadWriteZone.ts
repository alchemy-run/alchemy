import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadZoneClient } from "./ReadZone.ts";
import type { WriteZoneClient } from "./WriteZone.ts";
import type { Zone } from "./Zone.ts";

/** Every read and write operation on a bound zone. */
export interface ReadWriteZoneClient extends ReadZoneClient, WriteZoneClient {}

/**
 * Read and change a {@link Zone} and its record sets from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadWriteZoneHttp}. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: the `dns.admin` role on the project holding the zone, so the host can
 * read and change every zone in that project, not only this one. A custom role
 * would be narrower, but STACKIT doesn't document DNS permission names. The role
 * name follows STACKIT's `<product>.admin` pattern, but no STACKIT source lists
 * it; check it with `listRoles` before relying on it, because a wrong name fails
 * the deploy.
 *
 * ### Reading and Writing a Zone
 * **Example:** Replace a TXT record from a Cloudflare Worker
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
 *     const zone = yield* Stackit.DNS.ReadWriteZone(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rrSets } = yield* zone.listRecordSets({ type_eq_: "TXT" });
 *         yield* Effect.forEach(rrSets, (rrset) =>
 *           zone.deleteRecordSet({ rrSetId: rrset.id }),
 *         );
 *         return yield* HttpServerResponse.json({ deleted: rrSets.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.ReadWriteZoneHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface ReadWriteZone extends Binding.Service<
  ReadWriteZone,
  "Stackit.DNS.ReadWriteZone",
  (zone: Zone) => Effect.Effect<ReadWriteZoneClient>
> {}

export const ReadWriteZone = Binding.Service<ReadWriteZone>("Stackit.DNS.ReadWriteZone");
