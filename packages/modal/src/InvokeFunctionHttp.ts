import * as functions from "@distilled.cloud/modal/functions";
import {
  asEffectOrStream,
  decodeRpcResponseStream,
  decodeRpcResult,
  RpcCallError,
} from "alchemy/Rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BlobOps, downloadBlob, MAX_INLINE_BYTES, uploadBlob } from "./Blob.ts";
import { decodeCbor, encodeCbor } from "./Cbor.ts";
import { isFunctionRef, makeFunctionBinding, type ResolvedFunction } from "./FunctionTarget.ts";
import { operations, seconds } from "./internal.ts";
import { RPC_STREAM_KEY } from "./internal/Entrypoint.ts";
import { RPC_KEY_KWARG, RpcCaller } from "./internal/RpcAuth.ts";
import {
  FunctionCallFailed,
  FunctionCallTimeout,
  InvokeFunction,
  type CallOptions,
  type FunctionClient,
  type FunctionTarget,
} from "./InvokeFunction.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
const InvokeOps = operations({
  map: functions.functionMap,
  putInputs: functions.functionPutInputs,
  getOutputs: functions.getFunctionOutputs,
  cancel: functions.cancelFunctionCall,
  blobs: BlobOps,
});

export type InvokeOps = Effect.Success<typeof InvokeOps>;

/** One input: CBOR `[args, kwargs]`, inline or (over 2 MiB) as a blob. */
const encodeInput = Effect.fn(function* (
  blobs: BlobOps,
  args: ReadonlyArray<unknown>,
  kwargs: Record<string, unknown>,
  method: string | undefined,
) {
  const bytes = yield* Effect.try({
    try: () => encodeCbor([args, kwargs]),
    catch: (cause) =>
      new FunctionCallFailed({
        status: "INVALID_ARGUMENTS",
        message: `Arguments aren't CBOR-encodable: ${String(cause)}`,
      }),
  });
  const payload =
    bytes.length > MAX_INLINE_BYTES
      ? { argsBlobId: yield* uploadBlob(blobs, bytes) }
      : { args: yield* Effect.sync(() => Buffer.from(bytes).toString("base64")) };
  return {
    ...payload,
    dataFormat: "DATA_FORMAT_CBOR",
    methodName: method,
  } satisfies functions.FunctionInput;
});

/** The value of a finished output, or its failure. */
const decodeOutput = Effect.fn(function* (
  blobs: BlobOps,
  functionCallId: string,
  output: functions.GetFunctionOutputsItem,
) {
  const result = output.result;
  if (result?.status !== "GENERIC_STATUS_SUCCESS") {
    return yield* new FunctionCallFailed({
      status: result?.status ?? "GENERIC_STATUS_UNSPECIFIED",
      message: result?.exception || `Function call ${functionCallId} failed`,
      traceback: result?.traceback,
    });
  }
  const bytes = result.dataBlobId
    ? yield* downloadBlob(blobs, result.dataBlobId)
    : result.data
      ? yield* Effect.sync(() => new Uint8Array(Buffer.from(result.data!, "base64")))
      : undefined;
  if (bytes === undefined) return null;
  return yield* Effect.try({
    try: () => decodeCbor(bytes),
    catch: (cause) =>
      new FunctionCallFailed({
        status: "INVALID_RESULT",
        message: `The result isn't CBOR (return plain values, or set the function's serialization): ${String(cause)}`,
      }),
  });
});

/** Inputs per `FunctionPutInputs` request. */
const BATCH = 49;

/** A client for a resolved function. */
export const makeFunctionClient = (resolved: ResolvedFunction, ops: InvokeOps): FunctionClient => {
  const { functionId, method } = resolved;

  /** Collect `count` outputs of a call, by input index. */
  const collect = Effect.fn(function* (
    functionCallId: string,
    count: number,
    timeout: number | string | undefined,
  ) {
    const budget = seconds(timeout) ?? 300;
    const rounds = Math.max(1, Math.ceil(budget / 55));
    const values = new Map<number, unknown>();
    let lastEntryId = "0-0";
    for (let round = 0; round < rounds && values.size < count; round++) {
      const response = yield* ops.getOutputs({
        functionCallId,
        maxValues: Math.min(1000, count - values.size),
        timeout: Math.min(55, budget),
        lastEntryId,
        // A map's outputs stay until all are read; a single output is popped.
        clearOnSuccess: count === 1,
      });
      if (response.lastEntryId) lastEntryId = response.lastEntryId;
      for (const output of response.outputs ?? []) {
        if (!output.result) continue;
        values.set(output.idx ?? 0, yield* decodeOutput(ops.blobs, functionCallId, output));
      }
    }
    if (values.size < count) {
      return yield* new FunctionCallTimeout({
        functionCallId,
        message: `Function call ${functionCallId} didn't finish within ${budget} seconds`,
      });
    }
    return Array.from({ length: count }, (_, idx) => values.get(idx));
  });

  /**
   * Start a function call the way Modal's clients do: a unary call sends its
   * input with `FunctionMap` (or with `FunctionPutInputs` when Modal doesn't
   * take it there); a map creates the call, then sends every input with
   * `FunctionPutInputs`.
   */
  const start = Effect.fn(function* (
    inputs: ReadonlyArray<readonly [ReadonlyArray<unknown>, Record<string, unknown>]>,
    type: "FUNCTION_CALL_TYPE_UNARY" | "FUNCTION_CALL_TYPE_MAP",
    invocation: "FUNCTION_CALL_INVOCATION_TYPE_SYNC" | "FUNCTION_CALL_INVOCATION_TYPE_ASYNC",
  ) {
    const id = yield* functionId;
    const items = yield* Effect.forEach(inputs, ([args, kwargs], idx) =>
      Effect.map(encodeInput(ops.blobs, args, kwargs, method), (input) => ({ idx, input })),
    );
    const unary = type === "FUNCTION_CALL_TYPE_UNARY";
    const response = yield* ops.map({
      functionId: id,
      functionCallType: type,
      functionCallInvocationType: invocation,
      returnExceptions: false,
      pipelinedInputs: unary ? items : undefined,
    });
    const functionCallId = response.functionCallId ?? "";
    const sent = unary && (response.pipelinedInputs ?? []).length > 0 ? items.length : 0;
    for (let offset = sent; offset < items.length; offset += BATCH) {
      yield* ops.putInputs({
        functionId: id,
        functionCallId,
        inputs: items.slice(offset, offset + BATCH),
      });
    }
    return functionCallId;
  });

  return {
    call: <A>(
      args: ReadonlyArray<unknown> = [],
      kwargs: Record<string, unknown> = {},
      options: CallOptions = {},
    ) =>
      start(
        [[args, kwargs]],
        "FUNCTION_CALL_TYPE_UNARY",
        "FUNCTION_CALL_INVOCATION_TYPE_SYNC",
      ).pipe(
        Effect.flatMap((id) => collect(id, 1, options.timeout)),
        // CBOR results are untyped; the caller names the shape it expects.
        Effect.map(([value]) => value as A),
      ),
    map: <A>(inputs: ReadonlyArray<ReadonlyArray<unknown>>, options: CallOptions = {}) =>
      inputs.length === 0
        ? Effect.succeed([] as A[])
        : start(
            inputs.map((args) => [args, {}] as const),
            "FUNCTION_CALL_TYPE_MAP",
            "FUNCTION_CALL_INVOCATION_TYPE_SYNC",
          ).pipe(
            Effect.flatMap((id) => collect(id, inputs.length, options.timeout)),
            Effect.map((values) => values as A[]),
          ),
    spawn: (args = [], kwargs = {}) =>
      start(
        [[args, kwargs]],
        "FUNCTION_CALL_TYPE_UNARY",
        "FUNCTION_CALL_INVOCATION_TYPE_ASYNC",
      ).pipe(Effect.map((functionCallId) => ({ functionCallId }))),
    result: <A>(call: { readonly functionCallId: string }, options: CallOptions = {}) =>
      collect(call.functionCallId, 1, options.timeout).pipe(Effect.map(([value]) => value as A)),
    cancel: (call) =>
      ops.cancel({ functionCallId: call.functionCallId }).pipe(
        Effect.catchTag("FunctionCallNotFound", () => Effect.void),
        Effect.asVoid,
      ),
  };
};

/** Whether a call's result is a streamed RPC result (see `RPC_STREAM_KEY`). */
const isStreamResult = (value: unknown): value is { [RPC_STREAM_KEY]: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as Record<string, unknown>)[RPC_STREAM_KEY]);

/**
 * The typed client of a `Modal.Function` program's RPC methods. Each method
 * is a call to the function's method of that name; its result is the
 * program's JSON answer, a failure envelope the call fails with, or a
 * stream's values. A Function without methods (an async program) keeps
 * the {@link FunctionClient} operations.
 */
export const makeRpcClient = (
  resolved: ResolvedFunction,
  ops: InvokeOps,
  methods: Effect.Effect<ReadonlyArray<string> | undefined>,
  key: Effect.Effect<string | undefined>,
): Record<string, unknown> => {
  const client = makeFunctionClient(resolved, ops);
  const callMethod = (name: string, args: ReadonlyArray<unknown>) =>
    key.pipe(
      Effect.flatMap((value) =>
        makeFunctionClient({ ...resolved, method: name }, ops).call(
          args,
          // The binding's key: the program serves only callers it issued keys to.
          value === undefined ? {} : { [RPC_KEY_KWARG]: value },
        ),
      ),
      Effect.flatMap((value) =>
        isStreamResult(value)
          ? // The stream's values, re-encoded as the NDJSON the RPC codec
            // decodes (byte chunks and a trailing failure marker included).
            Effect.succeed(
              Stream.fromIterable(value[RPC_STREAM_KEY]).pipe(
                Stream.map((item) => `${JSON.stringify(item)}\n`),
                Stream.encodeText,
                decodeRpcResponseStream,
              ),
            )
          : decodeRpcResult(value),
      ),
    );
  return new Proxy(
    {},
    {
      get: (_, prop) => {
        // Never thenable, and no symbol members.
        if (typeof prop !== "string" || prop === "then") return undefined;
        const call = (args: unknown[]) =>
          Effect.gen(function* () {
            const names = (yield* methods) ?? [];
            if (names.includes(prop)) return yield* callMethod(prop, args);
            const operation = (client as unknown as Record<string, unknown>)[prop];
            if (typeof operation === "function") {
              return yield* (operation as (...a: unknown[]) => Effect.Effect<unknown, unknown>)(
                ...args,
              );
            }
            return yield* new RpcCallError({
              method: prop,
              cause: `The function has no RPC method ${prop}`,
            });
          });
        return (...args: unknown[]) =>
          asEffectOrStream(
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the stub's declared method types carry `RuntimeContext`, which the caller's runtime provides
            call(args) as Effect.Effect<unknown, unknown>,
          );
      },
    },
  );
};

/**
 * {@link InvokeFunction} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the function's environment.
 *
 * @layer
 * @product Function
 * @provides Modal.InvokeFunction
 */
export const InvokeFunctionHttp = Layer.effect(
  InvokeFunction,
  Effect.gen(function* () {
    const caller = yield* RpcCaller;
    return yield* makeFunctionBinding({
      tag: "Modal.InvokeFunction",
      operations: InvokeOps,
      role: "contributor",
      make: Effect.fn(function* (resolved, ops, target: FunctionTarget) {
        if (isFunctionRef(target)) return makeFunctionClient(resolved, ops);
        // This host's key for the Function's RPC methods (minted at deploy).
        const key = yield* caller(target as unknown as { readonly LogicalId: string });
        // The program's methods, recorded at deploy (an attribute of the Function).
        const methods = yield* (
          target as unknown as {
            readonly methods: Effect.Effect<Effect.Effect<ReadonlyArray<string> | undefined>>;
          }
        ).methods;
        // Typed by `InvokeFunction`'s call signatures from the target's program.
        return makeRpcClient(resolved, ops, methods, key) as unknown as FunctionClient;
      }),
    });
  }),
);
