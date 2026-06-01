import type {
  BatchRecordError,
  BatchRecordRequest,
  BatchRecordResponse,
  CreateRecordError,
  CreateRecordRequest,
  CreateRecordResponse,
  DeleteRecordError,
  DeleteRecordResponse,
  PatchRecordError,
  PatchRecordRequest,
  PatchRecordResponse,
  UpdateRecordError,
  UpdateRecordRequest,
  UpdateRecordResponse,
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

/** Create-record request, minus the zone id (passed positionally). */
export type CreateRecordRequestInput = Omit<CreateRecordRequest, "zoneId">;

/** Update-record request, minus the zone id and record id (positional). */
export type UpdateRecordRequestInput = Omit<
  UpdateRecordRequest,
  "zoneId" | "dnsRecordId"
>;

/** Patch-record request, minus the zone id and record id (positional). */
export type PatchRecordRequestInput = Omit<
  PatchRecordRequest,
  "zoneId" | "dnsRecordId"
>;

/** Batch-records request, minus the zone id (passed positionally). */
export type BatchRecordRequestInput = Omit<BatchRecordRequest, "zoneId">;

/**
 * Mutating DNS record operations. Backed by the `DNS Write` permission group.
 */
export interface DnsWriteClient {
  /** Create a DNS record. */
  createDnsRecord(
    zoneId: string,
    request: CreateRecordRequestInput,
  ): Effect.Effect<CreateRecordResponse, CreateRecordError, RuntimeContext>;
  /** Overwrite (PUT) a DNS record. */
  updateDnsRecord(
    zoneId: string,
    dnsRecordId: string,
    request: UpdateRecordRequestInput,
  ): Effect.Effect<UpdateRecordResponse, UpdateRecordError, RuntimeContext>;
  /** Partially update (PATCH) a DNS record. */
  patchDnsRecord(
    zoneId: string,
    dnsRecordId: string,
    request: PatchRecordRequestInput,
  ): Effect.Effect<PatchRecordResponse, PatchRecordError, RuntimeContext>;
  /** Delete a DNS record by id. */
  deleteDnsRecord(
    zoneId: string,
    dnsRecordId: string,
  ): Effect.Effect<DeleteRecordResponse, DeleteRecordError, RuntimeContext>;
  /** Apply a batch of create / update / patch / delete operations atomically. */
  batchDnsRecords(
    zoneId: string,
    request: BatchRecordRequestInput,
  ): Effect.Effect<BatchRecordResponse, BatchRecordError, RuntimeContext>;
}

/** Build the write client over a bound token. */
export const dnsWriteClient = (token: DnsToken): DnsWriteClient => {
  const authorize = authorizeDns(token);
  return {
    createDnsRecord: Effect.fn("Cloudflare.Dns.createDnsRecord")(
      function* (zoneId, request) {
        return yield* authorize(dns.createRecord({ zoneId, ...request }));
      },
    ),
    updateDnsRecord: Effect.fn("Cloudflare.Dns.updateDnsRecord")(
      function* (zoneId, dnsRecordId, request) {
        return yield* authorize(
          dns.updateRecord({ zoneId, dnsRecordId, ...request }),
        );
      },
    ),
    patchDnsRecord: Effect.fn("Cloudflare.Dns.patchDnsRecord")(
      function* (zoneId, dnsRecordId, request) {
        return yield* authorize(
          dns.patchRecord({ zoneId, dnsRecordId, ...request }),
        );
      },
    ),
    deleteDnsRecord: Effect.fn("Cloudflare.Dns.deleteDnsRecord")(
      function* (zoneId, dnsRecordId) {
        return yield* authorize(dns.deleteRecord({ zoneId, dnsRecordId }));
      },
    ),
    batchDnsRecords: Effect.fn("Cloudflare.Dns.batchDnsRecords")(
      function* (zoneId, request) {
        return yield* authorize(dns.batchRecord({ zoneId, ...request }));
      },
    ),
  };
};

/**
 * Binding that lets a Worker create, update, and delete Cloudflare DNS records
 * at runtime.
 *
 * Creates a scoped {@link AccountApiToken} with only the `DNS Write` permission
 * (across all zones in the account) and binds its value into the Worker so
 * runtime code can authenticate.
 *
 * @binding
 *
 * @section Mutating DNS records across all zones
 * @example Bind a token scoped to every zone in the account
 * ```typescript
 * const dns = yield* Cloudflare.DnsWrite.bind();
 * ```
 *
 * @section Mutating DNS records in a specific zone
 * @example Bind a token scoped to a single zone
 * ```typescript
 * const dns = yield* Cloudflare.DnsWrite.bind({ zoneId });
 * ```
 *
 * @example Create a record
 * ```typescript
 * const { result } = yield* dns.createDnsRecord(zoneId, {
 *   type: "A",
 *   name: "app.example.com",
 *   content: "192.0.2.1",
 *   ttl: 1,
 *   proxied: true,
 * });
 * ```
 *
 * @example Update and delete a record
 * ```typescript
 * yield* dns.updateDnsRecord(zoneId, recordId, {
 *   type: "A",
 *   name: "app.example.com",
 *   content: "192.0.2.2",
 *   ttl: 1,
 * });
 * yield* dns.deleteDnsRecord(zoneId, recordId);
 * ```
 *
 * @example Apply a batch of changes atomically
 * ```typescript
 * yield* dns.batchDnsRecords(zoneId, {
 *   posts: [{ type: "A", name: "a.example.com", content: "192.0.2.1", ttl: 1 }],
 *   deletes: [{ id: oldRecordId }],
 * });
 * ```
 *
 * @section Runtime Layer
 * Provide {@link DnsWriteLive} in the Worker's runtime layer.
 * ```typescript
 * Effect.provide(Cloudflare.DnsWriteLive)
 * ```
 */
export class DnsWrite extends Binding.Service<
  DnsWrite,
  (options?: DnsBindOptions) => Effect.Effect<DnsWriteClient>
>()("Cloudflare.DnsWrite") {}

/**
 * Deploy-time policy for {@link DnsWrite}. Attaches the `DNS Write` permission
 * to the token via its binding contract.
 */
export class DnsWritePolicy extends Binding.Policy<
  DnsWritePolicy,
  (token: AccountApiToken, zoneId: string | undefined) => Effect.Effect<void>
>()("Cloudflare.DnsWrite") {}

/** Runtime layer for {@link DnsWrite}. */
export const DnsWriteLive = Layer.effect(
  DnsWrite,
  makeDnsClient(DnsWritePolicy, "DnsWriteToken", dnsWriteClient),
);

/** Live deploy-time policy layer for {@link DnsWritePolicy}. */
export const DnsWritePolicyLive = makeDnsPolicyLive(
  DnsWritePolicy,
  "Cloudflare.DnsWrite",
  ["DNS Write"],
);
