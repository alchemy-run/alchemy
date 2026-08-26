import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { GcpOpContext } from "@distilled.cloud/gcp/aiplatform_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Output } from "../../Output.ts";

/**
 * Shared HTTP scaffolding for AI Platform named-resource bindings.
 * NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer construction
 * (after providing Credentials + HttpClient) so the inner runtime Effect is
 * `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeNamedHttpBinding = <
  Resource extends { name: Output<string, never>; LogicalId: string },
  I extends { name: string },
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
    return Effect.fn(function* (resource: Resource) {
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        const resourceName = yield* name;
        return yield* run({
          ...(request ?? {}),
          name: resourceName,
        } as I);
      });
    });
  });
