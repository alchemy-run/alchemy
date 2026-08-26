import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Calendar } from "./Calendar.ts";
import type { Event } from "./Event.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Calendar bindings.
 * NOT exported from index.ts.
 */
export const makeCalendarHttpBinding = <
  I extends { calendarId: string },
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
    return Effect.fn(function* (cal: Calendar) {
      const calendarId = yield* cal.calendarId;
      return Effect.fn(`${options.tag}(${cal.LogicalId})`)(function* (
        request: Omit<I, "calendarId">,
      ) {
        return yield* run({
          ...request,
          calendarId: yield* calendarId,
        } as I);
      });
    });
  });

export const makeEventHttpBinding = <
  I extends { calendarId: string; eventId: string },
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
    return Effect.fn(function* (event: Event) {
      const calendarId = yield* event.calendarId;
      const eventId = yield* event.eventId;
      return Effect.fn(`${options.tag}(${event.LogicalId})`)(function* (
        request: Omit<I, "calendarId" | "eventId">,
      ) {
        return yield* run({
          ...request,
          calendarId: yield* calendarId,
          eventId: yield* eventId,
        } as I);
      });
    });
  });
