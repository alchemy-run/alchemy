import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface ImportRecordSetsRequest extends Omit<
  dns.ImportRecordSetsRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `importRecordSets`: bulk-apply record sets to a
 * zone. Record sets it creates aren't tracked by Alchemy, and `delete`
 * removes ones that are.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link ImportRecordSetsHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.zone.create` permission on the project holding the zone, so the
 * host can change every zone in that project, not only this one. STACKIT authorizes
 * every DNS write with that one permission.
 *
 * ### Importing Record Sets
 * **Example:** Upsert record sets from a Cloudflare Worker
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
 *     const importRecordSets = yield* Stackit.DNS.ImportRecordSets(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const summary = yield* importRecordSets({
 *           format: "json",
 *           importType: "upsert",
 *           rrSets: [{ name: "www", type: "A", ttl: 300, content: ["192.0.2.10"] }],
 *         });
 *         return yield* HttpServerResponse.json(summary);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.ImportRecordSetsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface ImportRecordSets extends Binding.Service<
  ImportRecordSets,
  "Stackit.DNS.ImportRecordSets",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: ImportRecordSetsRequest,
    ) => Effect.Effect<dns.ImportRecordSetsResponse, dns.ImportRecordSetsError, RuntimeContext>
  >
> {}

export const ImportRecordSets = Binding.Service<ImportRecordSets>("Stackit.DNS.ImportRecordSets");
