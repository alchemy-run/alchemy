import { safeHttpEffect } from "alchemy/Http";
import * as Output from "alchemy/Output";
import { serveRpc } from "alchemy/Rpc";
import { createHostRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import * as Effect from "effect/Effect";
import { RPC_METHODS_ENV, RPC_SERVE_ENV } from "./Entrypoint.ts";
import { parseCallers, requireRpcCaller, RPC_CALLERS_ENV } from "./RpcAuth.ts";

/** The RPC methods of a program's shape: every function besides `fetch` and `run`. */
export const rpcMethodsOf = (shape: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(shape ?? {}).filter(
      ([key, value]) => key !== "fetch" && key !== "run" && typeof value === "function",
    ),
  );

/** The method names a function's env records (see {@link RPC_METHODS_ENV}). */
export const rpcMethodNamesOf = (env: Record<string, unknown> | undefined): string[] => {
  const value = env?.[RPC_METHODS_ENV];
  if (typeof value !== "string") return [];
  try {
    const names = JSON.parse(value) as unknown;
    return Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The runtime context of a `Modal.Function` or `Modal.Server` program. At
 * plan it records the program's RPC methods in its env, so the Function's
 * definition can name them. At run time it serves them on `/__rpc__/*`
 * next to `fetch`, but only where the provider set {@link RPC_SERVE_ENV}
 * (where Modal authenticates every request), and only to callers holding a
 * key a binding issued (see `RpcAuth.ts`).
 */
export const createModalRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const base = createHostRuntimeContext(type)(id);
    const serveBase = base.serve;
    const serve: HostRuntimeContext["serve"] = (handler, options) =>
      Effect.gen(function* () {
        const methods = rpcMethodsOf(options?.shape);
        const names = Object.keys(methods).sort();
        if (!globalThis.__ALCHEMY_RUNTIME__ && names.length > 0) {
          yield* base.set(RPC_METHODS_ENV, Output.literal(names));
        }
        const enabled = (yield* base.get<unknown>(RPC_SERVE_ENV)) !== undefined;
        if (!enabled || names.length === 0) return yield* serveBase(handler, options);
        const fallback = safeHttpEffect(handler);
        const callers = parseCallers(yield* base.get<unknown>(RPC_CALLERS_ENV));
        return yield* serveBase(
          requireRpcCaller(callers, serveRpc(methods, fallback), fallback),
          options,
        );
      }) as Effect.Effect<void, never, any>;
    return Object.assign(base, { serve });
  };
