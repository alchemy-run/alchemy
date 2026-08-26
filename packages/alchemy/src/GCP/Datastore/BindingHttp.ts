import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Indexe } from "./Indexe.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Datastore bindings.
 * NOT exported from index.ts.
 */
export const makeIndexeHttpBinding = <
  I extends { projectId: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (index: Indexe) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: index,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const project = yield* index.project;
      return Effect.fn(`${options.tag}(${index.LogicalId})`)(function* (
        request: Omit<I, "projectId"> & { projectId?: string },
      ) {
        return yield* run({
          ...request,
          projectId: request.projectId ?? (yield* project),
        } as I);
      });
    });
  });
