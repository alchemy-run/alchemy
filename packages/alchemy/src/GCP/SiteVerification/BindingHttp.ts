import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { toPathId } from "./internal.ts";
import type { WebResource } from "./WebResource.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Site Verification web-resource bindings.
 * NOT exported from index.ts.
 */
export const makeWebResourceHttpBinding = <
  I extends { id: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (resource: WebResource) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: resource,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const webResourceId = yield* resource.webResourceId;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request: Omit<I, "id">,
      ) {
        return yield* run({
          ...request,
          id: toPathId(yield* webResourceId),
        } as I);
      });
    });
  });
