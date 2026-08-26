import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * Shared HTTP scaffolding for Oracle Database@Google Cloud bindings.
 * NOT exported from index.ts.
 */
export const makeOracleNameHttpBinding = <
  Resource extends { name: unknown; LogicalId: string },
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
    return Effect.fn(function* (resource: Resource) {
      const name = yield* resource.name as Effect.Effect<string>;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            name,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
