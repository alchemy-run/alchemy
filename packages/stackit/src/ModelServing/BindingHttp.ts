import {
  ModelServingInferenceCredentials,
  modelServingInferenceCredentialsOf,
} from "@distilled.cloud/stackit/Credentials";
import type * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as Redacted from "effect/Redacted";
import { redactedValue } from "../internal/aiTokens.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { Token } from "./Token.ts";

/**
 * Shared HTTP scaffolding for STACKIT AI Model Serving bindings.
 * NOT exported from index.ts.
 *
 * Management bindings grant on the project holding the token: STACKIT has no role binding on a
 * single token (see `StackitBindings`). The grants list exactly the permission an operation
 * needs, the `x-stackit-authorization` action in the service's API spec.
 *
 * The model catalogue has its authorization turned off in the spec, so it grants nothing and only
 * needs a STACKIT access token to sign with.
 *
 * Inference bindings call the OpenAI-compatible API with the bound token, so they grant no STACKIT
 * role and create no service account.
 */

/** Build a binding over one operation on a token: `<Op>Http.ts` is one call to it. */
export const makeTokenHttpBinding = <
  I extends { projectId: string; regionId: string; tId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ModelServing.GetToken`. */
  tag: string;
  /** The permission the operation needs on the project holding the token. */
  permission: string;
  /** The distilled operation; the token's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (token: Token) => ({
      projectId: token.projectId,
      regionId: token.region,
      tId: token.tokenId,
    }),
    grants: (token) => [StackitBindings.grantOn(token, { permissions: [options.permission] })],
  });

/** Build a binding over one operation on the bound token's project and region. */
export const makeProjectHttpBinding = <
  I extends { projectId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ModelServing.ListTokens`. */
  tag: string;
  /** The permission the operation needs on the project. */
  permission: string;
  /** The distilled operation; the project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (token: Token) => ({ projectId: token.projectId, regionId: token.region }),
    grants: (token) => [StackitBindings.grantOn(token, { permissions: [options.permission] })],
  });

/**
 * Build a binding over a catalogue operation: these belong to a region, so nothing is bound and no
 * role is granted. The host still gets a service account and key, to sign with.
 */
export const makeCatalogHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ModelServing.ListModels`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`({});
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* run(request);
      });
    });
  });

/** Calls `model_serving_inference` operations with a bound token. */
export interface InferenceCaller {
  <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E, inference.ModelServingInferenceOpContext>,
    request: I,
  ): Effect.Effect<A, E>;
}

/**
 * Where a host reads a token's region and value, once its bundle runs. A value can reach the host
 * unwrapped, whatever its type says.
 */
export interface InferenceAccess {
  readonly region: Effect.Effect<string>;
  readonly token: Effect.Effect<string | Redacted.Redacted<string> | undefined>;
}

/**
 * The caller for one token. Each request acquires what it needs, so nothing outlives a request on
 * a host like workerd. The token travels through the host's environment, kept `Redacted`.
 */
export const makeInferenceCaller =
  (access: InferenceAccess): InferenceCaller =>
  (operation, request) =>
    Effect.gen(function* () {
      const region = yield* access.region;
      const token = yield* access.token;
      return yield* operation(request).pipe(
        Effect.provideService(
          ModelServingInferenceCredentials,
          modelServingInferenceCredentialsOf({
            region,
            token: token === undefined ? undefined : redactedValue(token),
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      );
    });

/** A bound token's caller. Reading its attributes here binds them into the host's env. */
export const inferenceCallerOf = Effect.fn(function* (token: Token) {
  const region = yield* token.region;
  const value = yield* token.token;
  return makeInferenceCaller({ region, token: value });
});

/** Build a binding over one inference operation: `<Op>Http.ts` is one call to it. */
export const makeInferenceBinding = <I, A, E>(
  operation: (input: I) => Effect.Effect<A, E, inference.ModelServingInferenceOpContext>,
) =>
  Effect.fn(function* (token: Token) {
    const call = yield* inferenceCallerOf(token);
    return (request: I) => call(operation, request);
  });
