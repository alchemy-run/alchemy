import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { fromCloudflareFetcher } from "./Fetcher.ts";

export const StreamTag = "~alchemy/rpc/stream";
export const ErrorTag = "~alchemy/rpc/error";

type StreamEncoding = "bytes" | "jsonl";

export type RpcStreamEnvelope = {
  _tag: typeof StreamTag;
  encoding: StreamEncoding;
  body: ReadableStream<Uint8Array>;
};

export class RpcDecodeError extends Data.TaggedError("RpcDecodeError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

export class RpcCallError extends Data.TaggedError("RpcCallError")<{
  readonly method: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `RPC call to "${this.method}" failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

export type RpcErrorEnvelope = {
  _tag: typeof ErrorTag;
  error: unknown;
};

export const isRpcErrorEnvelope = (value: unknown): value is RpcErrorEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === ErrorTag &&
  "error" in value;

/**
 * Normalize an error value into a plain, structured-clone-safe object.
 * Tagged errors keep `_tag` and all own enumerable fields.
 * Plain `Error` instances keep `name`, `message`, and `stack`.
 */
export const encodeRpcError = (error: unknown): unknown => {
  if (error === null || error === undefined) return error;
  if (typeof error !== "object") return error;

  const obj = error as Record<string, unknown>;
  if ("_tag" in obj && typeof obj._tag === "string") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = obj[key];
    }
    if (error instanceof Error && !("message" in out)) {
      out.message = (error as Error).message;
    }
    return out;
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  return error;
};

export const isRpcStreamEnvelope = (
  value: unknown,
): value is RpcStreamEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === StreamTag &&
  "encoding" in value &&
  (value.encoding === "bytes" || value.encoding === "jsonl") &&
  "body" in value &&
  value.body instanceof ReadableStream;

export const fromRpcReadableStream = (
  body: ReadableStream<Uint8Array>,
  encoding: StreamEncoding,
): Stream.Stream<any, Socket.SocketError | RpcDecodeError> => {
  const stream = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) =>
      Socket.isSocketError(cause)
        ? cause
        : new Socket.SocketError({
            reason: new Socket.SocketReadError({ cause }),
          }),
  });

  if (encoding === "bytes") {
    return stream;
  }

  return stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Effect.try({
        try: () => JSON.parse(line),
        catch: (cause) => new RpcDecodeError({ cause }),
      }),
    ),
  );
};

export const fromRpcStreamEnvelope = (
  envelope: RpcStreamEnvelope,
): Stream.Stream<any, Socket.SocketError | RpcDecodeError> =>
  fromRpcReadableStream(envelope.body, envelope.encoding);

export const decodeRpcValue = (value: unknown) => {
  if (isRpcStreamEnvelope(value)) {
    return fromRpcReadableStream(value.body, value.encoding);
  }

  if (value instanceof ReadableStream) {
    return fromRpcReadableStream(value, "bytes");
  }

  return value;
};

/**
 * Decode an RPC return value, lifting error envelopes into the Effect
 * error channel so that remote `Effect.fail(...)` values are recoverable.
 */
export const decodeRpcResult = (
  value: unknown,
): Effect.Effect<unknown, unknown> => {
  if (isRpcErrorEnvelope(value)) {
    return Effect.fail(value.error);
  }
  return Effect.succeed(decodeRpcValue(value));
};

export const makeRpcStub = <Shape>(stub: any): Shape => {
  const fetcher = fromCloudflareFetcher(stub);

  return new Proxy(fetcher, {
    get: (target: any, prop) =>
      prop in target
        ? target[prop]
        : (...args: any[]) =>
            Effect.tryPromise({
              try: () => stub[prop](...args),
              catch: (cause) =>
                new RpcCallError({ method: String(prop), cause }),
            }).pipe(Effect.flatMap(decodeRpcResult)),
  }) as Shape;
};

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 *
 * Accepts the `DurableObject` base class and a `getExport` resolver so the
 * implementation lives in real TypeScript instead of a generated string template.
 */
export const makeDurableObjectBridge = (
  DurableObject: abstract new (state: unknown, env: unknown) => object,
  getExport: (
    name: string,
  ) => Promise<
    (state: unknown, env: unknown) => Effect.Effect<Record<string, unknown>>
  >,
) => {
  return class DurableObjectBridge extends (DurableObject as new (
    state: unknown,
    env: unknown,
  ) => object) {
    constructor(
      state: {
        blockConcurrencyWhile: (fn: () => Promise<unknown>) => Promise<unknown>;
      },
      env: unknown,
    ) {
      super(state, env);

      const object: Promise<Record<string, (...args: unknown[]) => unknown>> =
        state.blockConcurrencyWhile(async () => {
          const cls = await getExport(this.constructor.name);
          return await Effect.runPromise(cls(state, env));
        }) as Promise<Record<string, (...args: unknown[]) => unknown>>;

      return new Proxy(this, {
        get: (target, prop) =>
          prop !== "fetch" && prop !== "connect"
            ? async (...args: unknown[]) => {
                const methods = await object;
                const value = methods[prop as string](...args);
                if (Effect.isEffect(value)) {
                  const exit = await Effect.runPromiseExit(
                    value as Effect.Effect<unknown, never>,
                  );
                  if (exit._tag === "Success") {
                    if (Stream.isStream(exit.value)) {
                      return await Effect.runPromise(
                        toRpcStream(
                          exit.value,
                        ) as Effect.Effect<RpcStreamEnvelope>,
                      );
                    }
                    return exit.value;
                  }
                  const failReason = exit.cause.reasons.find(
                    Cause.isFailReason,
                  );
                  if (failReason) {
                    return {
                      _tag: ErrorTag,
                      error: encodeRpcError(failReason.error),
                    } satisfies RpcErrorEnvelope;
                  }
                  const dieReason = exit.cause.reasons.find(Cause.isDieReason);
                  throw (
                    dieReason?.defect ??
                    new Error("RPC method failed with an unexpected cause")
                  );
                }
                return value;
              }
            : (target as Record<string | symbol, unknown>)[prop],
      });
    }
  };
};

export const toRpcStream = (stream: Stream.Stream<any, any, any>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const [head, rest] = yield* Stream.peel(stream, Sink.head());

      if (Option.isSome(head) && head.value instanceof Uint8Array) {
        return {
          _tag: StreamTag,
          encoding: "bytes",
          body: Stream.toReadableStream(
            rest.pipe(Stream.prepend([head.value])),
          ),
        } satisfies RpcStreamEnvelope;
      }

      const body = Option.isSome(head)
        ? rest.pipe(Stream.prepend([head.value]))
        : rest;

      return {
        _tag: StreamTag,
        encoding: "jsonl",
        body: Stream.toReadableStream(
          body.pipe(
            Stream.map((value) => JSON.stringify(value) + "\n"),
            Stream.encodeText,
          ),
        ),
      } satisfies RpcStreamEnvelope;
    }),
  );
