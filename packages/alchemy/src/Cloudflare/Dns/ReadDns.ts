import type {
  GetRecordError,
  GetRecordResponse,
  ListRecordsError,
  ListRecordsRequest,
  ListRecordsResponse,
} from "@distilled.cloud/cloudflare/dns";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Zone } from "../Zone/Zone.ts";
import { type DnsToken } from "./DnsBinding.ts";
import { authorizeWith } from "../HttpClientUtils.ts";

/**
 * Binding that lets a Worker read Cloudflare DNS records at runtime.
 *
 * Creates a least-privilege {@link AccountApiToken} with only the `DNS Read`
 * permission, scoped to the single zone passed to `bind`, and binds its value
 * into the Worker so runtime code can authenticate.
 *
 * @binding
 * @product DNS
 * @category Domains & DNS
 *
 * @section Reading DNS records at runtime
 * @example Read records from inside a Worker
 * Bind the client in the Worker's Init phase and provide {@link ReadDnsBinding}.
 * The zone is fixed by `.bind(zone)` — the provisioned token only grants
 * access to that zone, so calls take no `zoneId`. Pass the {@link Zone}
 * resource directly (it's an `Effect`), or `yield* Zone` for a resolved value.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * const Zone = Cloudflare.Zone.Zone("MyZone", { name: "example.com" });
 *
 * export class ReadDnserWorker extends Cloudflare.Worker<ReadDnserWorker>()(
 *   "ReadDnserWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Init phase — bind the read client scoped to the zone.
 *     const dns = yield* Cloudflare.Dns.ReadDns(Zone);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { result } = yield* dns.listDnsRecords({ type: "A" });
 *         const record = yield* dns.getDnsRecord(result[0].id);
 *         return yield* HttpServerResponse.json({ id: record.id });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Dns.ReadDnsBinding)),
 * ) {}
 * ```
 */
export interface ReadDns extends Binding.Service<
  ReadDns,
  "Cloudflare.Dns.ReadDns",
  (zone: Zone) => Effect.Effect<ReadDnsClient>
> {}

export const ReadDns = Binding.Service<ReadDns>("Cloudflare.Dns.ReadDns");

/** List-records request, minus the zone id (bound at `.bind(zone)` time). */
export type ListRecordsRequestInput = Omit<ListRecordsRequest, "zoneId">;

/**
 * Read-only DNS record operations. Backed by the `DNS Read` permission group.
 * The zone is fixed when the client is bound, so no `zoneId` is passed per call.
 */
export interface ReadDnsClient {
  /** Fetch a single DNS record by id. */
  getDnsRecord(
    dnsRecordId: string,
  ): Effect.Effect<GetRecordResponse, GetRecordError, RuntimeContext>;
  /** List the DNS records in the bound zone. */
  listDnsRecords(
    request?: ListRecordsRequestInput,
  ): Effect.Effect<ListRecordsResponse, ListRecordsError, RuntimeContext>;
}

/** Build the read-only client over a bound token and zone id. */
export const dnsReadClient = (
  token: DnsToken,
  zoneId: Effect.Effect<string>,
): ReadDnsClient => {
  const authorize = authorizeWith(token);
  return {
    getDnsRecord: Effect.fn("Cloudflare.Dns.getDnsRecord")(
      function* (dnsRecordId) {
        return yield* authorize(
          dns.getRecord({ zoneId: yield* zoneId, dnsRecordId }),
        );
      },
    ),
    listDnsRecords: Effect.fn("Cloudflare.Dns.listDnsRecords")(
      function* (request) {
        return yield* authorize(
          dns.listRecords({ zoneId: yield* zoneId, ...request }),
        );
      },
    ),
  };
};
