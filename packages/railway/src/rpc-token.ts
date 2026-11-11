import { makeRandom } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

/** Env var on the RPC host. Callers send it as {@link RPC_TOKEN_HEADER}. */
export const RPC_TOKEN_ENV = "ALCHEMY_RPC_TOKEN";

/** Request header the caller must send. Never accepted from the public edge. */
export const RPC_TOKEN_HEADER = "x-alchemy-rpc-token";

export const PRIVATE_HOST_SUFFIX = ".railway.internal";

export const DEFAULT_RPC_PORT = 3000;

/** Same prefix as `alchemy/Rpc` so Function canvas code does not import Rpc.ts. */
export const RPC_PATH_PREFIX = "/__rpc__/";

/** Same envelope tag as `alchemy/Rpc.ErrorTag`. */
export const RPC_ERROR_TAG = "~alchemy/rpc/error";

// The protocol's version header and trace metadata, as `alchemy/Rpc` defines
// them (`RPC_PROTOCOL_HEADER`, `currentRpcMeta`, `rpcParentOf`), kept here so
// canvas Functions don't import Rpc.ts.

/** Same as `alchemy/Rpc.RPC_PROTOCOL_HEADER`. */
export const RPC_PROTOCOL_HEADER = "x-alchemy-rpc";

/**
 * The call's own trace context, as `alchemy/Rpc.rpcMetaHeaders` sends it:
 * proxies may rewrite `traceparent`, but leave this header alone.
 */
export const RPC_TRACEPARENT_HEADER = "x-alchemy-meta-traceparent";

/** The protocol versions this runtime speaks; `alchemy/Rpc.SUPPORTED_RPC_VERSIONS`. */
export const RPC_PROTOCOL_VERSION = 1;

/** The W3C `traceparent` of the current span, if there is one to propagate. */
export const currentTraceparent: Effect.Effect<string | undefined> = Effect.gen(function* () {
  if (yield* Tracer.DisablePropagation) return undefined;
  const span = yield* Effect.currentParentSpan.pipe(Effect.option);
  if (Option.isNone(span)) return undefined;
  const { traceId, spanId, sampled } = span.value;
  return `00-${traceId.padStart(32, "0")}-${spanId}-${sampled ? "01" : "00"}`;
});

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

/**
 * Run `effect` as a child of the caller's span. The call's own header names it
 * outright; a bare `traceparent` (an older caller) applies only without a span
 * of the callee's own.
 */
export const withCallerSpan =
  (own: string | undefined, bare: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const parse = (value: string | undefined) => {
      const match = value === undefined ? null : TRACEPARENT.exec(value.trim());
      return match === null
        ? undefined
        : Tracer.externalSpan({
            traceId: match[1]!,
            spanId: match[2]!,
            sampled: (Number.parseInt(match[3]!, 16) & 1) === 1,
          });
    };
    const forced = parse(own);
    if (forced !== undefined) return Effect.withParentSpan(effect, forced);
    const fallback = parse(bare);
    if (fallback === undefined) return effect;
    return Effect.flatMap(Effect.currentParentSpan.pipe(Effect.option), (current) =>
      Option.isSome(current) ? effect : Effect.withParentSpan(effect, fallback),
    );
  };

export const RPC_TOKEN_ATTR = "rpcToken";

const envKey = (logicalId: string, suffix: string) =>
  `RAILWAY_RPC_${logicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_${suffix}`;

export const rpcEnvKeys = (logicalId: string) => ({
  host: envKey(logicalId, "HOST"),
  port: envKey(logicalId, "PORT"),
  token: envKey(logicalId, "TOKEN"),
});

/**
 * Child {@link makeRandom} for a Function/Service logical id. Generated
 * once, persisted in alchemy state, reused on later deploys.
 */
export const mintRpcToken = (logicalId: string) => makeRandom(`${logicalId}RpcToken`);
