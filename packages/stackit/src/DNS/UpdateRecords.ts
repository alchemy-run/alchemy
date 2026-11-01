import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface UpdateRecordsRequest extends Omit<
  dns.PartialUpdateRecordRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `partialUpdateRecord`: add or delete single
 * records in a record set without rewriting the set.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link UpdateRecordsHttp}. The zone's project and id are
 * injected into each request. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: the `dns.admin` role on the project holding the zone, so the host can
 * change every zone in that project, not only this one. A custom role would be
 * narrower, but STACKIT doesn't document DNS permission names. The role name
 * follows STACKIT's `<product>.admin` pattern, but no STACKIT source lists it;
 * check it with `listRoles` before relying on it, because a wrong name fails the
 * deploy.
 *
 * ### Adding or Removing One Record
 * **Example:** Add one record from a Cloudflare Worker
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
 *     const updateRecords = yield* Stackit.DNS.UpdateRecords(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const updated = yield* updateRecords({
 *           rrSetId: "<record-set-id>",
 *           action: "add",
 *           records: [{ content: "192.0.2.11" }],
 *         });
 *         return yield* HttpServerResponse.json(updated);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.UpdateRecordsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface UpdateRecords extends Binding.Service<
  UpdateRecords,
  "Stackit.DNS.UpdateRecords",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: UpdateRecordsRequest,
    ) => Effect.Effect<dns.Message, dns.PartialUpdateRecordError, RuntimeContext>
  >
> {}

export const UpdateRecords = Binding.Service<UpdateRecords>("Stackit.DNS.UpdateRecords");
