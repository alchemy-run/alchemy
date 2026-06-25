import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Zone } from "../Zone/Zone.ts";
import { type DnsToken } from "./DnsBinding.ts";
import { dnsReadClient, type DnsReadClient } from "./DnsRead.ts";
import { dnsWriteClient, type DnsWriteClient } from "./DnsWrite.ts";

/**
 * Binding that lets a Worker perform the full Cloudflare DNS record CRUD
 * surface at runtime.
 *
 * Creates a least-privilege {@link AccountApiToken} with both the `DNS Read`
 * and `DNS Write` permissions, scoped to the single zone passed to `bind`, and
 * binds its value into the Worker so runtime code can authenticate.
 *
 * @binding
 * @product DNS
 * @category Domains & DNS
 *
 * @section Managing DNS records at runtime
 * @example Full CRUD from inside a Worker
 * Bind the client in the Worker's Init phase and provide
 * {@link DnsReadWriteBinding}. The zone is fixed by `.bind(zone)` — the
 * provisioned token only grants access to that zone, so calls take no
 * `zoneId`. Pass the {@link Zone} resource directly (it's an `Effect`), or
 * `yield* Zone` for a resolved value.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * const Zone = Cloudflare.Zone("MyZone", { name: "example.com" });
 *
 * export class DnsWorker extends Cloudflare.Worker<DnsWorker>()(
 *   "DnsWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Init phase — bind the full CRUD client scoped to the zone.
 *     const dns = yield* Cloudflare.DnsReadWrite(Zone);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { result } = yield* dns.createDnsRecord({
 *           type: "A",
 *           name: "app.example.com",
 *           content: "192.0.2.1",
 *           ttl: 1,
 *         });
 *         const record = yield* dns.getDnsRecord(result.id);
 *         yield* dns.deleteDnsRecord(result.id);
 *         return yield* HttpServerResponse.json({ id: record.id });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.DnsReadWriteBinding)),
 * ) {}
 * ```
 */
export interface DnsReadWrite extends Binding.Service<
  DnsReadWrite,
  "Cloudflare.Dns.DnsReadWrite",
  (zone: Zone) => Effect.Effect<DnsReadWriteClient>
> {}

export const DnsReadWrite = Binding.Service<DnsReadWrite>(
  "Cloudflare.Dns.DnsReadWrite",
);

/** Combined read + write DNS record operations. */
export interface DnsReadWriteClient extends DnsReadClient, DnsWriteClient {}

/** Build the combined read + write client over a bound token and zone id. */
export const dnsReadWriteClient = (
  token: DnsToken,
  zoneId: Effect.Effect<string>,
): DnsReadWriteClient => ({
  ...dnsReadClient(token, zoneId),
  ...dnsWriteClient(token, zoneId),
});
