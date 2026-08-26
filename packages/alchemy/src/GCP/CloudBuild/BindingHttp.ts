import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Repository } from "./Repository.ts";

/**
 * Shared HTTP scaffolding for Cloud Build v2 repository bindings.
 * NOT exported from index.ts.
 */
export const makeRepositoryHttpBinding = <
  I extends { repository: string },
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
    return Effect.fn(function* <T extends Repository>(repository: T) {
      const name = yield* repository.name;
      return Effect.fn(`${options.tag}(${repository.LogicalId})`)(function* (
        request?: Omit<I, "repository">,
      ) {
        return yield* options
          .operation({
            ...(request as I),
            repository: yield* name,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
