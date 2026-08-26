import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Repository } from "./Repository.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Cloud Build v2 repository bindings.
 * NOT exported from index.ts.
 */
export const makeRepositoryHttpBinding = <
  I extends { repository: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E> | ((input: I) => Effect.Effect<A, E>);
}) =>
  Effect.gen(function* () {
    const run = Effect.isEffect(options.operation)
      ? yield* options.operation as GcpHttpOp<I, A, E>
      : (options.operation as (input: I) => Effect.Effect<A, E>);
    return Effect.fn(function* <T extends Repository>(repository: T) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: repository,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* repository.name;
      return Effect.fn(`${options.tag}(${repository.LogicalId})`)(function* (
        request?: Omit<I, "repository">,
      ) {
        return yield* run({
          ...(request as I),
          repository: yield* name,
        } as I);
      });
    });
  });
