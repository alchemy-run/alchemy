import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import {
  type DnsToken,
  makeDnsClient,
  makeDnsPolicyLive,
} from "./DnsBinding.ts";
import { dnsReadClient, type DnsReadClient } from "./DnsRead.ts";
import { dnsWriteClient, type DnsWriteClient } from "./DnsWrite.ts";

/** Combined read + write DNS record operations. */
export interface DnsReadWriteClient extends DnsReadClient, DnsWriteClient {}

/** Build the combined read + write client over a bound token. */
export const dnsReadWriteClient = (token: DnsToken): DnsReadWriteClient => ({
  ...dnsReadClient(token),
  ...dnsWriteClient(token),
});

/**
 * Binding that lets a Worker perform the full Cloudflare DNS record CRUD
 * surface at runtime.
 *
 * Creates a scoped {@link AccountApiToken} with both the `DNS Read` and `DNS
 * Write` permissions (across all zones in the account) and binds its value into
 * the Worker so runtime code can authenticate.
 *
 * @binding
 *
 * @section Managing DNS records at runtime
 * @example Create, read, and delete a record from a request handler
 * ```typescript
 * // init
 * const dns = yield* Cloudflare.DnsReadWrite.bind();
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const { result } = yield* dns.createDnsRecord(zoneId, {
 *       type: "A",
 *       name: "app.example.com",
 *       content: "192.0.2.1",
 *       ttl: 1,
 *     });
 *     const record = yield* dns.getDnsRecord(zoneId, result.id);
 *     yield* dns.deleteDnsRecord(zoneId, result.id);
 *     return HttpServerResponse.json({ id: record.result.id });
 *   }),
 * };
 * ```
 *
 * @section Runtime Layer
 * Provide {@link DnsReadWriteLive} in the Worker's runtime layer.
 * ```typescript
 * Effect.provide(Cloudflare.DnsReadWriteLive)
 * ```
 */
export class DnsReadWrite extends Binding.Service<
  DnsReadWrite,
  () => Effect.Effect<DnsReadWriteClient>
>()("Cloudflare.DnsReadWrite") {}

/**
 * Deploy-time policy for {@link DnsReadWrite}. Attaches both the `DNS Read` and
 * `DNS Write` permissions to the token via its binding contract.
 */
export class DnsReadWritePolicy extends Binding.Policy<
  DnsReadWritePolicy,
  (token: AccountApiToken) => Effect.Effect<void>
>()("Cloudflare.DnsReadWrite") {}

/** Runtime layer for {@link DnsReadWrite}. */
export const DnsReadWriteLive = Layer.effect(
  DnsReadWrite,
  makeDnsClient(DnsReadWritePolicy, "DnsReadWriteToken", dnsReadWriteClient),
);

/** Live deploy-time policy layer for {@link DnsReadWritePolicy}. */
export const DnsReadWritePolicyLive = makeDnsPolicyLive(
  DnsReadWritePolicy,
  "Cloudflare.DnsReadWrite",
  ["DNS Read", "DNS Write"],
);
