/**
 * The Route 53 implementation of the {@link Dns} seam.
 *
 * Provide it on the impl of a resource that declares DNS records (a Celld
 * or Rivet worker with a `domain`):
 *
 * ```typescript
 * export default Api.make(
 *   { fleet: Cells, main: import.meta.url, expose: "public", domain: "api.example.com" },
 *   Effect.gen(function* () { ... }).pipe(
 *     Effect.provide(Layer.mergeAll(CounterLive, AWS.Route53Dns())),
 *   ),
 * );
 * ```
 *
 * Records are declared as ordinary `AWS.Route53.Record` graph nodes with NO
 * `hostedZoneId` — the record's own reconcile infers the governing zone
 * from the resolved name (most-specific public zone wins) and persists it.
 * `ALIAS` records are served as `CNAME` (a zone-apex alias needs the
 * target's canonical hosted zone id, which the portable seam does not
 * carry — pass a subdomain, or declare `AWS.Route53.Record` directly for
 * an apex alias).
 *
 * Building the layer registers the service on the current runtime context
 * (the same capture channel `Telemetry.layer` uses) so the worker's
 * registration can read it back after the impl evaluated. Inside a
 * deployed runtime the layer is a strict no-op and the record provider
 * module is never imported (lazy import inside the effect body).
 *
 * @layer
 * @provides Alchemy.Dns
 * @product Route 53
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Dns,
  type DnsRecord,
  type DnsRecordProps,
  type DnsService,
} from "../Dns.ts";
import { CurrentRuntimeContext } from "../RuntimeContext.ts";

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
            // Route 53 aliases need the target's canonical hosted zone id,
            // which the portable seam does not carry — serve ALIAS as CNAME.
            type: props.type === "ALIAS" ? "CNAME" : props.type,
            ttl: "60 seconds",
            records: props.values,
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
