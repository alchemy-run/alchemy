import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { noteNameOf } from "./internal.ts";
import type { Note } from "./Note.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Keep note bindings.
 * NOT exported from index.ts.
 */
export const makeKeepNoteHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (note: Note) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: note,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* note.name;
      return Effect.fn(`${options.tag}(${note.LogicalId})`)(function* (
        request: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: noteNameOf(yield* name),
        } as I);
      });
    });
  });
