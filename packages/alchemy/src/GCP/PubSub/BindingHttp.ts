import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Subscription } from "./Subscription.ts";
import type { Topic } from "./Topic.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Pub/Sub bindings.
 * NOT exported from index.ts.
 */
export const makeTopicHttpBinding = <
  I extends { topic: string },
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
    return Effect.fn(function* (topic: Topic) {
      const name = yield* topic.name;
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request: Omit<I, "topic">,
      ) {
        return yield* run({
          ...request,
          topic: yield* name,
        } as I);
      });
    });
  });

export const makeSubscriptionHttpBinding = <
  I extends { subscription: string },
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
    return Effect.fn(function* (subscription: Subscription) {
      const name = yield* subscription.name;
      return Effect.fn(`${options.tag}(${subscription.LogicalId})`)(function* (
        request: Omit<I, "subscription">,
      ) {
        return yield* run({
          ...request,
          subscription: yield* name,
        } as I);
      });
    });
  });
