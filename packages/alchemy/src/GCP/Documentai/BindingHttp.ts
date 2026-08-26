import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type { GcpOpContext } from "@distilled.cloud/gcp/documentai_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Output } from "../../Output.ts";
import type { Processor } from "./Processor.ts";
import type { Schema } from "./Schema.ts";
import type { SchemasSchemaVersion } from "./SchemasSchemaVersion.ts";

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

const makeNamedHttpBinding = <
  Resource extends { name: Output<string, never>; LogicalId: string },
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* options.operation.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (resource: Resource) {
      const name = yield* resource.name;
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

/**
 * Shared HTTP scaffolding for Document AI bindings.
 * NOT exported from index.ts.
 */
export const makeProcessorHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<Processor, I, A, E>(options);

export const makeSchemaHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<Schema, I, A, E>(options);

export const makeSchemaVersionHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) => makeNamedHttpBinding<SchemasSchemaVersion, I, A, E>(options);
