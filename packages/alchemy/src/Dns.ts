/**
 * The pluggable DNS seam: ONE Context service with ONE method — declare a
 * DNS record as an ordinary resource node — implemented per provider
 * (`AWS.Route53Dns()`, `Cloudflare.Dns()`).
 *
 * Resources that need DNS wiring (a Celld/Rivet worker with a `domain`)
 * capture this service from the impl's provide chain and declare their
 * records through it, so WHICH provider hosts the zone is the caller's
 * choice and never baked into the resource:
 *
 * ```typescript
 * export default Api.make(
 *   { fleet: Cells, main: import.meta.url, expose: "public", domain: "api.example.com" },
 *   Effect.gen(function* () { ... }).pipe(
 *     Effect.provide(Layer.mergeAll(CounterLive, Cloudflare.Dns())),
 *   ),
 * );
 * ```
 *
 * Implementations register themselves on the current runtime context when
 * their Layer builds (the same capture channel `Telemetry.layer` uses), keep
 * provider imports lazy (so runtime bundles never pull provider modules),
 * and are strict no-ops inside a deployed runtime.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Input } from "./Input.ts";

/** Record types the portable DNS seam speaks. */
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "ALIAS" | "TXT";

export interface DnsRecordProps {
  /** Fully-qualified record name, e.g. `api.example.com`. */
  readonly name: Input<string>;
  /**
   * Record type. `ALIAS` targets a DNS name (an ALB, a CDN) — providers
   * without a native alias concept serve it as a `CNAME`.
   */
  readonly type: DnsRecordType;
  /** Record values (targets for `CNAME`/`ALIAS`, addresses for `A`/`AAAA`). */
  readonly values: Input<string[]>;
}

/** The declared record, echoed back to the caller. */
export interface DnsRecord {
  readonly name: Input<string>;
  readonly type: DnsRecordType;
  readonly values: Input<string[]>;
}

export interface DnsService {
  /**
   * Declare one DNS record as an ordinary resource node under the caller's
   * ambient namespace. The governing zone is inferred from the resolved
   * `name` by the record resource's own reconcile (most-specific zone wins)
   * — no zone lookups happen at declaration time.
   */
  readonly record: (
    id: string,
    props: DnsRecordProps,
  ) => Effect.Effect<DnsRecord, never, any>;
}

/**
 * The DNS seam's Context tag. Provide an implementation layer —
 * `AWS.Route53Dns()` or `Cloudflare.Dns()` — on the impl of the resource
 * that declares records.
 *
 * @layer
 */
export class Dns extends Context.Service<Dns, DnsService>()("Alchemy.Dns") {}
