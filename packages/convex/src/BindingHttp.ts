import type { Credentials } from "@distilled.cloud/convex/Credentials";
import { fromDeployment } from "@distilled.cloud/convex/Credentials";
import * as functions from "@distilled.cloud/convex/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { DeployKey } from "./DeployKey.ts";
import type { Deployment } from "./Deployment.ts";
import {
  type Args,
  type Failure,
  type FunctionDeclaration,
  type Success,
  encodeArgs,
} from "./Function.ts";

/** A Convex function threw, or doesn't exist. Convex reports both as a 200. */
export class ConvexFunctionError extends Data.TaggedError("ConvexFunctionError")<{
  readonly message: string;
  /** The function that failed. */
  readonly path: string;
  /** The value of a `ConvexError` the function threw, if any. */
  readonly data?: unknown;
}> {}

type Requirements = Credentials | HttpClient.HttpClient;

/** Run a call against one deployment, reading its URL and any token at runtime. */
export const onHost =
  (
    url: Effect.Effect<string, never, RuntimeContext>,
    token?: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>,
  ) =>
  <A, E>(effect: Effect.Effect<A, E, Requirements>): Effect.Effect<A, E, RuntimeContext> =>
    Effect.gen(function* () {
      const deploymentUrl = yield* url;
      const key = token === undefined ? undefined : yield* token;
      const layer = Layer.mergeAll(
        fromDeployment({ url: deploymentUrl, token: key }),
        FetchHttpClient.layer,
      );
      return yield* effect.pipe(Effect.provide(layer));
    });

/** The value of a function's response, or a typed failure. */
export const unwrap = <A>(path: string, response: functions.UdfResponse) =>
  response.status === "success"
    ? Effect.succeed(response.value as A)
    : Effect.fail(
        new ConvexFunctionError({
          path,
          message: response.errorMessage,
          data: response.errorData ?? undefined,
        }),
      );

/**
 * A deploy key for this host, limited to `allowedActions` on this deployment.
 * It's what lets a binding call the Deployment API from any host: the key goes
 * into the host's environment, and your team token stays on your machine.
 */
export const hostKey = Effect.fn(function* (
  deployment: Deployment,
  suffix: string,
  allowedActions: string[],
) {
  const Key = yield* DeployKey;
  const host = yield* Binding.Host;
  const key = yield* Key(`${host?.LogicalId ?? ""}${deployment.LogicalId}${suffix}Key`, {
    deployment,
    allowedActions,
  });
  return yield* key.value;
});

/** A public function another host may call, typed by its declaration. */
export type Callable<Kind extends FunctionDeclaration["kind"]> = FunctionDeclaration<
  Kind,
  string,
  any,
  any,
  any,
  false
>;

/**
 * Call a declared function over the HTTP API: encode its arguments, send
 * them in Convex's JSON format, and decode the result or typed failure. A
 * failure the declaration doesn't describe stays a `ConvexFunctionError`.
 */
export const callDeclared = <F extends FunctionDeclaration, E, R>(
  fn: F,
  args: Args<F>,
  send: (args: Record<string, unknown>) => Effect.Effect<functions.UdfResponse, E, R>,
): Effect.Effect<Success<F>, Failure<F> | E | ConvexFunctionError | Schema.SchemaError, R> =>
  Effect.gen(function* () {
    const encoded = yield* encodeArgs(fn, args);
    const response = yield* send(convexToJson(encoded) as Record<string, unknown>);
    if (response.status === "success") {
      if (fn.returns === undefined) return undefined as Success<F>;
      return (yield* Schema.decodeEffect(fn.returns)(
        jsonToConvex(response.value as never),
      )) as Success<F>;
    }
    const data =
      response.errorData === undefined || response.errorData === null
        ? undefined
        : jsonToConvex(response.errorData as never);
    const undeclared = new ConvexFunctionError({
      path: fn.path,
      message: response.errorMessage,
      data: data as Value | undefined,
    });
    if (fn.error === undefined || data === undefined) return yield* undeclared;
    const failure = yield* Schema.decodeEffect(fn.error)(data).pipe(Effect.option);
    return yield* Option.match(failure, {
      onNone: () => Effect.fail(undeclared),
      onSome: (value) => Effect.fail(value as Failure<F>),
    });
  });
