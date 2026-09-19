import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Note } from "./Note.ts";
import type { Occurrence } from "./Occurrence.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

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
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeOccurrenceHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (occurrence: Occurrence) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: occurrence,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* occurrence.name;
      return Effect.fn(`${options.tag}(${occurrence.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
