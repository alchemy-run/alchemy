/**
 * How a Durable Stream's messages are written and read: a codec derived
 * from the message's Schema, provided as a Layer. Each format is one Layer
 * over one `effect/encoding` module, so a program only bundles the formats
 * it provides.
 *
 * ```typescript
 * import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
 *
 * Effect.provide(Layer.mergeAll(Default, Services, StreamFormat.Json));
 * ```
 */
import * as Arr from "effect/Array";
import * as Channel from "effect/Channel";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as JsonArray from "effect/encoding/JsonArray";
import * as Ndjson from "effect/encoding/Ndjson";
import * as SchemaBinaryEncoding from "effect/encoding/SchemaBinary";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** A message Schema a format can encode and decode without services. */
export type MessageSchema<A = any> = Schema.Codec<A, any, never, never>;

/** A message didn't match its Schema, or its bytes weren't valid for the format. */
export class StreamFormatError extends Data.TaggedError("Rivet.StreamFormatError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface StreamFormatShape {
  /**
   * The stream's content type, fixed when the stream is created. With
   * `application/json` the stream stores separate messages; with anything
   * else it stores bytes the format frames itself.
   */
  readonly contentType: string;
  /**
   * `messages` when the stream splits appends into messages itself (JSON):
   * every read body and every live event is a whole JSON array. `bytes` when
   * the stream is one run of bytes: read bodies and live events continue
   * one another and decode as one.
   */
  readonly framing: "messages" | "bytes";
  /** Encode messages into the body of one append. */
  readonly encode: <A>(
    schema: MessageSchema<A>,
    messages: Arr.NonEmptyReadonlyArray<A>,
  ) => Effect.Effect<Uint8Array, StreamFormatError>;
  /** Decode a run of bytes into messages, keeping state across chunks. */
  readonly decode: <A>(
    schema: MessageSchema<A>,
  ) => <E extends { readonly _tag: string }, R>(
    bytes: Stream.Stream<Uint8Array<ArrayBuffer>, E, R>,
  ) => Stream.Stream<A, E | StreamFormatError, R>;
}

/** The format a Durable Stream's messages are written and read in. */
export class StreamFormat extends Context.Service<StreamFormat, StreamFormatShape>()(
  "Rivet.StreamFormat",
) {}

/** What a format's own channels fail with. */
type FormatFailure = Schema.SchemaError | JsonArray.JsonArrayError | Ndjson.NdjsonError;

const isFormatFailure = <E extends { readonly _tag: string }>(
  error: E | FormatFailure,
): error is FormatFailure =>
  error._tag === "SchemaError" || error._tag === "JsonArrayError" || error._tag === "NdjsonError";

const formatError = (cause: FormatFailure) =>
  new StreamFormatError({ message: cause.message, cause });

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/** A format over one `effect/encoding` module's schema channels. */
const make = (options: {
  readonly contentType: string;
  readonly framing: "messages" | "bytes";
  readonly encoder: <A, IE>(
    schema: MessageSchema<A>,
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<Uint8Array>,
    FormatFailure | IE,
    unknown,
    Arr.NonEmptyReadonlyArray<A>,
    IE,
    unknown
  >;
  readonly decoder: <A, IE>(
    schema: MessageSchema<A>,
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<A>,
    FormatFailure | IE,
    unknown,
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    IE,
    unknown
  >;
}): StreamFormatShape => ({
  contentType: options.contentType,
  framing: options.framing,
  encode: (schema, messages) =>
    Stream.fromIterable(messages).pipe(
      Stream.pipeThroughChannel(options.encoder<(typeof messages)[number], never>(schema)),
      Stream.runCollect,
      Effect.map(concat),
      Effect.mapError(formatError),
    ),
  decode: (schema) => (bytes) =>
    bytes.pipe(
      Stream.pipeThroughChannel(options.decoder(schema)),
      Stream.mapError((error) => (isFormatFailure(error) ? formatError(error) : error)),
    ),
});

/**
 * JSON: one message per append, read back as JSON arrays. The stream's
 * content type is `application/json`, which keeps messages separate and
 * readable in Rivet's dashboard.
 */
export const Json: Layer.Layer<StreamFormat> = Layer.succeed(StreamFormat)(
  make({
    contentType: "application/json",
    framing: "messages",
    encoder: (schema) => JsonArray.encodeSchema(schema)(),
    decoder: (schema) => JsonArray.decodeSchema(schema)(),
  }),
);

/** Newline-delimited JSON on a byte stream: one message per line. */
export const Ndjson_: Layer.Layer<StreamFormat> = Layer.succeed(StreamFormat)(
  make({
    contentType: "application/x-ndjson",
    framing: "bytes",
    encoder: (schema) => Ndjson.encodeSchema(schema)(),
    decoder: (schema) => Ndjson.decodeSchema(schema)(),
  }),
);
export { Ndjson_ as Ndjson };

/**
 * Effect's compact binary codec on a byte stream. `fingerprint` writes a
 * smaller, positional layout that both sides must share exactly.
 */
export const SchemaBinary = (options?: SchemaBinaryEncoding.Options): Layer.Layer<StreamFormat> =>
  Layer.succeed(StreamFormat)(
    make({
      contentType: "application/octet-stream",
      framing: "bytes",
      encoder: (schema) => SchemaBinaryEncoding.encode(schema, options)(),
      decoder: (schema) => SchemaBinaryEncoding.decode(schema, options)(),
    }),
  );
