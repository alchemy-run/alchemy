/**
 * The server-only half of `alchemy/Client` — the direct in-process
 * dispatch behind the value form (`createClient(Backend)`).
 *
 * Loaded ONLY through the guarded dynamic import in `index.ts` (and never
 * from `browser.ts`), so client bundles that import `alchemy/Client`
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
import { SERVE_SHELL_KEY } from "../Serve/constants.ts";
import { hasStackMarkers, resolveServeEnv } from "../Serve/Env.ts";
import { RPC_PATH, rpcMethodsOf } from "../Serve/Rpc.ts";
import type { ServeShell } from "../Serve/Serve.ts";
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
  // Snapshot the per-call identity FIRST, before any await: a headers
  // thunk backed by a framework's ambient accessor (TanStack's
  // getRequestHeaders, Next's headers) must run in the calling request's
  // synchronous window — awaiting env/runtime first would let a
  // concurrent call's ambient context bleed into this one. The thunk
  // itself fires synchronously inside `resolveHeaders`; only its result
  // is awaited later. The no-op catch marks an eventual rejection as
  // observed so an earlier throw (e.g. prerender) can't surface it as an
  // unhandled rejection.
  const headersPromise = resolveHeaders(options?.headers);
  headersPromise.catch(() => {});
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
  // Cloud-flavored runtime: an AWS Website class carries a serve shell
  // whose `runtime` builds the Lambda/Node layer recipe (credentials
  // chain, Node services); without a shell the default
  // (Cloudflare-flavored) bridge applies.
  const shell = (site as Record<string, unknown>)[SERVE_SHELL_KEY] as
    | ServeShell
    | undefined;
  const runtime =
    shell?.runtime !== undefined
      ? await shell.runtime(site, env)
      : await getSiteRuntime(site, env, noopPin);
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
      headers: await headersPromise,
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
