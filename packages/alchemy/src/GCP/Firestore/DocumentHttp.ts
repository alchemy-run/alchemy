import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { GcpOpContext } from "@distilled.cloud/gcp/firestore_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Database } from "./Database.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * Distilled ops are OperationMethods: yield them once at Layer construction
 * (after providing Credentials + HttpClient) so the inner runtime Effect is
 * `Effect<A, E>` and does not leak `GcpOpContext`.
 */
type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  GcpOpContext
> &
  ((input: I) => Effect.Effect<A, E, GcpOpContext>);

/**
 * Shared HTTP scaffolding for Firestore document bindings.
 * NOT exported from index.ts.
 */
export const makeDocumentHttpBinding = <
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
    return Effect.fn(function* (database: Database) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: database,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* database.name;
      return Effect.fn(`${options.tag}(${database.LogicalId})`)(function* (
        request: Omit<I, "name"> & { documentPath: string },
      ) {
        const documentPath = request.documentPath;
        const relative = documentPath.replace(/^\/+/, "");
        const databaseName = yield* name;
        const rest: Omit<I, "name"> = request;
        return yield* run({
          ...rest,
          name: `${databaseName}/documents/${relative}`,
        } as I);
      });
    });
  });
