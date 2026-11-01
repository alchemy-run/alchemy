import type * as dns from "@distilled.cloud/stackit/dns";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Zone } from "./Zone.ts";

export interface CreateRecordSetRequest extends Omit<
  dns.CreateRecordSetRequest,
  "projectId" | "zoneId"
> {}

/**
 * Runtime binding for DNS `createRecordSet`: create a record set in a zone
 * at runtime, such as an ACME DNS-01 challenge.
 *
 * Bind this operation to a {@link Zone} in a Function/Worker init phase
 * and provide {@link CreateRecordSetHttp}. The zone's project and id are
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
 * ### Creating a Record Set
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
 *     const createRecordSet = yield* Stackit.DNS.CreateRecordSet(yield* Domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rrset } = yield* createRecordSet({
 *           name: "_acme-challenge",
 *           type: "TXT",
 *           records: [{ content: "<token>" }],
 *           ttl: 60,
 *         });
 *         return yield* HttpServerResponse.json({ id: rrset.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.CreateRecordSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category DNS
 */
export interface CreateRecordSet extends Binding.Service<
  CreateRecordSet,
  "Stackit.DNS.CreateRecordSet",
  (
    zone: Zone,
  ) => Effect.Effect<
    (
      request: CreateRecordSetRequest,
    ) => Effect.Effect<dns.RecordSetResponse, dns.CreateRecordSetError, RuntimeContext>
  >
> {}

export const CreateRecordSet = Binding.Service<CreateRecordSet>("Stackit.DNS.CreateRecordSet");
