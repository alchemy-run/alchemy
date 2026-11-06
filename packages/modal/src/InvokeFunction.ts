import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { downloadBlob, uploadBlob } from "./Blob.ts";
import type { Function } from "./Function.ts";
import type { FunctionLookupError } from "./FunctionTarget.ts";
import type { ErrorOf, OpError } from "./internal.ts";
import type { InvokeOps } from "./InvokeFunctionHttp.ts";

/** A function deployed outside the Stack (`modal deploy`), by name. */
export interface FunctionRef {
  /** Name of the deployed App (`modal deploy` / `modal.App("…")`). */
  readonly app: string;
  /** Function name in the App (`"embed"`), or `"Class.method"` for a class method. */
  readonly function: string;
  /** Environment the App is deployed in. @default the workspace default */
  readonly environment?: string;
  /**
   * Parameters of a parameterized class (`modal.parameter()` fields), for a
   * `"Class.method"` target. Modal runs one set of containers per value set.
   */
  readonly parameters?: Record<string, string | number | boolean | Uint8Array>;
}

/** What a function binding targets: a `Modal.Function` of the Stack, or a deployed function by name. */
export type FunctionTarget = Function | FunctionRef;

/** The function raised, or Modal failed the call. */
export class FunctionCallFailed extends Data.TaggedError("Modal.FunctionCallFailed")<{
  readonly status: string;
  readonly message: string;
  readonly traceback?: string;
}> {}

/** The call didn't finish within its timeout. */
/** Calling a function: looking it up, sending inputs, reading outputs, and the call's own failure. */
export type InvokeError =
  | FunctionLookupError
  | OpError<InvokeOps, "map" | "putInputs" | "getOutputs">
  | ErrorOf<typeof uploadBlob | typeof downloadBlob>
  | FunctionCallFailed
  | FunctionCallTimeout;

export class FunctionCallTimeout extends Data.TaggedError("Modal.FunctionCallTimeout")<{
  readonly functionCallId: string;
  readonly message: string;
}> {}

/** Options for one call. */
export interface CallOptions {
  /** How long to wait for the result (seconds, or `"10 minutes"`). @default 300 seconds */
  readonly timeout?: number | string;
}

/** Call one function. Arguments and results travel as CBOR. */
export interface FunctionClient {
  /** Call the function and wait for its result. */
  call<A = unknown>(
    args?: ReadonlyArray<unknown>,
    kwargs?: Record<string, unknown>,
    options?: CallOptions,
  ): Effect.Effect<A, InvokeError, RuntimeContext>;
  /**
   * Call the function once per input, in parallel across containers, and
   * return the results in input order. Each input is a list of positional
   * arguments. Fails with the first failed input.
   */
  map<A = unknown>(
    inputs: ReadonlyArray<ReadonlyArray<unknown>>,
    options?: CallOptions,
  ): Effect.Effect<A[], InvokeError, RuntimeContext>;
  /** Start a call without waiting; read it later with {@link result}. */
  spawn(
    args?: ReadonlyArray<unknown>,
    kwargs?: Record<string, unknown>,
  ): Effect.Effect<{ readonly functionCallId: string }, InvokeError, RuntimeContext>;
  /** The result of a spawned call, waiting up to `timeout`. */
  result<A = unknown>(
    call: { readonly functionCallId: string },
    options?: CallOptions,
  ): Effect.Effect<A, InvokeError, RuntimeContext>;
  /** Cancel a spawned call. */
  cancel(call: {
    readonly functionCallId: string;
  }): Effect.Effect<void, FunctionLookupError | OpError<InvokeOps, "cancel">, RuntimeContext>;
}

/**
 * Call a Modal Function from any runtime: a Worker, a Lambda, a Durable
 * Object, another Modal Function. Bind a `Modal.Function` of the Stack, or
 * a function deployed with `modal deploy` by name.
 *
 * Arguments and results are CBOR (Modal's cross-language format): numbers,
 * strings, bytes, lists, dicts, booleans and `None`. A `Modal.Function`
 * program receives them as JSON (`Modal.FunctionCall`); a Python function
 * needs no changes. Payloads over 2 MiB go through Modal's blob store.
 *
 * ### Call a function
 * **Example:** A `Modal.Function` of the Stack, from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import Embed from "./Embed.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const embed = yield* Modal.InvokeFunction(Embed);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* embed.call<{ tokens: number }>(["hello world"]);
 *         return yield* HttpServerResponse.json(result);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.InvokeFunctionHttp)),
 * ) {}
 * ```
 *
 * **Example:** A Python function deployed with `modal deploy`
 * ```typescript
 * const embed = yield* Modal.InvokeFunction({ app: "inference", function: "embed" });
 * const vector = yield* embed.call<number[]>(["hello world"]);
 * ```
 *
 * **Example:** A method of a parameterized Python class
 * ```typescript
 * const model = yield* Modal.InvokeFunction({
 *   app: "inference",
 *   function: "Model.generate",
 *   parameters: { size: "7b" },
 * });
 * const text = yield* model.call<string>(["hello"]);
 * ```
 *
 * ### Fan out
 * **Example:** One call per input, in parallel
 * ```typescript
 * const results = yield* embed.map<{ tokens: number }>([["a"], ["b"], ["c"]]);
 * ```
 *
 * ### Fire and forget
 * **Example:** Spawn, then read the result later
 * ```typescript
 * const job = yield* train.spawn([], { epochs: 3 });
 * const metrics = yield* train.result(job, { timeout: "30 minutes" });
 * ```
 *
 * @binding
 * @product Function
 */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "Modal.InvokeFunction",
  (target: FunctionTarget) => Effect.Effect<FunctionClient>
> {}

export const InvokeFunction = Binding.Service<InvokeFunction>("Modal.InvokeFunction");
