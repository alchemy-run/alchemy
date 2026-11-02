import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface ExportRecordSetsRequest extends Omit<
  dns.ExportRecordSetsRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `exportRecordSets`: export a zone's record sets
 * as `json`, `csv` or `bind`, for a backup.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link ExportRecordSetsHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.zone.list` permission on the project holding the zone, so the
 * host can read every zone in that project, not only this one.
 *
 * ### Exporting a Zone
 * **Example:** Export the zone from a Cloudflare Worker
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
 *     const exportRecordSets = yield* Stackit.DNS.ExportRecordSets(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const exported = yield* exportRecordSets({ format: "json" });
 *         return yield* HttpServerResponse.json(exported);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.ExportRecordSetsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface ExportRecordSets extends Binding.Service<
  ExportRecordSets,
  "Stackit.DNS.ExportRecordSets",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: ExportRecordSetsRequest,
    ) => Effect.Effect<dns.ZoneDataExchange, dns.ExportRecordSetsError, RuntimeContext>
  >
> {}

export const ExportRecordSets = Binding.Service<ExportRecordSets>("Stackit.DNS.ExportRecordSets");
