import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Database } from "./Database.ts";

/**
 * Shared HTTP scaffolding for Firestore document bindings.
 * NOT exported from index.ts.
 */
export const makeDocumentHttpBinding = <
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
    return Effect.fn(function* <D extends Database>(database: D) {
      const name = yield* database.name;
      return Effect.fn(`${options.tag}(${database.LogicalId})`)(function* (
        request: Omit<I, "name"> & { documentPath: string },
      ) {
        const { documentPath, ...rest } = request;
        const relative = documentPath.replace(/^\/+/, "");
        return yield* options
          .operation({
            ...(rest as unknown as I),
            name: `${yield* name}/documents/${relative}`,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
