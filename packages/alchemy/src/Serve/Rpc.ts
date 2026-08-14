/**
 * The `createClient` wire protocol — the frontend→backend RPC bridge of
 * effectful Websites (serve core, dispatch half).
 *
 * Every effectful Website claims {@link RPC_PATH} (`"/api/__rpc"` — one
 * universal path on every framework and both clouds) in its edge routing,
 * and every delivery surface checks the rpc path BEFORE `server.routes`
 * matching. The protocol (v1, plain JSON):
 *
 *   - `POST /api/__rpc/<method>` with a JSON **array** body (positional
 *     args)
 *   - success        → 200 `{"value": <json>}`
 *   - typed failure  → 400 `{"error": {"_tag": ..., ...props}}`
 *   - defect         → 500 `{"defect": {"message"}}` (no stack/internals)
 *   - unknown method → 404 `{"error": {"_tag": "RpcMethodNotFound",
 *     "method"}}`
 *   - non-POST verbs → 405 `{"error": {"_tag": "RpcMethodNotAllowed",
 *     "method"}}`
 *   - malformed body → 400 `{"error": {"_tag": "RpcInvalidArguments",
 *     "message"}}`
 *
 * Methods are the **own enumerable function-valued keys** of the impl
 * shape; `fetch` and the platform handler keys (`queue`, `scheduled`,
 * `email`, `tail`, ...) are never dispatchable. Each RPC call runs with
 * the same per-request `Scope`/`waitUntil`/telemetry semantics as `fetch`
 * and with `HttpServerRequest` in context, so methods can self-authorize
 * by reading headers/cookies.
 *
 * The client half is `alchemy/Client` ({@link createClient} /
 * `createEffectClient`): the type-only form POSTs this protocol from the
 * browser and decodes the envelope into typed rejections/failures; the
 * value form skips the wire entirely with direct in-process dispatch on
 * the server.
 *
 * This module is a serve-core LEAF (like `Routes.ts`): it must never
 * import `Worker.ts`/provider graphs — it is compiled into foreign server
 * bundles (Next/turbopack, nitro rollup) and evaluated at plan time by
 * the engine.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Scope } from "effect/Scope";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The universal URL prefix under which an effectful Website's RPC methods
 * are dispatched: `POST /api/__rpc/<method>` — the path
 * `alchemy/Client`'s {@link createClient} targets on the wire. One path
 * on every framework and both clouds — it sits inside the `/api/*`
 * catch-all convention the explicit Next mounts already own, so no
 * per-framework variance exists. The path is RESERVED: user routes must
 * not claim it, and no `server.routes` claim is needed to reach it.
 */
export const RPC_PATH = "/api/__rpc";

/**
 * The routing glob every effectful Website appends to its edge claim
 * (`assets.runWorkerFirst` on Cloudflare, the CloudFront `serverRoutes`
 * metadata on AWS) so the RPC dispatch is reachable regardless of
 * `server.routes`.
 */
export const RPC_CLAIM = `${RPC_PATH}*`;

/**
 * Is this pathname an RPC dispatch request? A method-boundary-safe prefix
 * check: {@link RPC_PATH} itself or `{RPC_PATH}/...` — deliberately NOT a
 * bare `startsWith`, so sibling paths like `/api/__rpcx` stay with the
 * user's routes.
 */
export const isRpcPath = (pathname: string): boolean =>
  pathname === RPC_PATH || pathname.startsWith(`${RPC_PATH}/`);

/**
 * Append {@link RPC_CLAIM} to a `runWorkerFirst`-dialect rule list unless
 * an existing rule already covers (or collides with) it. Cloudflare's
 * `run_worker_first` parser REJECTS redundant rules — a glob rule makes
 * every other rule sharing its prefix invalid — so the claim is only
 * appended when:
 *
 *   - no positive glob rule covers it (e.g. the default `"/api/*"` covers
 *     `"/api/__rpc*"`, so the dispatch is already worker-first), and
 *   - no existing rule sits inside the reserved `/api/__rpc` space (a
 *     user rule there would be made redundant BY the claim; the path is
 *     reserved and documented — we do not fight over it at plan time).
 *
 * Negative (`!`) rules are ignored: they compile into the asset-worker
 * rule set and can neither cover nor collide with the positive claim.
 */
export const withRpcClaim = (rules: readonly string[]): string[] => {
  const covered = rules.some(
    (rule) =>
      !rule.startsWith("!") &&
      ((rule.endsWith("*") && RPC_CLAIM.startsWith(rule.slice(0, -1))) ||
        rule.startsWith(RPC_PATH)),
  );
  return covered ? [...rules] : [...rules, RPC_CLAIM];
};

/**
 * Platform handler keys that are never dispatchable as RPC methods (the
 * Cloudflare `ExportedHandler` set — kept as a literal so this leaf never
 * imports `Worker.ts`).
 */
const PLATFORM_HANDLER_KEYS: ReadonlySet<string> = new Set([
  "fetch",
  "tail",
  "trace",
  "tailStream",
  "scheduled",
  "test",
  "email",
  "queue",
]);

/**
 * Resolve the RPC-dispatchable methods of an impl shape: own enumerable
 * function-valued keys, minus `fetch` and the platform handler keys.
 */
export const rpcMethodsOf = (
  shape: Record<string, unknown> | undefined,
): Record<string, (...args: unknown[]) => unknown> => {
  const methods: Record<string, (...args: unknown[]) => unknown> = {};
  if (shape === undefined || shape === null) {
    return methods;
  }
  for (const key of Object.keys(shape)) {
    const value = shape[key];
    if (typeof value === "function" && !PLATFORM_HANDLER_KEYS.has(key)) {
      methods[key] = value as (...args: unknown[]) => unknown;
    }
  }
  return methods;
};

/** Pathname of an `HttpServerRequest.url` (absolute or path-relative). */
const pathnameOf = (url: string): string =>
  new URL(url, "http://localhost").pathname;

/**
 * A JSON envelope response. The body is stringified HERE — synchronously,
 * outside `HttpServerResponse.json`'s `HttpBodyError` channel — and a
 * stringify throw (circular value, BigInt) resolves `undefined` so the
 * caller can answer a sanitized defect envelope instead.
 */
const envelope = (
  body: unknown,
  status: number,
): HttpServerResponse.HttpServerResponse | undefined => {
  try {
    return HttpServerResponse.text(JSON.stringify(body), {
      status,
      contentType: "application/json",
    });
  } catch {
    return undefined;
  }
};

const defectEnvelope = (
  message: string,
): HttpServerResponse.HttpServerResponse =>
  envelope({ defect: { message } }, 500)!;

/**
 * The RPC dispatch `HttpEffect` for one request against an impl shape —
 * the serve core's `dispatchRpc`, mounted beside the fetch handler by
 * every delivery surface. Never fails: every outcome (values, typed
 * failures, defects, unknown methods, wrong verbs, malformed bodies) is
 * envelope-encoded per the protocol above. Runs inside the same
 * per-request pipeline as `fetch`, so `HttpServerRequest`, the request
 * `Scope`, and telemetry are in context for the invoked method.
 */
export const dispatchRpc = (
  shape: Record<string, unknown> | undefined,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest | Scope
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (request.method !== "POST") {
      return envelope(
        { error: { _tag: "RpcMethodNotAllowed", method: request.method } },
        405,
      )!;
    }
    const pathname = pathnameOf(request.url);
    const raw = pathname.startsWith(`${RPC_PATH}/`)
      ? pathname.slice(RPC_PATH.length + 1)
      : "";
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
    const method = rpcMethodsOf(shape)[name];
    if (name.length === 0 || method === undefined) {
      return envelope(
        { error: { _tag: "RpcMethodNotFound", method: name } },
        404,
      )!;
    }

    const bodyText = yield* Effect.result(request.text);
    if (Result.isFailure(bodyText)) {
      return envelope(
        {
          error: {
            _tag: "RpcInvalidArguments",
            message: "failed to read the request body",
          },
        },
        400,
      )!;
    }
    let args: unknown[];
    try {
      const parsed: unknown =
        bodyText.success.length > 0 ? JSON.parse(bodyText.success) : [];
      if (!Array.isArray(parsed)) {
        return envelope(
          {
            error: {
              _tag: "RpcInvalidArguments",
              message:
                "the request body must be a JSON array of positional arguments",
            },
          },
          400,
        )!;
      }
      args = parsed;
    } catch (cause) {
      return envelope(
        {
          error: {
            _tag: "RpcInvalidArguments",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        },
        400,
      )!;
    }

    // A synchronous throw from the method body is a defect, like any
    // other. Non-Effect return values pass through as the success value
    // (plain-JSON v1 — no Stream encoding on this protocol).
    const exit = yield* Effect.exit(
      Effect.suspend(() => {
        const invoked = method(...args);
        return Effect.isEffect(invoked)
          ? (invoked as Effect.Effect<unknown, unknown>)
          : Effect.succeed(invoked);
      }),
    );

    if (exit._tag === "Success") {
      return (
        envelope(
          { value: exit.value === undefined ? null : exit.value },
          200,
        ) ??
        defectEnvelope(
          `RPC method "${name}" returned a value that is not JSON-serializable`,
        )
      );
    }

    const failReason = exit.cause.reasons.find(Cause.isFailReason);
    if (failReason !== undefined) {
      return (
        envelope({ error: encodeRpcFailure(failReason.error) }, 400) ??
        defectEnvelope(
          `RPC method "${name}" failed with a value that is not JSON-serializable`,
        )
      );
    }

    // Defect (or interruption): log server-side, answer a sanitized 500 —
    // never echo stacks or internals to the network.
    yield* Effect.logError(
      `RPC method "${name}" died with a defect`,
      exit.cause,
    );
    const squashed = Cause.squash(exit.cause);
    return defectEnvelope(
      squashed instanceof Error ? squashed.message : String(squashed),
    );
  });

/**
 * Normalize a typed failure into the `{"error": ...}` envelope payload:
 * tagged errors keep `_tag` + own enumerable props (plus `message` when
 * the error is an `Error` whose message isn't an own prop); plain
 * `Error`s keep `name`/`message`; everything else passes through.
 */
export const encodeRpcFailure = (error: unknown): unknown => {
  if (error === null || error === undefined || typeof error !== "object") {
    return error;
  }
  const obj = error as Record<string, unknown>;
  if (typeof obj._tag === "string") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = obj[key];
    }
    if (error instanceof Error && !("message" in out)) {
      out.message = error.message;
    }
    return out;
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
};

/**
 * Compose the RPC dispatch in front of a fetch handler: requests at
 * {@link RPC_PATH} are dispatched to the shape's methods, everything else
 * runs `fallback` (an `HttpEffect`, or an init Effect resolving to one —
 * the `Main.fetch` dual shape). This is how the plain effect paths (the
 * rolldown-bundled Cloudflare Worker, the `FunctionBundle` Lambda) serve
 * the protocol: the platform's `serve` wraps the user's fetch with it.
 */
export const withRpcDispatch = (
  shape: Record<string, unknown>,
  fallback:
    | Effect.Effect<any, any, any>
    | Effect.Effect<Effect.Effect<any, any, any>, any, any>,
): Effect.Effect<any, any, any> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (isRpcPath(pathnameOf(request.url))) {
      return yield* dispatchRpc(shape);
    }
    const resolved: any = yield* fallback as Effect.Effect<any, any, any>;
    return HttpServerResponse.isHttpServerResponse(resolved)
      ? resolved
      : yield* resolved as Effect.Effect<any, any, any>;
  });
