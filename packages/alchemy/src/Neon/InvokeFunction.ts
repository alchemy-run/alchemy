import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import {
  CurrentRuntimeContext,
  type RuntimeContext,
  sanitizeKey,
} from "../RuntimeContext.ts";
import type { Function } from "./Function.ts";

export interface InvokeFunctionClient {
  /** Public base URL; access control remains the application's responsibility. */
  url: Effect.Effect<string, never, RuntimeContext>;
  /** Stream an HTTP response. Supply caller authorization explicitly; no account API key is attached. */
  fetch(
    path?: string,
    init?: RequestInit,
  ): Effect.Effect<Response, InvokeFunctionError, RuntimeContext>;
}

import * as Data from "effect/Data";
export class InvokeFunctionError extends Data.TaggedError(
  "InvokeFunctionError",
)<{ message: string }> {}

/**
 * Bind a public Function URL to any Alchemy runtime host.
 *
 * ### Invoke a Function
 * **Example:** Forward explicit caller credentials
 * ```typescript
 * const invoke = yield* Neon.InvokeFunction(api);
 * const response = yield* invoke.fetch("/private", { headers: { authorization: bearer } });
 * ```
 *
 * @binding
 */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "Neon.InvokeFunction",
  (fn: Function) => Effect.Effect<InvokeFunctionClient>
> {}
export const InvokeFunction = Binding.Service<InvokeFunction>(
  "Neon.InvokeFunction",
);

/**
 * URL-only binding. Does not provision an invocation credential or private route.
 *
 * @layer
 * @provides Neon.InvokeFunction
 */
export const InvokeFunctionBinding = Layer.effect(
  InvokeFunction,
  Effect.gen(function* () {
    const host = yield* CurrentRuntimeContext;
    if (!host)
      return yield* Effect.die(
        new Error("Neon.InvokeFunction requires a Platform host"),
      );
    return Effect.fn(function* (fn: Function) {
      const key = sanitizeKey(
        `NEON_FUNCTION_${Array.from(fn.FQN, (character) => character.codePointAt(0)!.toString(16)).join("_")}_URL`,
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) yield* host.set(key, fn.url);
      const url = host
        .get<string>(key)
        .pipe(
          Effect.flatMap((url) =>
            url
              ? Effect.succeed(url)
              : Effect.die(new Error("Missing Neon Function URL binding")),
          ),
        );
      return {
        url,
        fetch: (path = "/", init?: RequestInit) =>
          Effect.gen(function* () {
            const base = yield* url;
            const target = yield* Effect.try({
              try: () => new URL(path, base),
              catch: () =>
                new InvokeFunctionError({
                  message: "Invalid Function request path",
                }),
            });
            if (target.origin !== new URL(base).origin)
              return yield* new InvokeFunctionError({
                message: "Function invocation must remain on the bound origin",
              });
            return yield* Effect.tryPromise({
              try: (signal) =>
                fetch(target, {
                  ...init,
                  signal: init?.signal
                    ? AbortSignal.any([signal, init.signal])
                    : signal,
                }),
              catch: () =>
                new InvokeFunctionError({
                  message: "Neon Function HTTP request failed",
                }),
            });
          }),
      };
    });
  }),
);
