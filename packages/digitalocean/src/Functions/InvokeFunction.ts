import type * as Fn from "@distilled.cloud/digitalocean/Functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { Action } from "./Action.ts";

/** The function ran and failed, or did not finish within the call. */
export class FunctionInvocationFailed extends Data.TaggedError(
  "DigitalOcean.Functions.FunctionInvocationFailed",
)<{
  readonly function: string;
  readonly activationId: string | undefined;
  readonly status: string | undefined;
  readonly result: unknown;
}> {
  override get message() {
    return `Function '${this.function}' failed (${this.status ?? "unknown"}, activation ${this.activationId ?? "none"}).`;
  }
}

/** The function's endpoint or key is missing from this runtime's environment. */
export class FunctionBindingNotConfigured extends Data.TaggedError(
  "DigitalOcean.Functions.FunctionBindingNotConfigured",
)<{
  readonly function: string;
}> {
  override get message() {
    return `Function '${this.function}' is not bound to this runtime: its access key is missing from the environment.`;
  }
}

export type InvokeFunctionError =
  | FunctionInvocationFailed
  | FunctionBindingNotConfigured
  | Fn.InvokeActionError;

export interface InvokeFunctionClient {
  /** Runs the function with these parameters and returns its result. */
  <A = unknown>(
    parameters?: Record<string, unknown>,
  ): Effect.Effect<A, InvokeFunctionError, RuntimeContext>;
}

/**
 * Invoke a DigitalOcean function from a runtime and wait for its result.
 * Binding it mints a `Functions.AccessKey` for the host, scoped to the
 * function's namespace, because DigitalOcean signs no workload identity a
 * runtime could present instead; the key reaches the host as a secret.
 *
 * **Example:** Call a function from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const fn = yield* Resize;
 *     const resize = yield* DigitalOcean.Functions.InvokeFunction(fn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const out = yield* resize<{ url: string }>({ width: 200 });
 *         return HttpServerResponse.text(out.url);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Functions.InvokeFunctionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Functions
 */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "DigitalOcean.Functions.InvokeFunction",
  (fn: Action) => Effect.Effect<InvokeFunctionClient>
> {}

export const InvokeFunction = Binding.Service<InvokeFunction>(
  "DigitalOcean.Functions.InvokeFunction",
);
