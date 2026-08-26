import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { UsersDataSource } from "./UsersDataSource.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Fitness data-source bindings.
 * NOT exported from index.ts.
 */
export const makeUsersDataSourceHttpBinding = <
  I extends { userId: string; dataSourceId: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* options.operation.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (source: UsersDataSource) {
      const userId = yield* source.userId;
      const dataStreamId = yield* source.dataStreamId;
      return Effect.fn(`${options.tag}(${source.LogicalId})`)(function* (
        request: Omit<I, "userId" | "dataSourceId">,
      ) {
        return yield* run({
          ...request,
          userId: yield* userId,
          dataSourceId: yield* dataStreamId,
        } as I);
      });
    });
  });
