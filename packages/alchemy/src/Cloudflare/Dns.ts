/**
 * The Cloudflare implementation of the {@link Dns} seam.
 *
 * Provide it on the impl of a resource that declares DNS records (a Celld
 * or Rivet worker with a `domain`):
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
 * Records are declared as ordinary `Cloudflare.DNS.Record` graph nodes with
 * NO `zoneId` — the record's own reconcile infers the governing zone from
 * the resolved name via `findZoneByName` label-walking (most-specific zone
 * wins) and persists it. `ALIAS` records are served as un-proxied `CNAME`s
 * (Cloudflare flattens CNAMEs at the zone apex automatically); records stay
 * un-proxied so TLS terminates at the target (an ALB's ACM certificate).
 *
 * Building the layer registers the service on the current runtime context
 * (the same capture channel `Telemetry.layer` uses) so the worker's
 * registration can read it back after the impl evaluated. Inside a deployed
 * runtime the layer is a strict no-op and the record provider module is
 * never imported (lazy import inside the effect body).
 *
 * @layer
 * @provides Alchemy.Dns
 * @product DNS
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Dns as DnsTag,
  type DnsRecord,
  type DnsRecordProps,
  type DnsService,
} from "../Dns.ts";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import { CurrentRuntimeContext } from "../RuntimeContext.ts";

/** Strip a trailing dot — ACM hands back `...acm-validations.aws.` forms. */
const trimDot = (value: string) => value.replace(/\.$/, "");

/** Trim a possibly-Output name input without losing its dependency edges. */
const trimInput = (value: Input<string>): Input<string> =>
  typeof value === "string"
    ? trimDot(value)
    : Output.asOutput(value as string | Output.Output<string>).pipe(
        Output.map(trimDot),
      );

/**
 * Cloudflare records carry ONE value per record; the seam's multi-value
 * shape maps to the first value (round-robin sets are out of the portable
 * seam's scope).
 */
const firstValue = (values: Input<string[]>): Input<string> =>
  Array.isArray(values)
    ? trimInput((values[0] ?? "") as Input<string>)
    : Output.asOutput(values as string[] | Output.Output<string[]>).pipe(
        Output.map((resolved: string[]) => trimDot(resolved[0] ?? "")),
      );

export const Dns = (): Layer.Layer<DnsTag> =>
  Layer.effect(
    DnsTag,
    Effect.gen(function* () {
      const record = (
        id: string,
        props: DnsRecordProps,
      ): Effect.Effect<DnsRecord, never, any> =>
        Effect.gen(function* () {
          const echo: DnsRecord = {
            name: props.name,
            type: props.type,
            values: props.values,
          };
          // A deployed runtime re-executes the deploy module — declaring
          // graph nodes (and importing the provider module) is a plan-only
          // concern.
          if (globalThis.__ALCHEMY_RUNTIME__) {
            return echo;
          }
          const { Record } = yield* Effect.promise(
            () => import("./DNS/Record.ts"),
          );
          yield* Record(id, {
            name: trimInput(props.name),
            // Cloudflare flattens apex CNAMEs, so ALIAS is a plain CNAME.
            type: props.type === "ALIAS" ? "CNAME" : props.type,
            content: firstValue(props.values),
            proxied: false,
          });
          return echo;
        }).pipe(Effect.orDie) as Effect.Effect<DnsRecord, never, any>;

      const service: DnsService = { record };

      // Register on the runtime context so the platform's registration can
      // read the seam back after the impl evaluated (see Dns.ts).
      const ctx = yield* CurrentRuntimeContext;
      if (ctx !== undefined) {
        ctx.dns = service;
      }
      return service;
    }),
  );
