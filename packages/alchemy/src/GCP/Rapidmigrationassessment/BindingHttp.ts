import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Collector } from "./Collector.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * Shared HTTP scaffolding for Rapid Migration Assessment collector
 * bindings. NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeCollectorHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: Effect.Effect<
    (input: I) => Effect.Effect<A, E>,
    never,
    Credentials | HttpClient.HttpClient
  > &
    ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (collector: Collector) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: collector,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* collector.name;
      return Effect.fn(`${options.tag}(${collector.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        const collectorName = yield* name;
        return yield* run({
          ...(request ?? {}),
          name: collectorName,
        } as I);
      });
    });
  });
