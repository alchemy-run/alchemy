import * as Effect from "effect/Effect";
import type { Indexe } from "./Indexe.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

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
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (index: Indexe) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: index,
        iam: [grantFor(options.iam, index.name)],
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
