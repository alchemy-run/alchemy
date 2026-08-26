import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { GcpOpContext } from "@distilled.cloud/gcp/pubsublite_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { AdminReservation } from "./AdminReservation.ts";
import type { AdminSubscription } from "./AdminSubscription.ts";
import type { AdminTopic } from "./AdminTopic.ts";

type Op<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  GcpOpContext
>;

/**
 * Shared HTTP scaffolding for Pub/Sub Lite bindings.
 * NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeReservationHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* (
      options.operation as Effect.Effect<
        (input: I) => Effect.Effect<A, E>,
        never,
        Credentials | HttpClient.HttpClient
      >
    ).pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (reservation: AdminReservation) {
      const name = yield* reservation.name;
      return Effect.fn(`${options.tag}(${reservation.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request ?? {}),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeTopicNameHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* (
      options.operation as Effect.Effect<
        (input: I) => Effect.Effect<A, E>,
        never,
        Credentials | HttpClient.HttpClient
      >
    ).pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (topic: AdminTopic) {
      const name = yield* topic.name;
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request ?? {}),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeTopicStatsHttpBinding = <
  I extends { topic: string },
  A,
  E,
>(options: {
  tag: string;
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* (
      options.operation as Effect.Effect<
        (input: I) => Effect.Effect<A, E>,
        never,
        Credentials | HttpClient.HttpClient
      >
    ).pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (topic: AdminTopic) {
      const name = yield* topic.name;
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request?: Omit<I, "topic">,
      ) {
        return yield* run({
          ...(request ?? {}),
          topic: yield* name,
        } as I);
      });
    });
  });

export const makeSubscriptionHttpBinding = <
  I extends { name?: string; subscription?: string },
  A,
  E,
>(options: {
  tag: string;
  field: "name" | "subscription";
  operation: Op<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* (
      options.operation as Effect.Effect<
        (input: I) => Effect.Effect<A, E>,
        never,
        Credentials | HttpClient.HttpClient
      >
    ).pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (subscription: AdminSubscription) {
      const name = yield* subscription.name;
      return Effect.fn(`${options.tag}(${subscription.LogicalId})`)(function* (
        request?: Omit<I, "name" | "subscription">,
      ) {
        const resolved = yield* name;
        const input =
          options.field === "subscription"
            ? ({ ...(request ?? {}), subscription: resolved } as I)
            : ({ ...(request ?? {}), name: resolved } as I);
        return yield* run(input);
      });
    });
  });
