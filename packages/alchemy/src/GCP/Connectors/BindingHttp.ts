import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { ConnectionsEntityTypesEntity } from "./ConnectionsEntityTypesEntity.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Integration Connectors entity bindings.
 * NOT exported from index.ts.
 */
export const makeEntityHttpBinding = <
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
    return Effect.fn(function* (entity: ConnectionsEntityTypesEntity) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: entity,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* entity.name;
      return Effect.fn(`${options.tag}(${entity.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });
