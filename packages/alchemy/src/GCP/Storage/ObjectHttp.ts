import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Bucket } from "./Bucket.ts";

/**
 * Shared HTTP scaffolding for Cloud Storage object bindings.
 * NOT exported from index.ts.
 */
export const makeObjectHttpBinding = <
  I extends { bucket?: string },
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
    return Effect.fn(function* (bucket: Bucket) {
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`${options.tag}(${bucket.LogicalId})`)(function* (
        request: Omit<I, "bucket">,
      ) {
        return yield* options
          .operation({
            ...request,
            bucket: yield* bucketName,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
