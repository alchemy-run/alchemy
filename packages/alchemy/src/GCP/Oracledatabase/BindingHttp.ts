import * as Effect from "effect/Effect";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Oracle Database@Google Cloud bindings.
 * NOT exported from index.ts.
 */
export const makeOracleNameHttpBinding = <
  Resource extends { name: unknown; LogicalId: string },
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  /** Oracle Database@Google Cloud has no resource-level IAM: project grant. */
  iam: Pick<BindingIam, "role">;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (resource: Resource) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: resource,
        iam: [{ role: options.iam.role }],
      });
      const name = yield* resource.name as Effect.Effect<string>;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name,
        } as I);
      });
    });
  });
