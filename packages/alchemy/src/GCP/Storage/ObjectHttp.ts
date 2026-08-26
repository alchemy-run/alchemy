import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { GcpOpContext } from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Bucket } from "./Bucket.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  GcpOpContext
> &
  ((input: I) => Effect.Effect<A, E, GcpOpContext>);

/**
 * Shared HTTP scaffolding for Cloud Storage object bindings.
 * Distilled ops are OperationMethods: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 * NOT exported from index.ts.
 */
export const makeObjectHttpBinding = <
  I extends { bucket?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (bucket: Bucket) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: bucket,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`${options.tag}(${bucket.LogicalId})`)(function* (
        request: Omit<I, "bucket">,
      ) {
        return yield* run({
          ...request,
          bucket: yield* bucketName,
        } as I);
      });
    });
  });
