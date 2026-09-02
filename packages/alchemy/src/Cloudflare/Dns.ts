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

/** Trim a possibly-Output input without losing its dependency edges. */
const trimInput = (value: Input<string>): Input<string> =>
  typeof value === "string"
    ? trimDot(value)
    : Output.asOutput(value as string | Output.Output<string>).pipe(
        Output.map(trimDot),
      );

/**
 * The Cloudflare implementation of the `Alchemy.Dns` seam.
 *
 * Records are declared as ordinary `Cloudflare.DNS.Record` graph nodes with
 * NO `zoneId` — the record's own reconcile infers the governing zone from
 * the resolved name via `findZoneByName` label-walking (most-specific zone
 * wins) and persists it. Cloudflare records carry ONE value each, so a
 * multi-value declaration becomes one record node per value (`{id}`,
 * `{id}-2`, `{id}-3`, …). Records stay un-proxied so TLS terminates at the
 * target (an ALB's ACM certificate); Cloudflare flattens apex CNAMEs
 * automatically.
 *
 * Building the layer registers the service on the current runtime context
 * (the same capture channel `Telemetry.layer` uses) so the worker's
 * registration can read it back after the impl evaluated. Inside a deployed
 * runtime the layer is a strict no-op and the record provider module is
 * never imported (lazy import inside the effect body).
 *
 * ### Providing the Seam
 * **Example:** DNS records for a worker's domain through Cloudflare
 * ```typescript
 * export default Api.make(
 *   { fleet: Cells, main: import.meta.url, expose: "public", domain: "api.example.com" },
 *   Effect.gen(function* () { ... }).pipe(
 *     Effect.provide(Layer.mergeAll(CounterLive, Cloudflare.CloudflareDns())),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Alchemy.Dns
 * @product DNS
 */
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
          // One record node per value — the first keeps the caller's id so
          // single-value declarations (the common case) are stable.
          for (const [index, value] of props.values.entries()) {
            yield* Record(index === 0 ? id : `${id}-${index + 1}`, {
              name: trimInput(props.name),
              type: props.type,
              content: trimInput(value),
              proxied: false,
            });
          }
          return echo;
        });

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
