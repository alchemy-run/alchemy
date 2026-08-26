import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Effect from "effect/Effect";
import type { Output } from "../Output.ts";
import { bindGcpHost } from "./Host.ts";

/**
 * Distilled ops are `OperationMethod`s: yield them once at Layer
 * construction so the inner runtime Effect is `Effect<A, E>` and does
 * not leak `GcpOpContext`. Do not `provideService` Credentials/HttpClient
 * here — the host Layer already provides them.
 */
export type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  GcpOpContext
> &
  ((input: I) => Effect.Effect<A, E, GcpOpContext>);

/**
 * Shared HTTP scaffolding for GCP named-resource bindings.
 *
 * Yields the distilled operation (no double-provide) and, at deploy
 * time, grants `role` on the ambient Cloud Run / Function host the way
 * AWS bindings attach IAM policy statements.
 */
export const makeNamedHttpBinding = <
  Resource extends { LogicalId: string },
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  /** IAM role granted to the host runtime SA, e.g. `roles/redis.viewer`. */
  role: string;
  resourceName: (resource: Resource) => Output<string, never>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (resource: Resource) {
      const name = yield* options.resourceName(resource);
      yield* bindGcpHost({
        tag: options.tag,
        resource,
        iam: [{ role: options.role }],
      });
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        const resourceName = yield* name;
        return yield* run({
          ...(request ?? {}),
          name: resourceName,
        } as I);
      });
    });
  });
