import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Note } from "./Note.ts";
import type { Occurrence } from "./Occurrence.ts";

/**
 * Shared HTTP scaffolding for Container Analysis get bindings.
 * NOT exported from index.ts.
 */
export const makeNoteHttpBinding = <
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
    return Effect.fn(function* (note: Note) {
      const name = yield* note.name;
      return Effect.fn(`${options.tag}(${note.LogicalId})`)(function* (
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

export const makeOccurrenceHttpBinding = <
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
    return Effect.fn(function* (occurrence: Occurrence) {
      const name = yield* occurrence.name;
      return Effect.fn(`${options.tag}(${occurrence.LogicalId})`)(function* (
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
