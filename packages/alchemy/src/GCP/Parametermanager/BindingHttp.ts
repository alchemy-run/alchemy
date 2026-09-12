import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { ParametersVersion } from "./ParametersVersion.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Parameter Manager version bindings.
 * NOT exported from index.ts.
 */
export const makeParameterVersionHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
  toInput: (versionName: string, request: Req | undefined) => I;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (version: ParametersVersion) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: version,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* version.name;
      return Effect.fn(`${options.tag}(${version.LogicalId})`)(function* (
        request?: Req,
      ) {
        return yield* run(options.toInput(yield* name, request));
      });
    });
  });
