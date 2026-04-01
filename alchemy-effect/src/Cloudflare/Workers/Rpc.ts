import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { fromCloudflareFetcher } from "./Fetcher.ts";

export const StreamTag = "~alchemy/rpc/stream";

type StreamEncoding = "bytes" | "jsonl";

export type DurableObjectRpcStreamEnvelope = {
  _tag: typeof StreamTag;
  encoding: StreamEncoding;
  body: ReadableStream<Uint8Array>;
};

export const isRpcStreamEnvelope = (
  value: unknown,
): value is DurableObjectRpcStreamEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === StreamTag &&
  "encoding" in value &&
  (value.encoding === "bytes" || value.encoding === "jsonl") &&
  "body" in value &&
  value.body instanceof ReadableStream;

export const fromRpcReadableStream = <E>(
  body: ReadableStream<Uint8Array>,
  encoding: StreamEncoding,
): Stream.Stream<any, E> => {
  const stream = Stream.fromReadableStream({
    evaluate: () => body,
    // TODO(sam): better error handling
    onError: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

  return encoding === "bytes"
    ? stream
    : stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.map((line) => JSON.parse(line)),
      );
};

export const fromRpcStreamEnvelope = <E>(
  envelope: DurableObjectRpcStreamEnvelope,
): Stream.Stream<any, E> =>
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

export const makeRpcStub = <Shape>(stub: any): Shape => {
  const fetcher = fromCloudflareFetcher(stub);

  return new Proxy(fetcher, {
    get: (target: any, prop) =>
      prop in target
        ? target[prop]
        : (...args: any[]) =>
            Effect.tryPromise(async () => {
              try {
                return decodeRpcValue(await stub[prop](...args));
              } catch (error) {
                console.error("error", error);
                throw error;
              }
            }),
  }) as Shape;
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
        } satisfies DurableObjectRpcStreamEnvelope;
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
      } satisfies DurableObjectRpcStreamEnvelope;
    }),
  );
