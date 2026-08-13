/**
 * The server-only half of `alchemy/client` — the direct in-process
 * dispatch behind the value form (`createClient(Backend)`).
 *
 * Loaded ONLY through the guarded dynamic import in `index.ts` (and never
 * from `browser.ts`), so client bundles that import `alchemy/client`
 * carry none of the serve-bridge graph.
 *
 * Dispatch semantics mirror the HTTP dispatch's per-event pipeline
 * (`Serve/Bridge.ts`): the same lazy WeakMap-memoized isolate build per
 * backend class, a fresh request `Scope` per call (settled inline before
 * the promise resolves — tRPC-caller style), per-event telemetry, and a
 * synthesized `HttpServerRequest` in context so methods can
 * self-authorize from `options.headers` (empty when absent). Unlike the
 * HTTP path there is no envelope: the method's success value and typed
 * failure are returned/thrown AS-IS (real instances, not structural
 * decodes).
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ServerRequest from "effect/unstable/http/HttpServerRequest";
import { getSiteRuntime, markRuntime } from "../Serve/Bridge.ts";
import { hasStackMarkers, resolveServeEnv } from "../Serve/Env.ts";
import { RPC_PATH, rpcMethodsOf } from "../Serve/Rpc.ts";
import { buildEventTelemetry } from "../Telemetry.ts";
import { decodeRpcErrorPayload, RpcPrerenderError } from "./Errors.ts";
import { resolveHeaders, type ServerClientOptions } from "./Core.ts";

const noopPin = (): void => {};

/**
 * Invoke one backend method in-process. Resolves the method's success
 * value; throws the method's typed failure (the real error instance), an
 * {@link RpcPrerenderError} in a marker-less build-time world, an
 * `RpcError` tagged `RpcMethodNotFound` for unknown methods, or the
 * squashed defect.
 */
export const invokeServerMethod = async (
  site: object,
  method: string,
  args: readonly unknown[],
  options: ServerClientOptions | undefined,
): Promise<unknown> => {
  markRuntime();
  const env = await resolveServeEnv(options?.env);
  if (!hasStackMarkers(env)) {
    throw new RpcPrerenderError({
      method,
      message:
        `backend method "${method}" was called during prerender (no ` +
        "alchemy stack in the environment) — make the page dynamic or " +
        "move the call client-side.",
    });
  }
  const runtime = await getSiteRuntime(site, env, noopPin);
  const fn = rpcMethodsOf(runtime.shape())[method];
  if (fn === undefined) {
    throw decodeRpcErrorPayload({
      _tag: "RpcMethodNotFound",
      method,
      message: `the backend does not expose an RPC method named "${method}"`,
    });
  }

  // Synthesize the per-request identity: headers (cookies/authorization)
  // ride into `HttpServerRequest` so methods self-authorize exactly as
  // they do over the HTTP dispatch. Empty when no headers were given.
  const request = ServerRequest.fromWeb(
    new Request(`http://localhost${RPC_PATH}/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: await resolveHeaders(options?.headers),
    }),
  );

  const scope = Scope.makeUnsafe();
  const exit = await Effect.suspend(() => {
    const returned = fn(...args);
    return Effect.isEffect(returned)
      ? (returned as Effect.Effect<unknown, unknown>)
      : Effect.succeed(returned);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ServerRequest.HttpServerRequest, request),
        Layer.succeed(Scope.Scope, scope),
        Layer.effectContext(
          buildEventTelemetry(runtime.context, scope, runtime.telemetry()),
        ),
      ).pipe(Layer.provideMerge(Layer.succeedContext(runtime.context))),
    ),
    Effect.runPromiseExit,
  );

  // Settle the request scope inline before resolving — the caller is
  // in-process, so finalizers must not outlive the call.
  await Effect.runPromise(Scope.close(scope, Exit.void));

  if (exit._tag === "Success") {
    return exit.value;
  }
  const fail = exit.cause.reasons.find(Cause.isFailReason);
  if (fail !== undefined) {
    // The REAL typed failure — no envelope, no structural decode.
    throw fail.error;
  }
  throw Cause.squash(exit.cause);
};
