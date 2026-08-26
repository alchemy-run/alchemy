import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { CatalogsServingConfig } from "./CatalogsServingConfig.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Retail serving-config bindings.
 * NOT exported from index.ts.
 */
export const makeServingConfigHttpBinding = <
  I extends { placement: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (servingConfig: CatalogsServingConfig) {
      const name = yield* servingConfig.name;
      return Effect.fn(`${options.tag}(${servingConfig.LogicalId})`)(function* (
        request: Omit<I, "placement">,
      ) {
        return yield* run({
          ...request,
          placement: yield* name,
        } as I);
      });
    });
  });
