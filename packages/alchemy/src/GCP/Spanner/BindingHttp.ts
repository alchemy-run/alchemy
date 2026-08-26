import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Instance } from "./Instance.ts";

/**
 * Shared HTTP scaffolding for Cloud Spanner instance bindings.
 * NOT exported from index.ts.
 */
export const makeSpannerInstanceHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (instance: Instance) {
      const name = yield* instance.name;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            name: yield* name,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
