import type {
  GetRecordError,
  GetRecordResponse,
  ListRecordsError,
  ListRecordsRequest,
  ListRecordsResponse,
} from "@distilled.cloud/cloudflare/dns";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import {
  authorizeDns,
  type DnsBindOptions,
  type DnsToken,
  makeDnsClient,
  makeDnsPolicyLive,
} from "./DnsBinding.ts";

/** List-records request, minus the zone id (passed positionally). */
export type ListRecordsRequestInput = Omit<ListRecordsRequest, "zoneId">;

/**
 * Read-only DNS record operations. Backed by the `DNS Read` permission group.
 */
export interface DnsReadClient {
  /** Fetch a single DNS record by id. */
  getDnsRecord(
    zoneId: string,
    dnsRecordId: string,
  ): Effect.Effect<GetRecordResponse, GetRecordError, RuntimeContext>;
  /** List the DNS records in a zone. */
  listDnsRecords(
    zoneId: string,
    request?: ListRecordsRequestInput,
  ): Effect.Effect<ListRecordsResponse, ListRecordsError, RuntimeContext>;
}

/** Build the read-only client over a bound token. */
export const dnsReadClient = (token: DnsToken): DnsReadClient => {
  const authorize = authorizeDns(token);
  return {
    getDnsRecord: Effect.fn("Cloudflare.Dns.getDnsRecord")(
      function* (zoneId, dnsRecordId) {
        return yield* authorize(dns.getRecord({ zoneId, dnsRecordId }));
      },
    ),
    listDnsRecords: Effect.fn("Cloudflare.Dns.listDnsRecords")(
      function* (zoneId, request) {
        return yield* authorize(dns.listRecords({ zoneId, ...request }));
      },
    ),
  };
};

/**
 * Binding that lets a Worker read Cloudflare DNS records at runtime.
 *
 * Creates a scoped {@link AccountApiToken} with only the `DNS Read` permission
 * (across all zones in the account) and binds its value into the Worker so
 * runtime code can authenticate.
 *
 * @binding
 *
 * @section Reading DNS records across all zones
 * @example Bind a token scoped to every zone in the account
 * ```typescript
 * const dns = yield* Cloudflare.DnsRead.bind();
 * ```
 *
 * @section Reading DNS records in a specific zone
 * @example Bind a token scoped to a single zone
 * ```typescript
 * const dns = yield* Cloudflare.DnsRead.bind({ zoneId });
 * ```
 *
 * @section Reading records
 * @example List and get records
 * ```typescript
 * const { result } = yield* dns.listDnsRecords(zoneId, { type: "A" });
 * const record = yield* dns.getDnsRecord(zoneId, result[0].id);
 * ```
 *
 * @section Runtime Layer
 * Provide {@link DnsReadLive} in the Worker's runtime layer.
 * ```typescript
 * Effect.provide(Cloudflare.DnsReadLive)
 * ```
 */
export class DnsRead extends Binding.Service<
  DnsRead,
  (options?: DnsBindOptions) => Effect.Effect<DnsReadClient>
>()("Cloudflare.DnsRead") {}

/**
 * Deploy-time policy for {@link DnsRead}. Attaches the `DNS Read` permission to
 * the token via its binding contract.
 */
export class DnsReadPolicy extends Binding.Policy<
  DnsReadPolicy,
  (token: AccountApiToken, zoneId: string | undefined) => Effect.Effect<void>
>()("Cloudflare.DnsRead") {}

/** Runtime layer for {@link DnsRead}. */
export const DnsReadLive = Layer.effect(
  DnsRead,
  makeDnsClient(DnsReadPolicy, "DnsReadToken", dnsReadClient),
);

/** Live deploy-time policy layer for {@link DnsReadPolicy}. */
export const DnsReadPolicyLive = makeDnsPolicyLive(
  DnsReadPolicy,
  "Cloudflare.DnsRead",
  ["DNS Read"],
);
