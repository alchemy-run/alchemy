import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Connection } from "./Connection.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for BigQuery Connection bindings.
 * NOT exported from index.ts.
 */
export const makeConnectionHttpBinding = <
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
    return Effect.fn(function* (connection: Connection) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: connection,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* connection.name;
      return Effect.fn(`${options.tag}(${connection.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
