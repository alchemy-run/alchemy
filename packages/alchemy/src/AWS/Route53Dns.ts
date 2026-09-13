import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Dns,
  type DnsRecord,
  type DnsRecordProps,
  type DnsService,
} from "../Dns.ts";
import { CurrentRuntimeContext } from "../RuntimeContext.ts";

/**
 * The Route 53 implementation of the `Alchemy.Dns` seam.
 *
 * Records are declared as ordinary `AWS.Route53.Record` graph nodes with NO
 * `hostedZoneId` — the record's own reconcile infers the governing zone
 * from the resolved name (most-specific public zone wins) and persists it.
 * Multi-value records become one Route 53 record set carrying every value.
 *
 * Building the layer registers the service on the current runtime context
 * (the same capture channel `Telemetry.layer` uses) so the worker's
 * registration can read it back after the impl evaluated. Inside a
 * deployed runtime the layer is a strict no-op and the record provider
 * module is never imported (lazy import inside the effect body).
 *
 * ### Providing the Seam
 * **Example:** DNS records for a worker's domain through Route 53
 * ```typescript
 * export default Api.make(
 *   { fleet: Cells, main: import.meta.url, expose: "public", domain: "api.example.com" },
 *   Effect.gen(function* () { ... }).pipe(
 *     Effect.provide(Layer.mergeAll(CounterLive, AWS.Route53Dns())),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Alchemy.Dns
 * @product Route 53
 */
export const Route53Dns = (): Layer.Layer<Dns> =>
  Layer.effect(
    Dns,
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
            () => import("./Route53/Record.ts"),
          );
          yield* Record(id, {
            name: props.name,
            type: props.type,
            ttl: "60 seconds",
            records: [...props.values],
          });
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
