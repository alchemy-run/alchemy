import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { File } from "./File.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Drive file bindings.
 * NOT exported from index.ts.
 */
export const makeFileHttpBinding = <
  I extends { fileId: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (file: File) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: file,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const fileId = yield* file.fileId;
      return Effect.fn(`${options.tag}(${file.LogicalId})`)(function* (
        request: Omit<I, "fileId">,
      ) {
        return yield* run({
          ...request,
          fileId: yield* fileId,
        } as I);
      });
    });
  });
