import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Input } from "./Input.ts";

/**
 * Record types the portable DNS seam speaks. Every provider serves each of
 * these natively; aliases (a zone-apex pointer at a load balancer) need the
 * target's canonical hosted zone and are declared through the provider's
 * own record resource (`AWS.Route53.Record` with `aliasTarget`).
 */
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT";

export interface DnsRecordProps {
  /** Fully-qualified record name, e.g. `api.example.com`. */
  readonly name: Input<string>;
  /** Record type. */
  readonly type: DnsRecordType;
  /**
   * Record values (targets for `CNAME`, addresses for `A`/`AAAA`). Each
   * value may be an unresolved `Output`; the COUNT is static so a provider
   * without multi-value record sets can declare one record per value.
   */
  readonly values: ReadonlyArray<Input<string>>;
}

/** The declared record, echoed back to the caller. */
export interface DnsRecord {
  readonly name: Input<string>;
  readonly type: DnsRecordType;
  readonly values: ReadonlyArray<Input<string>>;
}

export interface DnsService {
  /**
   * Declare one DNS record as an ordinary resource node under the caller's
   * ambient namespace. The governing zone is inferred from the resolved
   * `name` by the record resource's own reconcile (most-specific zone wins)
   * — no zone lookups happen at declaration time, so declaring cannot fail;
   * a missing zone surfaces as the record node's typed deploy failure.
   */
  readonly record: (
    id: string,
    props: DnsRecordProps,
  ) => Effect.Effect<DnsRecord, never, any>;
}

/**
 * The pluggable DNS seam: ONE Context service with ONE method — declare a
 * DNS record as an ordinary resource node — implemented per provider by
 * `AWS.Route53Dns()` and `Cloudflare.CloudflareDns()`.
 *
 * Resources that need DNS wiring (a worker with a `domain`) capture this
 * service from the impl's provide chain and declare their records through
 * it, so WHICH provider hosts the zone is the caller's choice and never
 * baked into the resource. Implementations register themselves on the
 * current runtime context when their Layer builds (the same capture channel
 * `Telemetry.layer` uses), keep provider imports lazy (so runtime bundles
 * never pull provider modules), and are strict no-ops inside a deployed
 * runtime.
 *
 * ```typescript
 * export default Api.make(
 *   { fleet: Cells, main: import.meta.url, expose: "public", domain: "api.example.com" },
 *   Effect.gen(function* () { ... }).pipe(
 *     Effect.provide(Layer.mergeAll(CounterLive, Cloudflare.CloudflareDns())),
 *   ),
 * );
 * ```
 */
export class Dns extends Context.Service<Dns, DnsService>()("Alchemy.Dns") {}
