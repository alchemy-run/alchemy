import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { GcpOpContext } from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Function as CloudFunction } from "./Function.ts";

/**
 * Shared HTTP scaffolding for Cloud Functions bindings.
 * NOT exported from index.ts.
 */
export const makeFunctionHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: Effect.Effect<
    (input: I) => Effect.Effect<A, E>,
    never,
    GcpOpContext
  > &
    ((input: I) => Effect.Effect<A, E, GcpOpContext>);
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* options.operation.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (fn: CloudFunction) {
      const name = yield* fn.name;
      return Effect.fn(`${options.tag}(${fn.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
